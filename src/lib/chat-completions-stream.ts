import type { ServerSentEventMessage } from "fetch-event-stream"

import { mergeCopilotUsage } from "./token-usage"
import type { ChatCompletionChunk } from "./types/chat-completions"

export interface ChatCompletionFailure {
  message: string
  type: string
  code: string | null
}

interface FailureDetails {
  message?: unknown
  type?: unknown
  code?: unknown
}

interface ChatCompletionStreamEvent {
  message: ServerSentEventMessage
  completion: ChatCompletionChunk | null
  failure?: ChatCompletionFailure
}

export function getChatCompletionFailure(
  value: unknown,
  event?: string,
): ChatCompletionFailure | null {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as {
        choices?: unknown
        error?: unknown
        copilot_errors?: unknown
      })
    : null
  const finishFailed =
    Array.isArray(record?.choices)
    && record.choices.some(
      (choice: unknown) =>
        typeof choice === "object"
        && choice !== null
        && "finish_reason" in choice
        && choice.finish_reason === "error",
    )
  const error = record?.error
  const hasError =
    typeof error === "string" ? error.trim().length > 0
    : typeof error === "object" && error !== null ?
      Object.keys(error).length > 0
    : Boolean(error)
  if (!finishFailed && !hasError && event !== "error") return null

  const details =
    readFailureDetails(hasError ? error : record?.copilot_errors)
    ?? (event === "error" ? readFailureDetails(value) : null)
  const code = safeErrorIdentifier(details?.code)
  const type = safeErrorIdentifier(details?.type) ?? "api_error"
  const message = safeErrorMessage(details?.message)
  const fallback =
    finishFailed && !hasError ?
      "Provider returned error finish_reason"
    : "Upstream chat completion failed."
  return {
    message: message ?? fallback,
    type,
    code,
  }
}

/** Drain failed streams so usage reaches clients before the single error. */
export async function* guardChatCompletionsStream(
  source: AsyncIterable<unknown>,
  options?: { reportPostFinishErrors?: boolean },
): AsyncGenerator<ChatCompletionStreamEvent> {
  let terminalSeen = false
  let doneSeen = false
  let failure: ChatCompletionFailure | null = null
  let usage: ChatCompletionChunk["usage"]
  let copilotUsage: ChatCompletionChunk["copilot_usage"]
  let metadata: Partial<ChatCompletionChunk> = {}

  try {
    for await (const value of source) {
      const envelope =
        typeof value === "object"
        && value !== null
        && ("data" in value || "event" in value || "comment" in value)
      const message: ServerSentEventMessage =
        envelope ?
          (value as ServerSentEventMessage)
        : { data: JSON.stringify(value) }
      const data = envelope ? parseChunkData(message.data) : value
      const completion = parseCompletion(data)
      const candidate =
        typeof data === "object" && data !== null && !Array.isArray(data) ?
          (data as Partial<ChatCompletionChunk>)
        : null
      if (candidate) {
        metadata = { ...metadata, ...chunkMetadata(candidate) }
        if (candidate.usage) {
          usage = {
            ...usage,
            ...candidate.usage,
            prompt_tokens_details:
              candidate.usage.prompt_tokens_details ?
                {
                  ...usage?.prompt_tokens_details,
                  ...candidate.usage.prompt_tokens_details,
                }
              : usage?.prompt_tokens_details,
            completion_tokens_details:
              candidate.usage.completion_tokens_details ?
                {
                  ...usage?.completion_tokens_details,
                  ...candidate.usage.completion_tokens_details,
                }
              : usage?.completion_tokens_details,
          }
        }
        if (candidate.copilot_usage) {
          copilotUsage = mergeCopilotUsage(
            copilotUsage ?? {},
            candidate.copilot_usage,
          )
        }
      }

      if (failure) continue
      failure = getChatCompletionFailure(data, message.event)
      if (failure) {
        const partial = partialCompletion(completion)
        if (partial) {
          yield {
            message: { data: JSON.stringify(partial) },
            completion: partial,
          }
        }
        continue
      }

      if (message.data?.trim() === "[DONE]") {
        terminalSeen = true
        doneSeen = true
      }
      if (
        completion?.choices?.some(
          (choice) => typeof choice.finish_reason === "string",
        )
      ) {
        terminalSeen = true
      }
      yield { message, completion }
    }
  } catch {
    if (
      !failure
      && !doneSeen
      && (!terminalSeen || options?.reportPostFinishErrors)
    ) {
      failure = {
        type: "api_error",
        code: "upstream_stream_error",
        message: "Upstream chat completion stream failed, retry your request.",
      }
    }
  }

  if (!failure && !terminalSeen) {
    failure = {
      type: "api_error",
      code: "incomplete_stream",
      message:
        "Upstream chat completion stream ended before a terminal event, retry your request.",
    }
  }
  if (!failure) return

  if (usage || copilotUsage) {
    const completion = {
      ...metadata,
      choices: [],
      ...(usage && { usage }),
      ...(copilotUsage && { copilot_usage: copilotUsage }),
    } as ChatCompletionChunk
    yield { message: { data: JSON.stringify(completion) }, completion }
  }
  yield {
    message: { event: "error", data: JSON.stringify({ error: failure }) },
    completion: null,
    failure,
  }
}

