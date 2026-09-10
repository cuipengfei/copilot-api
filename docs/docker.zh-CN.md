# Docker 部署

镜像以非特权 `bun` 用户运行，应用代码仍由 root 所有。GitHub 认证数据、provider 配置和其他需要持久化的 gateway 状态存放在 `/data`。将持久化存储挂载到这里，才能在重建容器后保留这些数据。

服务在容器内监听 `0.0.0.0:4141`，以支持 Docker 端口映射。Compose 默认只将该端口发布到宿主机的 `127.0.0.1`。这种非回环监听要求先配置网关 API Key，并将 CORS 限制为请求自身的同源地址；GitHub token 不能替代网关 Key。

## 首次安装

以下 Compose 步骤用于全新安装。已有部署请先阅读[已有 bind mount 部署](#已有-bind-mount-部署)和[旧镜像迁移](#旧-root-镜像或旧路径迁移)。如果不使用 Compose，最小运行示例见 README 中的[直接使用 Docker 运行](../README.zh-CN.md#直接使用-docker-运行)。

在仓库根目录创建 `.env`（已有文件时不要覆盖），构建镜像，并配置供 API 客户端使用的强网关 Key：

```sh
cp .env.example .env
docker compose build
docker compose run --rm copilot-api auth keys --add YOUR_GATEWAY_API_KEY
```

接下来选择一种上游配置方式。如果需要交互式登录或配置 provider，执行：

```sh
docker compose run --rm copilot-api auth login
```

如果你已有 GitHub token，可以跳过这条命令，改为编辑 `.env`：

```dotenv
COPILOT_API_GITHUB_TOKEN=your_github_token_here
```

`COPILOT_API_GITHUB_TOKEN` 优先于旧变量 `GH_TOKEN`，后者仍可作为回退。二者提供的都是上游凭据，而不是网关 API Key。请限制 `.env` 的宿主机访问权限，不要将它提交到版本控制。`auth keys --add` 的 Key 参数可能出现在 shell 历史和进程列表中：只在可信主机上初始化，不要将真实 Key 粘贴到 issue 或日志。

完成凭据配置后，启动服务：

```sh
docker compose up -d --no-build
docker compose ps
```

将 API 客户端连接到 `http://127.0.0.1:4141`，并使用前面配置的网关 Key。

默认镜像 `copilot-api:local` 从当前源码构建。本次改动之前发布的版本以 root 运行，并使用旧版 `/root/.local/share/copilot-api` 路径，因此不具备本部署约定；配合本 Compose 文件使用时，容器仍以 root 运行，并会在 `/data` 中写入 root 所属的文件。等新版本包含该约定后，再把 `COPILOT_API_IMAGE` 设置为对应版本标签或摘要，然后执行 `docker compose pull` 和 `docker compose up -d --no-build`。

Compose 将项目级命名卷 `copilot-api-data` 挂载到 `/data`。它是 Docker 管理的存储，**不是**宿主机的 `./copilot-data` 目录。重建容器或执行 `docker compose down` 后，卷中的数据仍会保留。**除非明确要删除数据，不要执行 `docker compose down -v`。** 升级时保持 Compose 项目名一致，确保服务继续使用原来的卷。

Compose 使用只读根文件系统、可写临时文件系统、移除 capabilities、禁止提权和日志轮转；认证命令与服务使用相同的数据卷和限制。`XDG_CACHE_HOME` 指向 `/data/cache`，使 VSCode 设备 ID 保存在可写数据卷上；否则只读根文件系统会导致每次重建容器都生成临时设备 ID。

## 已有 bind mount 部署

**不要把已有 bind mount 部署直接换成基础 Compose：这会选择另一个初始为空的命名卷。** 完成下方备份及权限准备后，通过显式覆盖配置保留原宿主机目录：

```sh
export COPILOT_API_DATA_DIR=/absolute/path/to/existing/data
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml config --quiet
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml run --rm copilot-api auth keys --list
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml up -d --no-build
```

这些命令将 `COPILOT_API_DATA_DIR` 指定的宿主机目录映射到容器内的 `/data`；未设置该变量时，覆盖配置默认将 `./copilot-data` 映射到 `/data`。GitHub 认证数据、provider 配置和其他 gateway 状态仍保存在这个宿主机目录中，而不是迁移到命名卷。

先构建新镜像，或显式拉取兼容的仓库镜像。后续所有命令（包括认证）都使用相同覆盖配置和 Compose 项目名。`auth keys --list` 会显示 Key，请私下执行。覆盖配置拒绝自动创建不存在的目录，避免路径拼错后用空数据启动。保留已有 Token、代理及端口绑定设置，不要覆盖现有环境文件。

## 旧 root 镜像或旧路径迁移

旧镜像使用 `/root/.local/share/copilot-api`。替换镜像或挂载目标不会迁移所有权，Dockerfile 中的 `chown /data` 也不会修改宿主机 bind mount。不要通过让网关以 root 运行来绕过权限问题。

1. 使用 `docker inspect` 记录旧镜像摘要、Compose 项目名和挂载来源。先停止旧服务再备份，尤其是存在 SQLite 数据库及附属文件时。
2. 将**整个**旧数据目录备份到构建上下文之外的受保护位置，包括配置、GitHub Token、provider 凭据、数据库和 OAuth 应用子目录，不输出文件内容。
3. 保持宿主机来源不变，仅将容器内目标改为 `/data`。检查目标镜像实际 UID/GID，不要假定数字 ID。
4. 修正所选目录及其全部文件的所有权，而不只是父目录。只修改父目录后，root 所有的 `0600` 文件仍不可读。
5. 使用新镜像和相同挂载，私下执行 `auth keys --list`，确认 provider 配置保留，再启动服务并检查健康状态及带认证请求。保留备份用于回滚。

以下示例适用于 Linux 宿主机的 rootful Docker，必须**先停止并备份旧服务**，且已构建新镜像：

```sh
IMAGE=copilot-api:local
DATA_DIR=/absolute/path/to/existing/data
test -d "$DATA_DIR" || exit 1
test "$DATA_DIR" != / || exit 1
APP_UID=$(docker run --rm --entrypoint id "$IMAGE" -u bun)
APP_GID=$(docker run --rm --entrypoint id "$IMAGE" -g bun)
sudo chown -R "$APP_UID:$APP_GID" "$DATA_DIR"
sudo chmod 700 "$DATA_DIR"
```

递归修改所有权前检查解析后的实际路径。不要使用 `chmod 777`、修改无关目录或递归重写文件内容。Rootless Docker 和 user namespace remapping 需要对应的宿主机 UID 映射，不能照搬 rootful 示例。Docker Desktop 和 SELinux 主机也有不同的共享或标签要求。启动前使用预期的运行身份测试挂载。

回滚时停止新服务，恢复受保护的备份、旧镜像和旧挂载定义。排障时不要删除当前状态。读取配置时，除文件不存在外，其他错误均会报告，不会按空配置处理。入口脚本还会在启动前检查数据目录访问权限和配置文件可读性。

## 端口、代理和健康检查

- 宿主机端口发布使用 `COPILOT_API_BIND` 和 `COPILOT_API_PORT`；容器内始终监听固定端口 4141，健康检查探测 `127.0.0.1:4141`。只能修改宿主机端口映射：向容器传入 `--port` 会使探针失配，容器将报告不健康。
- Compose 转发大小写 HTTP/HTTPS/ALL/NO 代理变量，优先使用非空大写值。Bun 内置 HTTP 客户端会读取 `HTTP_PROXY`（用于 `http://` 目标）、`HTTPS_PROXY`（用于 `https://` 目标）和 `NO_PROXY`（用于排除），因此只靠容器环境即可代理应用流量。它**不读取** `ALL_PROXY`，只设置它不会代理 gateway 请求；该变量仅为容器内的其他工具转发。CLI 的 `--proxy-env` 和 `--no-proxy-env` 仅影响 Node 运行时，在本镜像中不起作用。支持 HTTP 代理不等于支持所有 SOCKS 配置。
- 代理地址中的 `127.0.0.1` 指容器自身，不是宿主机。使用容器可达地址；Linux 上访问宿主机代理可能需要显式配置 `host-gateway` 映射。
- 健康检查使用 `curl --noproxy '*'` 请求 `127.0.0.1:4141`，并限制连接及总耗时，因此已配置的代理不会拦截它。该检查仅验证本地存活，不验证 GitHub 凭据、provider 可用性或额度。Docker 健康状态本身不会重启不健康容器；`restart: unless-stopped` 针对进程退出生效。
- 企业 CA 应以只读方式挂载可信证书包，并配置运行时 CA 输入。不要通过关闭证书验证来解决代理问题。

## 测试

入口脚本测试也会作为 `bun test` 的一部分在主 CI 中运行。修改镜像或 Compose 文件前后，可在本地执行以下检查。容器测试使用一次性测试卷、合成 Key、禁用容器外网，并采用与 Compose 相同的文件系统和权限限制。

```sh
bun test tests/docker-entrypoint.test.ts
docker build -t copilot-api:test .
COPILOT_API_DOCKER_TEST_IMAGE=copilot-api:test bun test tests/docker-smoke.test.ts
```

未设置环境变量时 smoke 测试跳过，不接触已部署容器或已有数据卷。
