import consola from "consola"
import { readFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import { HARD_QUESTION } from "~/lib/auto-probe-prompts"
import type { AutoSelectionTier } from "~/services/copilot/get-auto-selection"

export interface HardSnippet {
  file: string
  startLine: number
  text: string
}

export interface ProbeSourceLocation {
  file: string
  startLine: 0
  lineCount: number
}

export interface SourceTaskPrompt {
  id:
    | "task-correctness"
    | "task-behavior"
    | "task-cancellation"
    | "task-concurrency"
  tier: Extract<AutoSelectionTier, "balance" | "intelligence">
  prompt: string
  sources: Array<ProbeSourceLocation>
}

const TASK_CONTEXT_FILES = [
  { file: "lib/auth/request-auth.ts", inTests: false },
  { file: "server.ts", inTests: false },
  { file: "lib/config/index.ts", inTests: false },
  { file: "request-auth.test.ts", inTests: true },
] as const

const TASK_BEHAVIOR =
  "Task: 说明这段程序的主要行为、输入、输出和状态变化。仅依据提供的材料，不要求修改代码。"
const TASK_CANCELLATION =
  "Task: 为该模块增加调用方可取消操作的能力，保持现有成功路径、错误传播和资源清理行为。检查已有取消支持；若已满足，指出证据。否则给出完整修改、受影响调用方和验证用例。"
const TASK_CONCURRENCY =
  "Task: 检查并发请求、取消、异常和状态变化的交错。只报告有源码依据的问题；给出能够触发问题的事件顺序、最小修复和区分修复前后行为的验证。证据不足时明确说明。"
const TASK_CORRECTNESS =
  "Task: 完成端到端正确性分析：建立状态模型，追踪跨文件调用关系，检查并发、取消和异常下的不变量；对成立的问题给出完整修复与确定性验证，对无法确认的问题列出缺失证据。不得预设一定存在缺陷。"

const TASKS = [
  {
    id: "task-correctness",
    tier: "intelligence",
    task: TASK_CORRECTNESS,
  },
  { id: "task-behavior", tier: "intelligence", task: TASK_BEHAVIOR },
  { id: "task-cancellation", tier: "balance", task: TASK_CANCELLATION },
  { id: "task-concurrency", tier: "intelligence", task: TASK_CONCURRENCY },
] as const

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT"

const lineCountOf = (text: string): number =>
  text.length === 0 ?
    0
  : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)

const displayPath = (absolutePath: string): string =>
  relative(process.cwd(), absolutePath).split(sep).join("/")

export const createSourceTaskPrompts = async (
  sourceRoot: string,
): Promise<Array<SourceTaskPrompt>> => {
  const testsRoot = resolve(sourceRoot, "..", "tests")
  const files = await Promise.all(
    TASK_CONTEXT_FILES.map(async ({ file, inTests }) => {
      const absolutePath = resolve(inTests ? testsRoot : sourceRoot, file)
      const content = await readFile(absolutePath, "utf8")
      return { absolutePath, content }
    }),
  )
  const body = files
    .map(
      ({ absolutePath, content }) =>
        `File: ${displayPath(absolutePath)}\n\`\`\`typescript\n${content}\n\`\`\`\n`,
    )
    .join("\n")
  const sources = files.map(({ absolutePath, content }) => ({
    file: displayPath(absolutePath),
    startLine: 0 as const,
    lineCount: lineCountOf(content),
  }))
  return TASKS.map(({ id, tier, task }) => ({
    id,
    tier,
    prompt: `${body}\n${task}`,
    sources,
  }))
}

const taskCache = new Map<string, Promise<Array<SourceTaskPrompt>>>()

export const getCachedSourceTaskPrompts = (
  sourceRoot: string,
): Promise<Array<SourceTaskPrompt>> => {
  const key = resolve(sourceRoot)
  const existing = taskCache.get(key)
  if (existing !== undefined) return existing
  const pending = createSourceTaskPrompts(key).catch((error: unknown) => {
    if (isEnoent(error)) {
      consola.warn("[auto-session] source tasks skipped: ENOENT")
      return []
    }
    taskCache.delete(key)
    throw error
  })
  taskCache.set(key, pending)
  return pending
}

export const createHardPrompt = (snippet: HardSnippet): string =>
  `${snippet.text}\n\n${HARD_QUESTION}`

type Rng = (maxExclusive: number) => number
const defaultRng: Rng = (maxExclusive) =>
  Math.floor(Math.random() * maxExclusive)

type SnippetFile = { file: string; lines: Array<string> }

const collectSnippetFiles = async (
  rootDir: string,
  exclude?: HardSnippet,
): Promise<Array<SnippetFile>> => {
  const glob = new Bun.Glob("**/*.ts")
  const files: Array<SnippetFile> = []
  for await (const relativeFile of glob.scan(rootDir)) {
    if (relativeFile.endsWith(".test.ts") || relativeFile.endsWith(".d.ts"))
      continue
    const file = join(rootDir, relativeFile)
    const lines = readFileSync(file, "utf8").split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    if (lines.length < 100) continue
    if (exclude?.file === file && lines.length - 100 + 1 === 1) continue
    files.push({ file, lines })
  }
  return files
}

const pickHardSnippet = ({
  files,
  rng,
  exclude,
}: {
  files: ReadonlyArray<SnippetFile>
  rng: Rng
  exclude?: HardSnippet
}): HardSnippet | undefined => {
  if (files.length === 0) return undefined
  const picked = files[rng(files.length)]
  const windows = picked.lines.length - 100 + 1
  const excludedStart =
    exclude?.file === picked.file && exclude.startLine < windows ?
      exclude.startLine
    : -1
  const available = windows - (excludedStart >= 0 ? 1 : 0)
  if (available <= 0) return undefined
  let startLine = rng(available)
  if (excludedStart >= 0 && startLine >= excludedStart) startLine += 1
  return {
    file: picked.file,
    startLine,
    text: picked.lines.slice(startLine, startLine + 100).join("\n"),
  }
}

// Uniformly choose a file, then a 100-line window.
export const sampleHardSnippet = async (
  rootDir: string = resolve(process.cwd(), "src"),
  rng: Rng = defaultRng,
  exclude?: HardSnippet,
): Promise<HardSnippet | undefined> => {
  try {
    await stat(rootDir)
    const files = await collectSnippetFiles(rootDir, exclude)
    return pickHardSnippet({ files, rng, exclude })
  } catch (error) {
    if (!isEnoent(error)) throw error
    consola.warn("[auto-session] source sampling skipped: ENOENT")
    return undefined
  }
}
