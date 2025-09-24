import { existsSync, mkdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { GeminiRequest } from "~/routes/generate-content/types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

interface DebugLogData {
  timestamp: string
  requestId: string
  originalGeminiPayload: GeminiRequest
  translatedOpenAIPayload: ChatCompletionsPayload | null
  error?: string
  processingTime?: number
}

export class DebugLogger {
  private static instance: DebugLogger | undefined
  private logDir: string

  private constructor() {
    this.logDir = process.env.DEBUG_LOG_DIR || join(process.cwd(), "debug-logs")
    this.ensureLogDir()
  }

  static getInstance(): DebugLogger {
    if (!DebugLogger.instance) {
      DebugLogger.instance = new DebugLogger()
    }
    return DebugLogger.instance
  }

  private ensureLogDir(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true })
    }
  }

  private generateLogFileName(requestId: string): string {
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
    return join(this.logDir, `debug-gemini-${timestamp}-${requestId}.log`)
  }

  async logRequest(data: {
    requestId: string
    geminiPayload: GeminiRequest
    openAIPayload?: ChatCompletionsPayload | null
    error?: string
    processingTime?: number
  }): Promise<void> {
    const logData: DebugLogData = {
      timestamp: new Date().toISOString(),
      requestId: data.requestId,
      originalGeminiPayload: data.geminiPayload,
      translatedOpenAIPayload: data.openAIPayload ?? null,
      error: data.error,
      processingTime: data.processingTime,
    }

    const logPath = this.generateLogFileName(data.requestId)

    try {
      await writeFile(logPath, JSON.stringify(logData, null, 2), "utf8")
      console.log(`[DEBUG] Logged request data to: ${logPath}`)
    } catch (writeError) {
      console.error(`[DEBUG] Failed to write log file ${logPath}:`, writeError)
    }
  }

  // For backward compatibility during development
  static async logGeminiRequest(
    geminiPayload: GeminiRequest,
    openAIPayload?: ChatCompletionsPayload,
    error?: string,
  ): Promise<void> {
    const logger = DebugLogger.getInstance()
    const requestId = Math.random().toString(36).slice(2, 8)
    await logger.logRequest({ requestId, geminiPayload, openAIPayload, error })
  }
}
