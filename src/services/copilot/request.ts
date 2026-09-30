import type { UpstreamTransportConfig } from "~/lib/config-store"

import { retryAfterInvalidAutoModeSelector } from "~/services/copilot/auto-session-retry"
import { retryAfterTlsCertificateVerificationFailure } from "~/services/tls-retry"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

export interface CopilotHttpRequestOptions {
  headers: Record<string, string>
  payload: { model: string }
  clientSignal?: AbortSignal
  transportConfig: Pick<
    Required<UpstreamTransportConfig>,
    "headersTimeoutMs" | "streamInactivityTimeoutMs"
  >
}

export const sendCopilotHttpRequest = (
  url: string,
  {
    headers,
    payload,
    clientSignal,
    transportConfig,
  }: CopilotHttpRequestOptions,
): Promise<Response> =>
  retryAfterTlsCertificateVerificationFailure(
    () =>
      fetchUpstreamWithLifecycle(
        url,
        { method: "POST", headers, body: JSON.stringify(payload) },
        {
          clientSignal,
          headersTimeoutMs: transportConfig.headersTimeoutMs,
          streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
        },
      ),
    { signal: clientSignal },
  )

export const sendCopilotRequest = async (
  url: string,
  options: CopilotHttpRequestOptions,
): Promise<Response> => {
  const sendRequest = () => sendCopilotHttpRequest(url, options)
  return retryAfterInvalidAutoModeSelector(
    await sendRequest(),
    options.headers,
    options.payload.model,
    sendRequest,
  )
}
