#!/bin/bash

# Probe /models/session, optionally /models/session/intent and the final request.
# Use --list-models for the Auto model set only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./copilot-auth.sh
source "$SCRIPT_DIR/copilot-auth.sh"

PROXY_URL="${COPILOT_PROXY_URL:-http://localhost:4141}"
PROMPT="Reply with exactly: hi"
MAX_OUTPUT=256
SKIP_FINAL=false
LIST_MODELS=false
SHOW_HEADERS=false
EXPECTED_ACCOUNT="individual"

usage() {
  cat <<'EOF'
Usage: test-auto-route.sh [options]

  --proxy-url URL    Select the running copilot-api instance
  --business         Require a business token endpoint
  --list-models      Stop after /models/session and print available_models
  --skip-final       Run session + intent, but do not send the final request
  --show-headers     Print response headers (never prints Authorization)
  --prompt TEXT      Prompt used for intent/final probes
  --max-output N     Final response output limit
  --help             Show this help
EOF
}

print_safe_json() {
  jq 'del(.token, .session_token, .copilot_token, .access_token, .refresh_token)'
}

print_safe_headers() {
  sed -E '/^[Aa]uthorization:/d; /^[Cc]opilot-[Ss]ession-[Tt]oken:/d; /^[Ss]et-[Cc]ookie:/d'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy-url) PROXY_URL="$2"; shift 2 ;;
    --business) EXPECTED_ACCOUNT="business"; shift ;;
    --list-models) LIST_MODELS=true; SKIP_FINAL=true; shift ;;
    --skip-final) SKIP_FINAL=true; shift ;;
    --show-headers) SHOW_HEADERS=true; shift ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --max-output) MAX_OUTPUT="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

copilot_auth_init "$PROXY_URL" "$EXPECTED_ACCOUNT"

REQUEST_ID_BASE="auto-$(cat /proc/sys/kernel/random/uuid)"
OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mapfile -t COMMON_HEADERS < <(copilot_auth_common_headers)

SESSION_HEADERS="$(mktemp)"
INTENT_HEADERS="$(mktemp)"
FINAL_HEADERS="$(mktemp)"
trap 'rm -f "$SESSION_HEADERS" "$INTENT_HEADERS" "$FINAL_HEADERS"' EXIT

session_body='{"auto_mode":{"model_hints":["auto"]}}'
session_json="$(
  curl -sS -D "$SESSION_HEADERS" "$COPILOT_BASE/models/session" \
    "${COMMON_HEADERS[@]}" \
    -H "openai-intent: model-access" \
    -H "x-interaction-type: model-access" \
    -H "x-request-id: ${REQUEST_ID_BASE}-session" \
    -d "$session_body"
)"

echo "=== Probe Metadata ==="
jq -n \
  --arg observed_at "$OBSERVED_AT" \
  --arg proxy_url "$PROXY_URL" \
  --arg upstream "$COPILOT_BASE" \
  --arg account "$EXPECTED_ACCOUNT" \
  '{observed_at: $observed_at, proxy_url: $proxy_url, upstream: $upstream, account: $account}'
echo "=== Session Response ==="
if [[ "$SHOW_HEADERS" == "true" ]]; then
  print_safe_headers < "$SESSION_HEADERS"
  echo
fi
echo "$session_json" | print_safe_json

if ! echo "$session_json" | jq -e '.available_models | type == "array"' >/dev/null; then
  echo "ERROR: /models/session response did not contain available_models[]" >&2
  exit 1
fi

echo
echo "=== Auto Models (raw order) ==="
echo "$session_json" | jq -r '.available_models[]'
echo
echo "=== Auto Models (sorted unique) ==="
echo "$session_json" | jq -r '.available_models[]' | sort -u
echo
echo "$session_json" | jq '{count: (.available_models | length), selected_model, expires_at}'

if [[ "$LIST_MODELS" == "true" ]]; then
  exit 0
fi

session_token="$(echo "$session_json" | jq -r '.session_token // empty')"
available_models="$(echo "$session_json" | jq -c '.available_models')"
if [[ -z "$session_token" ]]; then
  echo "ERROR: session_token missing; cannot run /models/session/intent" >&2
  exit 1
