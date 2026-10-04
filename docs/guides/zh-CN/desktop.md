# 桌面应用

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/desktop.md)

<a id="electron-desktop-app"></a>

## Electron 桌面应用

如果你更喜欢图形界面，仓库里还提供了位于 `desktop/` 的 Electron 桌面应用。它支持 GitHub Copilot 登录、OpenAI Codex OAuth 与最多 3 个 Codex 账号的手动切换、移除未在使用的账号，以及 Kimi、DeepSeek、DashScope、OpenRouter 或自定义 provider 的 API Key 配置。Provider 配置、服务 API Key 和账号修改后，会自动刷新运行中的服务，新请求使用更新后的配置。授权或配置 provider 后，可以一键启动或停止本地代理，并在界面里直接查看本地端点、鉴权 Header、可用模型、额度和日志。

监听地址、代理、详细日志和 Token 日志属于服务启动选项，保存后会自动重启正在运行的服务，进行中的请求可能中断。OAuth App、API Home、SQLite DB Path 和 Enterprise URL 仍需重启桌面应用。服务未运行时只保存设置，不会自动启动。

再次发起 GitHub 登录会取代之前的尝试，包括 token 保存阶段。被取代的尝试不会报告成功，也不会覆盖后续已完成登录的凭据与账号设置。

设置页还可以配置 `OAuth App`、`API Home`、`SQLite DB Path`、`Enterprise URL`、详细日志以及最小化到托盘。Windows x64（`.exe`）、macOS Apple Silicon（`.dmg`）和 Linux x64（`.AppImage`）安装包发布在 GitHub Releases：

https://github.com/caozhiyuan/copilot-api/releases

Linux 用户需要先为下载的 AppImage 添加执行权限：

```sh
chmod +x Copilot-API-*-linux-x86_64.AppImage
./Copilot-API-*-linux-x86_64.AppImage
```

下载对应平台的安装包后，在应用内授权或配置 provider，选择端口并启动服务，再把你的客户端指向应用里显示的本地端点即可。发布版桌面应用使用随包内置的 Electron 运行时，正常使用不需要额外安装 Node.js；token usage 历史记录会在该内置运行时支持 SQLite 时启用。

打包后的应用会在启动 15 秒后，以及每 6 小时检查 GitHub 最新稳定版。也可以通过 **设置 → 应用更新 → 检查更新** 手动触发。Windows NSIS 和 Linux AppImage 会自动下载更新，并使用 release 元数据中的 SHA-512 校验安装包。下载完成后点击 **重启并安装**；安装前会停止本地 API 服务，中断进行中的请求。正常关闭应用不会安装待更新版本。

macOS 版本未签名，发现新版本后提供下载入口，需要手动安装新的 DMG。在 AppImage 之外启动的 Linux 应用，以及缺少更新元数据的旧 release，也会使用手动安装。开发模式不检查更新。更新请求使用应用中配置的代理。

桌面发布流程会一并上传 `latest.yml`、Windows `.blockmap` 和 `latest-linux.yml`，先上传安装包，再上传更新元数据。v2.6.29 等现有 release 没有这些文件；用户需要先手动安装一次包含此功能的新版本，后续版本才可自动更新。用户电脑无需配置 GitHub Token。

桌面应用里的高级配置页会通过 `GET/POST /admin/config/model-mappings` 读写这份共享的模型映射。同一份映射会统一作用于 `POST /v1/messages`、`POST /v1/messages/count_tokens`、`POST /v1/responses` 和 `POST /v1/chat/completions`，不再按接口区分。它使用的是 `auth.adminApiKey`，不是普通的 `auth.apiKeys`；应用会在服务启动并自动生成该 key 后，直接从 `config.json` 读取它来发起请求。
