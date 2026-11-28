# Gemini Copilot Chat 四标记选择策略

Status: ready-for-agent

## Problem Statement

Gemini 请求目前经 Copilot Chat Completions 上游发送时，共享缓存 helper 仍采用“前两条非空 system + 最后一条非空 non-system”的本地 2+1 选点规则。该规则没有表达 VS Code 官方 Chat 算法针对当前 user、工具调用批次和所有位置不带非空 `tool_calls` 的 assistant 设置的缓存边界，也没有统一的四标记预算。

Messages→Chat 入口还会在 route 层先无条件应用一次旧规则，随后 Gemini service 再应用 helper。若只修改 service 或只修改 helper 的默认行为，Gemini 可能先得到旧规则标记，再用新规则补位，形成混合结果。调用方重放带有历史标记的消息时，还需要既有标记占用预算、重复应用不增标，并且不能删除调用方已经提供的标记。

本次工作统一请求构造策略和重复处理行为。Gemini 的命中率、配额和费用变化另需上游数据验证。

## Solution

为 Copilot Gemini 的 Chat Completions 请求迁移 VS Code 官方 Chat cache-breakpoint 构造策略：在消息级 `copilot_cache_control: { type: "ephemeral" }` 上实施总预算 4，从尾部按逆扫顺序选择当前 user 下方的连续 tool 批次末端、当前 user 和所有位置不带非空 `tool_calls` 的 assistant，仍有预算时再从开头的连续 system/user 消息补位。

直接 Gemini Chat、Messages→Chat 以及经过共享 service 的 Gemini Responses→Chat fallback 都使用同一策略。Messages→Chat 必须在第一次 helper 应用前确定 Gemini 策略，不得先按非 Gemini 旧规则加标再由 service 修补。非 Gemini 的 Messages→Chat 仍沿用现行 2+1 规则；Claude 原生 Messages、GPT 原生 Responses、其他 provider 及模型 metadata 缺失时的现有边界不扩大。

helper 只读取消息顺序和现有字段来选择目标，只在仍有预算且目标可打标时补充缺失的消息级标记。已有标记保留并计入预算；输入已有标记超过 4 个时全部保留且不再新增。相同请求或序列化重放再次经过 helper 时不增加标记。

## User Stories

1. 作为 Gemini Chat Completions 调用方，我希望上游请求使用官方 Chat 的缓存边界选点，以便请求结构与 VS Code 的构造策略保持一致。
2. 作为 Messages API 调用方，我希望 Anthropic 消息翻译成 Chat 消息后也使用同一 Gemini 策略，以便不同兼容入口不会生成不同的缓存边界。
3. 作为维护者，我希望 Messages→Chat 在首次写标记前确定策略，以便 Gemini 不会混合旧 2+1 规则与新四标记规则。
4. 作为工具型 agent 调用方，我希望当前 user 下方每个连续 tool 批次只在原始顺序的最后一条 tool 上选点，以便每个工具轮次有一个明确边界。
5. 作为普通多轮对话调用方，我希望不带 tool_calls 的 assistant 按从近到远顺序选点，以便当前回复和历史回复都遵循官方 Chat 结构。
6. 作为带有 system 和自定义上下文的调用方，我希望逆扫后仍有预算时从开头连续 system/user 补位，以便利用剩余预算而不越过其他 role。
7. 作为发送空内容或结构化内容的调用方，我希望空字符串、`null` 和空数组跳过、非空数组可参与选点，以便 helper 不在不可打标的内容上新增标记。
8. 作为重放历史请求的调用方，我希望已有消息级标记占用四标记预算，以便重放不会因为重新计算而额外增标。
9. 作为自带缓存标记的调用方，我希望已有标记的值、位置和消息内容保持不变，以便代理不会擅自重写客户端意图。
10. 作为已有 4 个标记的调用方，我希望 helper 立即停止新增，以便输出不会出现第 5 个标记。
11. 作为已有超过 4 个标记的调用方，我希望所有标记原样保留且不再新增，以便兼容旧输入而不静默删除客户端内容。
12. 作为非 Gemini 调用方，我希望现有 Messages→Chat 2+1 行为保持不变，以便 Gemini 策略迁移不会改变其他模型的请求。
13. 作为 Claude 原生 Messages 或 GPT 原生 Responses 调用方，我希望本次不改变这些原生协议路径，以便变更范围仅限 Copilot Gemini Chat 构造。
14. 作为维护者，我希望 helper 对同一对象和序列化重放都幂等，以便 route 与 service 的多次应用不会累积标记。
15. 作为实施 agent，我希望入口测试捕获实际上游请求、局部测试覆盖选点矩阵，以便从外部行为验证完整链路而非只验证内部选择函数。
16. 作为文档读者，我希望 local-features 描述新策略、预算边界和无命中率承诺，以便文档不再把 Gemini 描述为旧 2+1 规则。

