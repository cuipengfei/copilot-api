import consola from "consola"

import { mergeCopilotUsage } from "~/lib/token-usage"

import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
  ChatCompletionResponse,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "~/lib/types/chat-completions"
import type {
  IncompleteDetails,
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
  ResponseUsage,
  ResponsesPayload,
  ResponsesResult,
  ToolChoiceOptions,
} from "~/lib/types/responses"

type ResponseStatus = "completed" | "incomplete"

type ChatToolCallStreamState = {
  outputIndex: number
  itemId: string
  callId: string
  name: string
  arguments: string
  doneEmitted: boolean
}

export interface ChatCompletionToResponsesStreamState {
  responseCreated: boolean
  sequenceNumber: number
  terminalEmitted: boolean
  responseId?: string
  chatCompletionId?: string
  createdAt?: number
  model?: string
  outputText: string
  textOutputIndex?: number
  textItemId?: string
  textDoneEmitted: boolean
  emittedOutputItemIds: Set<string>
  doneOutputItemIds: Set<string>
  nextOutputIndex: number
  pendingStatus?: ResponseStatus
  toolCalls: Map<number, ChatToolCallStreamState>
  latestCopilotUsage?: ChatCompletionChunk["copilot_usage"]
  latestUsage?: ChatCompletionChunk["usage"]
}

type ChatCompletionsPayloadWithReasoningEffort = ChatCompletionsPayload & {
  reasoning_effort?: ResponsesPayload["reasoning"] extends infer R ?
    R extends { effort?: infer E } ?
      E
    : never
  : never
}

export const translateResponsesToChatCompletions = (
  payload: ResponsesPayload,
): ChatCompletionsPayloadWithReasoningEffort => {
  const result: ChatCompletionsPayloadWithReasoningEffort = {
    model: payload.model,
    messages: translateResponsesInputToChatMessages(payload),
    tools: translateResponsesToolsToChatTools(payload.tools),
    tool_choice: translateResponsesToolChoice(payload.tool_choice),
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_tokens: payload.max_output_tokens,
    stream: payload.stream,
    user: payload.metadata?.user_id,
  }

  if (payload.reasoning?.effort) {
    result.reasoning_effort = payload.reasoning.effort
  }

  return result
}

export const createChatCompletionToResponsesStreamState =
  (): ChatCompletionToResponsesStreamState => ({
    responseCreated: false,
    sequenceNumber: 0,
    terminalEmitted: false,
    outputText: "",
    textDoneEmitted: false,
    emittedOutputItemIds: new Set(),
    doneOutputItemIds: new Set(),
    nextOutputIndex: 0,
    toolCalls: new Map(),
  })

export const translateChatCompletionChunkToResponsesStreamEvents = (
  chunk: ChatCompletionChunk,
  state: ChatCompletionToResponsesStreamState,
): Array<ResponseStreamEvent> => {
  const events: Array<ResponseStreamEvent> = []
  rememberChunkMetadata(chunk, state)

  if (!state.responseCreated) {
    events.push({
      type: "response.created",
      sequence_number: nextSequenceNumber(state),
      response: buildResponsesResultFromStreamState(state, "in_progress"),
    })
    state.responseCreated = true
  }

  if (chunk.choices.length === 0) {
    if (chunk.usage) {
      events.push(...emitPendingTerminalEvent(state))
    }
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (delta.content && delta.content.length > 0) {
    const textOutput = ensureTextOutput(state)
    state.outputText += delta.content
    events.push(
      ...emitOutputItemAdded(
        buildTextMessageItem(state, "in_progress"),
        state,
        textOutput.outputIndex,
      ),
      {
        type: "response.output_text.delta",
        sequence_number: nextSequenceNumber(state),
        item_id: textOutput.itemId,
        output_index: textOutput.outputIndex,
        content_index: 0,
        delta: delta.content,
      },
    )
  }

  if (delta.tool_calls && delta.tool_calls.length > 0) {
    for (const toolCallDelta of delta.tool_calls) {
      const toolCallState = ensureToolCall(state, toolCallDelta)
      if (toolCallDelta.function?.arguments) {
        toolCallState.arguments += toolCallDelta.function.arguments
        events.push(
          ...emitOutputItemAdded(
            buildFunctionCallItem(toolCallState, "in_progress"),
            state,
            toolCallState.outputIndex,
          ),
          {
            type: "response.function_call_arguments.delta",
            sequence_number: nextSequenceNumber(state),
            item_id: toolCallState.itemId,
            output_index: toolCallState.outputIndex,
            delta: toolCallDelta.function.arguments,
          },
        )
      }
    }
  }

  if (choice.finish_reason) {
    events.push(...buildFinishEvents(choice.finish_reason, state))
  }

  return events
}

export const flushChatCompletionToResponsesStreamEvents = (
  state: ChatCompletionToResponsesStreamState,
): Array<ResponseStreamEvent> => emitPendingTerminalEvent(state)

export const translateChatCompletionStreamErrorToResponsesEvent = (
  error: unknown,
  state: ChatCompletionToResponsesStreamState = createChatCompletionToResponsesStreamState(),
): ResponseStreamEvent => {
  let message =
    "An unexpected error occurred during chat completions streaming."
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  }

  if (!state.responseId) {
    state.responseId = "resp_chatcmpl_failed"
  }

  return {
    type: "response.failed",
    sequence_number: nextSequenceNumber(state),
    response: buildResponsesResultFromStreamState(state, "failed", {
      code: null,
      message,
    }),
  }
}

