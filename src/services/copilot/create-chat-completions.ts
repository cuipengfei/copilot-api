import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { generateSessionHeaders } from "~/lib/headers"
import { state } from "~/lib/state"

// Error info type
type ErrorInfo = {
  status: number
  statusText: string
  body: string
  headers: Record<string, string>
  hasTools: boolean
  toolCount: number
  toolNames: Array<string>
  toolChoice: ChatCompletionsPayload["tool_choice"]
}

// Helper function to create error info object
function createErrorInfo(
  response: Response,
  errorBody: string,
  payload: ChatCompletionsPayload,
): ErrorInfo {
  const hasTools = Boolean(payload.tools && payload.tools.length > 0)
  return {
    status: response.status,
    statusText: response.statusText,
    body: errorBody,
    headers: Object.fromEntries(response.headers.entries()),
    hasTools,
    toolCount: hasTools && payload.tools ? payload.tools.length : 0,
    toolNames:
      hasTools && payload.tools ?
        payload.tools.map((tool) => tool.function.name)
      : [],
    toolChoice: payload.tool_choice,
  }
}

// Helper function to handle error logging
function handleErrorLogging(
  errorBody: string,
  errorInfo: ErrorInfo,
  payload: ChatCompletionsPayload,
) {
  // Check if this is the specific "Tool name is required" error
  if (
    errorBody.includes("Tool name is required")
    || errorBody.includes("invalid_tool_call_format")
  ) {
    consola.error("[COPILOT_TOOLS] Tool validation error detected", {
      ...errorInfo,
      detailedPayload: JSON.stringify(
        {
          model: payload.model,
          tools: payload.tools,
          tool_choice: payload.tool_choice,
          messages: payload.messages.map((msg) => ({
            role: msg.role,
            hasContent: Boolean(msg.content),
            hasToolCalls: Boolean(msg.tool_calls),
            toolCallsCount: msg.tool_calls?.length || 0,
          })),
        },
        null,
        2,
      ),
    })
  } else {
    consola.error("Failed to create chat completions", errorInfo)
  }
}

// Helper function to validate and log tools
function validateAndLogTools(payload: ChatCompletionsPayload) {
  if (!payload.tools || payload.tools.length === 0) return

  consola.info("[COPILOT_TOOLS] Request contains tools", {
    toolCount: payload.tools.length,
    toolNames: payload.tools.map((tool) => tool.function.name),
    toolChoice: payload.tool_choice,
  })

  // Validate all tools have required fields
  for (const [index, tool] of payload.tools.entries()) {
    const toolInfo = {
      index,
      type: tool.type,
      functionName: tool.function.name,
      hasName: Boolean(tool.function.name),
      nameType: typeof tool.function.name,
      nameLength: tool.function.name.length || 0,
      hasDescription: Boolean(tool.function.description),
      hasParameters: Boolean(tool.function.parameters),
    }

    if (
      !tool.function.name
      || typeof tool.function.name !== "string"
      || tool.function.name.trim() === ""
    ) {
      consola.error("[COPILOT_TOOLS] Invalid tool detected", toolInfo)
    } else {
      consola.debug("[COPILOT_TOOLS] Tool validation passed", toolInfo)
    }
  }
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  abortSignal?: AbortSignal,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Generate headers based on current mode
  const sessionHeaders = generateSessionHeaders(payload, state.headerMode)

  // Build headers
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    ...sessionHeaders, // This includes X-Initiator
  }

  // Optional: Add debug logging for all modes
  consola.debug(
    `Headers (${state.headerMode} mode): X-Initiator=${sessionHeaders["X-Initiator"]}`,
  )

  // Enhanced logging for tool-related requests
  validateAndLogTools(payload)

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: abortSignal,
  })

  if (!response.ok) {
    // Clone response to avoid body consumption conflict
    const responseClone = response.clone()
    const errorBody = await responseClone.text()

    // Enhanced error logging for tool-related issues
    const errorInfo = createErrorInfo(response, errorBody, payload)
    handleErrorLogging(errorBody, errorInfo, payload)

    // Always include full request payload for debugging in verbose mode
    if (state.manualApprove || process.env.NODE_ENV === "development") {
      consola.debug("[COPILOT_REQUEST] Full request payload for debugging", {
        requestPayload: JSON.stringify(payload, null, 2),
      })
    }

    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
