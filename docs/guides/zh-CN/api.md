# API 与认证

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/api.md)

<a id="api-authentication"></a>

## API 认证

- **受保护的普通路由：** 当配置了 `auth.apiKeys` 且非空时，除 `/`、`/usage-viewer` 和 `/usage-viewer/` 以外的普通路由都需要认证。非回环监听要求启动时存在非空的 `auth.apiKeys`，即使运行期间 Key 被清空也会继续以拒绝请求的方式安全失败。
- **Admin 路由：** 所有 `/admin/*` 路由都要求 `auth.adminApiKey`。如果缺失，服务会在启动时自动生成并在开始提供服务前写回 `config.json`。
- **允许的认证头：**
  - `x-api-key: <your_key>`
  - `Authorization: Bearer <your_key>`
- **CORS 预检：** `OPTIONS` 请求始终允许。
- **未配置普通 key 时：** 普通路由仍可直接访问；但这条规则不适用于 `/admin/*`，后者只接受 `auth.adminApiKey`。

普通受保护路由的示例请求：

```sh
curl http://localhost:4141/v1/models \
  -H "x-api-key: your_api_key"
```

Admin 路由的示例请求：

```sh
curl http://localhost:4141/admin/config/model-mappings \
  -H "x-api-key: your_admin_api_key"
```

<a id="api-endpoints"></a>

## API 端点

服务端提供多个 OpenAI / Anthropic 兼容端点。请求会根据所选模型和 `provider/model` 别名路由到 GitHub Copilot、内置 `codex` provider 或已配置的 provider。下列每个 `/v1/...` 端点也都支持 `/:provider/v1/...` 形式的 provider 级路径，表格中不再重复列出。

### OpenAI 兼容端点

这些端点模拟 OpenAI API 结构。

| 端点                        | 方法 | 说明                                                                                                     |
| --------------------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| `POST /v1/responses`        | `POST` | OpenAI 中用于生成模型响应的高级接口。支持 `Content-Encoding: zstd` 请求体和 `openai-responses` provider 的 `provider/model` 别名。zstd 请求解压仅作用于 Responses 路由，包括 provider-scoped 别名路由。 |
| `POST /v1/chat/completions` | `POST` | 为给定聊天对话创建模型响应。支持 `openai-compatible` provider 的 `provider/model` 别名；目标 provider 已配置时可在没有 Copilot 的情况下使用。 |
| `GET /v1/models`            | `GET` | 列出 Copilot 模型以及已启用 provider 的 `provider/model-id` 模型。来自 Codex 客户端（`User-Agent` 以 `codex` 开头）的请求会转发到 Codex Models 上游。 |
| `POST /v1/embeddings`       | `POST` | 创建表示输入文本的向量嵌入。                                                                             |

### Codex 后端端点

这些端点实现 Codex 后端 API。顶层图片请求要求已有可用的 Codex 登录态；alpha-search 则可以使用 Codex 后端或 Responses web-search 适配器。

| 端点                                                       | 方法 | 说明                                                                                                 |
| ---------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/alpha/search`            | `POST` | 将 Codex alpha-search 请求路由到 Codex 后端，或在本地及通过 Responses web search 处理支持的命令。 |
| `POST /v1/images/generations` | `POST` | 将 JSON 图片生成请求转发到 Codex Images 上游。请求未携带 `Content-Type` 时，网关默认补充 `application/json`。请求 `model` 命中已配置的 model mapping 时会被改写；映射结果为已配置 provider 的 `provider/model` 别名时，请求将转发到该 provider 的 images 端点。 |
| `POST /v1/images/edits` | `POST` | 将图片编辑请求转发到 Codex Images 上游。请使用 `multipart/form-data`，并让 HTTP 客户端自动生成 `boundary`；网关在接收上传时就把文件流式写入临时磁盘文件，转发时从磁盘读取，大文件不会常驻内存。multipart 请求总大小上限为 128 MiB，单文件上限为 64 MiB，最多包含 16 个文件；超过限制时返回 `413`。model mapping 与 `provider/model` 别名路由同样适用于此端点。 |

对于路由到 Codex 后端的请求，网关会使用当前 Codex 登录态覆盖客户端的 authorization 和 account header，并保留兼容的请求元数据。基于 Responses 的 alpha-search 则遵循所选 Copilot 或 provider 的路由。

### Anthropic 兼容端点

这些端点设计为兼容 Anthropic Messages API。

| 端点                                                          | 方法 | 说明                                                                                                 |
| ------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/messages`                                           | `POST` | 为给定对话创建模型响应。支持已配置 provider 的 `provider/model` 别名，包括通过 `openai-compatible` provider 做翻译。 |
| `POST /v1/messages/count_tokens`                              | `POST` | 计算一组消息的 token 数。支持已配置 provider 的 `provider/model` 别名。                          |

### 使用量监控端点

用于监控 Copilot 用量与额度的新端点。

| 端点           | 方法 | 说明                                              |
| -------------- | ---- | ------------------------------------------------- |
| `GET /usage`   | `GET` | 获取详细的 Copilot 使用统计与额度信息。          |

### Admin / 配置端点

这些端点用于本地管理操作，只接受 `auth.adminApiKey`。

| 端点                                 | 方法 | 说明                                                            |
| ------------------------------------ | ---- | --------------------------------------------------------------- |
| `GET /admin/config/model-mappings`   | `GET` | 返回当前 `config.json` 路径以及生效中的 `modelMappings` 映射。 |
| `POST /admin/config/model-mappings`  | `POST` | 只更新 `config.json` 里的 `modelMappings` 字段，并回传更新后的结果。 |
