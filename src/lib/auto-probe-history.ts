import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import {
  createProbeCondition,
  type ProbeCondition,
} from "~/lib/auto-probe-prompts"
import { writeFileAtomically } from "~/lib/atomic-file"
import { PATHS } from "~/lib/paths"

export interface ProbeObservation {
  condition: ProbeCondition
  observedAt: string
  outcome: "selected" | "error"
  modelIds: Array<string>
  pairedModelIds?: Array<string>
  status?: number
  errorCode?: string
  scores?: Record<string, number>
  generation?: Array<{
    modelId: string
    accepted: boolean
    discountPercent?: number
  }>
}

export interface ProbeHistoryStore {
  conditions: Array<ProbeCondition>
  observations: Array<ProbeObservation>
  record(observation: ProbeObservation): Promise<void>
  flush(): Promise<void>
}

const conditionSchema = z.discriminatedUnion("source", [
  z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.literal("auto"),
    tier: z.enum(["efficiency", "balance", "intelligence", "fast"]),
    prompt: z.string(),
  }),
  z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.literal("fusion"),
    planVersion: z.enum(["1", "2"]),
    fusionMode: z.literal("hydrafusion"),
    prompt: z.string(),
  }),
])
const modelIdSchema = z.string().refine((value) => value.trim().length > 0)
const metadataShape = {
  observedAt: z.iso.datetime({ offset: true }),
  outcome: z.enum(["selected", "error"]),
  modelIds: z.array(modelIdSchema),
  pairedModelIds: z.array(modelIdSchema).optional(),
  status: z.number().int().min(100).max(599).optional(),
  errorCode: z.string().optional(),
  scores: z.object({}).catchall(z.number()).optional(),
  generation: z
    .array(
      z.object({
        modelId: modelIdSchema,
        accepted: z.boolean(),
        discountPercent: z.number().min(0).max(100).optional(),
      }),
    )
    .optional(),
}
const observationSchema = z.object({
  condition: conditionSchema,
  ...metadataShape,
})
const runSchema = z
  .object({
    conditionId: z.string().regex(/^[a-f0-9]{64}$/),
    ...metadataShape,
  })
  .strict()
  .extend({
    generation: z
      .array(metadataShape.generation.unwrap().element.strict())
      .optional(),
  })
const conditionsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    conditions: z.array(
      z.discriminatedUnion("source", [
        conditionSchema.options[0].strict(),
        conditionSchema.options[1].strict(),
      ]),
    ),
  })
  .strict()

const safeSegment = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const safeWriter = /^(?:runtime|tester-[A-Za-z0-9][A-Za-z0-9_-]*)$/
const credentialPattern =
  /(?:\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\btid=[^\s;]+;exp=\d+[^\s]*)/

const assertNoSecrets = (
  text: string,
  secrets: ReadonlyArray<string>,
  includesPrompt = false,
): void => {
  if (
    credentialPattern.test(text)
    || (!includesPrompt && /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/.test(text))
    || secrets.some((secret) => secret && text.includes(secret))
  ) {
    throw new TypeError("Probe history refuses credential material")
  }
}

const validateCondition = (
  condition: ProbeCondition,
  secrets: ReadonlyArray<string>,
): void => {
  if (createProbeCondition(condition).id !== condition.id) {
    throw new TypeError("Probe history condition hash mismatch")
  }
  assertNoSecrets(condition.prompt, secrets, true)
}