## Implementation Decisions

### 模型判定与调用方策略

- 继续以模型 metadata 为 Gemini 判定依据：按请求解析后的 `payload.model` 在现有模型列表中精确查找，并以其 `capabilities.family` 匹配现有的大小写不敏感 Gemini family 规则。模型 ID 中含 `gemini` 或存在别名，不能单独作为启用依据。
- `createChatCompletions` 只在确认 Gemini family 时调用共享 helper，并显式使用 Gemini 策略。没有匹配 metadata 时保持现状，不由 service 添加 Gemini 标记。
- Messages→Chat 的 route 与 service 必须复用同一个基于模型 metadata 的内部判定，不得分别采用不同 family 来源或不同的模型识别规则。
- 让 helper 的策略成为显式内部参数，并迁移所有直接调用方。Gemini 调用传 Gemini 策略；Messages→Chat 在确认非 Gemini 或 metadata 缺失时传现行 legacy 策略。该参数仅供内部使用，不新增用户配置键。
- Gemini 的 Messages→Chat 第一次调用就必须使用 Gemini 策略；后续 service 再调用时仍为 Gemini 策略。不得先按 legacy 规则加 2+1 个标记，再由第二次调用补齐。
- 直接非 Gemini Chat 维持 service 不调用 helper 的现有行为；非 Gemini Messages→Chat 维持 route 层 legacy 2+1 行为。
- Gemini Responses→Chat fallback 因共享 `createChatCompletions` 而自然使用同一策略，不另建一套选点逻辑。原生 Responses 和原生 Messages 不接入本策略。

### Gemini 候选定义与顺序

- 总预算是 4 个消息级 `copilot_cache_control` 标记；候选不足时可以少于 4 个。合法新增值仍为 `{ type: "ephemeral" }`。
- 当前 user 定义为原始消息数组中从尾部向前遇到的第一条 `role: "user"`。其“下方”指原始数组中位于它之后的消息；其“历史”指位于它之前的消息。
- 连续 tool 批次是原始顺序中相邻的一组 `role: "tool"` 消息；连续 tool 批次的最后一条按原始数组位置判定；从尾部扫描时遇到的第一条 tool 就是该批次末端。
- 先计算已有标记数和剩余预算。剩余预算为 0 或负数时，整个选择过程立即停止，不进入逆扫或前缀补位。
- 剩余预算为正时，从尾部向头部扫描：
  - 在当前 user 下方，选择每个连续 tool 批次的最后一条。
  - 选择当前 user 本身。
  - 在任何位置，选择不带非空 `tool_calls` 的 assistant；带非空 `tool_calls` 的 assistant 不作为新增候选。
  - assistant 候选不受当前 user 边界限制；当前 user 后面若有无工具调用的 assistant，也会按逆扫顺序先获得标记。
  - 候选按逆扫遇到的先后顺序竞争预算，每次新增后立即扣减，耗尽即停止。
- 当前 user 的边界判定不依赖它是否已有标记或是否可打标。已有标记、空内容和跳过候选都不能把较老 user 错认成当前 user。
- 没有当前 user 时不虚构 user 锚点；逆扫仍选择各连续 tool 批次末端和不带 `tool_calls` 的 assistant，随后执行相同的前缀补位。
- 逆扫后仍有剩余预算时，从数组开头沿连续的 system/user 前缀向后补位；遇到第一个既非 system 也非 user 的消息后终止前缀扫描。前缀中已有标记或内容不可打标的消息只跳过，不提前终止后续 system/user 的补位。
- 逆扫阶段不单独给开发者消息、历史普通 user、带非空 `tool_calls` 的 assistant 或当前 user 上方的 tool 消息新增标记。历史普通 user 仍可以属于开头连续 system/user 的补位范围。

### 内容资格、已有标记与预算边界

