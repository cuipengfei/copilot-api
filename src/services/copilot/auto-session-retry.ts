import consola from "consola"

import {
  getAutoSessionTokenForModel,
  invalidateAutoSessionPairing,
  refreshAutoSession,
} from "~/lib/auto-session"

const isTokenRejectionStatus = (status: number): boolean =>
  status === 400 || status === 401

export const attachAutoSessionToken = async (
  headers: Record<string, string>,
  model: string,
  endpoint: string,
): Promise<void> => {
  const autoToken = await getAutoSessionTokenForModel(model, endpoint)
  if (autoToken) {
    headers["Copilot-Session-Token"] = autoToken
  }
}

// 共享 HTTP 规则：仅当本次请求已附 Auto 会话令牌且上游返回 400/401 时，
// 使该模型当前相同 session token 配对失效并重新取得一次后重试。
// 不看响应正文（正文可能不含任何已知错误串）；不附令牌、429/500、
// WebSocket 请求一律走原路径；重新取得失败传出错误并停止本次请求；
// 第二次失败由调用方按既有错误路径处理。
export const retryAfterAutoSessionTokenRejection = async (
  response: Response,
  headers: Record<string, string>,
  model: string,
  endpoint: string,
  retry: () => Promise<Response>,
): Promise<Response> => {
  const sentToken = headers["Copilot-Session-Token"]
  if (sentToken === undefined || !isTokenRejectionStatus(response.status)) {
    return response
  }

  // 快照定向失效结果：仅当该模型当前配对仍持有本请求携带的 token
  // （确认首次请求命中原 token）才删除并需要重新取得；迟到响应/并发
  // 清空不删任何现存映射、不消耗 /auto。
  const invalidated = invalidateAutoSessionPairing(model, sentToken)
  // 命中原 token 的 400/401：先摘除旧令牌，任何失败路径都不得携带它
  delete headers["Copilot-Session-Token"]
  if (invalidated) {
    // 重新取得失败传出错误并停止本次请求
    await refreshAutoSession()
  }
  await attachAutoSessionToken(headers, model, endpoint)

  consola.info(
    "[auto-session] upstream rejected auto session token, retrying once",
  )

  return retry()
}
