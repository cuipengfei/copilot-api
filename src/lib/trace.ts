import type { MiddlewareHandler } from "hono"

import {
  requestContext,
  resolveTraceId,
  type RequestContext,
} from "./request-context"
import {
  getRootSessionIdFromHeaders,
  getSessionAffinityFromHeaders,
} from "./utils"

export const traceIdMiddleware: MiddlewareHandler = async (c, next) => {
  const traceId = resolveTraceId(c.req.header("x-trace-id"))

  c.header("x-trace-id", traceId)

  const context: RequestContext = {
    traceId,
    startTime: Date.now(),
    userAgent: c.req.header("user-agent") || "",
    sessionAffinity: getSessionAffinityFromHeaders(c),
    rootSessionId: getRootSessionIdFromHeaders(c),
    isClaudeCode: Boolean(c.req.header("x-claude-code-session-id")?.trim()),
    parentSessionId: c.req.header("x-parent-session-id"),
  }
  // Native headers decide child/main only from authoritative session evidence:
  // Claude root session (+ optional agent id) or an OpenCode root paired with
  // a current-session header. Request ids, lone parent ids, or a bare root
  // leave the request unknown (undefined) so marker fallback can still apply.
  const claudeSessionId = c.req.header("x-claude-code-session-id")?.trim()
  if (claudeSessionId) {
    const claudeAgentId = c.req.header("x-claude-code-agent-id")?.trim()
    context.subagent =
      claudeAgentId ?
        {
          session_id: claudeSessionId,
          agent_id: `${claudeSessionId}:${claudeAgentId}`,
          agent_type: "subagent",
        }
      : null
  } else {
    const opencodeRootId = c.req.header("x-root-session-id")?.trim()
    const currentSessionId =
      c.req.header("x-opencode-session-id")?.trim()
      || c.req.header("x-session-affinity")?.trim()
    if (opencodeRootId && currentSessionId) {
      context.subagent =
        opencodeRootId === currentSessionId ? null : (
          {
            session_id: opencodeRootId,
            agent_id: currentSessionId,
            agent_type: "subagent",
          }
        )
    }
  }

  await requestContext.run(context, async () => {
    await next()
  })
}
