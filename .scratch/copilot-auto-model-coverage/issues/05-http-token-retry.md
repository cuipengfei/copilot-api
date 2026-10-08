# 05: HTTP 令牌失效后恢复请求

Status: ready-for-human
Blocked by: 04 令牌到期及凭据变化后保持正确配对

**What to build:** HTTP 推理请求实际附带 Auto 会话令牌并收到 400/401 时，使对应配对失效并为原模型重试一次。其他请求沿用原有错误处理，整项功能完成后同步现行 OpenSpec 规范。

## Acceptance criteria

- [x] 只有本次请求已附 Auto 令牌且上游返回 400/401 时才使配对失效并重试一次；不检查错误正文决定是否重试。
- [x] 重试保持原模型 ID；第二次仍失败时按原有错误路径返回。未附令牌、其他状态码或 WebSocket 请求不触发该 Auto 重试。
- [x] 系统实际调用 `/auto` 重新取得且重取失败时，将刷新错误传出并停止本次请求，不发第二次推理；旧 401 迟到且配对已被并发清除、无需重取时，仍为原模型无 token 重试一次。
- [x] 在受支持的 HTTP 路径中验证请求头、模型 ID、响应和错误传播；开启与关闭 `-F` 均符合规格。
- [x] 现行 OpenSpec 规范更新为实际支持的 Auto 行为，不保留与新行为冲突的旧要求；现有成本计算保持上游折后数据。
- [ ] 完成仓库规定的全量 lint、build、test 和 typecheck；真实 business 账户的验收须另行获得明确授权。

**规格：** [Copilot Auto 模型覆盖与会话迁移](../spec.md)

## Comments

- 2026-10-08：本地验证通过——1974 tests pass/0 fail/0 skip（隔离沙盒），build/tsc/非修改 lint 全绿。AC15 为合并条款维持不勾：全量 lint/build/test/typecheck 已过，但 `bun run lint:all --fix` 因用户禁止程序化改源码未执行，且真实 business 账户验收未获授权。85% 覆盖率未验证，Bun 原生报告不满足阈值（`src/lib/auto-session.ts` 全量 58.37% lines，存在动态 import 多实例合并疑问）。本工单不写已全部完成，转 ready-for-human 待人工验收与上游授权。
