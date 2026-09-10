# Docker deployment

The image runs as the unprivileged `bun` user and keeps application code root-owned. GitHub authentication data, provider configuration, and other persistent gateway state belong in `/data`. Mount persistent storage there so this data survives container recreation.

The server listens on `0.0.0.0:4141` inside the container so Docker port publishing works. Compose publishes that port only on the host's `127.0.0.1` by default. The non-loopback listener requires a gateway API key and restricts CORS to the request's own origin; a GitHub token does not replace the gateway key.

## New installation

The following Compose steps are for a new installation. For an existing deployment, first read [Existing bind mounts](#existing-bind-mounts) and [Root-image or old-path migration](#root-image-or-old-path-migration). For a minimal setup without Compose, see the [direct Docker commands](../README.md#run-directly-with-docker).

From the repository root, create `.env` only if you do not already have one, build the image, and configure a strong gateway key for your API clients:

```sh
cp .env.example .env
docker compose build
docker compose run --rm copilot-api auth keys --add YOUR_GATEWAY_API_KEY
```

Choose one way to configure your upstream service. To sign in interactively or configure a provider:

```sh
docker compose run --rm copilot-api auth login
```

Alternatively, if you already have a GitHub token, skip that command and edit `.env`:

```dotenv
COPILOT_API_GITHUB_TOKEN=your_github_token_here
```

`COPILOT_API_GITHUB_TOKEN` takes precedence over the legacy `GH_TOKEN` fallback. Both supply upstream credentials, not a gateway API key. Protect `.env` with appropriate host permissions and keep it out of version control. The key passed to `auth keys --add` can appear in shell history and the process list: initialize it only on a trusted host, and never paste real keys into issues or logs.

Once credentials are configured, start the service:

```sh
docker compose up -d --no-build
docker compose ps
```

Connect your API client to `http://127.0.0.1:4141` and use the gateway key configured above.

The default `copilot-api:local` image is built from this checkout. Releases published before this change run as root and use the legacy `/root/.local/share/copilot-api` layout, so they do not provide this deployment contract; paired with this Compose file they would still run as root and populate `/data` with root-owned files. Once a release includes this contract, set `COPILOT_API_IMAGE` to that version tag or digest, then run `docker compose pull` and `docker compose up -d --no-build`.

Compose mounts its project-scoped `copilot-api-data` named volume at `/data`. This is Docker-managed storage, not the host's `./copilot-data` directory. The volume survives container recreation and `docker compose down`. **Do not use `docker compose down -v` unless intentionally deleting your data.** Keep the same Compose project name when upgrading so the service continues to use the same volume.

Compose uses a read-only root filesystem, a writable temporary filesystem, dropped capabilities, no-new-privileges, and bounded logs. Authentication commands use the same volume and restrictions as the server. `XDG_CACHE_HOME` points at `/data/cache` so the VSCode device ID persists on the writable volume; without it, the read-only root filesystem forces an ephemeral device ID on every container recreation.

## Existing bind mounts

**Do not switch an existing bind mount to the base Compose file alone:** that selects a different, initially empty named volume. After the backup and ownership preparation below, preserve the original host directory with the explicit bind-mount override:

```sh
export COPILOT_API_DATA_DIR=/absolute/path/to/existing/data
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml config --quiet
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml run --rm copilot-api auth keys --list
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml up -d --no-build
```

These commands map the host directory selected by `COPILOT_API_DATA_DIR` to `/data` inside the container. If that variable is unset, the override maps `./copilot-data` to `/data`. GitHub authentication data, provider configuration, and other gateway state stay in that host directory, rather than moving to a named volume.

Build the new image first, or explicitly pull a compatible registry image. Use the same override and Compose project name for all subsequent commands, including authentication. `auth keys --list` displays keys: run it privately. The override refuses to auto-create a missing directory, catching path typos instead of silently starting with empty state. Preserve your existing token, proxy and host-binding settings; do not overwrite an existing environment file.

## Root-image or old-path migration

The former image used `/root/.local/share/copilot-api`. Changing the image or mount target does not migrate ownership, and the Dockerfile's `chown /data` does not change a host bind mount. Do not run the gateway as root to work around this.

1. Record the current image digest, Compose project name and mount source using `docker inspect`. Stop the old service before backing up, especially because state can include SQLite databases and sidecar files.
2. Back up the **whole** existing data directory to a protected location outside the build context. Include configuration, GitHub tokens, provider credentials, databases and OAuth-app subdirectories without printing their contents.
3. Keep the original host source and change only the mount target to `/data`. Inspect the target image's UID/GID rather than assuming numeric IDs.
4. Correct ownership of the selected directory and all its files, not just the directory. Root-owned `0600` files remain unreadable after changing only their parent.
5. Run `auth keys --list` privately with the new image and the same mount. Confirm provider configuration is preserved, start the service, and check health and an authenticated request. Retain the backup for rollback.

Example on a Linux host with a rootful Docker daemon, **after stopping and backing up the old service** and building the new image:

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

Verify the resolved path before recursive ownership commands. Do not use `chmod 777`, change unrelated directories, or recursively rewrite file contents. Rootless Docker and user-namespace remapping require the corresponding host UID mapping; this rootful example does not apply unchanged. Docker Desktop and SELinux hosts have different sharing/label requirements. Test the mount with the intended runtime identity before starting.

For rollback, stop the new service and restore the protected backup plus the old image and mount definition. Do not delete current state while investigating a failure. Configuration read errors other than a missing file are reported rather than treated as an empty configuration. The entrypoint also checks data-directory access and configuration readability before startup.

## Ports, proxies and health

- Host publication uses `COPILOT_API_BIND` and `COPILOT_API_PORT`. The container always listens on the fixed internal port 4141, and the health probe targets `127.0.0.1:4141`. Change only the host mapping: passing `--port` to the container makes the probe miss and the container report unhealthy.
- Compose forwards upper- or lower-case HTTP/HTTPS/ALL/NO proxy variables, preferring nonempty uppercase values. Bun's built-in HTTP client reads `HTTP_PROXY` for `http://` targets, `HTTPS_PROXY` for `https://` targets and `NO_PROXY` for exclusions, so application traffic is proxied from the container environment alone. It does **not** read `ALL_PROXY`, so setting only `ALL_PROXY` leaves gateway requests direct; that variable is forwarded only for other tools you run inside the container. The CLI's `--proxy-env` and `--no-proxy-env` flags only affect a Node runtime and have no effect in this image. HTTP proxy support does not imply every SOCKS configuration is supported.
- `127.0.0.1` in a proxy URL means the container, not the host. Use a reachable address. On Linux, an explicitly configured `host-gateway` mapping may be needed for a host proxy.
- The health check runs `curl --noproxy '*'` against `127.0.0.1:4141` with bounded timeouts, so a configured proxy cannot intercept it. This checks local liveness, not GitHub credentials, provider availability or quota. Docker health status alone does not restart an unhealthy container; `restart: unless-stopped` responds to process exit.
- For a corporate CA, mount the trusted bundle read-only and configure the runtime's CA input. Never disable certificate verification to make a proxy work.

## Tests

The entrypoint tests also run in the main CI job as part of `bun test`. Run these checks locally before or after changing the image or the Compose files. Integration tests use disposable test volumes, synthetic keys, no outbound container network, and the same filesystem/capability restrictions as Compose.

```sh
bun test tests/docker-entrypoint.test.ts
docker build -t copilot-api:test .
COPILOT_API_DOCKER_TEST_IMAGE=copilot-api:test bun test tests/docker-smoke.test.ts
```

Without the environment variable, smoke tests are skipped. They do not touch deployed containers or existing data volumes.