- 可新增标记的内容资格沿用本机类型和现有 helper：非空字符串或非空 content 数组。空字符串、`null`、空数组不可新增；非空数组可作为候选，不重写其 content parts。
- 本机合法消息级标记是 `copilot_cache_control: { type: "ephemeral" }`。每个已有该字段的消息计一个已有标记，并占用一个预算；content part 上的其他 `cache_control` 与本规格消息级字段分别处理。
- 已有标记无论在官方候选位置还是其他位置，都保持原消息、原值和原引用，不移动、不替换。即使它所在消息当前不符合新增内容资格，也不删除该客户端字段，并仍计入已有标记数，避免继续放大总数。
- 输入已有 0、1、2、3、4 个标记时，分别最多新增 4、3、2、1、0 个；候选不足时输出可以少于 4 个。
- 输入已有超过 4 个标记时，全部原样保留且不再新增。不得通过删除“多余”或“不支持”的标记来制造预算。
- “输出至多 4 个标记”的保证只适用于输入已有标记不超过 4 个的情况；对输入已经超过 4 个的情况，只保证不新增和不删除。
- 上游官方实现先计算 `4 - existing`，但逆向循环只在新增后检查预算，因此满额输入存在再新增一个的边界。本地必须在扫描前和每次新增后检查预算，不复制该行为。
- 上游会从不支持的内容移除 breakpoint；本地不采用该清理步骤，因为本任务禁止静默删除调用方已有内容或标记。

### 幂等与数据保持

- helper 只读现有 `messages` 顺序、role、内容资格、`tool_calls` 和已有标记来选择目标；唯一允许的写入是在选中的消息上补充缺失的 `copilot_cache_control`。
- 不重排消息，不改变 `content`、`tool_calls`、`tool_call_id`、reasoning 相关字段、tools、tool choice 或其他 payload 字段。
- 同一对象重复应用后，消息与标记保持深度相等，已有标记的对象引用保持不变。
- 将已处理 payload 序列化再反序列化后重放，已有标记仍占预算，结果不增加标记；幂等不能依赖对象引用是否跨重放保留。
- route 与 service 对同一 Gemini Messages→Chat 请求的多次应用遵守同一幂等约束。
- 不引入缓存开关、预算配置、模型 ID 覆盖或其他新配置。

### 文档

- 更新 local-features 中“Copilot Gemini 的 Chat 上游缓存标记”说明：以四标记策略替换 Gemini 的旧 2+1 描述，保留非 Gemini Messages→Chat 的现行规则。
- 文档同时说明 metadata family 判定、双入口一致策略、已有标记计入预算、超过预算保留且不新增、幂等和不保证命中率。
- 保留 Responses→Chat fallback 经共享 service 覆盖的事实，明确原生 Claude Messages 和 GPT Responses 不在扩展范围内。

## Testing Decisions

### 测试原则与优先级

- 只断言外部可观察行为：实际发送给上游的消息级标记、原有 payload 字段保持、预算和幂等；不导出或锁定内部逆扫状态机。
- 首选现有本地 HTTP 上游捕获入口：请求穿过真实 route、Messages 翻译、service 和发送路径，由本地服务器捕获最终 `/chat/completions` body。该入口能直接发现 Messages→Chat 先旧后新的混合问题。
- 保留 service 级完整上游 fetch body 捕获，用于 family metadata、大小写、模型别名和 metadata 缺失边界。
- 使用现有 `applyCopilotContextCache` 局部测试补充完整选点矩阵；这些测试仍通过公开 helper 的结果断言，不测试私有候选函数。
- 现有 local-features 第 19 节列出的 helper 测试和本地 HTTP 测试是直接先例，service 的 reasoning/cache 上游 body 捕获是 family 判定先例。

### 必测矩阵

