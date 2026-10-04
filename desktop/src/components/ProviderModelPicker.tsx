import { useState } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import { parseModelSelection } from '../lib/provider-model-options'

interface Props {
  provider: string
  options: string[]
  value: string
  loading: boolean
  readOnly?: boolean
  onChange: (value: string) => void
}

export default function ProviderModelPicker({
  provider,
  options,
  value,
  loading,
  readOnly,
  onChange,
}: Props) {
  const { t } = useLanguage()
  const [search, setSearch] = useState('')
  const selected = parseModelSelection(value)
  const available = [...new Set([...options, ...selected])].sort()
  const filtered = available
    .filter((id) => id.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((left, right) => {
      if (readOnly) return 0
      return Number(selected.includes(right)) - Number(selected.includes(left))
    })
  const toggle = (id: string, checked: boolean) => {
    onChange(
      (checked ?
        [...selected, id]
      : selected.filter((model) => model !== id)
      ).join('\n'),
    )
  }

  return (
    <div className="mt-5 flex min-h-80 flex-1 flex-col gap-3">
      <div className="relative shrink-0">
        <svg
          className="pointer-events-none absolute left-3 top-3 text-ink-faint"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </svg>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={`${provider}: ${t('providers.searchModels')}`}
          placeholder={t('providers.searchModels')}
          className="block h-10 w-full rounded-lg border border-line bg-canvas pl-9 pr-3 text-[13px] text-ink outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15"
        />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 text-[11px]">
        <span className="rounded-md bg-sunken px-2 py-1 font-medium text-ink-soft">
          {t(
            readOnly ? 'providers.availableCount' : 'providers.selectedCount',
          ).replace(
            '{count}',
            String(readOnly ? available.length : selected.length),
          )}
        </span>
        {!readOnly && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                onChange([...new Set([...selected, ...filtered])].join('\n'))
              }
              className="text-ink-soft transition hover:text-blue-600"
            >
              {t('providers.selectVisible')}
            </button>
            <span className="h-3 w-px bg-line" />
            <button
              type="button"
              onClick={() => onChange('')}
              className="text-ink-faint transition hover:text-ink"
            >
              {t('providers.clearSelection')}
            </button>
          </div>
        )}
      </div>
      <div className="grid min-h-48 flex-1 auto-rows-min grid-cols-1 content-start gap-2 overflow-y-auto p-0.5 sm:grid-cols-2">
        {filtered.map((id) => {
          const checked = !readOnly && selected.includes(id)
          return (
            <label
              key={id}
              className={`relative flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-3 transition-colors ${
                readOnly ? 'border-line bg-canvas cursor-default'
                : checked ?
                  'cursor-pointer border-blue-200 bg-blue-50/50 dark:border-blue-500/30 dark:bg-blue-500/10'
                : 'cursor-pointer border-line bg-canvas hover:border-blue-200 hover:bg-blue-50/30 dark:hover:border-blue-500/30'
              }`}
            >
              {!readOnly && (
                <>
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    aria-label={`${provider}: ${id}`}
                    checked={checked}
                    onChange={(event) => toggle(id, event.target.checked)}
                  />
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 ${checked ? 'border-blue-500 bg-blue-500 text-white' : 'border-line bg-surface text-transparent'}`}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="m3 8 3 3 7-7" />
                    </svg>
                  </span>
                </>
              )}
              <span className="min-w-0 break-all font-mono text-[12px] leading-5 text-ink">
                {id}
              </span>
            </label>
          )
        })}
        {filtered.length === 0 && (
          <p className="col-span-full rounded-lg border border-dashed border-line px-3 py-8 text-center text-xs text-ink-faint">
            {t(loading ? 'providers.loadingModels' : 'providers.noModels')}
          </p>
        )}
      </div>
      {!readOnly && (
        <details className="group shrink-0 rounded-lg border border-line-soft text-[11px] text-ink-soft">
          <summary className="cursor-pointer px-3 py-2.5 transition hover:text-ink">
            {t('providers.manualModels')}
          </summary>
          <label className="block border-t border-line-soft px-3 py-3">
            {t('providers.modelIds')}
            <textarea
              rows={3}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              className="mt-2 block w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs text-ink outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15"
            />
          </label>
        </details>
      )}
    </div>
  )
}
