import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalAccountType = state.accountType
const originalVsCodeVersion = state.vsCodeVersion

describe("decisions routes", () => {
  beforeEach(() => {
    state.copilotToken = "test-copilot-token"
    state.accountType = "business"
    state.vsCodeVersion = "1.100.0"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    state.copilotToken = originalCopilotToken
    state.accountType = originalAccountType
    state.vsCodeVersion = originalVsCodeVersion
  })

  test("forwards POST /v1/decisions and /decisions to Copilot upstream /v1/decisions", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []

    globalThis.fetch = ((
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url =
        typeof input === "string" ? input
        : input instanceof URL ? input.toString()
        : input.url
      calls.push({
        url,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      })

      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "gpt-6-luna",
            answers: [
              {
                type: "predicate",
                name: "damaged_goods",
                probability: 1,
              },
            ],
            usage: {
              input_tokens: 167,
              input_tokens_details: {
                cached_tokens: 0,
                cache_write_tokens: 0,
              },
              output_tokens: 0,
              output_tokens_details: {
                reasoning_tokens: 0,
              },
              total_tokens: 167,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-github-request-id": "req-decisions-123",
            },
          },
        ),
      )
    }) as typeof fetch

    const requestBody = {
      model: "gpt-6-luna-decisions",
      input: "The customer says their keyboard arrived with three broken keys.",
      questions: [
        {
          type: "predicate",
          name: "damaged_goods",
          instructions: "Does the customer report receiving damaged goods?",
        },
      ],
    }

    for (const path of ["/v1/decisions", "/decisions"]) {
      const response = await server.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get("x-github-request-id")).toBe(
        "req-decisions-123",
      )
      const json = await response.json()
      expect(json).toEqual({
        model: "gpt-6-luna",
        answers: [
          {
            type: "predicate",
            name: "damaged_goods",
            probability: 1,
          },
        ],
        usage: {
          input_tokens: 167,
          input_tokens_details: {
            cached_tokens: 0,
            cache_write_tokens: 0,
          },
          output_tokens: 0,
          output_tokens_details: {
            reasoning_tokens: 0,
          },
          total_tokens: 167,
        },
      })
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe(
      "https://api.business.githubcopilot.com/v1/decisions",
    )
    expect(calls[1]?.url).toBe(
      "https://api.business.githubcopilot.com/v1/decisions",
    )
    expect(calls[0]?.body).toEqual(requestBody)
  })
})
