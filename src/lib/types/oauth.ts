export interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

export interface OAuthAccountSummary {
  accountId: string
  alias?: string
  active: boolean
}

export interface XaiAuthInfo {
  url: string
  verificationUri: string
  userCode: string
  expiresAt: number
}
