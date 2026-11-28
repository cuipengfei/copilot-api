# 02: 运行时接入跨文件真实源码题、动态抽样题与动态补刷上限

Status: ready-for-human
Blocked by: 01 扩展 Fusion Standard 与 Max v1 探测条件及历史存储

**What to build:** 将 4 道跨文件真实源码任务题纳入运行时共享条件池，并在启动预热与后台补刷时将动态随机抽取的 100 行源码题同时喂给 Auto 和 Fusion；同时去掉写死的 `FUSION_TARGET_ATTEMPTS = 10`，让每轮补刷上限跟随当前去重候选池的实际大小动态计算。

## Acceptance criteria

- [x] 运行时共享并缓存 4 道跨文件源码任务题（`task-correctness`、`task-behavior`、`task-cancellation`、`task-concurrency`），供 Auto 和 Fusion 在启动与补刷时共同使用；缺少源码文件时记录日志并跳过，其他读取错误直接报告，tester 脚本复用同一套构造函数。
- [x] 启动预热和后台补刷动态抽取的 100 行真实源码题（`sampleHardSnippet` + `HARD_QUESTION`）同时生成 Auto 与 Fusion 候选条件参与探测。
- [x] 移除固定常量 `FUSION_TARGET_ATTEMPTS = 10`；Fusion 单轮补刷预算按当前轮次去重后的候选条件总数动态设置，中途凑齐全部目标模型立即停手，整轮候选试完仍有缺失才进入 90 秒冷却。
- [x] 行为测试验证动态补刷上限随候选数变化、动态源码题同时进入 Auto/Fusion 探测，以及凑齐目标模型后提前终止。

**规格：** [Copilot Fusion 与 Auto 折扣覆盖最大化规格](../spec.md)
