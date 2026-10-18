const PROVIDER_TYPE_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  'github-copilot': 'GitHub Copilot',
  'openai-compatible': 'Chat Completions',
  'openai-responses': 'Responses API',
  google: 'Google Gemini API',
}

export function getProviderTypeLabel(type: string | undefined): string {
  if (!type) return ''
  return PROVIDER_TYPE_LABELS[type] ?? type
}