- 直接 Gemini Chat 的普通多轮无工具对话：按逆扫顺序选择当前 user 和所有位置不带非空 `tool_calls` 的 assistant，再由开头连续 system/user 使用剩余预算。
- 最新 user 后存在没有 tool_calls 的终止 assistant 时，逆扫应先选该 assistant，再选最新 user，随后按预算选较近的其他候选。
- Messages→Chat 的等价普通多轮对话：翻译后得到同一策略的标记位置，最终上游 body 不含 legacy 先验加标造成的混合结果。
- Gemini Responses→Chat fallback：保持现有入口覆盖，并验证共享 service 不产生另一套结果。
- 当前 user 下方有多个工具轮次、每轮有连续多条 tool：只标记每个批次原始顺序的最后一条；预算按从尾部到头部的批次顺序消耗。
- 无工具对话：不错误选择 tool；所有位置带非空 `tool_calls` 的 assistant 均不作为新增候选。
- 无当前 user：不新增 user 锚点，仍按约定选择 tool 批次末端和无工具 assistant，并能进行前缀补位。
- 任意位置的 assistant 带非空 `tool_calls`：该消息不新增标记，其字段和顺序保持不变。
- 内容资格：空字符串、`null`、空数组均跳过；非空数组可以新增标记；已有标记即使位于不可新增内容上也被保留并计数。
- 前缀补位：只沿开头连续 system/user 使用剩余预算，跳过已有或不可打标项，遇到首个其他 role 后停止。
- 调用方已有 0、1、2、3、4 个合法标记：分别验证剩余预算；已有 4 个时完全不变，不能出现第 5 个。
- 调用方已有 5 个或更多标记：输出数量、位置和值均不变，且不新增。
- 任意位置的已有标记都占预算，不要求它们先符合官方候选位置。
- 同一对象重复应用、JSON 往返后的重放，以及 Messages→Chat 的 route/service 双重应用，都不增加或替换标记。
- 非 Gemini Messages→Chat 仍得到旧 2+1 选点；直接非 Gemini Chat 维持 service 不新增标记；metadata 缺失不凭模型 ID 启用 Gemini。
- Gemini family 匹配保持大小写不敏感，非匹配 family 和仅有 Gemini 风格别名的模型不启用新策略。
- Claude 原生 Messages、GPT 原生 Responses 和其他 provider 的现有请求构造不增加本策略。
- 对每个代表性用例，除预期新增标记外，消息顺序、content、`tool_calls`、`tool_call_id`、reasoning 和工具定义均与输入一致。

### 实施后的最小验证

- 运行共享 helper 的局部测试、Copilot context cache 的本地 HTTP 测试，以及 `createChatCompletions` 的上游 fetch 捕获测试。
- 若 Messages route 的签名或依赖接线发生变化，再运行其直接调用方测试；不以全量测试代替上述针对性验证。
- 本规格阶段不执行 build、lint、test 或 formatter；上述命令属于实施票据的验收步骤。

## Out of Scope

- 不迁移官方 Responses 的 20-breakpoint 算法，也不修改 GPT 原生 Responses 的缓存行为。
- 不修改 Claude 原生 Messages、其他 provider 或非 Gemini Chat 的选点规则。
- 不根据模型 ID、别名或用户配置扩大 Gemini 识别范围。
- 不删除、截断、移动或规范化调用方已有标记，包括输入已经超过 4 个的情况。
- 不重排消息、重写 content parts、修改工具调用或 reasoning 数据。
- 不新增缓存开关、预算配置、命中率遥测、性能基准或费用承诺。
- 不声称官方策略迁移必然提高 Gemini 缓存命中率；该效果需要独立的上游观测，本工作不据此验收。
- 不顺带重构无关请求流程或修改现有领域规则。

## Further Notes

- 官方基准：[VS Code `cacheBreakpoints.ts`，commit `2627b28b85b730e82b0121f013aca1e3f78d8d38`](https://github.com/microsoft/vscode/blob/2627b28b85b730e82b0121f013aca1e3f78d8d38/extensions/copilot/src/extension/intents/node/cacheBreakpoints.ts)。本规格只迁移其中 Chat Completions 分支的构造策略，Responses 分支明确不在范围内。
- 官方策略的意图是：当前 user 下方标记每轮最后一条 tool result，标记当前 user，并在所有位置不带非空 `tool_calls` 的 assistant 上设置边界；候选按实际逆扫顺序竞争预算，剩余预算用于 system/custom-instructions 前缀。本地保留这一优先级，同时显式修复满额输入仍可能新增的边界。
- 本地与官方有两项有意的数据保护差异：预算耗尽时在进入扫描前立即停止；不会从不可打标内容中删除既有客户端标记。
- 本仓库当前没有根级 GLOSSARY 或 ADR 目录可补充本次术语约束；规格沿用代码中的 Chat Completions、Messages→Chat、Responses→Chat fallback、family metadata 和 `copilot_cache_control` 名称。
- 本任务只交付规划，不包含运行代码、测试或文档实现改动。
