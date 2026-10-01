import { attachResponseHeaders } from "~/lib/response-headers"
import { retryAfterTlsCertificateVerificationFailure } from "~/services/tls-retry"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

export const fetchCodexResponsesUpstream: typeof fetchUpstreamWithLifecycle = (
  input,
  init,
  options,
) =>
  retryAfterTlsCertificateVerificationFailure(
    () => fetchUpstreamWithLifecycle(input, init, options),
    { signal: options.clientSignal },
  )

export const attachCodexResponsesHeaders = attachResponseHeaders
