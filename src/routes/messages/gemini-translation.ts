import { consola } from "consola"

import {
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type GeminiRequest,
  type GeminiResponse,
  type GeminiContent,
  type GeminiPart,
  type GeminiTextPart,
  type GeminiFunctionCallPart,
  type GeminiFunctionResponsePart,
  type GeminiTool,
  type GeminiCandidate,
  type GeminiCountTokensRequest,
  type GeminiCountTokensResponse,
  type GeminiUsageMetadata,
} from "./gemini-types"
import { mapOpenAIFinishReasonToGemini } from "./utils"

// Model mapping for Gemini models - only map unsupported variants to supported ones
function mapGeminiModelToCopilot(geminiModel: string): string {
  const modelMap: Record<string, string> = {
    "gemini-2.5-flash": "gemini-2.0-flash-001", // Map to supported Gemini model
    "gemini-2.0-flash": "gemini-2.0-flash-001", // Map to full model name
  }

  return modelMap[geminiModel] || geminiModel // Return original if supported
}

// Request translation: Gemini -> OpenAI

export function translateGeminiToOpenAINonStream(
  payload: GeminiRequest,
  model: string,
): ChatCompletionsPayload {
  consola.info("[GEMINI_TRANSLATE] Starting non-stream translation", {
    model,
    hasTools: Boolean(payload.tools),
    toolsLength: payload.tools?.length || 0,
    hasToolConfig: Boolean(payload.toolConfig),
    contentsLength: payload.contents.length,
  })

  const result = {
    model: mapGeminiModelToCopilot(model), // Map unsupported model variants to supported ones
    messages: translateGeminiContentsToOpenAI(
      payload.contents,
      payload.systemInstruction,
    ),
    max_tokens: payload.generationConfig?.maxOutputTokens || 4096,
    stop: payload.generationConfig?.stopSequences,
    stream: false,
    temperature: payload.generationConfig?.temperature,
    top_p: payload.generationConfig?.topP,
    tools: translateGeminiToolsToOpenAI(payload.tools),
    tool_choice: translateGeminiToolConfigToOpenAI(payload.toolConfig),
  }

  consola.info("[GEMINI_TRANSLATE] Non-stream translation completed", {
    finalModel: result.model,
    messagesCount: result.messages.length,
    hasTools: Boolean(result.tools),
    toolsCount: result.tools?.length || 0,
    toolChoice: result.tool_choice,
  })

  return result
}

export function translateGeminiToOpenAIStream(
  payload: GeminiRequest,
  model: string,
): ChatCompletionsPayload {
  consola.info("[GEMINI_TRANSLATE] Starting stream translation", {
    model,
    hasTools: Boolean(payload.tools),
    toolsLength: payload.tools?.length || 0,
    hasToolConfig: Boolean(payload.toolConfig),
    contentsLength: payload.contents.length,
  })

  const result = {
    model: mapGeminiModelToCopilot(model), // Map unsupported model variants to supported ones
    messages: translateGeminiContentsToOpenAI(
      payload.contents,
      payload.systemInstruction,
    ),
    max_tokens: payload.generationConfig?.maxOutputTokens || 4096,
    stop: payload.generationConfig?.stopSequences,
    stream: true,
    temperature: payload.generationConfig?.temperature,
    top_p: payload.generationConfig?.topP,
    tools: translateGeminiToolsToOpenAI(payload.tools),
    tool_choice: translateGeminiToolConfigToOpenAI(payload.toolConfig),
  }

  consola.info("[GEMINI_TRANSLATE] Stream translation completed", {
    finalModel: result.model,
    messagesCount: result.messages.length,
    hasTools: Boolean(result.tools),
    toolsCount: result.tools?.length || 0,
    toolChoice: result.tool_choice,
  })

  return result
}

// Helper function to process function response arrays
function processFunctionResponseArray(
  responseArray: Array<{
    functionResponse: { name: string; response: unknown }
  }>,
  pendingToolCalls: Map<string, string>,
  messages: Array<Message>,
): void {
  for (const responseItem of responseArray) {
    if ("functionResponse" in responseItem) {
      const functionName = responseItem.functionResponse.name
      const toolCallId = pendingToolCalls.get(functionName)
      if (toolCallId) {
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: JSON.stringify(responseItem.functionResponse.response),
        })
        pendingToolCalls.delete(functionName)
      }
    }
  }
}

// Helper function to check if tool calls have corresponding tool responses
function hasCorrespondingToolResponses(
  messages: Array<Message>,
  toolCalls: Array<ToolCall>,
): boolean {
  const toolCallIds = new Set(toolCalls.map((call) => call.id))

  // Look for tool messages that respond to these tool calls
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      toolCallIds.delete(message.tool_call_id)
    }
  }

  // If any tool call ID remains, it means there's no corresponding response
  return toolCallIds.size === 0
}

