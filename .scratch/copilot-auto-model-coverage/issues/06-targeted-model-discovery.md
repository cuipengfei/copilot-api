# 06: 按配置目标模型补齐 Auto 会话令牌

## Status

done

## Goal

保留四档双题启动探测；配置目标模型后，对当前凭据尚未覆盖的模型继续发起共享探测，并报告仍缺失的数量。上游决定选中的模型，不能保证获得全部配置目标。

## Context

- `/auto` 当前请求发送 `prompt` 与 `tier`，返回上游选定的 `selected_model.id`；模型选择随题目变化，探测样本不能作为固定档位门槛。
- 原有单点探测按 `(tier, kind)` 合并在途请求，目标补充探测需要独立的单飞键与真实请求计数。
- 配对的有效性取决于过期时间和当前 Copilot 凭据；身份轮换后必须重新检查缺失目标。

## Acceptance Criteria

- [x] `AppConfig` 支持可省略的 `autoDiscovery?: { models?: string[] }`；省略或空数组时不增加探测请求
- [x] 四档、每档简单题与源码难题的启动探测保持原样
- [x] 启动探测结算后，对配置中未覆盖的模型共享一轮补充探测；覆盖判定使用未过期且属于当前凭据的配对
- [x] 每档最多发送 10 次实际请求，按 efficiency、balance、intelligence、fast 循环；两种已使用的题目交替探测，常规请求间隔至少 3 秒
- [x] 429 遵守 Retry-After 或现有退避；401/403 暂停到凭据变化；停止探测后 `whenProbeSchedulerIdle()` 等待任务结算
- [x] 凭据轮换或已配置目标的配对过期后，重新检查并继续探测缺失模型
- [x] 启动日志只报告未完成探测点数量，目标补充日志只报告缺失模型数量；均不输出请求内容、源码或会话令牌
- [x] 行为测试验证命中终止、档位计数、轮换恢复及停止收敛
- [x] `bun run lint:all --fix` 通过
- [x] `bun run build` 通过
- [x] `bun run test` 通过
- [x] `bun run typecheck` 通过
- [x] `bun run lint:all` 通过

## Verification

- `bun run lint:all --fix`、`bun run build`、`bun run typecheck`、`bun run lint:all` 均通过；隔离配置 `COPILOT_API_HOME=/tmp/copilot-auto-tests.KDJz4U` 下全量测试 1982 项通过。
- `copilot-backend-tester` 从 4143 取得真实凭据：上游 `/auto` 的四档请求均返回 HTTP 200，efficiency 选中 Luna、balance 和 fast 选中 Sol、intelligence 选中 Astra。
- 真实凭据轮换后旧配对失效，三款目标重新补齐；停止探测后 `whenProbeSchedulerIdle()` 正常结算。
- 使用独立配置中的四个真实模型发送 13 次 `/auto`，四档请求数分别为 4、3、3、3；现场断言档位顺序、题目交替和相邻请求间隔至少 2.9 秒。此时第四个目标尚缺失。生产探测使用 3 秒计时器，并用十轮循环及单次实际请求上限限定每档最多 10 次。
- `tests/auto-session-targets.test.ts` 的三个配置边界测试通过；`tests/auto-session-discovery.test.ts` 和 `tests/auto-session-logs.test.ts` 验证启动日志只包含未完成探测点数，目标补充日志只包含缺失模型数。
- 最终代码在 4143–4146 逐个重启后，启动日志均为 `discovery complete incomplete=0`，目标补充日志均由 `missing=1` 变为 `missing=0`。4142 维持原 PID 962777，未重启；其运行进程尚未加载本次配置。
- 根目录 lint 明确使用 `eslint.config.js`，排除 `.scratch/**` 与由桌面端独立检查的 `desktop/**`；ESLint 忽略查询确认 `node_modules`、`dist`、`.vendor`、`.scratch`、`desktop` 不进入根目录检查，`src`、`tests`、`router` 仍接受检查。
