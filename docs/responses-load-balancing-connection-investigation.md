# /v1/responses 负载均衡下的 connection 归属问题：最终结论与修复

## 问题

在 `copilot-api` 通过本地 router / load balancer 暴露 `/v1/responses` 时，跨实例续链会出现上游 401：

```text
input item does not belong to this connection
```

本次文档只记录**已经验证**的事实、最终修复，以及明确排除的方案。

## 最终结论

这次问题不是单一原因，而是两层问题叠加：

1. `/v1/responses` 直连路径在缺少 `x-session-id` header 时，原先没有像 `messages -> responses` 路径那样把稳定 session 线索落到 payload 级连续性里。
2. 真实复现样本表明，`reasoning.encrypted_content` 不是跨实例可移植的 replay 字段；把它原样重放到别的实例时，会触发上游返回：

```text
input item does not belong to this connection
```

因此，最终修复也分成两部分：

- **补 payload-level continuity**：为 direct `/v1/responses` 回填稳定的 `prompt_cache_key`
- **去掉跨实例不安全的 replay 字段**：在 replay normalization 时移除 `reasoning.encrypted_content`

## 已确认事实

### 1. 401 来自上游 Copilot Responses API

本地代码只是在 `createResponses()` 中把 payload 转发到上游 `/responses`；本地没有“input item 属于哪条 connection”的校验逻辑。

因此这句错误：

```text
input item does not belong to this connection
```

是上游返回的，不是本地代理自己构造的。

### 2. router 确实支持 sticky，但这不是最终修法

仓库里的 router 代码和测试都能证明 sticky routing 存在，但本次最终修复**没有**依赖下面这些做法：

- 不要求客户端必须传 `x-session-id`
- 不让 router 从 request body 推导 sticky key
- 不把 `/v1/responses` 退回成“只能靠 sticky 才能工作”

本次保留的目标是：

> 缺少 `x-session-id` 时，router 仍然可以 least-loaded 分发；同时 `/v1/responses` 仍然具备上游需要的连续性。

### 3. `messages -> responses` 路径原本就有 payload-level continuity 线索

`src/routes/messages/responses-translation/request.ts` 已验证会从 `metadata.user_id` 解析稳定 session 线索，并写入 translated responses payload 的 `prompt_cache_key`。

这说明仓内原本就有一种**不依赖 router sticky**、而是依赖 payload 自身连续性语义的成功路径。

### 4. direct `/v1/responses` 的最小危险 replay 字段是 `reasoning.encrypted_content`

这条结论来自真实 outgoing payload dump 的 A/B 回放，不是猜测。

已验证的对照结果如下：

- 原始 payload：
  - `4140` → `401`
  - `4142` → `401`
  - `4144` → `401`
- 只删 assistant replay message：
  - 仍然失败
- 删整个 reasoning item：
  - 原本失败的端口全部转为 `200 OK`
- **只删 `reasoning.encrypted_content`**：
  - 原本失败的 `4140` / `4142` / `4144` 也全部转为 `200 OK`

因此，当前已验证的**最小触发字段**是：

- `reasoning.encrypted_content`

不是：

- assistant message 本身
- 整个 reasoning item 的 `summary`
- router 是否 sticky

### 5. `4145` 上出现的 `model_not_supported` 不属于这次 continuity 根因

在同一轮回放里，`4145` 返回的是：

```text
The requested model is not supported.
```

这是单独的模型支持问题，不能拿来判断 connection 归属。

## 最终修复

### 修复 1：给 direct `/v1/responses` 回填稳定的 `prompt_cache_key`

在 `src/routes/responses/handler.ts` 中，进入 `createResponses()` 之前先提取稳定 session key；优先级为：

1. `payload.prompt_cache_key`
2. `payload.metadata.user_id` 中 `_session_...`
3. 请求头 `x-session-id`

当 payload 自己没有 `prompt_cache_key`、但能提取到稳定 session key 时，回填：

```ts
payload.prompt_cache_key = stableSessionKey
```

这样 direct `/v1/responses` 路径就补上了与 `messages -> responses` 同类的 payload-level continuity 语义。

### 修复 2：replay normalization 时移除 `reasoning.encrypted_content`

在 `src/routes/responses/utils.ts` 的 `normalizeReasoningItem()` 中，direct `/v1/responses` replay 现在：

- 保留 `type: "reasoning"`
- 保留短 `id`
- 保留 `summary`
- **不再转发 `encrypted_content`**

也就是说，当前行为不是“把 reasoning 全删掉”，而是只删掉已验证不具跨实例可移植性的字段。

### 修复 3：不扩大 replay 清洗范围

当前 replay normalization 只针对已经被证据确认的危险字段做最小处理：

- 保留 reasoning item 本身
- 保留 `id`
- 保留 `summary`
- 仅移除 `encrypted_content`

也就是说，这次修复没有把 replay 输入扩大成“通用清洗器”，而是只处理已验证会导致跨实例 401 的字段。

## 明确没有做的事

下面这些都**不是**本次最终修复的一部分：

- 不修改 router sticky 的生产逻辑
- 不让 router 从 body 推导 session 并做 sticky
- 不要求客户端必须传 `x-session-id`
- 不把所有 reasoning item 一刀切删除
- 不把 assistant replay message 当成根因处理

## 为什么这个修法是最小修复

因为它只处理两类已经被证据坐实的问题：

1. **缺失 payload-level continuity** → 回填 `prompt_cache_key`
2. **跨实例不安全的 replay 字段** → 删除 `reasoning.encrypted_content`

没有把修复扩大到 router、负载均衡策略或其他未证实层面。

## 验证结果

### 1. 真实 curl 回放验证

基于真实 outgoing payload dump 的回放已经证明：

- 原始 payload 可稳定复现跨实例 401
- 只删 assistant 无法修复
- 只删 reasoning 可修复
- **只删 `reasoning.encrypted_content` 也可修复**

这说明当前修法命中了最小危险字段。

### 2. 自动化测试

已运行并通过：

- `bun test tests/responses-handler.test.ts`
  - `13 pass, 0 fail`
- `bun test tests/router/integration.test.ts`
  - `5 pass, 0 fail`

其中新增断言覆盖了：

- direct `/v1/responses` replay 会移除 `reasoning.encrypted_content`
- reasoning `summary` / 合法 `id` 仍保留
- 缺少 `x-session-id` 时 router 仍按 least-loaded，而不是被这次修复改成 sticky

### 3. 手工验证

本轮手工测试已确认通过。

## 一句话结论

把整件事压成一句话，就是：

> `/v1/responses` 的跨实例 401，最终不是靠恢复 sticky session 修好的；而是通过补齐 payload-level continuity，并在 replay 时去掉不具跨实例可移植性的 `reasoning.encrypted_content` 修好的。
