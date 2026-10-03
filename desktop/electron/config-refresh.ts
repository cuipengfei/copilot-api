interface ConfigRefreshDependencies {
  isRunning: () => boolean
  readAdminApiKey: () => Promise<string>
  invalidateConfigCache: () => void
  reloadConfig: (adminApiKeys: string[]) => Promise<void>
}

export function createConfigRefresher(dependencies: ConfigRefreshDependencies) {
  let pendingUpdate: Promise<unknown> = Promise.resolve()
  let activeAdminApiKey: string | undefined

  const saveAndRefresh = <Result>(
    save: () => Result | Promise<Result>,
  ): Promise<Result> => {
    const update = pendingUpdate.then(async () => {
      const running = dependencies.isRunning()
      const adminApiKey = running ? await dependencies.readAdminApiKey() : ''
      if (!running) activeAdminApiKey = undefined
      if (running) activeAdminApiKey ||= adminApiKey
      const result = await save()
      dependencies.invalidateConfigCache()
      if (running && dependencies.isRunning()) {
        const savedAdminApiKey = await dependencies.readAdminApiKey()
        const adminApiKeys = [
          ...new Set([
            activeAdminApiKey ?? adminApiKey,
            adminApiKey,
            savedAdminApiKey,
          ]),
        ].filter(Boolean)
        await dependencies.reloadConfig(adminApiKeys)
        activeAdminApiKey = await dependencies.readAdminApiKey()
      }
      return result
    })
    pendingUpdate = update.catch(() => {})
    return update
  }

  return {
    saveAndRefresh,
    setActiveAdminApiKey: (adminApiKey: string | undefined) => {
      activeAdminApiKey = adminApiKey
    },
  }
}
