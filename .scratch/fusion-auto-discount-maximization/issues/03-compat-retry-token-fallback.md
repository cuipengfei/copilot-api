# 03: 二层兼容重发接入会话令牌降级链

Status: ready-for-human
Blocked by: None

**What to build:** 将 `/responses` 在剥离 `reasoning.encrypted_content` 后的重发，以及 `/v1/messages` 在调整 `output_config.effort` 或剥离 `thinking` 块后的重发，统一从裸 `sendCopilotHttpRequest` 改为调用带会话令牌降级保护的 `sendCopilotRequest`。

## Acceptance criteria

- [x] `sendResponsesRequestWithReasoningReplay` 在遇到 `belong` 错误剥离加密思考内容重发时，通过 `sendCopilotRequest` 发送，若该次重发遇到会话令牌被拒（`400`/`401`），自动按 `30% → 10% → 0%` 降级重发。
- [x] `sendWithSignatureRetry` 在遇到 `invalid_reasoning_effort` 或 `thinking` 块错误修改请求体重发时，通过 `sendCopilotRequest` 发送，若该次重发遇到会话令牌被拒，按该端点已有的合法配对恢复；当前 native Messages 使用 Auto 10% 凭据，被拒后移除 token 按原价重发。
- [x] 补充回归测试覆盖六种场景：Responses 兼容重发在有或无缓存的 Auto fallback 时遭遇会话令牌拒绝（两种场景），以及两条 Messages 兼容重发路径各自遭遇会话令牌拒绝 HTTP 400 或 401（四种场景）；恢复重发过程中均保留修正后的请求体。

**规格：** [Copilot Fusion 与 Auto 折扣覆盖最大化规格](../spec.md)
