import { createHash } from "node:crypto"

import type { AutoSelectionTier } from "~/services/copilot/get-auto-selection"
import type { FusionMode } from "~/services/copilot/get-fusion-selection"

import { getConfig } from "~/lib/config/config-store"

import probeSample from "~/lib/auto-probe-sample.json"

// 探测文本保持固定；intelligence 使用已验证的真实源码快照与相关题面变体。
export const PREWARM_PROMPT = "hello"
export const HARD_QUESTION =
  "请指出这段代码中最可能的正确性问题，以及确认该问题所需的信息。"
export const TARGET_CODE_PROMPT =
  "Write a TypeScript function that normalizes URL paths, with tests for root, duplicate slashes, and trailing slashes."

const CONCURRENCY_QUESTION =
  "以提供的真实 TypeScript 源码为起点，完成并发与异常恢复问题的调查和完整修复。检验以下假设时序是否适用于真实实现：请求 A 启动共享异步操作，请求 B 加入等待，A 取消等待，凭据轮换，请求 C 建立同名新操作，旧操作完成后的 finally 清理误删 C，超时重试又重复提交已经成功的副作用。使用文件读取与代码检索工具确认全部调用方，使用终端命令运行确定性复现程序，并通过调试器检查暂停位置的状态。对于有证据的问题，交付可直接运行的完整 TypeScript 修复代码、全部受影响调用方以及控制每个暂停位置的并发回归测试，不能省略辅助函数。执行测试与类型检查，检查失败并完成修复。建立精确状态机，给出线性化点，证明状态与等待者数量守恒、提交幂等、取消互不干扰，以及异常和恢复边界下的安全性与活性。明确说明假设中不适用的部分，不得编造生产事故。"
const FAILURE_TRACE =
  "复现时请逐步记录 T0 创建共享操作、T1 第二个等待者加入、T2 首个等待者取消、T3 凭据轮换、T4 创建替代操作、T5 旧操作 finally 清理和 T6 超时重试的完整状态变化，"
const INTELLIGENCE_PROMPTS = [
  "用受控 Promise 调度器确定触发条件，逐行解释根因并交付完整修复代码。",
  "用受控 Promise 调度器逐步验证取消隔离、等待者数量守恒和恰好一次终态通知，交付完整修复代码及与每个不变量对应的回归测试。",
  "用受控 Promise 调度器逐步验证凭据轮换、陈旧回调清理和重复提交的异常恢复边界，交付完整修复代码及对应的确定性回归测试。",
].map(
  (verification) =>
    `${CONCURRENCY_QUESTION}${FAILURE_TRACE}${verification}\n\n${probeSample.text}`,
)

export const getIntelligenceProbePrompt = (attempt = 0): string =>
  INTELLIGENCE_PROMPTS[attempt % INTELLIGENCE_PROMPTS.length]

const SEED_PROMPTS = [
  PREWARM_PROMPT,
  "Write a CSS rule to center a div using flexbox.",
  TARGET_CODE_PROMPT,
  getIntelligenceProbePrompt(),
]

export type FusionPlanVersion = "1" | "2"
export type ExpectedDiscount = 10 | 30
export type ProbeDiscountSource = "fusion" | "auto"

export const pairingSourceForProbe = (probe: {
  expectedDiscount: ExpectedDiscount
}): ProbeDiscountSource => (probe.expectedDiscount === 30 ? "fusion" : "auto")

export type FusionStandardTier = Exclude<AutoSelectionTier, "efficiency">

export type AutoProbeConditionInput = {
  source: "auto"
  tier: AutoSelectionTier
  prompt: string
  fusion?: undefined
  expectedDiscount?: 10
}
export type FusionStandardProbeConditionInput = {
  source: "auto"
  tier: FusionStandardTier
  prompt: string
  fusion: true
  expectedDiscount?: ExpectedDiscount
}
export type FusionProbeConditionInput = {
  source: "fusion"
  planVersion: FusionPlanVersion
  fusionMode: FusionMode
  prompt: string
  expectedDiscount?: ExpectedDiscount
}
export type ProbeConditionInput =
  | AutoProbeConditionInput
  | FusionStandardProbeConditionInput
  | FusionProbeConditionInput

export type ProbeCondition = ProbeConditionInput & {
  id: string
  expectedDiscount: ExpectedDiscount
}

function completeProbeCondition<
  T extends ProbeConditionInput & { expectedDiscount: ExpectedDiscount },
>(parameters: T, tuple: Array<string | number | boolean>): T & { id: string } {
  const id = createHash("sha256").update(JSON.stringify(tuple)).digest("hex")
  return { ...parameters, id }
}

