// Fixed 12-case prompt set for `--variety` probing of POST /auto selection.
// P6 first: the full 4-file request-auth context x intelligence once selected Astra in a validation window (cannot be forced); task cases re-read those files fresh each run, hard cases carry sampled real 100-line snippets.

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"

import {
  HARD_QUESTION,
  PREWARM_PROMPT,
  TARGET_CODE_PROMPT,
} from "../../../../src/lib/auto-probe-prompts.ts"
import { sampleHardSnippet } from "../../../../src/lib/auto-session.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../../../..")
const DEFAULT_SOURCE_ROOT = resolve(REPO_ROOT, "src")

const TINY_PROMPT = "Reply with exactly: hi."

// 四个 task case 共用的完整跨文件上下文（相对 sourceRoot；tests 在 sourceRoot 的兄弟目录）
const TASK_CONTEXT_FILES = [
  { file: "lib/request-auth.ts", inTests: false },
  { file: "server.ts", inTests: false },
  { file: "lib/config.ts", inTests: false },
  { file: "request-auth.test.ts", inTests: true },
]

/**
 * @typedef {Object} VarietySource
 * @property {string} file repo 相对路径（相对 REPO_ROOT，避免输出绝对个人路径）
 * @property {number} startLine 0 起点行号
 * @property {number} lineCount 行数（hard 片段恒为 100；跨文件 task 为文件实际行数）
 */

/**
 * @typedef {Object} VarietyCase
 * @property {string} id 固定 case 标识
 * @property {"efficiency"|"balance"|"intelligence"|"fast"} tier 探测档位
 * @property {string} prompt 上送 /auto 的完整题目（hard/task 含真实源码）
 * @property {string} prompt_sha256 prompt 的 SHA-256（hex），供跨轮追溯比对，不打印正文
 * @property {VarietySource=} source 仅 hard case 携带 100 行片段出处
 * @property {Array<VarietySource>=} sources 仅跨文件 task case 携带各完整文件出处
 */

// 四个任务探测的固定任务措辞，保持稳定便于跨轮比较
const TASK_BEHAVIOR =
  "Task: 说明这段程序的主要行为、输入、输出和状态变化。仅依据提供的材料，不要求修改代码。"
const TASK_CANCELLATION =
  "Task: 为该模块增加调用方可取消操作的能力，保持现有成功路径、错误传播和资源清理行为。检查已有取消支持；若已满足，指出证据。否则给出完整修改、受影响调用方和验证用例。"
const TASK_CONCURRENCY =
  "Task: 检查并发请求、取消、异常和状态变化的交错。只报告有源码依据的问题；给出能够触发问题的事件顺序、最小修复和区分修复前后行为的验证。证据不足时明确说明。"
const TASK_CORRECTNESS =
  "Task: 完成端到端正确性分析：建立状态模型，追踪跨文件调用关系，检查并发、取消和异常下的不变量；对成立的问题给出完整修复与确定性验证，对无法确认的问题列出缺失证据。不得预设一定存在缺陷。"

const HARD_TIERS = ["efficiency", "balance", "intelligence", "fast"]
// 有历史命中的优先条件：P6 完整上下文 × intelligence 曾选中 Astra（不能强制），排最前
const FIRST_TASK_CASE = {
  id: "task-correctness",
  tier: "intelligence",
  task: TASK_CORRECTNESS,
}
const TASK_CASES = [
  { id: "task-behavior", tier: "intelligence", task: TASK_BEHAVIOR },
  { id: "task-cancellation", tier: "balance", task: TASK_CANCELLATION },
  { id: "task-concurrency", tier: "intelligence", task: TASK_CONCURRENCY },
]

const toSource = (snippet) => ({
  file: relative(REPO_ROOT, snippet.file).split(sep).join("/"),
  startLine: snippet.startLine,
  lineCount: snippet.text.split("\n").length,
})

const lineCountOf = (text) =>
  text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)

const displayPath = (absolutePath) =>
  relative(REPO_ROOT, absolutePath).split(sep).join("/")

const mustTaskFiles = async (sourceRoot) => {
  const testsRoot = resolve(sourceRoot, "..", "tests")
  return Promise.all(
    TASK_CONTEXT_FILES.map(async ({ file, inTests }) => {
      const absolutePath = resolve(inTests ? testsRoot : sourceRoot, file)
      let content
      try {
        content = await readFile(absolutePath, "utf8")
      } catch {
        throw new Error(`auto-variety: unable to read ${absolutePath}`)
      }
      return {
        path: displayPath(absolutePath),
        content,
        lineCount: lineCountOf(content),
      }
    }),
  )
}

const mustSample = async (sourceRoot) => {
  const snippet = await sampleHardSnippet(sourceRoot)
  if (!snippet) {
    throw new Error(
      "auto-variety: unable to sample a 100-line TypeScript snippet from the source root",
    )
  }
  return snippet
}

/**
 * 返回固定 12 条探测条件；任何片段/文件缺失即抛错，绝不退回裸 HARD_QUESTION
 * 顺序：task-correctness（历史 P6 命中条件）最先，随后 prewarm/tiny/target/hard
 * 四档，其余三个 task 按既有稳定 id 收尾
 * @param {{sourceRoot?: string}=} options sourceRoot 缺省为 repo 的 src 绝对路径
 * @returns {Promise<Array<VarietyCase>>} 固定顺序的 12 条 case，每条带 prompt_sha256
 */
export const createVarietyCases = async ({
  sourceRoot = DEFAULT_SOURCE_ROOT,
} = {}) => {
  const [hardSnippets, taskFiles] = await Promise.all([
    Promise.all(HARD_TIERS.map(() => mustSample(sourceRoot))),
    mustTaskFiles(sourceRoot),
  ])
  const taskBody = taskFiles
    .map(({ path, content }) => `File: ${path}\n\`\`\`typescript\n${content}\n\`\`\`\n`)
    .join("\n")
  const taskSources = taskFiles.map(({ path, lineCount }) => ({
    file: path,
    startLine: 0,
    lineCount,
  }))
  const withHash = (fields) => ({
    ...fields,
    prompt_sha256: createHash("sha256").update(fields.prompt).digest("hex"),
  })
  const taskCase = ({ id, tier, task }) =>
    withHash({
      id,
      tier,
      prompt: `${taskBody}\n${task}`,
      sources: taskSources,
    })

  const cases = [
    taskCase(FIRST_TASK_CASE),
    withHash({ id: "prewarm", tier: "efficiency", prompt: PREWARM_PROMPT }),
    withHash({ id: "tiny", tier: "fast", prompt: TINY_PROMPT }),
    withHash({ id: "target-balance", tier: "balance", prompt: TARGET_CODE_PROMPT }),
    withHash({ id: "target-fast", tier: "fast", prompt: TARGET_CODE_PROMPT }),
  ]
  for (const [index, tier] of HARD_TIERS.entries()) {
    const snippet = hardSnippets[index]
    cases.push(
      withHash({
        id: `hard-${tier}`,
        tier,
        prompt: `${snippet.text}\n\n${HARD_QUESTION}`,
        source: toSource(snippet),
      }),
    )
  }
  for (const taskDef of TASK_CASES) {
    cases.push(taskCase(taskDef))
  }
  return cases
}