function readFailureDetails(value: unknown): FailureDetails | null {
  if (typeof value === "string" && value.trim()) return { message: value }
  if (Array.isArray(value)) {
    for (const item of value) {
      const details = readFailureDetails(item)
      if (details) return details
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  if ("message" in value || "code" in value || "type" in value) {
    return value
  }
  return "error" in value ? readFailureDetails(value.error) : null
}

function safeErrorIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null
  const identifier = value.trim()
  return (
      /^[a-z\d][a-z\d_.-]{0,63}$/iu.test(identifier)
        && !/^(?:sk-|gh[pousr]_|github_pat_|eyJ)/u.test(identifier)
    ) ?
      identifier
    : null
}

function safeErrorMessage(value: unknown): string | null {
  if (typeof value !== "string") return null
  // Error text sometimes appends a serialized request or credential headers.
  const message = value
    .split(
      /\b(?:authorization|proxy-authorization|copilot[-_ ]edits[-_ ]session|session(?:[-_ ](?:id|token))?|(?:x[-_])?api[-_ ]key|access[-_ ]token|refresh[-_ ]token|cookie|set-cookie|headers?|request(?:[-_ ]body)?)\b["']?\s*[:={[]/iu,
    )[0]
    .replace(/https?:\/\/[^\s]+/giu, "[redacted URL]")
    .replace(
      /\b(?:Bearer\s+\S+|sk-[a-z\d_-]+|gh[pousr]_[a-z\d_]+|github_pat_[a-z\d_]+|eyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+)/giu,
      "[redacted]",
    )
    .replace(/\p{Cc}/gu, " ")
    .replace(/[\s;,{"']+$/gu, "")
    .trim()
    .slice(0, 1024)
  return /[\p{L}\p{N}]/u.test(message) ? message : null
}

function parseChunkData(data: string | undefined): unknown {
  if (!data || data.trim() === "[DONE]") return null
  try {
    return JSON.parse(data) as unknown
  } catch {
    return data
  }
}

function parseCompletion(data: unknown): ChatCompletionChunk | null {
  return (
      typeof data === "object"
        && data !== null
        && !Array.isArray(data)
        && (!("choices" in data)
          || data.choices === null
          || (Array.isArray(data.choices)
            && data.choices.every(
              (choice: unknown) =>
                typeof choice === "object" && choice !== null,
            )))
    ) ?
      (data as ChatCompletionChunk)
    : null
}

function chunkMetadata(
  chunk: Partial<ChatCompletionChunk>,
): Partial<ChatCompletionChunk> {
  return {
    ...(chunk.id !== undefined && { id: chunk.id }),
    ...(chunk.object !== undefined && { object: chunk.object }),
    ...(chunk.created !== undefined && { created: chunk.created }),
    ...(chunk.model !== undefined && { model: chunk.model }),
    ...(chunk.system_fingerprint !== undefined && {
      system_fingerprint: chunk.system_fingerprint,
    }),
  }
}

function partialCompletion(
  chunk: ChatCompletionChunk | null,
): ChatCompletionChunk | null {
  const choices = chunk?.choices
    ?.filter((choice) => {
      const delta = choice.delta
      return (
        delta
        && (delta.content
          || delta.role
          || delta.tool_calls?.length
          || delta.reasoning
          || delta.reasoning_text
          || delta.reasoning_content
          || delta.reasoning_opaque)
      )
    })
    .map((choice) => ({
      index: choice.index,
      delta: choice.delta,
      finish_reason: null,
      logprobs: null,
    }))
  return chunk && choices?.length ?
      ({
        ...chunkMetadata(chunk),
        choices,
      } as ChatCompletionChunk)
    : null
}
