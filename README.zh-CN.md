# Copilot API

<p align="center">
  <img src="docs/hero/copilot-api-hero.svg" alt="Copilot API - Universal AI Gateway" width="1600" />
</p>

<p align="center">
  <strong>Universal AI Gateway</strong><br />
  One Gateway. Any Client. Multiple AI Providers.<br />
  Chat Completions &middot; OpenAI Responses &middot; Anthropic Messages
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jeffreycao/copilot-api"><img src="https://img.shields.io/npm/v/@jeffreycao/copilot-api.svg" alt="npm version"></a>
  <a href="https://github.com/caozhiyuan/copilot-api/blob/dev/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/caozhiyuan/copilot-api/stargazers"><img src="https://img.shields.io/github/stars/caozhiyuan/copilot-api.svg" alt="GitHub stars"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%3E%3D1.2.x-orange.svg" alt="Bun >= 1.2.x"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-%3E%3D22.13.0-green.svg" alt="Node >= 22.13.0"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

Copilot API 是一个本地 AI 网关，让 Claude Code、OpenCode、Codex 等客户端通过统一的 API 使用 GitHub Copilot、内置 Codex 和第三方模型服务。

<a id="highlights"></a>

## 功能亮点

- **统一 API 网关**：在同一个本地端点上提供 OpenAI 兼容的 Chat Completions（`/v1/chat/completions`）、OpenAI Responses API（`/v1/responses`）和 Anthropic 兼容的 Messages（`/v1/messages`）。
- **多 Provider 接入**：在同一个网关后面统一路由 GitHub Copilot、内置 `codex` provider 和第三方 provider（Kimi、DeepSeek、DashScope、OpenRouter、OpenCode Go 或自定义 provider）。GitHub Copilot 是可选能力——只要至少有一个启用中的 provider，无需 GitHub token 也能按 provider-only 模式启动。
- **为 Coding Agent 而生**：为 Claude Code、OpenCode 和 Codex 提供完整的配置指南，包括交互式 `--claude-code` 启动器和面向 Codex 的合并模型目录。
- **Streaming 与 WebSocket**：三种面向客户端的协议都支持 SSE 流式输出。上游 Copilot Responses 流量会根据每个模型声明的端点选择 WebSocket 或 HTTP；内置 `codex` provider 的流式 Responses 请求默认走 WebSocket，关闭 `useResponsesApiWebSocket` 后改走 HTTP。
- **桌面应用**：Electron 图形界面，支持 GitHub Copilot 登录、Codex OAuth、provider 配置、token 用量、日志查看和一键启动 / 停止。

<a id="quick-start"></a>

## 快速开始

需要 **Node.js >= 22.13.0**（npx）或 **Bun >= 1.2.x**。使用 GitHub Copilot 时需要相应订阅；也可以配置其他 provider 独立运行。

```sh
npx @jeffreycao/copilot-api@latest start
```

服务默认监听 `http://localhost:4141`。也可以先登录 GitHub Copilot 或配置第三方 provider：

```sh
npx @jeffreycao/copilot-api@latest auth login
```

验证网关已启动：

```sh
curl http://localhost:4141/v1/models
```

> [!NOTE]
> token usage 存储需要 Node.js >= 22.13.0 或 Bun。详见[通过 npx 使用](docs/guides/zh-CN/getting-started.md#using-with-npx)。

接下来可按你的客户端选择指南：[与 Claude Code 一起使用](docs/guides/zh-CN/claude-code.md#using-with-claude-code)、[与 OpenCode 一起使用](docs/guides/zh-CN/opencode.md#using-with-opencode)、[与 Codex 一起使用](docs/guides/zh-CN/codex.md#using-with-codex)，或通过 [Docker](docs/guides/zh-CN/docker.md#using-with-docker) 运行。

<a id="compatibility"></a>

## 兼容性

所有客户端都访问同一个本地端点。网关会把每个请求路由到 GitHub Copilot、内置 `codex` provider 或已配置的第三方 provider，并在 provider 使用不同协议时进行协议翻译。

**客户端 / 协议矩阵**

| 客户端 | Chat Completions | Responses | Anthropic Messages | 推荐 |
|---|:---:|:---:|:---:|---|
| Claude Code | — | — | ✅ 原生 / 适配 | Anthropic Messages |
| OpenCode | ✅ 原生 | ✅ 原生 / 适配 | ✅ 原生 / 适配（通过 `@ai-sdk/anthropic`） | Anthropic Messages |
| Codex | — | ✅ 原生 / 适配 | — | Responses |
| OpenAI 兼容客户端 | ✅ 原生 | ✅ 原生 / 适配 | — | Chat Completions |
| Anthropic 兼容客户端 | — | — | ✅ 原生 / 适配 | Anthropic Messages |

**Provider 与协议。** 协议能力按模型决定。Chat Completions 必须使用原生端点，Responses 和 Messages 则可在存在受支持路径时进行适配。内置 `codex` provider 原生使用 Responses；第三方 provider 可选择 `anthropic`、`openai-compatible` 或 `openai-responses`，也可按模型覆盖。

<a id="desktop-app"></a>

## 桌面应用

更喜欢图形界面？`desktop/` 目录下的 Electron 桌面应用支持 GitHub Copilot 登录、OpenAI Codex OAuth，以及 Kimi、DeepSeek、DashScope、OpenRouter 或自定义 provider 的 API Key 配置——可以一键启动 / 停止本地服务，并在一个窗口里查看本地端点、鉴权 Header、可用模型、用量和日志。

<p align="center">
  <img src="docs/screenshots/desktop-dashboard.png" alt="Copilot API 桌面应用首页" width="49%" />
  <img src="docs/screenshots/desktop-token-usage.png" alt="Copilot API 桌面应用 Token 用量页" width="49%" />
</p>

Windows x64（`.exe`）、macOS Apple Silicon（`.dmg`）和 Linux x64（`.AppImage`）安装包发布在 [GitHub Releases](https://github.com/caozhiyuan/copilot-api/releases)。完整配置与高级设置见 [Electron 桌面应用](docs/guides/zh-CN/desktop.md#electron-desktop-app)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [安装与启动](docs/guides/zh-CN/getting-started.md) | 运行环境、npx、provider 配置与源码运行 |
| [Claude Code](docs/guides/zh-CN/claude-code.md) | 交互式配置、settings.json 与模型映射 |
| [OpenCode](docs/guides/zh-CN/opencode.md) | Anthropic SDK 接入与模型配置 |
| [Codex](docs/guides/zh-CN/codex.md) | config.toml、模型目录与自动审核映射 |
| [Docker](docs/guides/zh-CN/docker.md) | Docker Compose、持久化存储与网络设置 |
| [桌面应用](docs/guides/zh-CN/desktop.md) | 安装、账号管理与高级设置 |
| [插件与工具搜索](docs/guides/zh-CN/integrations.md) | Claude Code / OpenCode 插件与 MCP 工具搜索桥接 |
| [用量监控](docs/guides/zh-CN/usage.md) | 用量面板、Token 历史与配额监控 |
| [命令行参考](docs/guides/zh-CN/cli.md) | 命令、参数与请求示例 |
| [配置参考](docs/guides/zh-CN/configuration.md) | config.json 配置项、模型路由与传输设置 |
| [API 与认证](docs/guides/zh-CN/api.md) | 端点、API Key 与管理接口认证 |
| [故障排查](docs/guides/zh-CN/troubleshooting.md) | 已知问题与处理方法 |

使用 GitHub Copilot 前请阅读 [GitHub Copilot 安全提示](NOTICE.md#github-copilot-security-notice)。
