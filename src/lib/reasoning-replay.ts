const PRIMARY_SESSION_HEADERS = [
  "x-session-id",
  "x-claude-code-session-id",
  "session-id",
  "session_id",
]

const FALLBACK_SESSION_HEADERS = [
  "x-root-session-id",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-client-request-id",
  "thread-id",
]

/**
 * Identity used to scope `belong`-replay learning to one client conversation.
 * Derived only from explicit headers/cache key: never from payload text, its
 * hash, or a requestContext-derived fallback session id.
 */
export function getReasoningReplayIdentity(
  headers: Headers,
  promptCacheKey?: string | null,
): string | undefined {
  const read = (name: string) => headers.get(name)?.trim() || undefined
  const session =
    PRIMARY_SESSION_HEADERS.map(read).find(Boolean)
    ?? (promptCacheKey?.trim() || undefined)
    ?? FALLBACK_SESSION_HEADERS.map(read).find(Boolean)
  if (session === undefined) return undefined
  return JSON.stringify([session, read("x-oc-agent") ?? "_"])
}
