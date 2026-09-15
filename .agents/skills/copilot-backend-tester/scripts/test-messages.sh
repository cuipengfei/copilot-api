#!/bin/bash

# Test GitHub Copilot /v1/messages directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./copilot-auth.sh
source "$SCRIPT_DIR/copilot-auth.sh"

if [[ "${1:-}" == "--help" ]]; then
  sed -n '/^usage()/,/^}/p' "$0" | sed '1d;$d'
  exit 0
fi

MODEL="${1:-}"
if [[ -z "$MODEL" ]]; then
  echo "ERROR: provide a live model ID as the first argument" >&2
  exit 1
fi
shift

PROXY_URL="${COPILOT_PROXY_URL:-http://localhost:4141}"
PROMPT="What is 2+2? Answer in one word."
INITIATOR="agent"
ADAPTIVE=false
EFFORT=""
THINKING_BUDGET=""
STREAM=false
SHOW_HEADERS=false
EXPECTED_ACCOUNT="individual"

usage() {
  cat <<'EOF'
Usage: test-messages.sh LIVE_MODEL_ID [options]

  --proxy-url URL    Select the running copilot-api instance
  --business         Require a business token endpoint
  --prompt TEXT      Prompt
  --initiator VALUE  X-Initiator value
  --adaptive         Use adaptive thinking
  --effort VALUE     Set output effort
  --thinking N       Set thinking budget
  --stream           Request streaming output
  --show-headers     Print response headers without Authorization
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy-url) PROXY_URL="$2"; shift 2 ;;
    --business) EXPECTED_ACCOUNT="business"; shift ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --initiator) INITIATOR="$2"; shift 2 ;;
    --adaptive) ADAPTIVE=true; shift ;;
    --effort) EFFORT="$2"; shift 2 ;;
    --thinking) THINKING_BUDGET="$2"; shift 2 ;;
    --stream) STREAM=true; shift ;;
    --show-headers) SHOW_HEADERS=true; shift ;;
    --help) usage; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

copilot_auth_init "$PROXY_URL" "$EXPECTED_ACCOUNT"

thinking_json='null'
if [[ "$ADAPTIVE" == "true" ]]; then
  thinking_json='{"type":"adaptive"}'
elif [[ -n "$THINKING_BUDGET" ]]; then
  thinking_json="$(jq -nc --argjson budget "$THINKING_BUDGET" '{type: "enabled", budget_tokens: $budget}')"
fi

output_config='null'
if [[ -n "$EFFORT" ]]; then
  output_config="$(jq -nc --arg effort "$EFFORT" '{effort: $effort}')"
fi

body="$(
  jq -nc \
    --arg model "$MODEL" \
    --arg prompt "$PROMPT" \
    --argjson thinking "$thinking_json" \
    --argjson output_config "$output_config" \
    --argjson stream "$STREAM" \
    '{
      model: $model,
      max_tokens: 1024,
      stream: $stream,
      thinking: $thinking,
      output_config: $output_config,
      temperature: 1,
      messages: [{role: "user", content: $prompt}]
    } | with_entries(select(.value != null))'
)"

headers=(
  -H "Authorization: Bearer ${COPILOT_TOKEN}"
  -H "content-type: application/json"
  -H "copilot-integration-id: vscode-chat"
  -H "editor-device-id: ${EDITOR_DEVICE_ID}"
  -H "editor-version: vscode/${VSCODE_VERSION}"
  -H "editor-plugin-version: copilot-chat/${COPILOT_VERSION}"
  -H "user-agent: GitHubCopilotChat/${COPILOT_VERSION}"
  -H "openai-intent: conversation-agent"
  -H "x-interaction-type: conversation-agent"
  -H "x-vscode-user-agent-library-version: electron-fetch"
  -H "x-github-api-version: ${COPILOT_API_VERSION}"
  -H "X-Initiator: ${INITIATOR}"
  -H "x-request-id: messages-$(cat /proc/sys/kernel/random/uuid)"
)

echo "=== Request ==="
echo "$body" | jq .
echo "=== Response ==="

header_file="$(mktemp)"
body_file="$(mktemp)"
trap 'rm -f "$header_file" "$body_file"' EXIT

if [[ "$STREAM" == "true" ]]; then
  curl -sSN -D "$header_file" -o "$body_file" \
    "$COPILOT_BASE/v1/messages" "${headers[@]}" -d "$body"
else
  curl -sS -D "$header_file" -o "$body_file" \
    "$COPILOT_BASE/v1/messages" "${headers[@]}" -d "$body"
fi

if [[ "$SHOW_HEADERS" == "true" ]]; then
  echo "=== Response Headers ==="
  sed -E '/^[Aa]uthorization:/d; /^[Cc]opilot-[Ss]ession-[Tt]oken:/d; /^[Ss]et-[Cc]ookie:/d' "$header_file"
fi
cat "$body_file"
if [[ "$STREAM" != "true" ]]; then
  echo
  jq . "$body_file"
fi
