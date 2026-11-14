import { createHash } from "node:crypto"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import {
  createProbeCondition,
  getIntelligenceProbePrompt,
  getWantedModels,
  PREWARM_PROMPT,
  TARGET_CODE_PROMPT,
} from "../../../../src/lib/auto-probe-prompts.ts"
import { openProbeHistory } from "../../../../src/lib/auto-probe-history.ts"
import { parseFusionSelection } from "../../../../src/services/copilot/get-fusion-selection.ts"
import { createVarietyCases } from "./auto-variety-prompts.mjs"
import {
  copilotAuthInit,
  copilotCommonHeaders,
  copilotSelectionHeaders,
} from "./copilot-auth.mjs"
import { conversationHeaders, sanitizeJson } from "./probe-common.mjs"

const SOURCE_ROOT = join(import.meta.dirname, "../../../../src")
const GENERATION_INPUT = "Reply with exactly: hi"
const RETRYABLE = (status) => status === 429 || status >= 500
const RUNTIME_SEED_PROMPTS = [
  PREWARM_PROMPT,
  "Write a CSS rule to center a div using flexbox.",
  TARGET_CODE_PROMPT,
  getIntelligenceProbePrompt(),
]

export const VARIETY_DEFAULTS = {
  repeat: 1,
  intervalMs: 0,
  budgetMs: 60_000,
  maxRequests: 128,
}