const translateResponsesInputToChatMessages = (
  payload: ResponsesPayload,
): Array<Message> => {
  const messages: Array<Message> = []
  const instructions = payload.instructions?.trim()
  if (instructions) {
    messages.push({ role: "system", content: instructions })
  }

  if (typeof payload.input === "string") {
    messages.push({ role: "user", content: payload.input })
    return messages
  }

  if (!Array.isArray(payload.input)) {
    return messages
  }

  let droppedReasoningItems = 0
  for (const item of payload.input) {
    if ("type" in item && item.type === "reasoning") {
      droppedReasoningItems++
      continue
    }
    const message = translateResponsesInputItem(item)
    if (message) {
      messages.push(message)
    }
  }
  if (droppedReasoningItems > 0) {
    consola.info(
      `drop thinking block, reason: chat-completions fallback has no reasoning equivalent; skipped ${droppedReasoningItems} reasoning item(s)`,
    )
  }

  return messages
}

const translateResponsesInputItem = (
  item: ResponseInputItem,
): Message | undefined => {
  if (!isRecord(item)) {
    return undefined
  }

  if (isResponseInputMessage(item)) {
    return translateResponsesMessage(item)
  }

  if (isFunctionCallItem(item)) {
    return translateFunctionCall(item)
  }

  if (isFunctionCallOutputItem(item)) {
    return translateFunctionCallOutput(item)
  }

  return undefined
}

const translateResponsesMessage = (
  item: ResponseInputMessage,
): Message | undefined => {
  const role = item.role
  if (!["assistant", "developer", "system", "user"].includes(role)) {
    return undefined
  }

  const content = translateResponsesContent(item.content)
  if (content === undefined) {
    return undefined
  }

  return { role, content }
}

const translateFunctionCall = (
  item: ResponseFunctionToolCallItem,
): Message => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: item.call_id,
      type: "function",
      function: {
        name: item.name,
        arguments: item.arguments,
      },
    },
  ],
})

const translateFunctionCallOutput = (
  item: ResponseFunctionCallOutputItem,
): Message => ({
  role: "tool",
  tool_call_id: item.call_id,
  content: translateToolOutput(item.output),
})

const translateResponsesContent = (
  content: ResponseInputMessage["content"],
): Message["content"] | undefined => {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return null
  }

  const parts = content.flatMap((part) => translateResponsesContentPart(part))
  return parts.length > 0 ? parts : undefined
}

const translateResponsesContentPart = (
  part: ResponseInputContent,
): Array<ContentPart> => {
  if (!isRecord(part)) {
    return []
  }

  if (
    (part.type === "input_text" || part.type === "output_text")
    && typeof part.text === "string"
  ) {
    return [{ type: "text", text: part.text }]
  }

  return []
}

const translateToolOutput = (
  output: ResponseFunctionCallOutputItem["output"],
): Message["content"] => {
  if (typeof output === "string") {
    return output
  }

  const parts = output.flatMap((part) => translateResponsesContentPart(part))
  return parts.length > 0 ? parts : ""
}

