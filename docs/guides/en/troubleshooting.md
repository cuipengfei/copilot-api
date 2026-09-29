# Troubleshooting

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/troubleshooting.md)

<a id="troubleshooting"></a>

## Troubleshooting

**GitHub Copilot encrypted output decryption failure**

When the GitHub Copilot provider returns or logs `Encrypted function output content could not be decrypted or decoded`, it is usually an upstream issue. Set `useResponsesApiWebSocket` to `false` in `config.json` so Copilot Responses traffic goes over HTTP `/responses` instead:

```json
{
  "useResponsesApiWebSocket": false
}
```

Restart the server after changing the config. See [Configuration (config.json)](configuration.md#configuration-configjson) for the full option reference.