// Helper function to process function responses in content
function processFunctionResponses(
  functionResponses: Array<GeminiFunctionResponsePart>,
  pendingToolCalls: Map<string, string>,
  messages: Array<Message>,
): void {
  for (const funcResponse of functionResponses) {
    const functionName = funcResponse.functionResponse.name
    const toolCallId = pendingToolCalls.get(functionName)
    if (toolCallId) {
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify(funcResponse.functionResponse.response),
      })
      pendingToolCalls.delete(functionName)
    }
  }
}

// Helper function to process function calls and create assistant message
function processFunctionCalls(options: {
  functionCalls: Array<GeminiFunctionCallPart>
  content: GeminiContent
  pendingToolCalls: Map<string, string>
  messages: Array<Message>
}): void {
  const { functionCalls, content, pendingToolCalls, messages } = options

  consola.info("[GEMINI_FUNCTION_CALLS] Processing function calls", {
    functionCallCount: functionCalls.length,
    functionNames: functionCalls.map((call) => call.functionCall.name),
    functionCallDetails: functionCalls.map((call) => ({
      name: call.functionCall.name,
      hasName: Boolean(call.functionCall.name),
      nameType: typeof call.functionCall.name,
      hasArgs: Boolean(call.functionCall.args),
      argsKeys: Object.keys(call.functionCall.args),
    })),
  })

  const textContent = extractTextFromGeminiContent(content)
  const toolCalls = functionCalls.map((call) => {
    const toolCallId = generateToolCallId(call.functionCall.name)
    // Remember this tool call for later matching with responses
    pendingToolCalls.set(call.functionCall.name, toolCallId)

    consola.info("[GEMINI_FUNCTION_CALLS] Creating tool call", {
      functionName: call.functionCall.name,
      toolCallId,
      argumentsString: JSON.stringify(call.functionCall.args),
    })

    return {
      id: toolCallId,
      type: "function" as const,
      function: {
        name: call.functionCall.name,
        arguments: JSON.stringify(call.functionCall.args),
      },
    }
  })

  consola.info("[GEMINI_FUNCTION_CALLS] Final assistant message", {
    toolCallCount: toolCalls.length,
    hasTextContent: Boolean(textContent),
    toolCallIds: toolCalls.map((tc) => tc.id),
    toolCallNames: toolCalls.map((tc) => tc.function.name),
  })

  messages.push({
    role: "assistant",
    content: textContent || null,
    tool_calls: toolCalls,
  })
}

function translateGeminiContentsToOpenAI(
  contents: Array<
    | GeminiContent
    | Array<{
        functionResponse: { id?: string; name: string; response: unknown }
      }>
  >,
  systemInstruction?: GeminiContent,
): Array<Message> {
  const messages: Array<Message> = []
  const pendingToolCalls = new Map<string, string>() // function name -> tool_call_id

  // Add system instruction first if present
  if (systemInstruction) {
    const systemText = extractTextFromGeminiContent(systemInstruction)
    if (systemText) {
      messages.push({ role: "system", content: systemText })
    }
  }

  // Process conversation contents
  for (const item of contents) {
    // Handle special case where Gemini CLI sends function responses as nested arrays
    if (Array.isArray(item)) {
      processFunctionResponseArray(item, pendingToolCalls, messages)
      continue
    }

    const content = item
    const role = content.role === "model" ? "assistant" : "user"

    // Check for function calls/responses
    const functionCalls = content.parts.filter(
      (part): part is GeminiFunctionCallPart => "functionCall" in part,
    )
    const functionResponses = content.parts.filter(
      (part): part is GeminiFunctionResponsePart => "functionResponse" in part,
    )

    if (functionResponses.length > 0) {
      processFunctionResponses(functionResponses, pendingToolCalls, messages)
    }

    if (functionCalls.length > 0 && role === "assistant") {
      processFunctionCalls({
        functionCalls,
        content,
        pendingToolCalls,
        messages,
      })
    } else {
      // Regular message
      const messageContent = translateGeminiContentToOpenAI(content)
      if (messageContent) {
        messages.push({ role, content: messageContent })
      }
    }
  }

  // Post-process: Remove incomplete assistant messages from cancelled tool calls
  // When Gemini CLI cancels a tool call stream, it includes the incomplete assistant
  // message in conversation history. This message contains functionCall but lacks
  // corresponding functionResponse, causing OpenAI API validation errors.
  // We need to check ALL assistant messages, not just the last one, because cancelled
  // tool calls can be anywhere in the conversation history.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (
      message.role === "assistant"
      && message.tool_calls
      && !hasCorrespondingToolResponses(messages, message.tool_calls)
    ) {
      messages.splice(i, 1)
    }
  }

  return messages
}

