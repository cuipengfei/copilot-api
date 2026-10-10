// Shared authentication for copilot-backend-tester scripts.
// Mirrors the repo chain src/start.ts -> src/lib/token.ts -> get-copilot-token.ts.
// Versions and constants are read from repo sources at runtime; nothing is
// hardcoded, so upstream version bumps never require edits here.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"

const REPO_ROOT = join(import.meta.dirname, "../../../..")

function readSourceConst(name, file) {
  const src = readFileSync(join(REPO_ROOT, file), "utf8")
  const match = src.match(
    new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\s*=\\s*"([^"]+)"`, "m"),
  )
  if (!match) {
    throw new Error(`Unable to read const ${name} from ${file}`)
  }
  return match[1]
}

function readSourceHeaderConst(header, file) {
  const src = readFileSync(join(REPO_ROOT, file), "utf8")
  const re = new RegExp(`.*"${header}":\\s*"([^"]+)".*`, "g")
  let last
  for (const match of src.matchAll(re)) {
    last = match[1]
  }
  if (last === undefined) {
    throw new Error(`Unable to read header constant ${header} from ${file}`)
  }
  return last
}

function processGithubToken(proxyUrl) {
  const port = new URL(proxyUrl).port || undefined
  if (port === undefined) {
    return undefined
  }

  const lines = execSync("ps -eo args=", { encoding: "utf8" }).split("\n")
  for (const line of lines) {
    const fields = line.trim().split(/\s+/)
    if (!fields.includes("start") || !line.includes("src/main.ts")) {
      continue
    }
    let hasPort = false
    for (let i = 0; i < fields.length - 1; i++) {
      if ((fields[i] === "-p" || fields[i] === "--port") && fields[i + 1] === port) {
        hasPort = true
      }
    }
    if (!hasPort) {
      continue
    }
    for (let i = 0; i < fields.length - 1; i++) {
      if (fields[i] === "-g" || fields[i] === "--github-token") {
        return fields[i + 1]
      }
    }
  }

  return undefined
}

function fileGithubToken() {
  const appDir = process.env.COPILOT_API_HOME ?? `${process.env.HOME}/.local/share/copilot-api`
  const oauthApp = process.env.COPILOT_API_OAUTH_APP ?? ""
  const enterprisePrefix = process.env.COPILOT_API_ENTERPRISE_URL ? "ent_" : ""
  const tokenPath = join(appDir, oauthApp, `${enterprisePrefix}github_token`)

  try {
    return readFileSync(tokenPath, "utf8").replace(/[\r\n]/g, "")
  } catch {
    return undefined
  }
}

function resolveGithubToken(proxyUrl) {
  const token =
    processGithubToken(proxyUrl) ??
    process.env.COPILOT_API_GITHUB_TOKEN ??
    fileGithubToken()
  if (!token) {
    throw new Error(
      "No GitHub token found; use the selected process -g/--github-token, COPILOT_API_GITHUB_TOKEN, or the repo credential file",
    )
  }
  return token
}

export async function copilotAuthInit(proxyUrl, options) {
  // options: legacy expectedAccount string, or { expectedAccount, signal }.
  const expectedAccount = typeof options === "string" ? options : options?.expectedAccount
  const signal = typeof options === "string" ? undefined : options?.signal
  const copilotVersion = readSourceConst("COPILOT_VERSION", "src/lib/api-config.ts")
  const vscodeVersion = readSourceConst("FALLBACK", "src/services/get-vscode-version.ts")
  const apiVersion = readSourceConst("API_VERSION", "src/lib/api-config.ts")
  const githubApiVersion = readSourceHeaderConst("x-github-api-version", "src/lib/api-config.ts")

  const githubToken = resolveGithubToken(proxyUrl)

  const exchange = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${githubToken}`,
      "user-agent": `GitHubCopilotChat/${copilotVersion}`,
      "x-github-api-version": githubApiVersion,
      "x-vscode-user-agent-library-version": "electron-fetch",
    },
    signal,
  })

  if (!exchange.ok) {
    const error = new Error(`Copilot token exchange failed (HTTP ${exchange.status})`)
    error.status = exchange.status
    throw error
  }

  const exchangeBody = await exchange.json()

  if (!exchangeBody.token) {
    throw new Error("Token exchange response did not contain .token")
  }

  let base = exchangeBody.endpoints?.api ?? ""
  if (base === "") {
    if (expectedAccount === "business") {
      base = "https://api.business.githubcopilot.com"
    } else if (expectedAccount === "individual") {
      base = "https://api.githubcopilot.com"
    } else {
      throw new Error("Token response did not contain .endpoints.api")
    }
  }
  base = base.replace(/\/$/, "")

  if (expectedAccount === "business" && !base.includes(".business.githubcopilot.com")) {
    throw new Error(`--business disagrees with token endpoint ${base}`)
  }

  return {
    token: exchangeBody.token,
    base,
    copilotVersion,
    vscodeVersion,
    apiVersion,
    deviceId: process.env.EDITOR_DEVICE_ID ?? crypto.randomUUID(),
  }
}

export function copilotCommonHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.token}`,
    "content-type": "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-device-id": auth.deviceId,
    "editor-version": `vscode/${auth.vscodeVersion}`,
    "editor-plugin-version": `copilot-chat/${auth.copilotVersion}`,
    "user-agent": `GitHubCopilotChat/${auth.copilotVersion}`,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "x-github-api-version": auth.apiVersion,
    "X-Initiator": "agent",
  }
}
