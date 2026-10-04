import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  applyLaunchAtLogin,
  initializeLaunchAtLogin,
  LOGIN_ITEM_ARG,
  wasLaunchedAtLogin,
} from '../electron/login-item'

function createController(
  options: {
    isPackaged?: boolean
    launchItems?: Electron.LaunchItems[]
    openAtLogin?: boolean
    wasOpenedAtLogin?: boolean
  } = {},
) {
  const calls: Electron.Settings[] = []
  return {
    calls,
    isPackaged: options.isPackaged ?? true,
    setLoginItemSettings: (settings: Electron.Settings) => {
      calls.push(settings)
    },
    getLoginItemSettings: () => ({
      launchItems: options.launchItems ?? [],
      openAtLogin: options.openAtLogin ?? false,
      wasOpenedAtLogin: options.wasOpenedAtLogin ?? false,
    }),
  }
}

describe('desktop login item', () => {
  test('configures the packaged Windows login item with a launch marker', async () => {
    const controller = createController()
    const runtime = {
      platform: 'win32' as const,
      execPath: 'C:\\Program Files\\Copilot API\\Copilot API.exe',
      argv: [],
    }

    await applyLaunchAtLogin(
      controller,
      { launchAtLogin: true, minimizeToTray: true },
      runtime,
    )
    await applyLaunchAtLogin(
      controller,
      { launchAtLogin: false, minimizeToTray: false },
      runtime,
    )

    expect(controller.calls).toEqual([
      {
        openAtLogin: true,
        path: runtime.execPath,
        args: [LOGIN_ITEM_ARG],
        name: 'com.copilot-api.desktop',
      },
      {
        openAtLogin: false,
        path: runtime.execPath,
        args: [LOGIN_ITEM_ARG],
        name: 'com.copilot-api.desktop',
      },
    ])
  })

  test('preserves a disabled Windows login item while refreshing its path', async () => {
    const runtime = {
      platform: 'win32' as const,
      execPath: 'C:\\Program Files\\Copilot API\\Copilot API.exe',
      argv: [],
    }
    const controller = createController({
      launchItems: [
        {
          name: 'com.copilot-api.desktop',
          path: 'C:\\Old\\Copilot API.exe',
          args: [],
          scope: 'user',
          enabled: false,
        },
      ],
    })

    expect(await initializeLaunchAtLogin(controller, runtime)).toBe(false)
    expect(controller.calls).toEqual([
      {
        openAtLogin: true,
        path: runtime.execPath,
        args: [LOGIN_ITEM_ARG],
        enabled: false,
        name: 'com.copilot-api.desktop',
      },
    ])

    const current = createController({
      launchItems: [
        {
          name: 'com.copilot-api.desktop',
          path: runtime.execPath,
          args: [LOGIN_ITEM_ARG],
          scope: 'user',
          enabled: true,
        },
      ],
    })
    expect(await initializeLaunchAtLogin(current, runtime)).toBe(true)
    expect(current.calls).toEqual([])
    expect(await initializeLaunchAtLogin(createController(), runtime)).toBe(
      false,
    )
  })

  test('configures macOS to open hidden with minimize-to-tray', async () => {
    const controller = createController()
    const runtime = {
      platform: 'darwin' as const,
      execPath: '/Applications/Copilot API.app/Contents/MacOS/Copilot API',
      argv: [],
    }

    await applyLaunchAtLogin(
      controller,
      { launchAtLogin: true, minimizeToTray: true },
      runtime,
    )

    expect(controller.calls).toEqual([
      { openAtLogin: true, openAsHidden: true },
    ])

    expect(
      await initializeLaunchAtLogin(
        createController({ openAtLogin: true }),
        runtime,
      ),
    ).toBe(true)
  })

  test('manages the packaged Linux XDG autostart entry', async () => {
    const configHome = await fs.mkdtemp(
      path.join(os.tmpdir(), 'copilot-api-login-'),
    )
    const autostartPath = path.join(
      configHome,
      'autostart',
      'copilot-api.desktop',
    )
    const runtime = {
      platform: 'linux' as const,
      execPath: '/tmp/.mount-copilot/copilot-api',
      configHome,
      argv: [],
    }
    const controller = createController()
    const enabled = { launchAtLogin: true, minimizeToTray: false }

    try {
      await applyLaunchAtLogin(controller, enabled, {
        ...runtime,
        appImagePath: '/home/jay/Copilot API.AppImage',
      })

      expect(await fs.readFile(autostartPath, 'utf8')).toBe(`[Desktop Entry]
Type=Application
Name=Copilot API
Exec="/home/jay/Copilot API.AppImage" ${LOGIN_ITEM_ARG}
Terminal=false
`)
      expect(await initializeLaunchAtLogin(controller, runtime)).toBe(true)

      await fs.appendFile(autostartPath, 'Hidden=true\n')
      expect(await initializeLaunchAtLogin(controller, runtime)).toBe(false)
      expect(controller.calls).toEqual([])

      await applyLaunchAtLogin(controller, enabled, {
        ...runtime,
        appImagePath: '',
      })
      expect(await fs.readFile(autostartPath, 'utf8')).toContain(
        'Exec="/tmp/.mount-copilot/copilot-api"',
      )

      await applyLaunchAtLogin(controller, enabled, {
        ...runtime,
        appImagePath: '/home/jay/Copilot =`$"\\ AppImage',
      })

      expect(await fs.readFile(autostartPath, 'utf8')).toContain(
        'Exec="/home/jay/Copilot =\\\\`\\\\$\\\\"\\\\\\\\ AppImage" --launch-at-login',
      )

      for (const appImagePath of [
        '/home/jay/Copilot 100%.AppImage',
        '/tmp/a\tb',
      ]) {
        await expect(
          applyLaunchAtLogin(controller, enabled, { ...runtime, appImagePath }),
        ).rejects.toThrow('contains unsupported characters')
      }

      await applyLaunchAtLogin(
        controller,
        { launchAtLogin: false, minimizeToTray: false },
        runtime,
      )
      expect(await Bun.file(autostartPath).exists()).toBe(false)
      expect(await initializeLaunchAtLogin(controller, runtime)).toBe(false)
    } finally {
      await fs.rm(configHome, { recursive: true, force: true })
    }
  })

  test('skips unsupported or unpackaged apps', async () => {
    const settings = { launchAtLogin: true, minimizeToTray: false }
    const unsupported = createController()
    await applyLaunchAtLogin(unsupported, settings, {
      platform: 'freebsd',
      execPath: '/opt/copilot-api',
      argv: [],
    })

    const unpackaged = createController({ isPackaged: false })
    await applyLaunchAtLogin(unpackaged, settings)

    expect(unsupported.calls).toEqual([])
    expect(unpackaged.calls).toEqual([])
    expect(
      await initializeLaunchAtLogin(unsupported, {
        platform: 'freebsd',
        execPath: '/opt/copilot-api',
        argv: [],
      }),
    ).toBe(false)
    expect(await initializeLaunchAtLogin(unpackaged)).toBe(false)
  })

  describe('Linux AppImage updates', () => {
    let configHome: string
    let autostartPath: string
    const controller = createController()
    const oldAppImage = '/home/jay/Copilot-API-2.6.29-linux-x86_64.AppImage'
    const newAppImage = '/home/jay/Copilot-API-2.6.30-linux-x86_64.AppImage'
    const runtime = (appImagePath: string) => ({
      platform: 'linux' as const,
      execPath: '/tmp/.mount-copilot/copilot-api',
      configHome,
      argv: [],
      appImagePath,
    })

    beforeEach(async () => {
      configHome = await fs.mkdtemp(
        path.join(os.tmpdir(), 'copilot-api-login-update-'),
      )
      autostartPath = path.join(configHome, 'autostart', 'copilot-api.desktop')
    })

    afterEach(async () => {
      const cleanupPath = path.resolve(configHome)
      if (
        path.dirname(cleanupPath) !== path.resolve(os.tmpdir())
        || !path.basename(cleanupPath).startsWith('copilot-api-login-update-')
      )
        throw new Error('Unexpected test cleanup path')
      await fs.rm(cleanupPath, { recursive: true, force: true })
    })

    test('refreshes an enabled startup entry after a versioned update', async () => {
      await applyLaunchAtLogin(
        controller,
        { launchAtLogin: true, minimizeToTray: false },
        runtime(oldAppImage),
      )
      const extraFields =
        'Comment=Keep this preference\nX-GNOME-Autostart-Delay=10\n'
      await fs.appendFile(autostartPath, extraFields)

      expect(
        await initializeLaunchAtLogin(controller, runtime(newAppImage)),
      ).toBe(true)
      const entry = await fs.readFile(autostartPath, 'utf8')
      expect(entry).toContain(`Exec="${newAppImage}" ${LOGIN_ITEM_ARG}\n`)
      expect(entry).not.toContain(oldAppImage)
      expect(entry).toContain(extraFields)
    })

    test('preserves literal dollar signs when refreshing the executable', async () => {
      await applyLaunchAtLogin(
        controller,
        { launchAtLogin: true, minimizeToTray: false },
        runtime(oldAppImage),
      )

      expect(
        await initializeLaunchAtLogin(
          controller,
          runtime('/home/jay/Copilot $&.AppImage'),
        ),
      ).toBe(true)
      expect(await fs.readFile(autostartPath, 'utf8')).toContain(
        'Exec="/home/jay/Copilot \\\\$&.AppImage" --launch-at-login\n',
      )
    })

    test.each(['Hidden=true', 'X-GNOME-Autostart-enabled=false'])(
      'preserves an externally disabled entry with %s',
      async (disabledFlag) => {
        await applyLaunchAtLogin(
          controller,
          { launchAtLogin: true, minimizeToTray: false },
          runtime(oldAppImage),
        )
        await fs.appendFile(autostartPath, `${disabledFlag}\n`)
        const entry = await fs.readFile(autostartPath, 'utf8')

        expect(
          await initializeLaunchAtLogin(controller, runtime(newAppImage)),
        ).toBe(false)
        expect(await fs.readFile(autostartPath, 'utf8')).toBe(entry)
      },
    )

    test('keeps startup disabled when no entry exists', async () => {
      expect(
        await initializeLaunchAtLogin(controller, runtime(newAppImage)),
      ).toBe(false)
      expect(await Bun.file(autostartPath).exists()).toBe(false)
    })
  })

  test('detects login launches by platform', () => {
    const launched = (platform: NodeJS.Platform, argv: string[] = []) =>
      wasLaunchedAtLogin(createController(), {
        platform,
        execPath: 'copilot-api',
        argv,
      })

    const mac = createController({ wasOpenedAtLogin: true })
    expect(
      wasLaunchedAtLogin(mac, {
        platform: 'darwin',
        execPath: 'copilot-api',
        argv: [],
      }),
    ).toBe(true)
    expect(launched('win32', [LOGIN_ITEM_ARG])).toBe(true)
    expect(launched('win32')).toBe(false)
    expect(launched('linux', [LOGIN_ITEM_ARG])).toBe(true)
    expect(launched('freebsd')).toBe(false)
  })
})
