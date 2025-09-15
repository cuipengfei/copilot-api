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

## Code Style & Conventions

- **TypeScript**: Strict mode enabled, avoid `any` types
- **Imports**: Use `~/*` path aliases for `src/*` imports
- **Error Handling**: Use explicit error classes from `src/lib/error.ts`
- **Testing**: Place tests in `tests/` directory with `*.test.ts` naming
- **Formatting**: Prettier with package.json plugin
- **Linting**: @echristian/eslint-config with strict rules

## Important Notes

- Server uses GitHub Copilot as the underlying LLM provider
- Rate limiting and manual approval features help avoid GitHub abuse detection
- Token counting uses GPT-4o tokenizer regardless of the actual model being proxied
- All API translations maintain compatibility with OpenAI, Anthropic, and Gemini client libraries
- Gemini API debugging logs are written to `logs/` directory for troubleshooting translation issues