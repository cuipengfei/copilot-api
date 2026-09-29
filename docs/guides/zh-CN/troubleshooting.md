# 故障排查

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/troubleshooting.md)

<a id="troubleshooting"></a>

## 故障排查

**GitHub Copilot 加密输出解密失败**

使用 GitHub Copilot provider 时，如果响应或日志中出现 `Encrypted function output content could not be decrypted or decoded`，通常是上游问题。把 `config.json` 里的 `useResponsesApiWebSocket` 设为 `false`，让 Copilot Responses 改走 HTTP `/responses` 即可绕过：

```json
{
  "useResponsesApiWebSocket": false
}
```

修改后重启服务生效。完整配置项说明见[配置（config.json）](configuration.md#configuration-configjson)。