const translateResponsesToolsToChatTools = (
  tools: ResponsesPayload["tools"],
): Array<Tool> | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }

  const translatedTools = tools.flatMap((tool) => {
    if (tool.type !== "function") {
      return []
    }

    return [
      {
        type: "function" as const,
        function: {
          name: tool.name as string,
          ...(tool.description ?
            { description: tool.description as string }
          : {}),
          parameters: (tool.parameters ?? {}) as Record<string, unknown>,
        },
      },
    ]
  })

  return translatedTools.length > 0 ? translatedTools : undefined
}

const translateResponsesToolChoice = (
  toolChoice: ResponsesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] => {
  if (!toolChoice) {
    return undefined
  }

  if (typeof toolChoice === "string") {
    return translateToolChoiceOption(toolChoice)
  }

  return {
    type: "function",
    function: { name: toolChoice.name },
  }
}

const translateToolChoiceOption = (
  toolChoice: ToolChoiceOptions,
): ChatCompletionsPayload["tool_choice"] => toolChoice

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isResponseInputMessage = (item: unknown): item is ResponseInputMessage =>
  isRecord(item)
  && (item.type === undefined || item.type === "message")
  && typeof item.role === "string"

const isFunctionCallItem = (
  item: unknown,
): item is ResponseFunctionToolCallItem =>
  isRecord(item)
  && item.type === "function_call"
  && typeof item.call_id === "string"
  && typeof item.name === "string"
  && typeof item.arguments === "string"

const isFunctionCallOutputItem = (
  item: unknown,
): item is ResponseFunctionCallOutputItem =>
  isRecord(item)
  && item.type === "function_call_output"
  && typeof item.call_id === "string"
  && (typeof item.output === "string" || Array.isArray(item.output))

export const translateChatCompletionToResponsesResult = (
  response: ChatCompletionResponse,
): ResponsesResult => {
  const choice = response.choices[0]
  const finishReason = choice.finish_reason
  const status = mapFinishReasonToStatus(finishReason)
  const outputText = choice.message.content ?? ""
  const output = mapChoiceToOutputItems(response.id, choice, status)

  return {
    id: `resp_${response.id}`,
    object: "response",
    created_at: response.created,
    model: response.model,
    output,
    output_text: outputText,
    status,
    copilot_usage: response.copilot_usage ?? null,
    usage: mapUsage(response.usage),
    error: null,
    incomplete_details: mapIncompleteDetails(finishReason),
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: null,
    tools: [],
    top_p: null,
  }
}

const mapChoiceToOutputItems = (
  responseId: string,
  choice: ChatCompletionResponse["choices"][number],
  status: ResponseStatus,
): Array<ResponseOutputItem> => {
  const items: Array<ResponseOutputItem> = []
  const content = choice.message.content

  if (content) {
    items.push(
      createMessageOutput(content, status, {
        responseId,
        choiceIndex: choice.index,
      }),
    )
  }

  for (const toolCall of choice.message.tool_calls ?? []) {
    items.push(createFunctionCallOutput(toolCall))
  }

  return items
}

const createMessageOutput = (
  text: string,
  status: ResponseStatus,
  identifiers: {
    responseId: string
    choiceIndex: number
  },
): ResponseOutputMessage => ({
  id: `msg_${identifiers.responseId}_${identifiers.choiceIndex}`,
  type: "message",
  role: "assistant",
  status,
  content: [
    {
      type: "output_text",
      text,
      annotations: [],
    },
  ],
})

const createFunctionCallOutput = (
  toolCall: ToolCall,
): ResponseOutputFunctionCall => ({
  id: `fc_${toolCall.id}`,
  type: "function_call",
  call_id: toolCall.id,
  name: toolCall.function.name,
  arguments: toolCall.function.arguments,
  status: "completed",
})

const mapFinishReasonToStatus = (
  finishReason:
    ChatCompletionResponse["choices"][number]["finish_reason"] | undefined,
): ResponseStatus => {
  if (finishReason === "length" || finishReason === "content_filter") {
    return "incomplete"
  }

  return "completed"
}

const mapIncompleteDetails = (
  finishReason:
    ChatCompletionResponse["choices"][number]["finish_reason"] | undefined,
): IncompleteDetails | null => {
  if (finishReason === "length") {
    return { reason: "max_output_tokens" }
  }

  if (finishReason === "content_filter") {
    return { reason: "content_filter" }
  }

  return null
}

