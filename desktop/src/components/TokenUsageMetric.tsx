export type TokenUsageMetricValue = string | readonly string[]

function getTokenUsageValueLines(
  value: TokenUsageMetricValue,
): readonly string[] {
  return typeof value === 'string' ? [value] : value
}

export function TokenUsageValueLines({
  value,
}: {
  value: TokenUsageMetricValue
}) {
  const lines = getTokenUsageValueLines(value)

  return (
    <>
      {lines.map((line, index) => (
        <span key={`${line}-${index}`} className="block whitespace-nowrap">
          {line}
        </span>
      ))}
    </>
  )
}

export function TokenUsageMetric({
  label,
  loading,
  tone,
  value,
}: {
  label: string
  loading: boolean
  tone: 'amber' | 'blue' | 'cyan' | 'green' | 'slate' | 'violet'
  value: TokenUsageMetricValue
}) {
  const toneClasses = {
    amber:
      'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/15 dark:border-amber-500/30 dark:text-amber-400',
    blue: 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-500/15 dark:border-blue-500/30 dark:text-blue-400',
    cyan: 'bg-cyan-50 border-cyan-200 text-cyan-700 dark:bg-cyan-500/15 dark:border-cyan-500/30 dark:text-cyan-400',
    green:
      'bg-green-50 border-green-200 text-green-700 dark:bg-green-500/15 dark:border-green-500/30 dark:text-green-400',
    slate: 'bg-sunken border-line text-ink',
    violet:
      'bg-violet-50 border-violet-200 text-violet-700 dark:bg-violet-500/15 dark:border-violet-500/30 dark:text-violet-400',
  }[tone]
  const title = getTokenUsageValueLines(value).join('\n')

  return (
    <div className={`min-w-0 rounded-lg border px-2.5 py-2 ${toneClasses}`}>
      <div
        className={`text-[13px] font-bold leading-4 ${
          loading ? 'animate-pulse opacity-40' : ''
        }`}
        title={title}
      >
        {loading ? '…' : <TokenUsageValueLines value={value} />}
      </div>
      <div className="mt-1 whitespace-nowrap text-[13px] leading-4 opacity-70">
        {label}
      </div>
    </div>
  )
}

export function TokenUsageCostMetric({
  label,
  loading,
  value,
}: {
  label: string
  loading: boolean
  value: TokenUsageMetricValue
}) {
  return (
    <TokenUsageMetric
      label={label}
      loading={loading}
      tone="amber"
      value={value}
    />
  )
}