fi

prompt_len="${#PROMPT}"
intent_body="$(
  jq -nc \
    --arg prompt "$PROMPT" \
    --argjson available_models "$available_models" \
    --argjson prompt_char_count "$prompt_len" \
    '{prompt: $prompt, available_models: $available_models, turn_number: 1, prompt_char_count: $prompt_char_count}'
)"

intent_json="$(
  curl -sS -D "$INTENT_HEADERS" "$COPILOT_BASE/models/session/intent" \
    "${COMMON_HEADERS[@]}" \
    -H "openai-intent: conversation-agent" \
    -H "x-interaction-type: conversation-agent" \
    -H "Copilot-Session-Token: ${session_token}" \
    -H "x-request-id: ${REQUEST_ID_BASE}-intent" \
    -d "$intent_body"
)"

echo
echo "=== Intent Response ==="
if [[ "$SHOW_HEADERS" == "true" ]]; then
  print_safe_headers < "$INTENT_HEADERS"
  echo
fi
echo "$intent_json" | print_safe_json

chosen_model="$(echo "$intent_json" | jq -r '.chosen_model // empty')"
if [[ -z "$chosen_model" ]]; then
  echo "ERROR: chosen_model missing from /models/session/intent response" >&2
  exit 1
fi

if [[ "$SKIP_FINAL" == "true" ]]; then
  exit 0
fi

echo
echo "=== Final Request ==="
if [[ "$chosen_model" == claude-* ]]; then
  final_url="$COPILOT_BASE/v1/messages"
  final_body="$(
    jq -nc \
      --arg model "$chosen_model" \
      --arg prompt "$PROMPT" \
      --argjson max_tokens "$MAX_OUTPUT" \
      '{model: $model, max_tokens: $max_tokens, stream: false, messages: [{role: "user", content: $prompt}]}'
  )"
elif [[ "$chosen_model" == gpt-5* ]]; then
  final_url="$COPILOT_BASE/responses"
  final_body="$(
    jq -nc \
      --arg model "$chosen_model" \
      --arg input "$PROMPT" \
      --argjson max_output_tokens "$MAX_OUTPUT" \
      '{model: $model, input: $input, max_output_tokens: $max_output_tokens, stream: false}'
  )"
else
  final_url="$COPILOT_BASE/chat/completions"
  final_body="$(
    jq -nc \
      --arg model "$chosen_model" \
      --arg prompt "$PROMPT" \
      --argjson max_tokens "$MAX_OUTPUT" \
      '{model: $model, max_tokens: $max_tokens, stream: false, messages: [{role: "user", content: $prompt}]}'
  )"
fi

echo "$final_body" | jq .
final_json="$(
  curl -sS -D "$FINAL_HEADERS" "$final_url" \
    "${COMMON_HEADERS[@]}" \
    -H "openai-intent: conversation-agent" \
    -H "x-interaction-type: conversation-agent" \
    -H "Copilot-Session-Token: ${session_token}" \
    -H "x-request-id: ${REQUEST_ID_BASE}-final" \
    -d "$final_body"
)"

echo
echo "=== Final Response ==="
if [[ "$SHOW_HEADERS" == "true" ]]; then
  print_safe_headers < "$FINAL_HEADERS"
  echo
fi
echo "$final_json" | print_safe_json

echo
echo "=== Extracted Summary ==="
echo "$final_json" | jq -r '
  if .content then
    {endpoint: "messages", text: ([.content[]? | select(.type == "text") | .text] | join(""))}
  elif .choices then
    {endpoint: "chat/completions", text: .choices[0].message.content}
  else
    {
      endpoint: "responses",
      text: (
        [
          .output_text?,
          (.output[]? | select(.type == "message") | .content[]? | select(.type == "output_text") | .text)
        ]
        | map(select(. != null and . != ""))
        | unique
        | join("\n")
      ),
      incomplete_reason: .incomplete_details.reason?
    }
  end'