function translateGeminiContentToOpenAI(
  content: GeminiContent,
): string | Array<ContentPart> | null {
  if (content.parts.length === 0) return null

  const hasMedia = content.parts.some((part) => "inlineData" in part)

  if (!hasMedia) {
    // Text-only content
    return extractTextFromGeminiContent(content)
  }

  // Mixed content with media
  const contentParts: Array<ContentPart> = []
  for (const part of content.parts) {
    if ("text" in part) {
      contentParts.push({ type: "text", text: part.text })
    } else if ("inlineData" in part) {
      contentParts.push({
        type: "image_url",
        image_url: {
          url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        },
      })
    }
  }

  return contentParts
}

function extractTextFromGeminiContent(content: GeminiContent): string {
  return content.parts
    .filter((part): part is GeminiTextPart => "text" in part)
    .map((part) => part.text)
    .join("\n\n")
}

function translateGeminiToolsToOpenAI(
  geminiTools?: Array<GeminiTool>,
): Array<Tool> | undefined {
  if (!geminiTools || geminiTools.length === 0) return undefined

  consola.info("[GEMINI_TOOLS] Starting translation", {
    toolCount: geminiTools.length,
  })

  const tools: Array<Tool> = []
  for (const tool of geminiTools) {
    consola.info("[GEMINI_TOOLS] Processing tool", {
      hasFunctionDeclarations: Boolean(tool.functionDeclarations),
      hasGoogleSearch: Boolean(tool.googleSearch),
      hasUrlContext: Boolean(tool.urlContext),
      functionDeclarationsCount: tool.functionDeclarations?.length || 0,
    })

    // Handle standard function declarations
    if (tool.functionDeclarations) {
      for (const func of tool.functionDeclarations) {
        consola.info("[GEMINI_TOOLS] Processing function declaration", {
          name: func.name,
          hasName: Boolean(func.name),
          nameType: typeof func.name,
          hasDescription: Boolean(func.description),
          hasParameters: Boolean(func.parameters),
          hasParametersJsonSchema: Boolean(func.parametersJsonSchema),
        })

        // Validate that function name exists and is not empty
        if (
          !func.name
          || typeof func.name !== "string"
          || func.name.trim() === ""
        ) {
          consola.warn(
            "[GEMINI_TOOLS] Skipping function declaration - invalid or missing name",
            {
              name: func.name,
              nameType: typeof func.name,
              description: func.description,
            },
          )
          continue
        }

        // Ensure parameters is always a valid object

        const validParameters = func.parametersJsonSchema || func.parameters

        tools.push({
          type: "function",
          function: {
            name: func.name,
            description: func.description,
            parameters: validParameters,
          },
        })
      }
    }

    // Handle googleSearch tool (special case)
    if (tool.googleSearch !== undefined) {
      tools.push({
        type: "function",
        function: {
          name: "google_web_search",
          description:
            "Performs a web search using Google Search (via the Gemini API) and returns the results. This tool is useful for finding information on the internet based on a query.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search query to find information on the web.",
              },
            },
            required: ["query"],
          },
        },
      })
    }

    // Handle urlContext tool (special case for web_fetch)
    // Note: GitHub Copilot API doesn't support web_fetch functionality
    // Skip this tool to avoid "Failed to create chat completions" errors
    if (tool.urlContext !== undefined) {
      // Log that we're skipping this unsupported tool
      console.warn(
        "Skipping urlContext tool - not supported by GitHub Copilot API",
      )
      continue
    }
  }

  consola.info("[GEMINI_TOOLS] Translation completed", {
    finalToolCount: tools.length,
    toolNames: tools.map((t) => t.function.name),
  })

  return tools
}

