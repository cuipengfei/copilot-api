# 桌面应用

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/desktop.md)

<a id="electron-desktop-app"></a>

## Electron 桌面应用

如果你更喜欢图形界面，仓库里还提供了位于 `desktop/` 的 Electron 桌面应用。它支持 GitHub Copilot 登录、OpenAI Codex OAuth 与最多 3 个 Codex 账号的手动切换、移除未在使用的账号，以及 Kimi、DeepSeek、DashScope、OpenRouter 或自定义 provider 的 API Key 配置。切换 Codex 账号后，界面会提示手动重启服务。授权或配置 provider 后，可以一键启动或停止本地代理，并在界面里直接查看本地端点、鉴权 Header、可用模型、额度和日志。

设置页还可以配置 `OAuth App`、`API Home`、`SQLite DB Path`、`Enterprise URL`、详细日志以及最小化到托盘。Windows x64（`.exe`）、macOS Apple Silicon（`.dmg`）和 Linux x64（`.AppImage`）安装包发布在 GitHub Releases：

https://github.com/caozhiyuan/copilot-api/releases

Linux 用户需要先为下载的 AppImage 添加执行权限：

```sh
chmod +x Copilot-API-*-linux-x86_64.AppImage
./Copilot-API-*-linux-x86_64.AppImage
```

下载对应平台的安装包后，在应用内授权或配置 provider，选择端口并启动服务，再把你的客户端指向应用里显示的本地端点即可。发布版桌面应用使用随包内置的 Electron 运行时，正常使用不需要额外安装 Node.js；token usage 历史记录会在该内置运行时支持 SQLite 时启用。

桌面应用里的高级配置页会通过 `GET/POST /admin/config/model-mappings` 读写这份共享的模型映射。同一份映射会统一作用于 `POST /v1/messages`、`POST /v1/messages/count_tokens`、`POST /v1/responses` 和 `POST /v1/chat/completions`，不再按接口区分。它使用的是 `auth.adminApiKey`，不是普通的 `auth.apiKeys`；应用会在服务启动并自动生成该 key 后，直接从 `config.json` 读取它来发起请求。
