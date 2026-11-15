import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const isolatedHome = process.env.COPILOT_API_TEST_HOME
if (
  !isolatedHome
  || os.homedir() !== isolatedHome
  || process.env.HOME !== isolatedHome
  || !process.env.XDG_CACHE_HOME
) {
  throw new Error(
    "Tests require an isolated HOME and cache directory. Use bun run test [files].",
  )
}

// Set these before app imports snapshot paths or open the usage database.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-test-"))
process.env.XDG_CACHE_HOME = path.join(testHome, ".cache")
process.env.COPILOT_API_HOME = testHome
process.env.COPILOT_API_LOG_DIR = path.join(testHome, "logs")
process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
process.once("exit", () => {
  fs.rmSync(testHome, { recursive: true, force: true })
})
