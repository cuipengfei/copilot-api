import { missingValue } from "./probe-common.mjs"
import {
  isoDate,
  positiveInteger,
  runSelectionVariety,
  VARIETY_DEFAULTS,
} from "./selection-variety.mjs"

const HELP_TEXT = `Usage: test-fusion-select.mjs [options]

Probes POST /model/fusion and prints one sanitized JSON report.

Options:
  --proxy-url <url>       Local proxy URL used for credentials and instance identity
                          (default: http://localhost:4141)
  --business              Expect a business account upstream
  --plan-version <value>  1 | 2 | both (default: both)
  --runtime-seeds         Use only the four original runtime seed prompts
  --with-inference        Run billed generation pairs for every ordered step model
  --repeat <n>            Repeat the selected conditions (default: 1)
  --interval-ms <n>       Delay between conditions (default: 0)
  --budget-ms <n>         Whole-run deadline including authentication (default: 60000)
  --max-requests <n>      Shared selection and generation request budget (default: 128)
  --replay                Replay saved prompts instead of constructing new conditions
  --replay-date <date>    Replay only conditions observed on this UTC YYYY-MM-DD
  --history-root <path>   Read and write probe history below this root
  -h, --help              Show this help`

function parseArgs(argv) {
  const options = {
    proxyUrl: process.env.COPILOT_PROXY_URL ?? "http://localhost:4141",
    business: false,
    help: false,
    runtimeSeeds: false,
    planVersions: ["1", "2"],
    withInference: false,
    replay: false,
    replayDate: null,
    historyRoot: undefined,
    ...VARIETY_DEFAULTS,
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--proxy-url":
        options.proxyUrl = argv[++i] ?? missingValue("--proxy-url")
        break
      case "--business":
        options.business = true
        break
      case "--plan-version": {
        const value = argv[++i] ?? missingValue("--plan-version")
        if (value === "1" || value === "2") options.planVersions = [value]
        else if (value === "both") options.planVersions = ["1", "2"]
        else throw new Error("--plan-version expects 1, 2 or both")
        break
      }
      case "--runtime-seeds":
        options.runtimeSeeds = true
        break
      case "--with-inference":
        options.withInference = true
        break
      case "--repeat":
        options.repeat = positiveInteger(argv[++i] ?? missingValue("--repeat"), "--repeat")
        break
      case "--interval-ms":
        options.intervalMs = positiveInteger(
          argv[++i] ?? missingValue("--interval-ms"),
          "--interval-ms",
          { allowZero: true },
        )
        break
      case "--budget-ms":
        options.budgetMs = positiveInteger(argv[++i] ?? missingValue("--budget-ms"), "--budget-ms")
        break
      case "--max-requests":
        options.maxRequests = positiveInteger(
          argv[++i] ?? missingValue("--max-requests"),
          "--max-requests",
        )
        break
      case "--replay":
        options.replay = true
        break
      case "--replay-date":
        options.replayDate = isoDate(argv[++i] ?? missingValue("--replay-date"))
        options.replay = true
        break
      case "--history-root":
        options.historyRoot = argv[++i] ?? missingValue("--history-root")
        break
      case "-h":
      case "--help":
        options.help = true
        break
      default:
        throw new Error(`Unknown option: ${argv[i]}`)
    }
  }
  if (options.replay && options.runtimeSeeds) {
    throw new Error("--replay is mutually exclusive with --runtime-seeds")
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.error(HELP_TEXT)
} else {
  process.exitCode = await runSelectionVariety({ ...options, source: "fusion" })
}