export function createProbeCondition(
  input: AutoProbeConditionInput,
): AutoProbeConditionInput & { id: string; expectedDiscount: 10 }
export function createProbeCondition(
  input: FusionStandardProbeConditionInput,
): FusionStandardProbeConditionInput & {
  id: string
  expectedDiscount: ExpectedDiscount
}
export function createProbeCondition(
  input: FusionProbeConditionInput,
): FusionProbeConditionInput & {
  id: string
  expectedDiscount: ExpectedDiscount
}
export function createProbeCondition(input: ProbeConditionInput): ProbeCondition
export function createProbeCondition(
  input: ProbeConditionInput,
): ProbeCondition {
  if (input.source === "auto") {
    if (!input.fusion) {
      const parameters = {
        source: input.source,
        tier: input.tier,
        prompt: input.prompt,
        expectedDiscount: 10 as const,
      }
      return completeProbeCondition(parameters, [
        "auto",
        input.tier,
        input.prompt,
      ])
    }
    if ((input.tier as AutoSelectionTier) === "efficiency") {
      throw new TypeError(
        "Fusion Standard does not support the efficiency tier",
      )
    }
    const expectedDiscount = input.expectedDiscount ?? 30
    const parameters = {
      source: input.source,
      tier: input.tier,
      prompt: input.prompt,
      fusion: true as const,
      expectedDiscount,
    }
    return completeProbeCondition(parameters, [
      "auto",
      input.tier,
      input.prompt,
      true,
      expectedDiscount,
    ])
  }

  if (input.fusionMode === "hydrafusion-max" && input.planVersion !== "1") {
    throw new TypeError("Max Fusion only supports plan version 1")
  }
  const expectedDiscount = input.expectedDiscount ?? 30
  const parameters = {
    source: input.source,
    fusionMode: input.fusionMode,
    planVersion: input.planVersion,
    prompt: input.prompt,
    expectedDiscount,
  }
  const tuple: Array<string | number | boolean> = [
    "fusion",
    input.fusionMode,
    input.planVersion,
    input.prompt,
  ]
  if (input.fusionMode !== "hydrafusion" || expectedDiscount !== 30) {
    tuple.push(expectedDiscount)
  }
  return completeProbeCondition(parameters, tuple)
}

const VARIETY_PROMPTS = [
  "Write a Python script that reads a CSV file, groups rows by customer, sums the amounts and writes a JSON report. Provide the full executable script and tests.",
  "The production C++ process crashes in free() after a concurrent update. AddressSanitizer reports heap-use-after-free at reclaim_node, ThreadSanitizer reports a race between clear_hazard and delete_node, and gdb shows the hazard record still points to a freed node. Determine the exact causality and memory-model violation, reproduce the bug deterministically, prove a correct repair and implement exhaustive regression tests.",
  "Implement a TypeScript LRU cache with positive capacity, get and set, O(1) operations, replacement of existing keys, and least-recently-used eviction. Include executable assertions for eviction and updates.",
  "Prove that every finite integral domain is a field. Give a complete proof without writing code.",
  "Write a complete implementation and tests for a Python function that adds two integers. Do not reason or explain. Generate only source code and tests.",
]

const SHARED_PROMPTS = [
  ...new Set([...SEED_PROMPTS, ...INTELLIGENCE_PROMPTS, ...VARIETY_PROMPTS]),
]
export const createProbeConditionsForPrompt = (
  prompt: string,
  tiers: ReadonlyArray<AutoSelectionTier> = [
    "efficiency",
    "balance",
    "intelligence",
    "fast",
  ],
): Array<ProbeCondition> => [
  ...tiers.map((tier) =>
    createProbeCondition({ source: "auto", tier, prompt }),
  ),
  ...tiers
    .filter((tier): tier is FusionStandardTier => tier !== "efficiency")
    .map((tier) =>
      createProbeCondition({ source: "auto", tier, fusion: true, prompt }),
    ),
  ...(["1", "2"] as const).map((planVersion) =>
    createProbeCondition({
      source: "fusion",
      planVersion,
      fusionMode: "hydrafusion",
      prompt,
    }),
  ),
  createProbeCondition({
    source: "fusion",
    planVersion: "1",
    fusionMode: "hydrafusion-max",
    prompt,
  }),
]

const CONDITIONS = SHARED_PROMPTS.flatMap((prompt) =>
  createProbeConditionsForPrompt(prompt),
)

export const getProbeConditions = (): Array<ProbeCondition> =>
  CONDITIONS.map((condition) => ({ ...condition }))

export const parseAutoDiscoveryModels = (discovery: unknown): Array<string> => {
  if (discovery === undefined) return []
  if (
    discovery === null
    || typeof discovery !== "object"
    || Array.isArray(discovery)
  ) {
    throw new TypeError("autoDiscovery must be an object")
  }
  const models = "models" in discovery ? discovery.models : undefined
  if (models === undefined) return []
  if (
    !Array.isArray(models)
    || models.some(
      (model: unknown) => typeof model !== "string" || !model.trim(),
    )
  ) {
    throw new TypeError("autoDiscovery.models must contain nonempty model IDs")
  }
  return [...new Set<string>(models)]
}

export const getWantedModels = (): Array<string> =>
  parseAutoDiscoveryModels(getConfig().autoDiscovery)