function translateGeminiToolConfigToOpenAI(
  toolConfig?: GeminiRequest["toolConfig"],
): ChatCompletionsPayload["tool_choice"] {
  if (!toolConfig) return undefined

  const mode = toolConfig.functionCallingConfig.mode
  switch (mode) {
    case "AUTO": {
      return "auto"
    }
    case "ANY": {
      return "required"
    }
    case "NONE": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation: OpenAI -> Gemini

export function translateOpenAIToGemini(
  response: ChatCompletionResponse,
): GeminiResponse {
  const candidates: Array<GeminiCandidate> = response.choices.map(
    (choice, index) => ({
      content: translateOpenAIMessageToGeminiContent(choice.message),
      finishReason: mapOpenAIFinishReasonToGemini(choice.finish_reason),
      index,
    }),
  )

  return {
    candidates,
    usageMetadata: {
      promptTokenCount: response.usage?.prompt_tokens || 0,
      candidatesTokenCount: response.usage?.completion_tokens || 0,
      totalTokenCount: response.usage?.total_tokens || 0,
    },
  }
}

function translateOpenAIMessageToGeminiContent(
  message: Message,
): GeminiContent {
  const parts: Array<GeminiPart> = []

  // Handle text content
  if (typeof message.content === "string") {
    if (message.content) {
      parts.push({ text: message.content })
    }
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push({ text: part.text })
      } else {
        // Convert data URL back to inline data
        const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
        if (match) {
          parts.push({
            inlineData: {
              mimeType: match[1],
              data: match[2],
            },
          })
        }
      }
    }
  }

  // Handle tool calls
  if (message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      parts.push({
        functionCall: {
          name: toolCall.function.name,
          args:
            toolCall.function.arguments ?
              (JSON.parse(toolCall.function.arguments) as Record<
                string,
                unknown
              >)
            : {},
        },
      })
    }
  }

  return {
    parts,
    role: "model",
  }
}

// Utility functions

