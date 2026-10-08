# 02: 启动时发现更多模型

Status: ready-for-human
Blocked by: 01 指定模型使用 `/auto` 配对

**What to build:** 启动时针对 `efficiency`、`balance`、`intelligence`、`fast` 分别发送简单题与难题。简单题为 `hello`；难题使用当前源码树中随机选取的连续 100 行 TypeScript 代码，请求指出正确性问题和需要确认的信息。把每次成功响应按实际模型 ID 纳入可用配对。

## Acceptance criteria

- [x] 四档各两种题目均发起探测；同档简单题失败时仍尝试难题。
- [x] 同档两题选中相同模型时，仅对难题重新取样并再探测一次；重试结果按上游实际选择登记，不预设模型等级。
- [x] 重复模型合并为一份有效配对，成功的配对立即可供请求使用；启动日志仅展示去重后的模型 ID。
- [x] 没有符合要求的源码时报告未完成探测，正常请求路径保持可用；日志不包含凭据、会话令牌或抽样代码。
- [ ] 获得真实上游调用授权后，记录探测条件、结果与观测时间；不把具体模型名写成固定断言。

**规格：** [Copilot Auto 模型覆盖与会话迁移](../spec.md)

## Comments

- 2026-10-08：本地验证通过——1974 tests pass/0 fail/0 skip（隔离沙盒），build/tsc/非修改 lint 全绿；`bun run lint:all --fix` 因用户禁止程序化改源码未执行。AC14（真实上游调用授权后记录探测条件与观测）未勾选——真实 business 上游未获授权。85% 覆盖率未验证，Bun 原生报告不满足阈值（`src/lib/auto-session.ts` 全量 58.37% lines，存在动态 import 多实例合并疑问）。本地验收项已勾选，转 ready-for-human 待人工验收与上游授权。
