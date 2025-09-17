# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Build**: `bun run build` (uses tsdown)
- **Development**: `bun run dev` (with file watching)
- **Production**: `bun run start` (sets NODE_ENV=production)
- **Lint**: `bun run lint` (uses @echristian/eslint-config with cache)
- **Lint fix**: `bunx lint-staged` (fixes staged files)
- **Typecheck**: `bun run typecheck` (runs TypeScript compiler)
- **Test all**: `bun test`
- **Test single file**: `bun test tests/[filename].test.ts`
- **Package**: `bun run prepack` (builds before packaging)

## Project Architecture

### High-Level Structure
This is a GitHub Copilot API proxy server that exposes Copilot as OpenAI-compatible, Anthropic-compatible, and Gemini-compatible APIs. The server is built with Hono framework and uses Bun as the runtime.

### Core Architecture Components

**API Translation Layer** (`src/routes/messages/`):
- Translates between Anthropic Messages API format and OpenAI Chat Completions format
- Translates between Gemini API format and OpenAI Chat Completions format
- Handles both streaming and non-streaming responses
- Key files: `handler.ts`, `anthropic-types.ts`, `stream-translation.ts`, `non-stream-translation.ts`
- Gemini files: `gemini-handler.ts`, `gemini-translation.ts`, `gemini-types.ts`, `gemini-route.ts`

**Token Counting for Anthropic Models** (`src/lib/tokenizer.ts`):
- Uses `gpt-tokenizer/model/gpt-4o` for token counting
- Separates input tokens (all messages except last assistant message) from output tokens (last assistant message)
- Filters out tool messages and extracts text content from multipart messages
- Used by `/v1/messages/count_tokens` endpoint for Anthropic compatibility

**GitHub Copilot Integration** (`src/services/`):
- Authentication flow using device code OAuth
- Token management and refresh
- API requests to GitHub Copilot endpoints
- Usage monitoring and quota tracking

**Rate Limiting & Controls** (`src/lib/`):
- Rate limiting between requests (`rate-limit.ts`)
- Manual approval system for requests (`approval.ts`)
- State management for server configuration (`state.ts`)

### API Endpoints Structure

**OpenAI Compatible**:
- `/v1/chat/completions` - Chat completions
- `/v1/models` - Available models
- `/v1/embeddings` - Text embeddings

**Anthropic Compatible**:
- `/v1/messages` - Message completions (translates to/from OpenAI format)
- `/v1/messages/count_tokens` - Token counting for Anthropic format

**Gemini Compatible**:
- `/v1beta/models/{model}:generateContent` - Standard generation
- `/v1beta/models/{model}:streamGenerateContent` - Streaming generation
- `/v1beta/models/{model}:countTokens` - Token counting

**Monitoring**:
- `/usage` - GitHub Copilot usage dashboard
- `/token` - Current Copilot token info

### Key Implementation Details

**Anthropic Token Counting**:
The `getTokenCount()` function in `src/lib/tokenizer.ts` implements token counting specifically for Anthropic compatibility:
- Converts multipart content to text-only for counting
- Splits messages into input (all except last assistant) and output (last assistant message only)
- Uses GPT-4o tokenizer as the underlying counting mechanism
- Returns `{input: number, output: number}` format

**Message Translation**:
- OpenAI → Anthropic: Converts chat completion responses to Anthropic message format
- Anthropic → OpenAI: Converts Anthropic message requests to OpenAI chat completion format
- OpenAI → Gemini: Converts chat completion responses to Gemini response format
- Gemini → OpenAI: Converts Gemini requests to OpenAI chat completion format
- Handles tool calls, system messages, and content blocks appropriately for all formats

**Streaming Translation**:
Real-time conversion of OpenAI SSE chunks to both Anthropic streaming events and Gemini streaming responses, maintaining state for proper message reconstruction.

**Gemini API Implementation**:
The Gemini integration (`src/routes/messages/gemini-*`) provides:
- Full compatibility with Google's Gemini API specification
- Comprehensive request/response translation between Gemini and OpenAI formats
- Support for function calling, multimodal content (text + images), and streaming
- Extensive debug logging with file-based logs in `logs/` directory
- Error handling with appropriate HTTP status codes and Gemini-formatted error responses
- Support for generation configuration (temperature, max tokens, top-p, stop sequences)

**Key Architectural Patterns**:
- **Comprehensive Logging**: The `gemini-handler.ts` implements a robust, file-based logging system. All requests, responses, translations, and errors are logged to `logs/`. Pay special attention to `gemini-translation.log` for debugging payload transformations. The system automatically truncates large data fields in logs to maintain readability.
- **Non-Streaming to Streaming Conversion**: For streaming endpoints, if the upstream Copilot service returns a non-streaming response, the `handleNonStreamingToStreaming` function in `gemini-handler.ts` intelligently converts the complete response back into a Gemini-compatible stream. This handles API behavior inconsistencies gracefully.
- **Route Matching Strategy**: The router in `gemini-route.ts` uses ordered, overlapping wildcard paths (`/v1beta/models/*`). The order of registration is critical: more specific endpoints like `:streamGenerateContent` must be registered before the general `:generateContent` endpoint to ensure correct handler invocation.

