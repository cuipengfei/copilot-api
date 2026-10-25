# DeepSeek Harness

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/dsh.md)

## Using with DeepSeek Harness

Start the gateway, then install the [dsh-copilot-api](https://github.com/caozhiyuan/dsh-copilot-api) provider into an existing Harness profile:

```sh
npx @jeffreycao/copilot-api@latest start
dsh plugin --profile web add dsh-copilot-api
```

Restart Harness after the first install. The package inserts entry `copilot-api-provider`. No profile configuration is required.

Defaults:

- `baseURL`: `http://localhost:4141` (with or without `/v1`)
- `protocol`: `openai-responses`
- credential reference: `GITHUB_COPILOT_API_KEY`

Save the gateway API key in the Models card with **Save API key**, in Harness credentials, or in the launch environment of that name. Configuration stores the reference name, not the key. Use `anthropic-messages` as `protocol` for Messages.

Override the inserted entry only when a default is wrong. Keep the id `copilot-api-provider`, and restate every connection field you still need:

```yaml
- id: copilot-api-provider
  config:
    baseURL: http://localhost:4141
    apiKey: GITHUB_COPILOT_API_KEY
    protocol: openai-responses
    modelRefreshInterval: 120000
```

`apiKey` is a credential reference. `apiKeyEnv` is the same kind of name; when both are set, they must match. `headers` can be set to custom request headers. `modelRefreshInterval` is in milliseconds and defaults to `120000` (automatic refresh every 2 minutes); set it to `0` to disable periodic refresh.

Model mapping, headers, and development notes are in the [plugin repository](https://github.com/caozhiyuan/dsh-copilot-api).
