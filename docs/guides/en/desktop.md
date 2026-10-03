# Desktop App

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/desktop.md)

## Electron Desktop App

If you prefer a GUI, this repository also includes an Electron desktop app in `desktop/`. It supports GitHub Copilot sign-in, OpenAI Codex OAuth with manual switching among up to 3 Codex accounts and removal of accounts that are not in use, and API-key configuration for Kimi, DeepSeek, DashScope, OpenRouter, or a custom provider. After a Codex account switch, the app prompts you to restart the service manually. After authorization or provider configuration, it can start and stop the local proxy with one click and shows the local endpoint, auth header, available models, usage, and logs in the app.

Retrying GitHub sign-in supersedes the previous attempt, including token finalization. A superseded attempt cannot report success or overwrite a newer completed sign-in.

The settings screen also exposes `OAuth App`, `API Home`, `SQLite DB Path`, `Enterprise URL`, verbose logging, and minimize-to-tray. Windows x64 (`.exe`), macOS Apple Silicon (`.dmg`), and Linux x64 (`.AppImage`) packages are published in GitHub Releases:

https://github.com/caozhiyuan/copilot-api/releases

On Linux, make the downloaded AppImage executable before launching it:

```sh
chmod +x Copilot-API-*-linux-x86_64.AppImage
./Copilot-API-*-linux-x86_64.AppImage
```

Download the installer for your platform, authorize or configure a provider inside the app, choose a port, start the server, then point your client at the local endpoint shown in the app. Packaged desktop builds use the bundled Electron runtime, so normal desktop usage does not require installing Node.js separately. Token usage history is enabled when that bundled runtime supports SQLite.

The desktop app's Advanced Config page reads and writes the shared model mappings through `GET/POST /admin/config/model-mappings`. The same mappings apply across `POST /v1/messages`, `POST /v1/messages/count_tokens`, `POST /v1/responses`, and `POST /v1/chat/completions` instead of being split per interface. It uses `auth.adminApiKey` instead of the regular `auth.apiKeys`, and the app reads that key directly from `config.json` after the server has generated it on startup.