**Critical Gemini Translation Details**:
- **Dynamic Tool Call ID Generation**: The `tool_call_id` required by the OpenAI format is not present in the Gemini request. It is dynamically generated during translation by the `generateToolCallId` function. This ID is then temporarily stored in the `pendingToolCalls` map (keyed by function name) to correctly associate a subsequent `functionResponse` with the original `functionCall`.
- Gemini CLI sends function responses as **nested arrays** in `contents`, requiring special handling in `translateGeminiContentsToOpenAI()` via the `processFunctionResponseArray` helper.
- The `parametersJsonSchema` field takes precedence over `parameters` in function declarations to align with modern JSON Schema standards.
- **Critical Bug Fix**: Both the nested array (`processFunctionResponseArray`) and direct `functionResponse` part handling must use the same tool_call_id lookup pattern (`pendingToolCalls.get(functionName)`) to avoid OpenAI API validation errors when a user responds to a tool call.
- **Cancelled Tool Call Handling**: The `translateGeminiContentsToOpenAI` function includes post-processing logic to remove incomplete assistant messages with cancelled tool calls from ANY position in conversation history (not just the last message). This prevents 400 Bad Request errors when Gemini CLI includes cancelled tool calls in context.

## Code Style & Conventions

- **TypeScript**: Strict mode enabled, avoid `any` types
- **Imports**: Use `~/*` path aliases for `src/*` imports
- **Error Handling**: Use explicit error classes from `src/lib/error.ts`
- **Testing**: Place tests in `tests/` directory with `*.test.ts` naming
- **Formatting**: Prettier with package.json plugin (NO semicolons)
- **Linting**: @echristian/eslint-config with strict rules

**Critical Code Style Rules**:
- **No semicolons**: Project uses Prettier without semicolons - removing semicolons will fix many lint errors
- **Operator placement**: Use `&&` and `||` operators at the start of continuation lines, not at the end
- **String quotes**: Use double quotes consistently (`"text"` not `'text'`)
- **Import sorting**: Group imports with proper spacing between different import sources

## Important Notes

- Server uses GitHub Copilot as the underlying LLM provider
- Rate limiting and manual approval features help avoid GitHub abuse detection
- Token counting uses GPT-4o tokenizer regardless of the actual model being proxied
- All API translations maintain compatibility with OpenAI, Anthropic, and Gemini client libraries
- Gemini API debugging logs are written to `logs/` directory for troubleshooting translation issues
- **Development Workflow**: Claude should NOT run the server. The user will handle server testing and provide results for analysis.

## Common TypeScript and Lint Issues

**Routing and Path Parameter Issues**:
- **Gemini route patterns**: Cannot use standard Hono path parameters (`:model`) for routes containing colons like `/v1beta/models/gemini-2.5-pro:countTokens`
- **Solution**: Use wildcard routes (`/v1beta/models/*`) with URL string matching (`url.includes(":countTokens")`)
- **Model extraction**: Use regex pattern `/\/v1beta\/models\/([^:]+):/` to extract model name from URL
- **Route order**: More specific routes (streamGenerateContent) must be registered before general routes (generateContent)

**Token Counting Semantic Issues**:
- **Problem**: `handleGeminiCountTokens` was only returning `tokenCounts.input` instead of total tokens
- **Solution**: Calculate `totalTokens = tokenCounts.input + tokenCounts.output` before passing to `translateTokenCountToGemini()`
- **Context**: `getTokenCount()` returns `{input: number, output: number}` but Gemini expects total count

**Error Handling Patterns**:
- **Standard pattern**: Always use `forwardError(c, error)` from `~/lib/error` instead of custom error handling
- **Route level**: Wrap handler calls in try-catch blocks at route level, not inside handler functions
- **Avoid**: Custom error status mapping functions - use repository standard patterns

**Circular Import Prevention**:
- **Problem**: Importing utility functions between route and handler files creates circular dependencies
- **Solution**: Duplicate simple utility functions rather than sharing between tightly coupled modules
- **Example**: `extractModelFromUrl()` function should be in handler file, not shared from route file

**Shared Utility Reuse**:
- **Stop reason mapping**: Use `mapOpenAIFinishReasonToGemini` from `~/routes/messages/utils.ts` instead of duplicating
- **Pattern**: Check `utils.ts` for existing functions before implementing new utility functions
- **Import order**: Ensure proper import grouping when adding shared utility imports

## Debugging & Troubleshooting

**Common Gemini API Issues**:
- **Function calls fail while text prompts work**: Check `logs/gemini-translation.log` for missing `parameters` in translated tools
- **Tool response mapping errors**: Verify tool_call_id consistency between assistant tool calls and user tool responses
- **Nested array handling**: Gemini CLI sends function responses as nested arrays requiring `processFunctionResponseArray()` extraction
- **tool_call_id mismatch errors**: Ensure both `processFunctionResponseArray()` and direct function response handling use `pendingToolCalls.get(functionName)` consistently
- **Cancelled tool call errors**: 400 Bad Request errors may occur when Gemini CLI includes cancelled tool calls in conversation history. The post-processing logic in `translateGeminiContentsToOpenAI()` removes these incomplete assistant messages from all positions in the conversation.
- **HTTPError from create-chat-completions**: Usually indicates parameter validation failure in OpenAI translation layer
- **ESLint max-depth violations**: Extract helper functions when nested loops exceed 4 levels of depth

**Key Log Files**:
- `logs/gemini-errors.log`: HTTP errors and stack traces
- `logs/gemini-debug.log`: Request/response flow with full JSON payloads
- `logs/gemini-translation.log`: Translation pipeline details showing input/output transformations

**Debugging Commands**:
- `bun run lint && bun run typecheck && bun run build`: Full validation pipeline
- Check error reports in `C:\Users\39764\AppData\Local\Temp\gemini-client-error-*.json` for client-side failures