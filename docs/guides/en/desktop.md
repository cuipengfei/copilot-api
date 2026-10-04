# Desktop App

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/desktop.md)

## Electron Desktop App

If you prefer a GUI, this repository also includes an Electron desktop app in `desktop/`. It supports GitHub Copilot sign-in, OpenAI Codex OAuth with manual switching among up to 3 Codex accounts and removal of accounts that are not in use, and API-key configuration for Kimi, DeepSeek, DashScope, OpenRouter, or a custom provider. Provider configuration, server API keys, and account changes automatically refresh the running service; new requests use the updated configuration. After authorization or provider configuration, it can start and stop the local proxy with one click and shows the local endpoint, auth header, available models, usage, and logs in the app.

Listening host, proxy, verbose logging, and token logging are server startup options. Saving changes automatically restarts a running service and may interrupt active requests. OAuth App, API Home, SQLite DB Path, and Enterprise URL still require restarting the desktop app. Saving while the service is stopped does not start it.

Retrying GitHub sign-in supersedes the previous attempt, including token finalization. A superseded attempt cannot report success or overwrite a newer completed sign-in.

The settings screen also exposes `OAuth App`, `API Home`, `SQLite DB Path`, `Enterprise URL`, verbose logging, and minimize-to-tray. Windows x64 (`.exe`), macOS Apple Silicon (`.dmg`), and Linux x64 (`.AppImage`) packages are published in GitHub Releases:

https://github.com/caozhiyuan/copilot-api/releases

On Linux, make the downloaded AppImage executable before launching it:

```sh
chmod +x Copilot-API-*-linux-x86_64.AppImage
./Copilot-API-*-linux-x86_64.AppImage
```

Download the installer for your platform, authorize or configure a provider inside the app, choose a port, start the server, then point your client at the local endpoint shown in the app. Packaged desktop builds use the bundled Electron runtime, so normal desktop usage does not require installing Node.js separately. Token usage history is enabled when that bundled runtime supports SQLite.

Packaged builds check the latest stable GitHub Release 15 seconds after launch and every 6 hours. You can also use **Settings → Updates → Check for updates**. Windows NSIS and Linux AppImage builds download updates automatically and verify the installer against the SHA-512 checksum in the release metadata. Click **Restart and install** when ready; installation stops the local API server and interrupts active requests. Closing the app does not install a pending update.

macOS builds are unsigned and offer a link to download and manually install the new DMG. Linux builds launched outside an AppImage and older releases without updater metadata also use manual installation. Development builds do not check for updates. Update requests use the app's configured proxy.

The desktop release workflow uploads `latest.yml`, Windows `.blockmap` files, and `latest-linux.yml` alongside installers. Installers are uploaded before update metadata. Existing releases such as v2.6.29 do not contain these files; users must install a build with this feature once before subsequent releases can update automatically. No GitHub token is needed on users' machines.

The desktop app's Advanced Config page reads and writes the shared model mappings through `GET/POST /admin/config/model-mappings`. The same mappings apply across `POST /v1/messages`, `POST /v1/messages/count_tokens`, `POST /v1/responses`, and `POST /v1/chat/completions` instead of being split per interface. It uses `auth.adminApiKey` instead of the regular `auth.apiKeys`, and the app reads that key directly from `config.json` after the server has generated it on startup.
