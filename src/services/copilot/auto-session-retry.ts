import consola from "consola"

import {
  getAutoSessionTokenForModel,
  invalidateAutoSessionPairing,
  refreshAutoSession,
} from "~/lib/auto-session"

const isTokenRejectionStatus = (status: number): boolean =>
  status === 400 || status === 401

export const getResponseErrorMessage = async (
  response: Response,
): Promise<string | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await response.clone().text())
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
      return undefined
    }
    const error = parsed.error
    if (typeof error !== "object" || error === null || !("message" in error)) {
      return undefined
    }
    return typeof error.message === "string" ? error.message : undefined
  } catch {
    return undefined
  }
}

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

// 共享 HTTP 规则：携带 Auto 会话令牌的 400/401 若含 belong 错误，
// 说明问题在连接/内容绑定而非令牌失效：交回调用方处理并保留配对。
// 其余 400/401 按令牌失效处理一次；不附令牌、429/500、WebSocket 请求
// 一律走原路径；重新取得失败传出错误并停止本次请求。
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

  const errorMessage = await getResponseErrorMessage(response)
  if (errorMessage) {
    consola.warn(`[auto-session] upstream error: ${errorMessage}`)
  }
  if (errorMessage?.toLowerCase().includes("belong")) return response

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

  return retry()
}