export function positiveInteger(value, flag, { allowZero = false } = {}) {
  if (!/^\d+$/.test(value ?? "")) {
    throw new Error(`${flag} expects an integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) {
    throw new Error(`${flag} expects ${allowZero ? "a non-negative" : "a positive"} integer`)
  }
  return parsed
}

export function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) {
    throw new Error("--replay-date expects UTC YYYY-MM-DD")
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("--replay-date expects a valid UTC date")
  }
  return value
}

export function safeUrl(value) {
  const url = new URL(value)
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

async function saveObservation(history, observation) {
  try {
    await history.record(observation)
  } catch {
    throw new Error("history_write_failed")
  }
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex")
const sorted = (values) => [...new Set(values)].sort()
const dateOf = (observation) => observation.observedAt.slice(0, 10)

function instanceIdFor(proxyUrl) {
  const url = new URL(proxyUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--proxy-url expects an HTTP URL")
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  return `listen-${port}`
}

function fusionCase(autoCase, planVersion) {
  return {
    ...autoCase,
    condition: createProbeCondition({
      source: "fusion",
      planVersion,
      fusionMode: "hydrafusion",
      prompt: autoCase.condition.prompt,
    }),
  }
}

async function buildCases(options) {
  const autoCases = await createVarietyCases({ sourceRoot: SOURCE_ROOT })
  if (options.source === "auto") return autoCases
  const versions = options.planVersions
  const seen = new Set()
  const cases = autoCases.flatMap((autoCase) =>
    versions.map((version) => fusionCase(autoCase, version)),
  ).filter((entry) => {
    if (seen.has(entry.condition.id)) return false
    seen.add(entry.condition.id)
    return true
  })
  if (!options.runtimeSeeds) return cases
  return RUNTIME_SEED_PROMPTS.flatMap((prompt, seedIndex) =>
    versions.map((version) => {
      const match = cases.find(
        (entry) => entry.condition.planVersion === version
          && entry.condition.prompt === prompt,
      )
      if (!match) throw new Error("shared runtime seed condition is missing")
      return { ...match, id: `seed:${seedIndex}` }
    }),
  )
}

function replayCases(history, options) {
  const ids = options.replayDate === null ? null : new Set(
    history.observations
      .filter((observation) => dateOf(observation) === options.replayDate)
      .map((observation) => observation.condition.id),
  )
  return history.conditions
    .filter((condition) => condition.source === options.source)
    .filter((condition) => options.source === "auto"
      || options.planVersions.includes(condition.planVersion))
    .filter((condition) => ids === null || ids.has(condition.id))
    .map((condition) => ({
      id: `replay:${condition.id.slice(0, 12)}`,
      condition,
      prompt_sha256: sha256(condition.prompt),
    }))
}

function createBudget(options, report, controller) {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.budgetMs)
  const count = () => report.auto_requests + report.fusion_requests + report.generation_requests
  return {
    controller,
    timedOut: () => timedOut,
    clear: () => clearTimeout(timer),
    canRequest: () => !timedOut && count() < options.maxRequests,
    count(kind) {
      report[`${kind}_requests`] += 1
    },
  }
}

function retryAfterMs(response) {
  const value = response.headers.get("retry-after")
  if (value === null) return null
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

async function selectionFetch({ auth, condition, requestId, budget, report }) {
  const kind = condition.source
  const path = kind === "auto" ? "/auto" : "/model/fusion"
  const body = kind === "auto" ?
    { prompt: condition.prompt, tier: condition.tier }
  : {
      prompt: condition.prompt,
      fusion_mode: condition.fusionMode,
      plan_version: condition.planVersion,
    }
  for (let attempt = 1; ; attempt++) {
    if (!budget.canRequest()) {
      return { response: null, attempts: attempt - 1, budgetExhausted: true }
    }
    budget.count(kind)
    const response = await fetch(`${auth.base}${path}`, {
      method: "POST",
      headers: {
        ...copilotSelectionHeaders(auth, requestId),
        "VScode-SessionId": process.env.VSCODE_SESSION_ID ?? report.vscode_session_id,
        "VScode-MachineId": process.env.VSCODE_MACHINE_ID ?? report.vscode_machine_id,
      },
      body: JSON.stringify(body),
      signal: budget.controller.signal,
    })
    if (!RETRYABLE(response.status) || attempt === 2 || !budget.canRequest()) {
      return { response, attempts: attempt, budgetExhausted: false }
    }
    const waitMs = retryAfterMs(response) ?? 1000
    await delay(waitMs, undefined, { signal: budget.controller.signal })
  }
}

function validScores(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((score) => typeof score === "number" && Number.isFinite(score))
}

function parseAuto(body) {
  const model = body?.selected_model
  const endpoints = model?.supported_endpoints
  if (
    typeof model?.id !== "string" || model.id.trim() === ""
    || (endpoints !== undefined && (!Array.isArray(endpoints)
      || endpoints.some((endpoint) => typeof endpoint !== "string")))
    || (body?.hydra_scores !== undefined && !validScores(body.hydra_scores))
    || (body?.discounted_costs !== undefined && !validScores(body.discounted_costs))
    || typeof body?.session_token !== "string" || body.session_token.trim() === ""
    || typeof body?.expires_at !== "number" || !Number.isFinite(body.expires_at)
    || body.expires_at <= Date.now() / 1000
  ) {
    throw new Error("malformed_model")
  }
  return {
    modelIds: [model.id],
    supportedEndpoints: endpoints ?? null,
    sessionToken: body.session_token,
    expiresAt: body.expires_at,
    scores: validScores(body.hydra_scores) ? body.hydra_scores : null,
    discountedCosts: body.discounted_costs ?? null,
  }
}

function nanoAiu(body) {
  const value = body?.copilot_usage?.total_nano_aiu
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function rateChecks(withTokenBody, withoutTokenBody) {
  const withDetails = withTokenBody?.copilot_usage?.token_details
  const withoutDetails = withoutTokenBody?.copilot_usage?.token_details
  if (!Array.isArray(withDetails) || !Array.isArray(withoutDetails)) return []
  const withoutByType = new Map(withoutDetails.map((detail) => [detail?.token_type, detail]))
  return withDetails.flatMap((detail) => {
    const control = withoutByType.get(detail?.token_type)
    const valid = [detail, control].every((entry) =>
      typeof entry?.token_type === "string"
      && typeof entry.batch_size === "number" && entry.batch_size > 0
      && typeof entry.cost_per_batch === "number" && entry.cost_per_batch >= 0
      && typeof entry.token_count === "number" && entry.token_count >= 0)
    if (!valid || control.cost_per_batch === 0) return []
    const withRate = detail.cost_per_batch / detail.batch_size
    const withoutRate = control.cost_per_batch / control.batch_size
    return [{
      token_type: detail.token_type,
      with_token: {
        batch_size: detail.batch_size,
        cost_per_batch: detail.cost_per_batch,
        token_count: detail.token_count,
      },
      without_token: {
        batch_size: control.batch_size,
        cost_per_batch: control.cost_per_batch,
        token_count: control.token_count,
      },
      measured_discount_percent: (1 - withRate / withoutRate) * 100,
    }]
  })
}

function measuredDiscount(checks) {
  if (checks.length === 0) return null
  const first = checks[0].measured_discount_percent
  return checks.every((check) => Math.abs(check.measured_discount_percent - first) < 1e-9)
    ? first
    : null
}

async function generationFetch({ auth, modelId, endpoint, sessionToken, requestId, budget }) {
  if (!budget.canRequest()) return { budgetExhausted: true }
  const body = endpoint.endsWith("/responses") ?
    { model: modelId, input: GENERATION_INPUT, max_output_tokens: 64 }
  : endpoint.endsWith("/chat/completions") || endpoint.endsWith("/messages") ?
    {
      model: modelId,
      messages: [{ role: "user", content: GENERATION_INPUT }],
      max_tokens: 64,
    }
  : null
  if (!body) throw new Error("unsupported_generation_endpoint")
  budget.count("generation")
  const headers = conversationHeaders(copilotCommonHeaders(auth), "agent", requestId)
  if (endpoint.endsWith("/messages")) headers["anthropic-version"] = "2023-06-01"
  if (sessionToken !== null) headers["Copilot-Session-Token"] = sessionToken
  const response = await fetch(`${auth.base}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: budget.controller.signal,
  })
  let responseBody = null
  try {
    responseBody = await response.json()
  } catch {
    // HTTP status remains observable when a generation response is not JSON.
  }
  return { response, body: responseBody, budgetExhausted: false }
}