const mapUsage = (
  usage: ChatCompletionResponse["usage"] | null,
): ResponseUsage | null => {
  if (!usage) {
    return null
  }

  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined && {
      input_tokens_details: {
        cached_tokens: usage.prompt_tokens_details.cached_tokens,
      },
    }),
  }
}

const rememberChunkMetadata = (
  chunk: ChatCompletionChunk,
  state: ChatCompletionToResponsesStreamState,
): void => {
  state.chatCompletionId = chunk.id
  state.responseId = `resp_${chunk.id}`
  state.createdAt = chunk.created
  state.model = chunk.model
  if (chunk.copilot_usage) {
    state.latestCopilotUsage = mergeCopilotUsage(
      state.latestCopilotUsage ?? {},
      chunk.copilot_usage,
    )
  }
  if (chunk.usage) {
    state.latestUsage = chunk.usage
  }
}

const nextSequenceNumber = (
  state: ChatCompletionToResponsesStreamState,
): number => {
  const current = state.sequenceNumber
  state.sequenceNumber += 1
  return current
}

const ensureTextOutput = (
  state: ChatCompletionToResponsesStreamState,
): { outputIndex: number; itemId: string } => {
  if (state.textOutputIndex === undefined || state.textItemId === undefined) {
    const outputIndex = state.nextOutputIndex
    state.nextOutputIndex += 1
    state.textOutputIndex = outputIndex
    state.textItemId = `msg_${state.chatCompletionId ?? "chatcmpl"}_${outputIndex}`
  }

  return {
    outputIndex: state.textOutputIndex,
    itemId: state.textItemId,
  }
}

const ensureToolCall = (
  state: ChatCompletionToResponsesStreamState,
  toolCallDelta: NonNullable<
    ChatCompletionChunk["choices"][number]["delta"]["tool_calls"]
  >[number],
): ChatToolCallStreamState => {
  const existing = state.toolCalls.get(toolCallDelta.index)
  if (existing) {
    if (toolCallDelta.id) {
      existing.callId = toolCallDelta.id
      existing.itemId = `fc_${toolCallDelta.id}`
    }
    if (toolCallDelta.function?.name) {
      existing.name = toolCallDelta.function.name
    }
    return existing
  }

  const outputIndex = state.nextOutputIndex
  state.nextOutputIndex += 1
  const callId = toolCallDelta.id ?? `call_${outputIndex}`
  const toolCallState: ChatToolCallStreamState = {
    outputIndex,
    itemId: `fc_${callId}`,
    callId,
    name: toolCallDelta.function?.name ?? "function",
    arguments: "",
    doneEmitted: false,
  }
  state.toolCalls.set(toolCallDelta.index, toolCallState)
  return toolCallState
}

const buildFinishEvents = (
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"],
  state: ChatCompletionToResponsesStreamState,
): Array<ResponseStreamEvent> => {
  const events: Array<ResponseStreamEvent> = []
  if (state.textOutputIndex !== undefined && !state.textDoneEmitted) {
    events.push(
      {
        type: "response.output_text.done",
        sequence_number: nextSequenceNumber(state),
        item_id:
          state.textItemId ?? `msg_${state.chatCompletionId ?? "chatcmpl"}_0`,
        output_index: state.textOutputIndex,
        content_index: 0,
        text: state.outputText,
      },
      ...emitOutputItemDone(
        buildTextMessageItem(
          state,
          mapFinishReasonToStatus(finishReason ?? undefined),
        ),
        state,
        state.textOutputIndex,
      ),
    )
    state.textDoneEmitted = true
  }

  for (const toolCallState of state.toolCalls.values()) {
    if (toolCallState.doneEmitted) {
      continue
    }
    events.push(
      {
        type: "response.function_call_arguments.done",
        sequence_number: nextSequenceNumber(state),
        item_id: toolCallState.itemId,
        output_index: toolCallState.outputIndex,
        name: toolCallState.name,
        arguments: toolCallState.arguments,
      },
      ...emitOutputItemDone(
        buildFunctionCallItem(
          toolCallState,
          mapFinishReasonToStatus(finishReason ?? undefined),
        ),
        state,
        toolCallState.outputIndex,
      ),
    )
    toolCallState.doneEmitted = true
  }

  state.pendingStatus = mapFinishReasonToStatus(finishReason ?? undefined)
  if (state.latestUsage) {
    events.push(...emitPendingTerminalEvent(state))
  }
  return events
}

