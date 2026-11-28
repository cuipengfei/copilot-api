# 01: Align Gemini Chat cache breakpoints

Status: ready-for-agent

Blocked by: None

**What to build:** 为 Copilot Gemini 的 Chat Completions 请求统一采用 VS Code 官方 Chat 缓存边界选点策略，让直接 Gemini Chat、Messages→Chat 和共享 service 的 Gemini Responses→Chat fallback 都生成一致的、幂等的消息级标记，同时保持非 Gemini 和原生协议路径的现行行为。

**Spec:** [Gemini Copilot Chat 四标记选择策略](../spec.md)

## 行为要求

- 共享 helper 采用显式策略参数；所有直接调用方都迁移为在写标记前确定策略。Gemini 使用新策略，非 Gemini Messages→Chat 使用现行 legacy 策略，不保留靠模型 ID 猜测的隐式默认。
- Gemini 判定使用与 service 相同的现有模型 metadata：按解析后的模型名精确匹配，并检查大小写不敏感的 `capabilities.family`。别名或模型 ID 中出现 `gemini` 不能单独启用策略；metadata 缺失不凭模型 ID 启用 Gemini；此时 service 不新增 Gemini 标记，Messages→Chat 保持旧行为。
- Messages→Chat 第一次调用 helper 就必须确定 Gemini 或 legacy 策略。Gemini 的每个入口从首次处理起使用同一四标记策略；route 与 service 的后续应用使用同一策略且不增标。
- Gemini 总预算为 4 个消息级 `copilot_cache_control: { type: "ephemeral" }`。先统计所有已有消息级标记；剩余预算为 0 或负数时，在进入逆扫和前缀补位前立即停止。
- 当前 user 是原始消息数组中从尾部遇到的第一条 user。从尾部向头部扫描，选择当前 user 下方每个连续 tool 批次原始顺序的最后一条、当前 user，以及任何位置不带非空 `tool_calls` 的 assistant；所有候选按实际逆扫顺序使用预算，当前 user 后的无工具 assistant 先于当前 user 选取，每次新增后立即检查并停止于耗尽点。
- 已有标记或不可打标内容不影响当前 user 边界判断。没有当前 user 时不虚构 user 锚点，仍按逆扫顺序选择连续 tool 批次末端和任何位置不带非空 `tool_calls` 的 assistant。
- 逆扫后仍有预算时，从开头沿连续 system/user 前缀补位；已有标记或不可打标的前缀消息只跳过，遇到首个其他 role 后终止。
- 新增标记只作用于非空字符串或非空数组 content；空字符串、`null`、空数组跳过。非空数组不重写 content parts。
- 所有已有标记保持原位置、原值和原对象引用并计入预算，包括不处于官方候选位置或当前内容不可新增标记的情况。不删除、不移动、不替换客户端已有字段。
- 输入已有 0、1、2、3、4 个标记时分别最多新增 4、3、2、1、0 个；候选不足时可以少于 4 个。输入已有超过 4 个标记时全部保留且不再新增；四标记上限保证只适用于输入已有标记不超过 4 个的情况。
- helper 只补缺失标记，不重排消息，不改变 `content`、`tool_calls`、`tool_call_id`、reasoning、tools、tool choice 或其他 payload 字段，不新增用户配置。
- 同一对象重复应用、序列化后重放，以及 Messages→Chat 的 route/service 多次应用都不增加或替换标记。
- 直接非 Gemini Chat、非 Gemini Messages→Chat、Claude 原生 Messages、GPT 原生 Responses 和其他 provider 不扩大本次策略；Gemini Responses→Chat fallback 只通过共享 service 自然继承同一策略。
- 更新 local-features 的 Gemini Chat 缓存说明，替换 Gemini 的旧 2+1 描述，并记录 family metadata、双入口一致、已有标记预算、超过预算保留、幂等和“不承诺命中率”的边界。

## Acceptance criteria

- 直接 Gemini Chat 普通多轮无工具对话的上游 body 按逆扫顺序选择当前 user 和任何位置的无工具 assistant，再从开头连续 system/user 前缀补位，使用不超过 4 个标记。
- 当前 user 后有无工具调用的 assistant 时，最终上游请求先标记该 assistant，再标记当前 user，然后按逆扫顺序消耗剩余预算。
- Messages→Chat 经真实翻译和发送路径得到同一 Gemini 策略，Gemini 的每个入口从首次处理起使用同一四标记策略。
- Gemini Responses→Chat fallback 经共享 service 保持相同策略；GPT 原生 Responses 请求构造不变。
- 当前 user 下方存在多个工具轮次且每轮有多条连续 tool 时，只选每个批次原始顺序的最后一条；不同批次之间和批次内部顺序正确。
- 无工具、无当前 user、assistant 带非空 `tool_calls` 三类输入都有确定结果，且不会把任何位置带非空 `tool_calls` 的 assistant 当作候选。
- 空字符串、`null`、空数组不新增标记，非空数组可新增；候选不可打标时继续按顺序处理其他候选直到预算耗尽或候选穷尽。
- 开头连续 system/user 的剩余预算补位只扫描该前缀，跳过已有或不可打标项，遇到首个其他 role 后停止。
- 调用方已有 0、1、2、3、4 个标记时遵守各自剩余预算；已有 4 个时输出完全不变，不出现第 5 个标记。
- 调用方已有 5 个或更多标记时，输出数量、位置和值均不变且不新增；不要求四标记上限覆盖这种输入。
- 任意位置的已有合法标记都占预算并保留；同一对象重复应用后深度相等且引用不变，JSON 往返重放后不增标。
- Gemini Messages→Chat 经 route 和 service 两次应用后仍与一次应用结果相同。
- 非 Gemini Messages→Chat 保留旧“前两条非空 system + 最后一条非空 non-system”行为；直接非 Gemini Chat 和 metadata 缺失边界保持现状。
- family 大小写不敏感匹配有效，但仅有 Gemini 风格模型 ID 或别名不触发新策略。
- 代表性用例中，除预期新增的消息级标记外，消息顺序及所有内容、工具调用、reasoning 和工具定义保持输入原样。
- local-features 不再把 Gemini 描述为旧 2+1 规则，并明确本工作是官方 Chat 构造策略迁移，不宣称缓存命中率、配额或费用提升。

## Verification

- 扩展公开 helper 的局部测试矩阵，并运行该完整测试模块，不只运行新增用例。
- 扩展本地 HTTP 上游捕获测试，覆盖直接 Chat、Messages→Chat、Responses→Chat fallback 和非 Gemini 边界，并运行该完整测试模块。
- 使用现有 `createChatCompletions` 完整上游 fetch body 捕获测试验证 family metadata、别名、metadata 缺失及实际发送 body，并运行该完整测试模块。
- 若 Messages route 接线或签名变化，同时运行其直接调用方的完整测试模块，确认非 Gemini 和原生分流回归。
- 对共享 helper 的全部直接调用方做一致性检查：每个调用点都显式选择 Gemini 或 legacy 策略，没有遗漏的默认旧调用，也没有 model ID 字符串猜测。
- 文档检查限定为 local-features 的 Gemini 缓存说明；不修改运行规则文件，不加入未请求的配置。
