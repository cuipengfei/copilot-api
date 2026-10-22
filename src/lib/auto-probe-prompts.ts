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
