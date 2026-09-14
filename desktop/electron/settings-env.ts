import type { DesktopSettings } from '../src/types/ipc'

export function applySettingsEnvOverrides(
  settings: DesktopSettings,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const apiHome = settings.apiHome.trim()
  if (!env.COPILOT_API_HOME && apiHome) {
    env.COPILOT_API_HOME = apiHome
  }

  const sqliteDbPath = settings.sqliteDbPath.trim()
  if (!env.COPILOT_API_SQLITE_DB_PATH && sqliteDbPath) {
    env.COPILOT_API_SQLITE_DB_PATH = sqliteDbPath
  }

  if (!env.COPILOT_API_OAUTH_APP && settings.oauthApp === 'opencode') {
    env.COPILOT_API_OAUTH_APP = 'opencode'
  }

  const enterpriseUrl = settings.enterpriseUrl.trim()
  if (!env.COPILOT_API_ENTERPRISE_URL && enterpriseUrl) {
    env.COPILOT_API_ENTERPRISE_URL = enterpriseUrl
  }
}
