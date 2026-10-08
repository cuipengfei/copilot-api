# 01: 指定模型使用 `/auto` 配对

Status: ready-for-human
Blocked by: None

**What to build:** 服务从 `/auto` 取得并校验 `selected_model.id`、`session_token` 与 `expires_at`，按实际模型 ID 保存有效配对。客户端请求的模型 ID 保持不变；命中配对且上游 HTTP 端点适用时附带 `Copilot-Session-Token`。未命中或端点不适用时继续正常发送请求，开启或关闭 `-F` 均适用。

## Acceptance criteria

- [x] `/auto` 使用现有 Copilot 身份信息、API 版本和 JSON `content-type`；无效响应不能进入配对表，旧 `/models/session` 停止承担配对构建职责。
- [x] 完整 Copilot 请求路径可观察最终模型 ID、HTTP 端点和会话令牌请求头；配对命中与未命中、开启与关闭 `-F` 均符合规格。
- [x] 多个探测结果选中同一模型时只保留一份有效配对；令牌只能用于其对应的实际模型 ID。
- [x] 成本继续使用上游提供的折后 nano 单位数据，不再次使用 `discounted_costs` 计算折扣。
- [x] 迁移旧端点测试断言；新增验证遵守规格规定的真实请求与确定性处理测试边界。

**规格：** [Copilot Auto 模型覆盖与会话迁移](../spec.md)

## Comments

- 2026-10-08：本地验证通过——1974 tests pass/0 fail/0 skip（隔离沙盒），build/tsc/非修改 lint 全绿；`bun run lint:all --fix` 因用户禁止程序化改源码未执行。真实 business 上游未获授权。85% 覆盖率未验证，Bun 原生报告不满足阈值（`src/lib/auto-session.ts` 全量 58.37% lines，存在动态 import 多实例合并疑问）。本地验收项已勾选，转 ready-for-human 待人工验收与上游授权。
