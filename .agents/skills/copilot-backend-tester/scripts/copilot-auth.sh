#!/bin/bash

# Shared authentication for copilot-backend-tester scripts.
# Mirrors src/start.ts -> src/lib/token.ts -> get-copilot-token.ts.

copilot_auth_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
copilot_auth_repo_root="$(cd "$copilot_auth_script_dir/../../../.." && pwd)"

copilot_auth_source_constant() {
  local name="$1"
  local file="$2"

  sed -nE \
    "s/^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+${name}[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\2/p" \
    "$copilot_auth_repo_root/$file" | head -n 1
}

copilot_auth_source_header_constant() {
  local header="$1"
  local file="$2"

  sed -nE \
    "s/.*\"${header}\":[[:space:]]*\"([^\"]+)\".*/\1/p" \
    "$copilot_auth_repo_root/$file" | tail -n 1
}

copilot_auth_proxy_port() {
  local proxy_url="$1"
  printf '%s\n' "$proxy_url" | sed -nE 's#^https?://[^/:]+:([0-9]+)(/.*)?$#\1#p'
}

copilot_auth_process_token() {
  local proxy_url="$1"
  local port
  port="$(copilot_auth_proxy_port "$proxy_url")"

  if [[ -z "$port" ]]; then
    return 0
  fi

  ps -eo args= | awk -v port="$port" '
    /src\/main\.ts[[:space:]]+start/ {
      has_port = 0
      for (i = 1; i <= NF; i++) {
        if (($i == "-p" || $i == "--port") && $(i + 1) == port) {
          has_port = 1
        }
      }
      if (has_port) {
        for (i = 1; i < NF; i++) {
          if ($i == "-g" || $i == "--github-token") {
            print $(i + 1)
            exit
          }
        }
      }
    }
  '
}

copilot_auth_file_token() {
  local app_dir="${COPILOT_API_HOME:-$HOME/.local/share/copilot-api}"
  local oauth_app="${COPILOT_API_OAUTH_APP:-}"
  local enterprise_prefix=""

  if [[ -n "${COPILOT_API_ENTERPRISE_URL:-}" ]]; then
    enterprise_prefix="ent_"
  fi

  local token_path="$app_dir/$oauth_app/${enterprise_prefix}github_token"
  if [[ -r "$token_path" ]]; then
    tr -d '\r\n' < "$token_path"
  fi
}

copilot_auth_github_token() {
  local process_token
  process_token="$(copilot_auth_process_token "${1:-}")"
  if [[ -n "$process_token" ]]; then
    printf '%s\n' "$process_token"
    return 0
  fi

  if [[ -n "${COPILOT_API_GITHUB_TOKEN:-}" ]]; then
    printf '%s\n' "$COPILOT_API_GITHUB_TOKEN"
    return 0
  fi

  copilot_auth_file_token
}

copilot_auth_init() {
  local proxy_url="${1:-http://localhost:4141}"
  local expected_account="${2:-individual}"
  local github_token
  local response_file
  local status

  COPILOT_VERSION="${COPILOT_VERSION:-$(copilot_auth_source_constant COPILOT_VERSION src/lib/api-config.ts)}"
  VSCODE_VERSION="${VSCODE_VERSION:-$(copilot_auth_source_constant FALLBACK src/services/get-vscode-version.ts)}"
  COPILOT_API_VERSION="${COPILOT_API_VERSION:-$(copilot_auth_source_constant API_VERSION src/lib/api-config.ts)}"
  GITHUB_API_VERSION="${GITHUB_API_VERSION:-$(copilot_auth_source_header_constant x-github-api-version src/lib/api-config.ts)}"
  EDITOR_DEVICE_ID="${EDITOR_DEVICE_ID:-$(cat /proc/sys/kernel/random/uuid)}"

  : "${COPILOT_VERSION:?Unable to read COPILOT_VERSION from src/lib/api-config.ts}"
  : "${VSCODE_VERSION:?Unable to read VS Code fallback from src/services/get-vscode-version.ts}"
  : "${COPILOT_API_VERSION:?Unable to read API_VERSION from src/lib/api-config.ts}"
  : "${GITHUB_API_VERSION:?Unable to read GitHub API version from src/lib/api-config.ts}"

  github_token="$(copilot_auth_github_token "$proxy_url")"
  if [[ -z "$github_token" ]]; then
    echo "ERROR: no GitHub token found; use the selected process -g/--github-token, COPILOT_API_GITHUB_TOKEN, or the repo credential file" >&2
    return 1
  fi

  response_file="$(mktemp)"

  status="$(
    curl -sS -o "$response_file" -w '%{http_code}' \
      "https://api.github.com/copilot_internal/v2/token" \
      -H "authorization: token ${github_token}" \
      -H "user-agent: GitHubCopilotChat/${COPILOT_VERSION}" \
      -H "x-github-api-version: ${GITHUB_API_VERSION}" \
      -H "x-vscode-user-agent-library-version: electron-fetch"
  )"

  if [[ "$status" != 2* ]]; then
    echo "ERROR: Copilot token exchange failed (HTTP ${status})" >&2
    rm -f "$response_file"
    return 1
  fi

  COPILOT_TOKEN="$(jq -r '.token // empty' "$response_file")"
  COPILOT_BASE="$(jq -r '.endpoints.api // empty' "$response_file")"

  if [[ -z "$COPILOT_TOKEN" ]]; then
    echo "ERROR: token exchange response did not contain .token" >&2
    rm -f "$response_file"
    return 1
  fi

  if [[ -z "$COPILOT_BASE" ]]; then
    case "$expected_account" in
      business) COPILOT_BASE="https://api.business.githubcopilot.com" ;;
      individual) COPILOT_BASE="https://api.githubcopilot.com" ;;
      *)
        echo "ERROR: token response did not contain .endpoints.api" >&2
        rm -f "$response_file"
        return 1
        ;;
    esac
  fi

  COPILOT_BASE="${COPILOT_BASE%/}"
  if [[ "$expected_account" == "business" && "$COPILOT_BASE" != *".business.githubcopilot.com" ]]; then
    echo "ERROR: --business disagrees with token endpoint ${COPILOT_BASE}" >&2
    rm -f "$response_file"
    return 1
  fi

  rm -f "$response_file"
  export COPILOT_TOKEN COPILOT_BASE COPILOT_VERSION VSCODE_VERSION
  export COPILOT_API_VERSION GITHUB_API_VERSION EDITOR_DEVICE_ID
}

copilot_auth_common_headers() {
  printf '%s\n' \
    "-H" "Authorization: Bearer ${COPILOT_TOKEN}" \
    "-H" "content-type: application/json" \
    "-H" "copilot-integration-id: vscode-chat" \
    "-H" "editor-device-id: ${EDITOR_DEVICE_ID}" \
    "-H" "editor-version: vscode/${VSCODE_VERSION}" \
    "-H" "editor-plugin-version: copilot-chat/${COPILOT_VERSION}" \
    "-H" "user-agent: GitHubCopilotChat/${COPILOT_VERSION}" \
    "-H" "x-vscode-user-agent-library-version: electron-fetch" \
    "-H" "x-github-api-version: ${COPILOT_API_VERSION}" \
    "-H" "X-Initiator: agent"
}
