# 独立 worktree 实施记录

## 工作目录

- Worktree：`/home/cpf/code-inside/copilot-api-fusion-discounts`
- 分支：`feat/fusion-auto-discounts`
- 起点：`da1e3dfdab24dc3ef9f3cc4a518cdd66bd30c7e5`

## 操作与原因

1. 读取现有 Spec、Tickets 与开发规则，确认本次目标是新增折扣来源、扩大动态题面、补全兼容重试恢复。
2. 使用 `git worktree add -b feat/fusion-auto-discounts /home/cpf/code-inside/copilot-api-fusion-discounts da1e3dfdab24dc3ef9f3cc4a518cdd66bd30c7e5` 建立独立工作目录，使本次实现具有独立的源码文件和工作分支。
3. 将 `.scratch/fusion-auto-discount-maximization/` 复制到新 worktree，确保实现人员使用同一份规格与验收要求。
4. 使用 `bun install --frozen-lockfile --ignore-scripts` 在新 worktree 准备依赖；禁用安装脚本，避免安装时改变共享 Git hooks。
5. 按文件职责分别实施工单 01/02 与工单 03，由同一集成负责人在源码编辑结束后执行相关验证。
6. 在新 worktree 安装完成 324 个依赖包，并确认 crapper、dryer、mutator 已安装；读取工具用法，最终验证将复用本次 LCOV，限定到相关源码和关键分支。
7. 更新 docs/local-features.md 的折扣来源、补采预算、动态源码题面与兼容重试行为，便于后续维护与上游同步。
8. 新增真实本机 HTTP 验证，覆盖 High/Max 权限拒绝后 Standard 仍可取得 30% 配对，并由 createResponses 携带该 session token 发送请求。
9. 工单 03 的三条兼容重发已通过共用发送入口处理，新增六个真实 HTTP 恢复场景；检查将在全部编辑结束后统一执行。
10. 核对兼容恢复测试的端点边界：Fusion 只适用于 /responses；Messages 场景改为 Auto 10% 被拒后原价恢复，Responses 场景保留 Fusion 后备 Auto 或原价。
11. 核对新条件的数据形状：条件显式保存 expectedDiscount（10 或 30），Standard 保留实际 /auto 路由与 fusion 标记；选择接口统一使用 options 对象。
12. 核对已保存的 intelligence、fast 生成账单对照：两档的带令牌与不带令牌请求均 HTTP 200，四种 token_type 的单价折扣均为 30%；本次无需重新发送计费请求。
13. 新增集成测试同时检查公开折扣选择结果 source=fusion 和实际发送的 Standard session token；本机 HTTP 上游返回正常 Responses 内容，验证包含可见返回结果。
14. 将调度整合交给主代理、源码题面和选模条件分别独立处理；检查选模通路与折扣来源的分类，避免 Standard 被错误分配到普通 Auto 的补采队列。
15. 启动预热先发送固定题面，四个档位分别抽样连续 100 行源码；同一档位的完整题面同时用于 Auto 与 Fusion。
16. 本机 HTTP 测试使用完整的模型端点目录，历史 writer 随用例生命周期保存和关闭；测试控制的 Promise 在退出前完成清理。
17. 修正模拟时钟等待异步源码读取的驱动逻辑、准确选取当前刷新定时器与截止时间，按选择路由隔离测试记录。完整候选轮结束后的起始条件逐轮前移。
18. 使用 ESLint 的格式建议生成精确 patch，并通过文件编辑工具应用；所有源码改动由同一写入记录保存。
19. 按 Discovery 测试、会话调度、条件与历史存储、兼容重发、Mutation 执行方式分别并行处理收尾；每个文件只有一个实现负责人，检查与格式处理统一执行。
20. 查阅 crapper 的 LCOV 读取流程，使用现有 LCOV parser 合并同一源码各测试组的行覆盖信息，随后根据完整覆盖率计算函数评分。
21. 查阅 mutator 的隔离目录与测试入口，在临时执行脚本中将当前变体目录的源码和测试物化，并指定该目录的 tsconfig，确保变异检查执行当前变体。
22. 整理会话调度、历史存储、源码抽样和兼容重发中的职责阶段；保留公开接口、身份检查、请求顺序、错误处理与既有间隔。
23. 通过 TypeScript parser 核对 Discovery 测试的全部名称，将 60 个测试声明分配到五个互不重复的检查组；包含参数化场景时合计执行 61 个用例。
24. 在 mutator 隔离目录执行实际变体与原有测试，折扣来源比较的一处变异及 Standard 请求字段的四处变异全部触发测试失败。
25. 验证旧凭据 timer、499 与 599 HTTP 状态、Fusion 共享 Retry-After、tester 读取失败上下文及原始 cause，检查全部相关调用方并同步维护说明。

## 验证结果

- HTTP、条件与直接调用方：325 项通过、0 项失败，17 个文件。
- 会话、续期、日志和并发选择：160 项通过、0 项失败，8 个文件。
- 额外直接调用方及本机 HTTP：117 项通过、0 项失败，6 个文件。
- Discovery 全部五组：61 项通过、0 项失败。
- 相关回归合计：663 项通过，0 项失败；各组均使用 bun run test 的临时目录与内存 SQLite 隔离环境。
- bun run typecheck 与修改的 TypeScript 文件 ESLint：通过。
- 两个修改的 tester 脚本按 JavaScript ESLint 与 Prettier 配置检查：零错误、零警告。
- crapper（八个相关源码文件，合并最终测试组 LCOV，阈值 10）：通过，全部函数 CRAP 不超过 10。
- dryer（相关八个源码文件，阈值 0.8）：未发现重复候选。
- mutator：折扣来源比较 1/1、Standard 请求字段 4/4 变异均由实际测试检出。
- 维护文档、规格与三个工单的相对链接：全部有效。
