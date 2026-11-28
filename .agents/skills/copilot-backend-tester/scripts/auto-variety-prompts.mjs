// 固定 intelligence 输入优先；task 保留完整跨文件上下文，hard 仍采样真实 100 行源码。

import { createHash } from "node:crypto"
import { relative, resolve, sep } from "node:path"
import {
  createProbeCondition,
  getIntelligenceProbePrompt,
  getProbeConditions,
  PREWARM_PROMPT,
  TARGET_CODE_PROMPT,
} from "../../../../src/lib/auto-probe-prompts.ts"
import {
  createHardPrompt,
  createSourceTaskPrompts,
  sampleHardSnippet,
} from "../../../../src/lib/auto-probe-source-prompts.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../../../..")
const DEFAULT_SOURCE_ROOT = resolve(REPO_ROOT, "src")

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
 * @property {import("../../../../src/lib/auto-probe-prompts.ts").ProbeCondition} condition 完整共享探测条件
 */

const HARD_TIERS = ["efficiency", "balance", "intelligence", "fast"]

const toSource = (snippet) => ({
  file: relative(REPO_ROOT, snippet.file).split(sep).join("/"),
  startLine: snippet.startLine,
  lineCount: snippet.text.split("\n").length,
})

const mustTaskPrompts = async (sourceRoot) => {
  try {
    return await createSourceTaskPrompts(sourceRoot)
  } catch (error) {
    throw new Error(`auto-variety: unable to read ${sourceRoot}`, {
      cause: error,
    })
  }
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
 * 返回同一数组中的共享固定条件与真实源码条件。任何片段或文件缺失即抛错。
 * @param {{sourceRoot?: string, includeShared?: boolean}=} options sourceRoot 缺省为 repo 的 src 绝对路径
 * @returns {Promise<Array<VarietyCase>>} 带完整 ProbeCondition 的探测 case
 */
export const createVarietyCases = async ({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  includeShared = true,
} = {}) => {
  const [hardSnippets, taskPrompts] = await Promise.all([
    Promise.all(HARD_TIERS.map(() => mustSample(sourceRoot))),
    mustTaskPrompts(sourceRoot),
  ])
  if (taskPrompts.length === 0) {
    throw new Error(
      `auto-variety: required source task prompts are missing from ${sourceRoot}`,
    )
  }
  const [correctnessTask, ...remainingTasks] = taskPrompts
  const withHash = (fields) => ({
    ...fields,
    condition: createProbeCondition({
      source: "auto",
      tier: fields.tier,
      prompt: fields.prompt,
    }),
    prompt_sha256: createHash("sha256").update(fields.prompt).digest("hex"),
  })
  const taskCase = ({ id, tier, prompt, sources }) =>
    withHash({ id, tier, prompt, sources })

  const cases = [
    withHash({
      id: "intelligence-verified",
      tier: "intelligence",
      prompt: getIntelligenceProbePrompt(),
    }),
    taskCase(correctnessTask),
    withHash({ id: "prewarm", tier: "efficiency", prompt: PREWARM_PROMPT }),
    withHash({
      id: "target-balance",
      tier: "balance",
      prompt: TARGET_CODE_PROMPT,
    }),
    withHash({
      id: "target-fast",
      tier: "fast",
      prompt: TARGET_CODE_PROMPT,
    }),
  ]
  for (const [index, tier] of HARD_TIERS.entries()) {
    const snippet = hardSnippets[index]
    cases.push(
      withHash({
        id: `hard-${tier}`,
        tier,
        prompt: createHardPrompt(snippet),
        source: toSource(snippet),
      }),
    )
  }
  for (const task of remainingTasks) {
    cases.push(taskCase(task))
  }
  if (!includeShared) return cases
  const known = new Set(cases.map((entry) => entry.condition.id))
  for (const condition of getProbeConditions()) {
    if (
      condition.source !== "auto"
      || condition.fusion === true
      || known.has(condition.id)
    )
      continue
    known.add(condition.id)
    cases.push(
      withHash({
        id: `shared:${condition.id.slice(0, 12)}`,
        tier: condition.tier,
        prompt: condition.prompt,
      }),
    )
  }
  return cases
}
