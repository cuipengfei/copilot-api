import { useState } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import ProviderManagementPanel from './ProviderManagementPanel'

interface Props {
  onClose: () => void
  serverRunning?: boolean
}

export default function ProviderManagementModal({
  onClose,
  serverRunning,
}: Props) {
  const { t } = useLanguage()
  const [saving, setSaving] = useState(false)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!saving) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="providers-dialog-title"
        className="flex h-[85vh] max-h-[900px] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-canvas shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line-soft bg-surface px-5 py-3">
          <h2
            id="providers-dialog-title"
            className="text-sm font-semibold text-ink"
          >
            {t('providers.title')}
          </h2>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            aria-label={t('providers.close')}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-faint transition hover:bg-sunken hover:text-ink disabled:opacity-40"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ProviderManagementPanel
            serverRunning={serverRunning}
            onSavingChange={setSaving}
          />
        </div>
      </div>
    </div>
  )
}
