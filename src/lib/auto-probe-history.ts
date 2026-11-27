import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import {
  createProbeCondition,
  pairingSourceForProbe,
  type ProbeCondition,
  type ProbeDiscountSource,
} from "~/lib/auto-probe-prompts"
import { writeFileAtomically } from "~/lib/storage/atomic-file"
import { PATHS } from "~/lib/storage/paths"

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

const ordinaryAutoConditionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.literal("auto"),
  tier: z.enum(["efficiency", "balance", "intelligence", "fast"]),
  fusion: z.undefined().optional(),
  expectedDiscount: z.literal(10).default(10),
  prompt: z.string(),
})
const fusionStandardConditionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.literal("auto"),
  tier: z.enum(["balance", "intelligence", "fast"]),
  fusion: z.literal(true),
  expectedDiscount: z.union([z.literal(10), z.literal(30)]).default(30),
  prompt: z.string(),
})
const fusionConditionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.literal("fusion"),
  planVersion: z.enum(["1", "2"]),
  fusionMode: z.enum(["hydrafusion", "hydrafusion-max"]),
  expectedDiscount: z.union([z.literal(10), z.literal(30)]).default(30),
  prompt: z.string(),
})
const conditionSchema = z.union([
  ordinaryAutoConditionSchema,
  fusionStandardConditionSchema,
  fusionConditionSchema,
])
const supportsProbePlan = (condition: ProbeCondition): boolean =>
  condition.source !== "fusion"
  || condition.fusionMode !== "hydrafusion-max"
  || condition.planVersion === "1"

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
  condition: conditionSchema.refine(supportsProbePlan),
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
      z
        .union([
          ordinaryAutoConditionSchema.strict(),
          fusionStandardConditionSchema.strict(),
          fusionConditionSchema.strict(),
        ])
        .refine(supportsProbePlan),
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

const readWriterConditions = async (
  filePath: string,
  secrets: ReadonlyArray<string>,
) => {
  const text = await optionalRead(filePath)
  const conditions = new Map<string, ProbeCondition>()
  if (text === undefined) return { conditions, text }
  const file = parseFile(text, conditionsFileSchema, filePath)
  for (const condition of file.conditions) {
    validateCondition(condition, secrets)
    Object.freeze(condition)
    conditions.set(condition.id, condition)
  }
  return { conditions, text }
}

const readRunFile = async ({
  runPath,
  runName,
  conditions,
  observations,
  secrets,
}: {
  runPath: string
  runName: string
  conditions: ReadonlyMap<string, ProbeCondition>
  observations: Map<string, ProbeObservation>
  secrets: ReadonlyArray<string>
}): Promise<void> => {
  if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(runName)) {
    throw new Error(`Invalid probe history file: ${runPath}`)
  }
  const lines = await optionalRead(runPath)
  if (lines === undefined) return
  for (const line of lines.split("\n")) {
    if (!line) continue
    const record = parseFile(line, runSchema, runPath)
    const { conditionId, ...metadata } = record
    const condition = conditions.get(conditionId)
    if (
      condition === undefined
      || !record.observedAt.endsWith("Z")
      || record.observedAt.slice(0, 10) !== runName.slice(0, 10)
    ) {
      throw new Error(`Invalid probe history file: ${runPath}`)
    }
    assertNoSecrets(JSON.stringify(record), secrets)
    const observation: ProbeObservation = { condition, ...metadata }
    observations.set(observationKey(observation), observation)
  }
}

const readWriterRuns = async ({
  directory,
  conditions,
  observations,
  secrets,
}: {
  directory: string
  conditions: ReadonlyMap<string, ProbeCondition>
  observations: Map<string, ProbeObservation>
  secrets: ReadonlyArray<string>
}): Promise<void> => {
  const runsDirectory = path.join(directory, "runs")
  const runs = (await optionalEntries(runsDirectory))
    .filter((run) => run.isFile() && run.name.endsWith(".jsonl"))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const run of runs) {
    await readRunFile({
      runPath: path.join(runsDirectory, run.name),
      runName: run.name,
      conditions,
      observations,
      secrets,
    })
  }
}

const readHistory = async ({
  instanceDirectory,
  writer,
  secrets,
}: {
  instanceDirectory: string
  writer: string
  secrets: ReadonlyArray<string>
}) => {
  const conditions = new Map<string, ProbeCondition>()
  const observations = new Map<string, ProbeObservation>()
  let ownedConditions = new Map<string, ProbeCondition>()
  let ownedFile: string | undefined
  const writers = (await optionalEntries(instanceDirectory))
    .filter((entry) => entry.isDirectory() && safeWriter.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of writers) {
    const directory = path.join(instanceDirectory, entry.name)
    const loaded = await readWriterConditions(
      path.join(directory, "conditions.json"),
      secrets,
    )
    if (entry.name === writer) {
      ownedFile = loaded.text
      ownedConditions = loaded.conditions
    }
    for (const condition of loaded.conditions.values()) {
      conditions.set(condition.id, condition)
    }
    await readWriterRuns({
      directory,
      conditions: loaded.conditions,
      observations,
      secrets,
    })
  }
  return { conditions, observations, ownedConditions, ownedFile }
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
  const history = await readHistory({ instanceDirectory, writer, secrets })
  const { conditions, observations, ownedConditions } = history
  let ownedFile = history.ownedFile

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

const collectObservedConditions = ({
  source,
  observations,
  missing,
  candidates,
}: {
  source: ProbeDiscountSource
  observations: ReadonlyArray<ProbeObservation>
  missing: ReadonlySet<string>
  candidates: Map<string, ProbeCondition>
}) => {
  const relevant = new Set<string>()
  const observed = new Set<string>()
  for (const observation of observations) {
    const condition = observation.condition
    if (pairingSourceForProbe(condition) !== source) continue
    observed.add(condition.id)
    if (!candidates.has(condition.id)) candidates.set(condition.id, condition)
    if (
      observation.outcome === "selected"
      && observation.modelIds.some((model) => missing.has(model))
    ) {
      relevant.add(condition.id)
    }
  }
  return { relevant, observed }
}

const interleaveProbeConditions = (
  historical: ReadonlyArray<ProbeCondition>,
  ordinary: ReadonlyArray<ProbeCondition>,
): Array<ProbeCondition> => {
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

export const getRankedProbeConditions = ({
  source,
  conditions,
  observations,
  missingModels,
}: {
  source: ProbeDiscountSource
  conditions: ReadonlyArray<ProbeCondition>
  observations: ReadonlyArray<ProbeObservation>
  missingModels: ReadonlyArray<string>
}): Array<ProbeCondition> => {
  const missing = new Set(missingModels)
  const candidates = new Map<string, ProbeCondition>()
  for (const condition of conditions) {
    if (pairingSourceForProbe(condition) === source)
      candidates.set(condition.id, condition)
  }
  const { relevant, observed } = collectObservedConditions({
    source,
    observations,
    missing,
    candidates,
  })
  const historical: Array<ProbeCondition> = []
  const novel: Array<ProbeCondition> = []
  const previous: Array<ProbeCondition> = []
  for (const condition of candidates.values()) {
    if (relevant.has(condition.id)) historical.push(condition)
    else (observed.has(condition.id) ? previous : novel).push(condition)
  }
  return interleaveProbeConditions(historical, [...novel, ...previous])
}