function generateToolCallId(functionName: string): string {
  return `call_${functionName}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

// Helper function to process tool calls in streaming chunks
function processToolCalls(
  toolCalls: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>,
): Array<GeminiPart> {
  consola.info("[GEMINI_STREAM_TOOLS] Processing streaming tool calls", {
    toolCallCount: toolCalls.length,
    toolCallDetails: toolCalls.map((tc) => ({
      index: tc.index,
      id: tc.id,
      type: tc.type,
      functionName: tc.function?.name,
      hasFunctionName: Boolean(tc.function?.name),
      hasArguments: Boolean(tc.function?.arguments),
      argumentsLength: tc.function?.arguments?.length || 0,
    })),
  })

  const parts: Array<GeminiPart> = []

  for (const toolCall of toolCalls) {
    if (!toolCall.function?.name) {
      consola.info(
        "[GEMINI_STREAM_TOOLS] Skipping tool call - no function name",
        {
          toolCall: {
            index: toolCall.index,
            id: toolCall.id,
            type: toolCall.type,
            functionName: toolCall.function?.name,
            hasFunction: Boolean(toolCall.function),
          },
        },
      )
      continue
    }

    let args: Record<string, unknown>
    try {
      args = JSON.parse(toolCall.function.arguments || "{}") as Record<
        string,
        unknown
      >
    } catch {
      // In streaming, arguments might be incomplete JSON
      // Skip this chunk and wait for complete arguments
      consola.info(
        "[GEMINI_STREAM_TOOLS] Skipping tool call - invalid JSON arguments",
        {
          functionName: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      )
      continue
    }

    consola.info("[GEMINI_STREAM_TOOLS] Adding function call part", {
      functionName: toolCall.function.name,
      parsedArgs: args,
    })

    parts.push({
      functionCall: {
        name: toolCall.function.name,
        args,
      },
    })
  }

  consola.info("[GEMINI_STREAM_TOOLS] Completed processing", {
    finalPartsCount: parts.length,
    functionNames: parts.map((p) =>
      "functionCall" in p ? p.functionCall.name : "unknown",
    ),
  })

  return parts
}

// Helper function to create usage metadata
function createUsageMetadata(chunk: ChatCompletionChunk): GeminiUsageMetadata {
  return {
    promptTokenCount: chunk.usage?.prompt_tokens || 0,
    candidatesTokenCount: chunk.usage?.completion_tokens || 0,
    totalTokenCount: chunk.usage?.total_tokens || 0,
  }
}

// Helper function to process chunk parts
function processChunkParts(choice: {
  delta: {
    content?: string | null
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
}): Array<GeminiPart> {
  const parts: Array<GeminiPart> = []

  if (choice.delta.content) {
    parts.push({ text: choice.delta.content })
  }

  if (choice.delta.tool_calls) {
    parts.push(...processToolCalls(choice.delta.tool_calls))
  }

  return parts
}

// Helper function to determine finish reason inclusion
function shouldIncludeFinishReason(choice: {
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  delta: {
    tool_calls?: Array<unknown>
  }
}): boolean {
  // Always include finish_reason when present, regardless of tool calls
  // This ensures proper stream termination for both text and tool call completions
  return Boolean(choice.finish_reason)
}

// Helper function to create candidate object
function createGeminiCandidate(
  parts: Array<GeminiPart>,
  mappedFinishReason: string | undefined,
  index: number,
): GeminiCandidate {
  return {
    content: {
      parts,
      role: "model",
    },
    finishReason: mappedFinishReason as GeminiCandidate["finishReason"],
    index,
  }
}

// Helper function to handle parts processing and validation
function processParts(choice: {
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  delta: {
    content?: string | null
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
}): Array<GeminiPart> | null {
  const parts = processChunkParts(choice)

  if (parts.length === 0 && !choice.finish_reason) {
    consola.info(
      "[GEMINI_CHUNK_TRANSLATE] No parts and no finish reason, returning null",
    )
    return null
  }

  // If we have a finish reason but no parts, add an empty text part
  // This ensures Gemini CLI receives a properly formatted completion chunk
  if (parts.length === 0 && choice.finish_reason) {
    consola.info(
      "[GEMINI_CHUNK_TRANSLATE] Adding empty text part for finish reason chunk",
    )
    parts.push({ text: "" })
  }

  return parts
}

// Helper function to build complete response
function buildGeminiResponse(
  candidate: GeminiCandidate,
  shouldInclude: boolean,
  chunk: ChatCompletionChunk,
): {
  candidates: Array<GeminiCandidate>
  usageMetadata?: GeminiUsageMetadata
} {
  const response: {
    candidates: Array<GeminiCandidate>
    usageMetadata?: GeminiUsageMetadata
  } = {
    candidates: [candidate],
  }

  if (shouldInclude) {
    response.usageMetadata = createUsageMetadata(chunk)
    consola.info("[GEMINI_CHUNK_TRANSLATE] Added usage metadata", {
      promptTokens: chunk.usage?.prompt_tokens || 0,
      completionTokens: chunk.usage?.completion_tokens || 0,
      totalTokens: chunk.usage?.total_tokens || 0,
    })
  }

  return response
}

// Stream translation: OpenAI Chunk -> Gemini Stream Response
export function translateOpenAIChunkToGemini(chunk: ChatCompletionChunk): {
  candidates: Array<GeminiCandidate>
  usageMetadata?: GeminiUsageMetadata
} | null {
  consola.info("[GEMINI_CHUNK_TRANSLATE] Processing OpenAI chunk", {
    choicesCount: chunk.choices.length,
    chunkId: chunk.id,
    model: chunk.model,
  })

  if (chunk.choices.length === 0) {
    consola.info("[GEMINI_CHUNK_TRANSLATE] No choices, returning null")
    return null
  }

  const choice = chunk.choices[0]
  consola.info("[GEMINI_CHUNK_TRANSLATE] Processing choice", {
    index: choice.index,
    hasContent: Boolean(choice.delta.content),
    hasToolCalls: Boolean(choice.delta.tool_calls),
    finishReason: choice.finish_reason,
    finishReasonType: typeof choice.finish_reason,
    contentLength: choice.delta.content?.length || 0,
    toolCallsCount: choice.delta.tool_calls?.length || 0,
  })

  const parts = processParts(choice)
  if (!parts) {
    return null
  }

  const shouldInclude = shouldIncludeFinishReason(choice)
  const mappedFinishReason =
    shouldInclude ?
      mapOpenAIFinishReasonToGemini(choice.finish_reason)
    : undefined

  consola.info("[GEMINI_CHUNK_TRANSLATE] Mapped finish reason", {
    original: choice.finish_reason,
    mapped: mappedFinishReason,
    shouldIncludeFinishReason: shouldInclude,
  })

  const candidate = createGeminiCandidate(
    parts,
    mappedFinishReason,
    choice.index,
  )
  const response = buildGeminiResponse(candidate, shouldInclude, chunk)

  consola.info("[GEMINI_CHUNK_TRANSLATE] Final response", {
    candidatesCount: response.candidates.length,
    hasUsageMetadata: Boolean(response.usageMetadata),
    partsCount: parts.length,
    finishReason: mappedFinishReason,
  })

  return response
}

// Token counting translation

export function translateGeminiCountTokensToOpenAI(
  request: GeminiCountTokensRequest,
  model: string,
): ChatCompletionsPayload {
  return {
    model: mapGeminiModelToCopilot(model), // Map unsupported model variants to supported ones
    messages: translateGeminiContentsToOpenAI(
      request.contents,
      request.systemInstruction,
    ),
    max_tokens: 1, // Minimal for token counting
    tools: translateGeminiToolsToOpenAI(request.tools),
  }
}

export function translateTokenCountToGemini(
  totalTokens: number,
): GeminiCountTokensResponse {
  return {
    totalTokens,
  }
}