async function observeGeneration({ auth, selection, condition, requestId, budget, report }) {
  const observations = []
  for (const [index, modelId] of selection.modelIds.entries()) {
    const endpoint = condition.source === "auto" ?
      selection.supportedEndpoints?.find((candidate) => !candidate.startsWith("ws:"))
    : "/responses"
    const base = {
      condition_id: condition.id,
      step_index: condition.source === "fusion" ? index : null,
      model_id: modelId,
      endpoint: endpoint ?? null,
      expected_discount_percent: condition.source === "fusion" ? 30 : 10,
      measured_discount_percent: null,
      rate_checks: [],
    }
    const supported = endpoint && ["/responses", "/chat/completions", "/messages"]
      .some((suffix) => endpoint.endsWith(suffix))
    if (!supported) {
      report.generation_observations.push({
        ...base,
        accepted: false,
        error: endpoint ? "unsupported_generation_endpoint" : "no_supported_endpoint",
      })
      throw new Error("unsupported_generation_endpoint")
    }
    const withToken = await generationFetch({
      auth,
      modelId,
      endpoint,
      sessionToken: selection.sessionToken,
      requestId: `${requestId}-generation-${index}-with-token`,
      budget,
    })
    if (withToken.budgetExhausted) {
      return {
        observations,
        complete: false,
        stopReason: budget.timedOut() ? "deadline" : "request_budget",
      }
    }
    if (withToken.response.status === 401 || withToken.response.status === 403) {
      report.generation_observations.push({
        ...base,
        accepted: false,
        control_accepted: null,
        with_token_status: withToken.response.status,
        without_token_status: null,
      })
      observations.push({ modelId, accepted: false })
      report.identity_halt = true
      return { observations, complete: false, stopReason: "identity_halt" }
    }
    const withoutToken = await generationFetch({
      auth,
      modelId,
      endpoint,
      sessionToken: null,
      requestId: `${requestId}-generation-${index}-without-token`,
      budget,
    })
    if (withoutToken.budgetExhausted) {
      return {
        observations,
        complete: false,
        stopReason: budget.timedOut() ? "deadline" : "request_budget",
      }
    }
    const checks = rateChecks(withToken.body, withoutToken.body)
    const withCount = withToken.body?.copilot_usage?.token_details?.length
    const withoutCount = withoutToken.body?.copilot_usage?.token_details?.length
    const discount = checks.length > 0 && checks.length === withCount && checks.length === withoutCount
      ? measuredDiscount(checks)
      : null
    const accepted = withToken.response.ok && withToken.body !== null
    const controlAccepted = withoutToken.response.ok && withoutToken.body !== null
    report.generation_observations.push({
      ...base,
      accepted,
      control_accepted: controlAccepted,
      with_token_status: withToken.response.status,
      without_token_status: withoutToken.response.status,
      with_token_total_nano_aiu: nanoAiu(withToken.body),
      without_token_total_nano_aiu: nanoAiu(withoutToken.body),
      measured_discount_percent: discount,
      rate_checks: checks,
    })
    observations.push({
      modelId,
      accepted,
      ...(discount !== null && discount >= 0 && discount <= 100 ?
        { discountPercent: discount }
      : {}),
    })
    if (!accepted || !controlAccepted) {
      return { observations, complete: false, stopReason: "generation_failed" }
    }
  }
  return { observations, complete: true, stopReason: null }
}

