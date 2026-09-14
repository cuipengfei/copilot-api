import { describe, expect, test } from 'bun:test'

import { applySettingsEnvOverrides } from '../electron/settings-env'
import { normalizeSettings } from '../electron/settings-store'

describe('desktop settings environment', () => {
  test('maps startup settings to trimmed environment values', () => {
    const env: NodeJS.ProcessEnv = {}
    const settings = normalizeSettings({
      apiHome: ' C:/copilot-api ',
      sqliteDbPath: ' D:/copilot-data/usage.sqlite ',
      oauthApp: 'opencode',
      enterpriseUrl: ' company.ghe.com ',
    })

    applySettingsEnvOverrides(settings, env)

    expect(env).toEqual({
      COPILOT_API_HOME: 'C:/copilot-api',
      COPILOT_API_SQLITE_DB_PATH: 'D:/copilot-data/usage.sqlite',
      COPILOT_API_OAUTH_APP: 'opencode',
      COPILOT_API_ENTERPRISE_URL: 'company.ghe.com',
    })
  })

  test('keeps inherited environment values', () => {
    const env: NodeJS.ProcessEnv = {
      COPILOT_API_HOME: 'inherited-home',
      COPILOT_API_SQLITE_DB_PATH: 'inherited.sqlite',
      COPILOT_API_OAUTH_APP: 'inherited-app',
      COPILOT_API_ENTERPRISE_URL: 'inherited.ghe.com',
    }
    const settings = normalizeSettings({
      apiHome: 'configured-home',
      sqliteDbPath: 'configured.sqlite',
      oauthApp: 'opencode',
      enterpriseUrl: 'configured.ghe.com',
    })

    applySettingsEnvOverrides(settings, env)

    expect(env).toEqual({
      COPILOT_API_HOME: 'inherited-home',
      COPILOT_API_SQLITE_DB_PATH: 'inherited.sqlite',
      COPILOT_API_OAUTH_APP: 'inherited-app',
      COPILOT_API_ENTERPRISE_URL: 'inherited.ghe.com',
    })
  })

  test('ignores empty settings and the default OAuth app', () => {
    const env: NodeJS.ProcessEnv = {}
    const settings = normalizeSettings({
      apiHome: ' ',
      sqliteDbPath: ' ',
      enterpriseUrl: ' ',
    })

    applySettingsEnvOverrides(settings, env)

    expect(env).toEqual({})
  })
})