const optionalRead = async (filePath: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

const optionalEntries = async (directory: string) => {
  try {
    return await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

const parseFile = <T>(
  text: string,
  schema: z.ZodType<T>,
  filePath: string,
): T => {
  try {
    const parsed = schema.safeParse(JSON.parse(text) as unknown)
    if (parsed.success) return parsed.data
  } catch {
    // Parser errors may contain credential material from the input.
  }
  throw new Error(`Invalid probe history file: ${filePath}`)
}

const observationKey = (observation: ProbeObservation): string => {
  const { condition, scores, ...metadata } = observation
  return JSON.stringify({
    conditionId: condition.id,
    ...metadata,
    scores:
      scores === undefined ? undefined : (
        Object.fromEntries(
          Object.entries(scores).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      ),
  })
}

export const openProbeHistory = async ({
  instanceId,
  writer = "runtime",
  root = PATHS.PROBE_HISTORY_DIR,
  secrets = [],
}: {
  instanceId: string
  writer?: string
  root?: string
  secrets?: ReadonlyArray<string>
}): Promise<ProbeHistoryStore> => {
  if (!safeSegment.test(instanceId) || !safeWriter.test(writer)) {
    throw new TypeError(
      "Probe history instance and writer must be safe path segments",
    )
  }
  const instanceDirectory = path.join(root, instanceId)
  const writerDirectory = path.join(instanceDirectory, writer)
  const conditionsPath = path.join(writerDirectory, "conditions.json")
  const conditions = new Map<string, ProbeCondition>()
  const observations = new Map<string, ProbeObservation>()
  const ownedConditions = new Map<string, ProbeCondition>()
  let ownedFile: string | undefined
  const writers = (await optionalEntries(instanceDirectory))
    .filter((entry) => entry.isDirectory() && safeWriter.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of writers) {
    const directory = path.join(instanceDirectory, entry.name)
    const filePath = path.join(directory, "conditions.json")
    const text = await optionalRead(filePath)
    const writerConditions = new Map<string, ProbeCondition>()
    if (text !== undefined) {
      const file = parseFile(text, conditionsFileSchema, filePath)
      if (entry.name === writer) ownedFile = text
      for (const condition of file.conditions) {
        validateCondition(condition, secrets)
        Object.freeze(condition)
        conditions.set(condition.id, condition)
        writerConditions.set(condition.id, condition)
        if (entry.name === writer) ownedConditions.set(condition.id, condition)
      }
    }
    const runsDirectory = path.join(directory, "runs")
    const runs = (await optionalEntries(runsDirectory))
      .filter((run) => run.isFile() && run.name.endsWith(".jsonl"))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const run of runs) {
      const runPath = path.join(runsDirectory, run.name)
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(run.name)) {
        throw new Error(`Invalid probe history file: ${runPath}`)
      }
      const lines = await optionalRead(runPath)
      if (lines === undefined) continue
      for (const line of lines.split("\n")) {
        if (!line) continue
        const record = parseFile(line, runSchema, runPath)
        const { conditionId, ...metadata } = record
        const condition = writerConditions.get(conditionId)
        if (
          condition === undefined
          || !record.observedAt.endsWith("Z")
          || record.observedAt.slice(0, 10) !== run.name.slice(0, 10)
        ) {
          throw new Error(`Invalid probe history file: ${runPath}`)
        }
        assertNoSecrets(JSON.stringify(record), secrets)
        const observation: ProbeObservation = { condition, ...metadata }
        observations.set(observationKey(observation), observation)
      }
    }
  }

  let queue: Promise<void> = Promise.resolve()
  const store: ProbeHistoryStore = {
    conditions: [...conditions.values()],
    observations: [...observations.values()].sort((left, right) =>
      left.observedAt.localeCompare(right.observedAt),
    ),
    async record(input): Promise<void> {
      const parsed = observationSchema.safeParse(input)
      if (!parsed.success) throw new TypeError("Invalid probe observation")
      const observation: ProbeObservation = {
        ...parsed.data,
        observedAt: new Date(parsed.data.observedAt).toISOString(),
      }
      const { condition, ...metadata } = observation
      const run = { conditionId: condition.id, ...metadata }
      validateCondition(condition, secrets)
      assertNoSecrets(JSON.stringify(run), secrets)
      Object.freeze(condition)
      const publication = queue.then(async () => {
        validateCondition(condition, secrets)
        assertNoSecrets(JSON.stringify(run), secrets)
        if ((await optionalRead(conditionsPath)) !== ownedFile) {
          throw new Error(
            `Probe history writer file changed: ${conditionsPath}`,
          )
        }
        await fs.mkdir(writerDirectory, { recursive: true, mode: 0o700 })
        await fs.chmod(writerDirectory, 0o700)
        if (!ownedConditions.has(condition.id)) {
          const next = [...ownedConditions.values(), condition]
          const nextFile = `${JSON.stringify(
            {
              schemaVersion: 1,
              conditions: next,
            },
            null,
            2,
          )}\n`
          writeFileAtomically(conditionsPath, nextFile)
          ownedFile = nextFile
          ownedConditions.set(condition.id, condition)
        }
        if (!conditions.has(condition.id)) {
          conditions.set(condition.id, condition)
          store.conditions.push(condition)
        }
        const runsDirectory = path.join(writerDirectory, "runs")
        await fs.mkdir(runsDirectory, { recursive: true, mode: 0o700 })
        await fs.chmod(runsDirectory, 0o700)
        await fs.appendFile(
          path.join(
            runsDirectory,
            `${observation.observedAt.slice(0, 10)}.jsonl`,
          ),
          `${JSON.stringify(run)}\n`,
          { mode: 0o600 },
        )
        const key = observationKey(observation)
        if (!observations.has(key)) {
          observations.set(key, observation)
          store.observations.push(observation)
        }
      })
      queue = publication.catch((error: unknown) => {
        if (error instanceof TypeError) return
        throw error
      })
      void queue.catch(() => undefined)
      return publication
    },
    flush: () => queue,
  }
  return store
}

export const getRankedProbeConditions = ({
  source,
  conditions,
  observations,
  missingModels,
}: {
  source: ProbeCondition["source"]
  conditions: ReadonlyArray<ProbeCondition>
  observations: ReadonlyArray<ProbeObservation>
  missingModels: ReadonlyArray<string>
}): Array<ProbeCondition> => {
  const missing = new Set(missingModels)
  const relevant = new Set<string>()
  const observed = new Set<string>()
  const candidates = new Map<string, ProbeCondition>()
  for (const condition of conditions) {
    if (condition.source === source) candidates.set(condition.id, condition)
  }
  for (const observation of observations) {
    const condition = observation.condition
    if (condition.source !== source) continue
    observed.add(condition.id)
    if (!candidates.has(condition.id)) candidates.set(condition.id, condition)
    if (
      observation.outcome === "selected"
      && observation.modelIds.some((model) => missing.has(model))
    ) {
      relevant.add(condition.id)
    }
  }
  const historical: Array<ProbeCondition> = []
  const novel: Array<ProbeCondition> = []
  const previous: Array<ProbeCondition> = []
  for (const condition of candidates.values()) {
    if (relevant.has(condition.id)) historical.push(condition)
    else (observed.has(condition.id) ? previous : novel).push(condition)
  }
  const ordinary = [...novel, ...previous]
  const ranked: Array<ProbeCondition> = []
  for (
    let index = 0;
    index < Math.max(historical.length, ordinary.length);
    index += 1
  ) {
    if (historical[index]) ranked.push(historical[index])
    if (ordinary[index]) ranked.push(ordinary[index])
  }
  return ranked
}