function coverage(wanted, observed) {
  const wantedSet = new Set(wanted)
  const observedSet = new Set(observed)
  return {
    wanted: [...wanted],
    observed: sorted(observed),
    missing: wanted.filter((model) => !observedSet.has(model)),
    extra: sorted(observed.filter((model) => !wantedSet.has(model))),
  }
}

function dateComparison(previous, results, wanted, today, replayDate = null) {
  const yesterday = new Date(`${today}T00:00:00.000Z`)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  const previousDate = replayDate ?? yesterday.toISOString().slice(0, 10)
  const previousObservations = previous.filter((observation) => dateOf(observation) === previousDate)
  const currentIds = new Set(results.map((row) => row.condition_id))
  const historicalIds = new Set(previousObservations.map((observation) => observation.condition.id))
  const conditions = [...new Set([...currentIds, ...historicalIds])].sort().map((conditionId) => {
    const previousSelected = previousObservations.some(
      (observation) => observation.condition.id === conditionId && observation.outcome === "selected",
    )
    const currentRows = results.filter((row) => row.condition_id === conditionId)
    const currentSelected = currentRows.some((row) => row.status === 200 && row.models.length > 0)
    const comparable = previousSelected && currentSelected
    const previousModels = previousObservations
      .filter((observation) => observation.condition.id === conditionId && observation.outcome === "selected")
      .flatMap((observation) => observation.modelIds)
    const currentModels = currentRows.flatMap((row) => row.models)
    const olderModels = previous
      .filter((observation) => observation.condition.id === conditionId
        && dateOf(observation) < previousDate && observation.outcome === "selected")
      .flatMap((observation) => observation.modelIds)
    const before = sorted(previousModels)
    const current = sorted(currentModels)
    return {
      condition_id: conditionId,
      previous_outcome: previousSelected ? "selected"
        : previousObservations.some((observation) => observation.condition.id === conditionId) ? "error"
        : "not_observed",
      today_outcome: currentSelected ? "selected" : currentRows.length > 0 ? "error" : "not_observed",
      previous_models: before,
      today_models: current,
      added: comparable ? current.filter((model) => !before.includes(model)) : [],
      removed: comparable ? before.filter((model) => !current.includes(model)) : [],
      changed: comparable ? before.join("\0") !== current.join("\0") : null,
      recovered_models: comparable ? current.filter((model) => wanted.includes(model)
        && !before.includes(model) && olderModels.includes(model)) : [],
    }
  })
  return { previous_date: previousDate, today, conditions }
}

function stopForStatus(status) {
  return status === 401 || status === 403 ? "identity_halt" : `http_${status}`
}

