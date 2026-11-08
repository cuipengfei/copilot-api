# gpt-5.4 reasoning 跨实例回放 400 问题调查结论

## 问题

在 `gpt-5.4` 通过 Anthropic `/v1/messages` → Copilot Responses API 路径请求时，第二轮有时会报如下错误：

```text
Invalid 'input[71].id': string too long. Expected a string with maximum length 64,
but got a string with length 408 instead.
```

这个错误不是每轮都会出现。

## 先说结论

这次问题不是 `split("@")` 误切，也不是某个端口独有逻辑。

根因是两件事叠在一起：

1. **Copilot Responses API 自己返回了超长 reasoning id。**
2. **这个 id 只在生成它的那个 Copilot 后端实例上可回放；跨实例回放时，上游不认它，并回退到通用长度校验，于是触发 `id <= 64` 的 400。**

我们本地代理的角色是：

- 在 Responses → Anthropic 出站翻译时，把上游返回的 `encrypted_content` 和 `id` 重新组装成 Anthropic thinking `signature`
- 在下一轮 Anthropic → Responses 入站翻译时，再把这个 `signature` 拆回 `encrypted_content` 和 `id`

所以，**长 id 不是我们生成的；我们只是把上游给出的那对数据带到了下一轮。**

## 谁把 id 弄得这么长

已验证事实如下：

1. `round1` 的 Responses 原始返回体里，`reasoning.id` 本身就是超长字符串。
2. 我们的 Anthropic 出站翻译代码会把它组装成：

   ```ts
   signature: (item.encrypted_content ?? "") + "@" + item.id
   ```

   位置：`src/routes/messages/responses-translation/response.ts` 的 reasoning 输出映射。
3. 因此，Anthropic thinking block 里看到的长尾 `@...`，本质上就是上游原始 `reasoning.id`。

换言之：

- **长 id 的来源**：Copilot Responses API
- **Anthropic signature 的组装者**：copilot-api
- **下一轮把它再拆回来的人**：还是 copilot-api

## 已验证证据

### 1. 第一轮原始返回里已经带着超长 id

`/tmp/round1_4141.json` 与 `/tmp/round1_4142.json` 都能直接看到：第一轮 assistant 返回的 thinking block 已含超长 `signature`。

结合 `responses-translation.ts` 的组装逻辑可知，这个超长尾巴就是上游返回的 `reasoning.id`，不是我们凭空拼出来的新值。

### 2. `split("@")` 不是根因

此前怀疑是 `encrypted_content` 本身含 `@`，导致二次 `split("@")` 切错位置。这个结论已经被实测推翻：

- 当前抓到的真实 signature 只有一个 `@`
- `encrypted_content` 不含 `@`
- 所以 `split("@")` 并没有把第二段切错成假 id

这也是为什么热修虽然把解析改成了 `lastIndexOf("@")`，但那只是更稳妥的解析方式，不是本次事故的真正修复点。

### 3. 同实例回放成功，跨实例回放失败

curl 实测结果如下：

| 场景 | 结果 |
|---|---|
| 4141 round1 → 4141 round2 | ✅ 成功 |
| 4142 round1 → 4142 round2 | ✅ 成功 |
| 4141 round1 → 4142 round2 | ❌ `id` 长度超限 |
| 4142 round1 → 4141 round2 | ❌ `id` 长度超限 |

这说明同一个超长 id：

- 回到**生成它的同一实例**时，上游接受
- 发到**另一实例**时，上游拒绝

最合理、且已被现象支持的解释是：**该 reasoning id 与生成它的 Copilot 后端实例/令牌上下文绑定，不具备跨实例可移植性。**

### 4. 伪造短 id 也不行

进一步实测：

- 把长 id 换成短假 id（如 `rs_test`）→ ❌ `encrypted content could not be verified`
- 把 id 置空 → ❌ `Expected letters/numbers/underscores/dashes`

这说明 `encrypted_content` 和 `id` 是配对校验的：

- **不能截断**
- **不能伪造**
- **不能留空**

## 为什么不是每次都触发

因为并不是每轮都会把上一轮的 reasoning replay 到另一个实例。

只要命中下面任一情况，就可能暂时不报错：

1. 路由仍落回生成该 reasoning 的同一实例
2. 上一轮没有可 replay 的 reasoning item
3. 历史消息已被 compaction 裁掉
4. provider / model metadata 被丢弃，旧 reasoning 没再按 reasoning 形态回放

所以用户感受到的现象才会是：

- 一直用同一路 provider 时常常没事
- 切换后偶发爆炸
- 不是每次都稳定复现

## 热修为什么只能“丢弃 oversized reasoning”

前面几条实测已经把可选项筛完了：

- 保留原长 id：跨实例会 400
- 截断 id：上游校验失败
- 伪造短 id：上游校验失败
- 空 id：格式校验失败

因此，当前唯一已验证可行的热修是：

> **当解析出的 reasoning id 长度大于 64 时，不把这个 thinking block 翻译成 `ResponseInputReasoning`，也就不再把它回放给 Responses API。**

代码位置：`src/routes/messages/responses-translation/request.ts`

现有保护逻辑：

```ts
if (id.length > MAX_RESPONSES_REASONING_ID_LENGTH) {
  return undefined
}
```

这会带来一个已知代价：

- 跨实例时丢失该轮 reasoning cache replay
- 可能导致 `usage.input_cached_tokens` 下降到 0

但它能稳定避免 400，并且不会伪造上游无法验证的 reasoning 数据。

## 结论

把整件事压成一句话，就是：

> **超长 reasoning id 是 Copilot Responses API 生成的；copilot-api 只是把它带入 Anthropic signature，并在下一轮原样回放。该 id 在同实例可用、跨实例不可用；一旦跨实例回放，上游便按通用规则校验 `id <= 64`，于是报 400。**

所以本次热修不去“修正”这个 id，而是在发现它超长时直接停止 replay。就眼下已验证的证据看，这是代价最小、也是唯一可靠的兜底方式。
