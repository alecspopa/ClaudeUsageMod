export type UsageDay = {
  date: string
  usd: number
  tokens: number
  models: Record<string, number>
}

export type UsageScan = { today: string; days: UsageDay[]; scannedAt: number }

export type UsageLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageRange = 'today' | 'yesterday' | 'month'

declare module 'claude-code' {
  interface PluginState {
    'claude-usage': {
      scan: UsageScan | null
      limits: UsageLimit[]
      error: string | null
    }
  }
}