export async function runSelectionVariety(options) {
  const observedAt = new Date().toISOString()
  const expectedAccount = options.business ? "business" : "individual"
  const report = {
    observed_at: observedAt,
    source: options.source,
    proxy_url: safeUrl(options.proxyUrl),
    instance_id: instanceIdFor(options.proxyUrl),
    upstream: null,
    account: expectedAccount,
    account_source: "expectation",
    complete: false,
    stop_reason: null,
    identity_halt: false,
    auto_requests: 0,
    fusion_requests: 0,
    generation_requests: 0,
    expected_cases: 0,
    repeat: options.repeat,
    plan_versions: options.source === "fusion" ? options.planVersions : null,
    replay: options.replay,
    replay_date: options.replayDate,
    results: [],
    observed_models: [],
    coverage: { wanted: [], observed: [], missing: [], extra: [] },
    generation_observations: [],
    generation_observations_complete: null,
    date_comparison: null,
    vscode_session_id: process.env.VSCODE_SESSION_ID ?? crypto.randomUUID(),
    vscode_machine_id: process.env.VSCODE_MACHINE_ID ?? crypto.randomUUID(),
  }
  const budget = createBudget(options, report, new AbortController())
  const secrets = []
  let history
  let wanted = []
  let previous = []
  let stage = "auth"
  let exitCode = 1
  try {
    const auth = await copilotAuthInit(options.proxyUrl, {
      expectedAccount,
      signal: budget.controller.signal,
    })
    report.upstream = safeUrl(auth.base)
    secrets.push(auth.token)
    stage = "setup"
    wanted = getWantedModels()
    const writer = `tester-${crypto.randomUUID()}`
    stage = "history"
    history = await openProbeHistory({
      instanceId: report.instance_id,
      writer,
      secrets,
      ...(options.historyRoot === undefined ? {} : { root: options.historyRoot }),
    })
    report.history_writer = writer
    previous = history.observations.filter(({ condition }) =>
      condition.source === options.source && (condition.source !== "fusion"
        || options.planVersions.includes(condition.planVersion)))
    stage = "cases"
    const baseCases = options.replay ? replayCases(history, options) : await buildCases(options)
    const cases = Array.from({ length: options.repeat }, () => baseCases).flat()
    report.expected_cases = cases.length
    const requestIdBase = `${options.source}-variety-${crypto.randomUUID()}`
    stage = "run"

    for (const [index, varietyCase] of cases.entries()) {
      if (budget.timedOut()) {
        report.stop_reason = "deadline"
        break
      }
      if (!budget.canRequest()) {
        report.stop_reason = "request_budget"
        break
      }
      const { condition } = varietyCase
      const row = {
        prompt_id: varietyCase.id,
        condition_id: condition.id,
        tier: condition.source === "auto" ? condition.tier : null,
        plan_version: condition.source === "fusion" ? condition.planVersion : null,
        status: null,
        attempts: 0,
        selected_model: null,
        models: [],
        steps: [],
        fusion_pattern: null,
        supported_endpoints: null,
        expires_at: null,
        hydra_scores: null,
        discounted_costs: null,
        prompt_sha256: varietyCase.prompt_sha256,
        ...(varietyCase.source ? { source: varietyCase.source } : {}),
        ...(varietyCase.sources ? { sources: varietyCase.sources } : {}),
      }
      report.results.push(row)
      const requestId = `${requestIdBase}-${index}`
      let selection
      try {
        const { response, attempts, budgetExhausted } = await selectionFetch({
          auth,
          condition,
          requestId,
          budget,
          report,
        })
        row.attempts = attempts
        if (budgetExhausted) {
          report.stop_reason = budget.timedOut() ? "deadline" : "request_budget"
          break
        }
        row.status = response.status
        if (!response.ok) {
          row.error = `http_${response.status}`
          report.stop_reason = stopForStatus(response.status)
          report.identity_halt = response.status === 401 || response.status === 403
          await saveObservation(history, {
            condition,
            observedAt: new Date().toISOString(),
            outcome: "error",
            modelIds: [],
            status: response.status,
            errorCode: row.error,
          })
          break
        }
        let body
        try {
          body = await response.json()
        } catch {
          throw new Error("malformed_model")
        }
        selection = condition.source === "auto" ? parseAuto(body) : (() => {
          const parsed = parseFusionSelection(body, condition.planVersion)
          return {
            modelIds: parsed.steps.map((step) => step.modelId),
            steps: parsed.steps,
            fusionPattern: parsed.fusionPattern,
            sessionToken: parsed.sessionToken,
            expiresAt: parsed.expiresAt,
            scores: parsed.scores ?? null,
          }
        })()
        secrets.push(selection.sessionToken)
        row.models = [...selection.modelIds]
        row.selected_model = condition.source === "auto" || selection.modelIds.length === 1
          ? selection.modelIds[0]
          : null
        row.steps = (selection.steps ?? selection.modelIds.map((modelId) => ({ modelId })))
          .map((step) => ({ model_id: step.modelId, ...(step.role ? { role: step.role } : {}) }))
        row.fusion_pattern = selection.fusionPattern ?? null
        row.supported_endpoints = selection.supportedEndpoints ?? null
        row.expires_at = new Date(selection.expiresAt * 1000).toISOString()
        row.hydra_scores = selection.scores
        row.discounted_costs = selection.discountedCosts ?? null
        let generation
        let generationStopReason = null
        if (options.withInference) {
          report.generation_observations_complete = false
          const generationResult = await observeGeneration({
            auth,
            selection,
            condition,
            requestId,
            budget,
            report,
          })
          generation = generationResult.observations
          generationStopReason = generationResult.stopReason
          report.generation_observations_complete = generationResult.complete
        }
        await saveObservation(history, {
          condition,
          observedAt: new Date().toISOString(),
          outcome: "selected",
          modelIds: selection.modelIds,
          ...(selection.scores ? { scores: selection.scores } : {}),
          ...(generation?.length ? { generation } : {}),
        })
        if (generationStopReason !== null) {
          report.stop_reason = generationStopReason
          break
        }
      } catch (error) {
        if (error?.message === "history_write_failed") {
          row.error = "history_write_failed"
          report.stop_reason = "history_write_failed"
          break
        }
        row.error = error?.message === "malformed_model" || error?.message?.includes("invalid_")
          ? "malformed_model"
          : error?.message === "unsupported_generation_endpoint" ? "unsupported_generation_endpoint"
          : error?.name ?? "Error"
        report.stop_reason = budget.timedOut() ? "deadline"
          : row.error === "malformed_model" ? "malformed_model"
          : selection ? "generation_error"
          : "network_error"
        try {
          await saveObservation(history, {
            condition,
            observedAt: new Date().toISOString(),
            outcome: selection ? "selected" : "error",
            modelIds: selection?.modelIds ?? [],
            ...(row.status ? { status: row.status } : {}),
            ...(selection ? {} : { errorCode: row.error }),
          })
        } catch {
          report.stop_reason = "history_write_failed"
        }
        break
      }
      if (index < cases.length - 1 && options.intervalMs > 0) {
        await delay(options.intervalMs, undefined, { signal: budget.controller.signal })
      }
    }

    if (report.stop_reason === null && report.results.length === cases.length
      && report.results.every((row) => row.status === 200 && row.models.length > 0)) {
      report.complete = true
      exitCode = 0
    }
  } catch (error) {
    report.error = error?.name ?? "Error"
    report.stop_reason = budget.timedOut() ? "deadline"
      : Number.isInteger(error?.status) ? `http_${error.status}`
      : stage === "auth" ? "auth_failed"
      : stage === "history" ? "history_failed"
      : stage === "run" ? "network_error"
      : "case_profile_failed"
  } finally {
    report.observed_models = sorted(report.results.flatMap((row) => row.models))
    report.coverage = coverage(wanted, report.observed_models)
    report.date_comparison = dateComparison(
      previous,
      report.results,
      wanted,
      observedAt.slice(0, 10),
      options.replayDate,
    )
    if (history) {
      try {
        await history.flush()
      } catch {
        report.complete = false
        report.stop_reason = "history_flush_failed"
        exitCode = 1
      }
    }
    budget.clear()
    console.log(JSON.stringify(sanitizeJson(report, { secrets }), null, 2))
  }
  return exitCode
}