const emitPendingTerminalEvent = (
  state: ChatCompletionToResponsesStreamState,
): Array<ResponseStreamEvent> => {
  if (!state.pendingStatus || state.terminalEmitted) {
    return []
  }

  const response = buildResponsesResultFromStreamState(
    state,
    state.pendingStatus,
  )
  state.terminalEmitted = true
  return [
    {
      type:
        response.status === "incomplete" ?
          "response.incomplete"
        : "response.completed",
      sequence_number: nextSequenceNumber(state),
      response,
    },
  ]
}

const buildResponsesResultFromStreamState = (
  state: ChatCompletionToResponsesStreamState,
  status: ResponsesResult["status"],
  error: ResponsesResult["error"] = null,
): ResponsesResult => ({
  id: state.responseId ?? "resp_chatcmpl_stream",
  object: "response",
  created_at: state.createdAt ?? 0,
  model: state.model ?? "",
  output: buildOutputItemsFromStreamState(state, status),
  output_text: state.outputText,
  status,
  copilot_usage: state.latestCopilotUsage ?? null,
  usage: mapUsage(state.latestUsage),
  error,
  incomplete_details:
    status === "incomplete" ? { reason: "max_output_tokens" } : null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: null,
  tools: [],
  top_p: null,
})

const buildOutputItemsFromStreamState = (
  state: ChatCompletionToResponsesStreamState,
  status: ResponsesResult["status"],
): Array<ResponseOutputItem> => {
  const items: Array<ResponseOutputItem> = []
  const outputStatus = status === "incomplete" ? "incomplete" : "completed"

  if (state.textOutputIndex !== undefined && state.outputText.length > 0) {
    items.push(buildTextMessageItem(state, outputStatus))
  }

  for (const toolCallState of state.toolCalls.values()) {
    items.push(buildFunctionCallItem(toolCallState, outputStatus))
  }

  return items
}

const buildTextMessageItem = (
  state: ChatCompletionToResponsesStreamState,
  status: ResponseStatus | "in_progress",
): ResponseOutputMessage => ({
  id: state.textItemId ?? `msg_${state.chatCompletionId ?? "chatcmpl"}_0`,
  type: "message",
  role: "assistant",
  status,
  content: [
    {
      type: "output_text",
      text: state.outputText,
      annotations: [],
    },
  ],
})

const buildFunctionCallItem = (
  toolCallState: ChatToolCallStreamState,
  status: ResponseStatus | "in_progress",
): ResponseOutputFunctionCall => ({
  id: toolCallState.itemId,
  type: "function_call",
  call_id: toolCallState.callId,
  name: toolCallState.name,
  arguments: toolCallState.arguments,
  status,
})

const emitOutputItemAdded = (
  item: ResponseOutputItem,
  state: ChatCompletionToResponsesStreamState,
  outputIndex: number,
): Array<ResponseOutputItemAddedEvent> => {
  const itemId = item.id
  if (!itemId || state.emittedOutputItemIds.has(itemId)) return []
  state.emittedOutputItemIds.add(itemId)
  return [
    {
      type: "response.output_item.added",
      sequence_number: nextSequenceNumber(state),
      output_index: outputIndex,
      item: cloneOutputItem(item),
    },
  ]
}

const emitOutputItemDone = (
  item: ResponseOutputItem,
  state: ChatCompletionToResponsesStreamState,
  outputIndex: number,
): Array<ResponseOutputItemDoneEvent> => {
  const itemId = item.id
  if (!itemId || state.doneOutputItemIds.has(itemId)) return []
  state.doneOutputItemIds.add(itemId)
  return [
    {
      type: "response.output_item.done",
      sequence_number: nextSequenceNumber(state),
      output_index: outputIndex,
      item: cloneOutputItem(item),
    },
  ]
}

const cloneOutputItem = (item: ResponseOutputItem): ResponseOutputItem => {
  if (item.type === "message") {
    return {
      ...item,
      content: item.content?.map((block) => ({ ...block })),
    }
  }

  if (item.type === "function_call") {
    return { ...item }
  }

  return { ...item }
}
