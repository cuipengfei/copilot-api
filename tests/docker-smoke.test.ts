import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const image = process.env.COPILOT_API_DOCKER_TEST_IMAGE
const containers: Array<string> = []
const volumes: Array<string> = []
const decoder = new TextDecoder()
const hardening = [
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777",
  "--network=none",
]
const provider = {
  type: "openai-compatible",
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "synthetic-provider-key",
  enabled: true,
}

/**
 * Read the cache location from Compose so the test containers use the same
 * environment as a Compose deployment instead of inventing the path. Fails
 * loudly if Compose stops setting it, because the documented VSCode device ID
 * persistence depends on that variable.
 */
let cacheHome: string | undefined
function composeCacheHome(): string {
  if (cacheHome === undefined) {
    const compose = fs.readFileSync(
      fileURLToPath(new URL("../docker-compose.yaml", import.meta.url)),
      "utf8",
    )
    const match = /^\s*XDG_CACHE_HOME:\s*(\S+)\s*$/m.exec(compose)
    if (!match) {
      throw new Error("docker-compose.yaml must set XDG_CACHE_HOME")
    }
    cacheHome = match[1]
  }
  return cacheHome
}

function command(args: Array<string>, allowFailure = false) {
  const result = Bun.spawnSync({ cmd: ["docker", ...args], timeout: 60_000 })
  const output = decoder.decode(result.stdout).trim()
  const error = decoder.decode(result.stderr).trim()
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error("Docker command failed: " + args[0] + "\n" + error)
  }
  return { code: result.exitCode, output, error }
}

function createVolume(): string {
  const volume = "copilot-review-" + randomUUID()
  command(["volume", "create", volume])
  volumes.push(volume)
  return volume
}

function volumeArguments(volume: string): Array<string> {
  return ["--mount", "type=volume,src=" + volume + ",dst=/data"]
}

function runScript(volume: string, script: string, root = false) {
  return command([
    "run",
    "--rm",
    ...volumeArguments(volume),
    ...(root ? ["--user=0"] : []),
    "--network=none",
    "--entrypoint=bun",
    image!,
    "--eval",
    script,
  ])
}

function seedProvider(volume: string): void {
  runScript(
    volume,
    [
      'import fs from "node:fs";',
      'const config = JSON.parse(fs.readFileSync("/data/config.json", "utf8"));',
      "config.providers = " + JSON.stringify({ smoke: provider }) + ";",
      'fs.writeFileSync("/data/config.json", JSON.stringify(config));',
    ].join("\n"),
  )
}

function startContainer(volume: string): string {
  const container = "copilot-review-" + randomUUID()
  containers.push(container)
  command([
    "run",
    "--detach",
    "--name",
    container,
    ...hardening,
    ...volumeArguments(volume),
    "--health-interval=1s",
    "--health-start-period=1s",
    "--env=ALL_PROXY=http://127.0.0.1:9",
    "--env=NO_PROXY=",
    "--env=XDG_CACHE_HOME=" + composeCacheHome(),
    image!,
  ])
  return container
}

async function waitHealthy(container: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const status = command([
      "inspect",
      "--format={{.State.Status}} {{.State.Health.Status}}",
      container,
    ]).output
    if (status === "running healthy") return
    if (!status.startsWith("running")) break
    await Bun.sleep(250)
  }
  throw new Error(
    "Container did not become healthy:\n"
      + command(["logs", container], true).output,
  )
}

afterEach(() => {
  for (const container of containers.splice(0))
    command(["rm", "--force", container], true)
  for (const volume of volumes.splice(0))
    command(["volume", "rm", volume], true)
})

describe.skipIf(!image)("Docker lifecycle (opt-in)", () => {
  test("bootstrap, hardened startup, proxy-safe health, cache persistence and recreation", async () => {
    const volume = createVolume()
    command([
      "run",
      "--rm",
      ...hardening,
      ...volumeArguments(volume),
      image!,
      "--auth",
      "keys",
      "--add",
      "synthetic-gateway-key",
    ])
    seedProvider(volume)
    const container = startContainer(volume)
    await waitHealthy(container)
    expect(command(["exec", container, "id", "-u"]).output).not.toBe("0")
    expect(
      command([
        "exec",
        container,
        "sh",
        "-c",
        "test ! -w /app/dist/main.js && test -w /data",
      ]).code,
    ).toBe(0)
    // Cache-path persistence check, not a device-ID lifecycle test: this smoke
    // run seeds a provider, so setupProviderMode returns before the startup path
    // that calls getVSCodeDeviceId(). Writing to the documented path still proves
    // the cache survives the read-only root filesystem and container recreation.
    expect(composeCacheHome().startsWith("/data/")).toBe(true)
    expect(
      command([
        "exec",
        container,
        "sh",
        "-c",
        'test "$XDG_CACHE_HOME" = '
          + composeCacheHome()
          + ' && mkdir -p "$XDG_CACHE_HOME/Microsoft/DeveloperTools" && printf cached > "$XDG_CACHE_HOME/Microsoft/DeveloperTools/deviceid"',
      ]).code,
    ).toBe(0)
    expect(
      command([
        "exec",
        container,
        "curl",
        "--noproxy",
        "*",
        "--max-time",
        "3",
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "http://127.0.0.1:4141/models",
      ]).output,
    ).toBe("401")
    command(["stop", "--time=10", container])
    expect(
      command(["inspect", "--format={{.State.ExitCode}}", container]).output,
    ).toBe("0")
    const replacement = startContainer(volume)
    await waitHealthy(replacement)
    expect(
      command([
        "exec",
        replacement,
        "cat",
        composeCacheHome() + "/Microsoft/DeveloperTools/deviceid",
      ]).output,
    ).toBe("cached")
    expect(
      command([
        "run",
        "--rm",
        ...hardening,
        ...volumeArguments(volume),
        image!,
        "auth",
        "keys",
        "--list",
      ]).output,
    ).toContain("synthetic-gateway-key")
  }, 90_000)

  test("fails clearly without keys or with an unwritable data volume", () => {
    const volume = createVolume()
    const noKeys = command(
      ["run", "--rm", ...hardening, ...volumeArguments(volume), image!],
      true,
    )
    expect(noKeys.code).not.toBe(0)
    expect(noKeys.output + noKeys.error).toContain("Refusing to listen")
    runScript(
      volume,
      'import fs from "node:fs"; fs.chownSync("/data", 0, 0); fs.chmodSync("/data", 0o700)',
      true,
    )
    const noWrite = command(
      [
        "run",
        "--rm",
        ...hardening,
        ...volumeArguments(volume),
        image!,
        "auth",
        "keys",
        "--list",
      ],
      true,
    )
    expect(noWrite.code).not.toBe(0)
    expect(noWrite.output + noWrite.error).toContain("Cannot write API home")
  }, 60_000)

  test("preserves legacy unreadable data instead of replacing it", () => {
    const volume = createVolume()
    const sentinel = '{"auth":{"apiKeys":["preserve-me"]}}'
    runScript(
      volume,
      'import fs from "node:fs"; fs.writeFileSync("/data/config.json", '
        + JSON.stringify(sentinel)
        + ", {mode:0o600})",
      true,
    )
    const result = command(
      ["run", "--rm", ...hardening, ...volumeArguments(volume), image!],
      true,
    )
    expect(result.code).not.toBe(0)
    expect(result.output + result.error).toContain("refusing to replace")
    expect(
      runScript(
        volume,
        'import fs from "node:fs"; process.stdout.write(fs.readFileSync("/data/config.json", "utf8"))',
        true,
      ).output,
    ).toBe(sentinel)
  }, 60_000)
})
