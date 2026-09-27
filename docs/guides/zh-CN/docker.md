# Docker

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/docker.md)

<a id="using-with-docker"></a>

## 配合 Docker 使用

仓库提供的 Compose 文件使用当前已发布的 `ghcr.io/caozhiyuan/copilot-api:latest` 镜像，无需在用户机器上构建镜像。它将 gateway 状态保存在 `/data`，并以非 root 的 `bun` 用户运行服务。

### 使用 Docker Compose 快速启动

在仓库根目录执行以下命令。将 `YOUR_GATEWAY_API_KEY` 替换为客户端访问 gateway 时使用的强密钥：

```sh
mkdir -p copilot-data
docker compose pull
docker compose run --rm copilot-api --auth keys --add YOUR_GATEWAY_API_KEY
docker compose run --rm copilot-api --auth login
docker compose up -d
docker compose ps
```

如果环境变量或用户自己创建的私有 `.env` 中已经设置 `COPILOT_API_GITHUB_TOKEN` 或旧变量 `GH_TOKEN`，可以跳过 `--auth login`。GitHub token 用于访问 GitHub Copilot，不能替代上面配置的 gateway API Key。

每次启动服务或执行认证命令前，一次性的 `data-init` 服务只会修复挂载目录中属于 gateway 自身的状态文件：`config.json`、`github_token`（含企业版的 `ent_github_token`，以及 `opencode/github_token` 这类 OAuth 应用子目录）、`codex_credentials.json`、`desktop-config.json`、`copilot-api.sqlite*`、`logs/` 和 `cache/`。挂载目录中的其他文件和目录不会被改动。因此非 root 服务可以直接复用旧 root 容器写入的数据，包括权限为 `0600` 的配置文件。宿主机目录仍默认使用旧 Docker 文档中的 `./copilot-data`；Compose 将它挂载到 `/data`，并设置对应的 `COPILOT_API_HOME`。如需复用其他位置的已有目录，可在环境变量或用户自己的 `.env` 中设置 `COPILOT_API_DATA_DIR`。

```dotenv
COPILOT_API_DATA_DIR=/absolute/path/to/copilot-data
```

首次运行前请先建好宿主机目录。Compose 不会自动创建缺失的宿主机目录（`create_host_path: false`），因此 `COPILOT_API_DATA_DIR` 写错会直接报错，而不会以空状态启动。一次性的 `data-init` 服务在改归属前会拒绝 `/` 这类危险路径；当挂载内容中出现 `/etc`、`/usr` 等系统目录时（说明路径实际指向了系统根目录）也会直接拒绝运行。

默认本地地址为 `http://127.0.0.1:4141`。配置好 gateway API Key 后，如需监听宿主机所有网卡，可在用户自己的 `.env` 中设置：

```dotenv
COPILOT_API_BIND=0.0.0.0
COPILOT_API_PORT=4141
```

Compose 服务还会从环境变量或用户自己的私有 `.env` 中传入 `COPILOT_API_SQLITE_DB_PATH`、`COPILOT_API_ENTERPRISE_URL` 和 `COPILOT_API_OAUTH_APP`。SQLite 路径是容器内路径，应放在可写的 `/data` 挂载目录下，例如：

```dotenv
COPILOT_API_SQLITE_DB_PATH=/data/copilot-api.sqlite
COPILOT_API_ENTERPRISE_URL=company.ghe.com
COPILOT_API_OAUTH_APP=opencode
```

Token 和代理变量也可以在同一文件中覆盖。代理地址必须能从容器内部访问。容器内部端口保持 `4141`，以便健康检查正常工作。
