import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

let installScript
try {
  installScript = require.resolve('electron/install.js')
} catch {
  process.exit(0)
}

const electronDir = path.dirname(installScript)
const pathFile = path.join(electronDir, 'path.txt')

let binaryMissing = !existsSync(pathFile)
if (!binaryMissing) {
  const relPath = readFileSync(pathFile, 'utf-8').trim()
  binaryMissing = !existsSync(path.join(electronDir, 'dist', relPath))
}

if (binaryMissing) {
  console.log('[ensure-electron] Electron binary missing, downloading...')
  execFileSync(process.execPath, [installScript], {
    stdio: 'inherit',
    cwd: electronDir,
  })
}
