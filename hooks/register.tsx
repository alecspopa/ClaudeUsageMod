import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { UsageDay, UsageLimit, UsageRange, UsageScan } from '../types'

const SCAN_EVERY_MS = 5 * 60 * 1000

const scan = atom({ plugin: 'claude-usage', key: 'scan' } as const, null)
const limits = atom({ plugin: 'claude-usage', key: 'limits' } as const, [])
const error = atom({ plugin: 'claude-usage', key: 'error' } as const, null)

// --- Formatting ---

function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function dollars(usd: number): string {
  const cents = Math.round(usd * 100)
  return `$${groupDigits(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`
}

function compact(n: number, digits = 1): string {
  const steps: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [size, unit] of steps) {
    if (n >= size) return `${(n / size).toFixed(digits)}${unit}`
  }
  return String(Math.round(n))
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  return `${hours}h ${minutes % 60}m`
}

// "claude-opus-5-5" is shown as "Opus 5.5".
function modelName(model: string): string {
  const [family = model, ...version] = model.replace(/^claude-/, '').split('-')
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join('.')}`.trim()
}

const FAMILY_COLORS: Record<string, string> = {
  fable: '#d97757',
  mythos: '#d97757',
  opus: '#a78bfa',
  sonnet: '#3b82f6',
  haiku: '#22c55e',
}

function modelColor(name: string): string {
  return FAMILY_COLORS[name.split(' ')[0]?.toLowerCase() ?? ''] ?? '#9ca3af'
}

// --- Usage data ---

const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3600 * 1000,
  seven_day: 7 * 24 * 3600 * 1000,
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5 hours',
  seven_day: '7 days',
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Weekly',
  spend_limit: 'Extra Usage',
}

type Window = {
  name: string
  passed?: string
  used: number
  resetsIn?: number
  elapsed?: number
  leftAtReset?: number
}

function windowOf(limit: UsageLimit, now: number): Window {
  const name = LIMIT_NAMES[limit.kind] ?? limit.kind.replace(/_/g, ' ')
  const length = WINDOW_MS[limit.kind]
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (Number.isNaN(resetsAt)) return { name, used: limit.percentUsed }
  const resetsIn = resetsAt - now
  if (length === undefined) return { name, used: limit.percentUsed, resetsIn }
  const elapsed = Math.min(1, Math.max(0, 1 - resetsIn / length))
  const passed =
    `The line shows the time passed: ${duration(elapsed * length)} of ${WINDOW_NAMES[limit.kind]}. ` +
    'Keep the blue bar left of the line to have some of the limit left at reset.'
  // Too early in the window to project the pace.
  if (elapsed < 0.02) return { name, used: limit.percentUsed, resetsIn, elapsed, passed }
  const leftAtReset = Math.max(0, Math.round(100 - limit.percentUsed / elapsed))
  return { name, used: limit.percentUsed, resetsIn, elapsed, passed, leftAtReset }
}

function daysIn(data: UsageScan, which: UsageRange): UsageDay[] {
  if (which === 'month') return data.days
  const index = data.days.length - (which === 'today' ? 1 : 2)
  const day = data.days[index]
  return day ? [day] : []
}

function total(days: UsageDay[]): { usd: number; tokens: number; models: [string, number][] } {
  const models = new Map<string, number>()
  let usd = 0
  let tokens = 0
  for (const day of days) {
    usd += day.usd
    tokens += day.tokens
    for (const [model, cost] of Object.entries(day.models)) {
      const name = modelName(model)
      models.set(name, (models.get(name) ?? 0) + cost)
    }
  }
  const sorted = [...models].filter(([, cost]) => cost >= 0.005).sort((a, b) => b[1] - a[1])
  return { usd, tokens, models: sorted }
}

let isScanning = false

async function rescan($: EngineInterface): Promise<void> {
  if (isScanning) return
  isScanning = true
  try {
    const usage = await $.session.usage().catch(() => undefined)
    if (usage) await keepLimits($, usage.rateLimits)
    const home = (await $.env.get('HOME')) ?? ''
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
    const ran = await $.process.run(
      [
        '/usr/bin/python3',
        `${$.plugin.root}/scripts/scan.py`,
        `${config}/projects`,
        `${home}/.cache/claude-usage/scan.json`,
      ],
      { timeoutMs: 5 * 60 * 1000 },
    )
    if (ran.exitCode !== 0) {
      await update($, error, () => ran.stderr.trim().split('\n').pop() ?? 'The scan failed.')
      return
    }
    const parsed = JSON.parse(ran.stdout) as Omit<UsageScan, 'scannedAt'>
    const scannedAt = await $.clock.now()
    await update($, scan, () => ({ ...parsed, scannedAt }))
    await update($, error, () => null)
  } catch (cause) {
    await update($, error, () => String(cause))
  } finally {
    isScanning = false
  }
}

async function keepLimits($: EngineInterface, next: UsageLimit[]): Promise<void> {
  if (next.length === 0) return
  const plain = next.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
  await update($, limits, () => plain)
  // A new session has no reading until its first response, so keep the last one.
  await $.store.set('limits', plain)
}

// --- Drawings for surfaces with Svg ---

function meterSvg(width: number, used: number, marker?: number): string {
  const fill = Math.max(used > 0 ? 6 : 0, (Math.min(used, 100) / 100) * width)
  const tick =
    marker === undefined
      ? ''
      : `<rect x="${Math.min(width - 2, (marker / 100) * width)}" y="0" width="2" height="12" rx="1" fill="#9ca3af"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="12" viewBox="0 0 ${width} 12">` +
    `<rect x="0" y="3" width="${width}" height="6" rx="3" fill="#8884"/>` +
    `<rect x="0" y="3" width="${fill}" height="6" rx="3" fill="#3b82f6"/>${tick}</svg>`
  )
}

function trendSvg(width: number, values: number[]): string {
  const height = 14
  const highest = Math.max(...values, 0.01)
  const step = width / Math.max(values.length, 1)
  const bars = values.map((value, i) => {
    const barHeight = Math.max(1, (value / highest) * height)
    return `<rect x="${i * step + 1}" y="${height - barHeight}" width="${Math.max(1, step - 2)}" height="${barHeight}" fill="#3b82f6"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bars.join('')}</svg>`
}

// --- Drawings for the terminal ---

function meterText(width: number, used: number): string {
  const filled = Math.round((Math.min(used, 100) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function trendText(values: number[]): string {
  const levels = '▁▂▃▄▅▆▇█'
  const highest = Math.max(...values, 0.01)
  return values.map(value => levels[Math.min(7, Math.floor((value / highest) * 7.99))]).join('')
}

// --- Hooks ---

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const kept = (await $.store.get('limits')) as UsageLimit[] | undefined
    if (kept) await update($, limits, () => kept)
    $.clock.after(0, () => void rescan($))
    $.clock.every(SCAN_EVERY_MS, () => void rescan($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await keepLimits($, e.rateLimits)
    if (e.changed.includes('cost')) void rescan($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const hasSvg = e.surface !== 'terminal'
    const data = await read($, scan)
    const windows = await read($, limits)
    const failure = await read($, error)
    const now = await $.clock.now()
    // A render hook cannot write state, so the scan starts on a timer.
    if (!data && !failure && !isScanning) $.clock.after(0, () => void rescan($))

    const svg = (source: string, alt: string) => {
      if (e.surface === 'terminal') return null
      const { Svg } = $.ui.resolve(e)
      return <Svg source={source} alt={alt} />
    }

    // Every line has the same column boxes, so the text after the drawings lines up.
    const line = (name: string, drawing: RenderChildren, middle?: RenderChildren, last?: RenderChildren) => (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Box width={12}>
          <Text bold>{name}</Text>
        </Box>
        {drawing}
        {middle !== undefined && <Box width={34}>{middle}</Box>}
        {last !== undefined && <Box flexShrink={0}>{last}</Box>}
      </Box>
    )

    const meters = windows.map(limit => {
      const w = windowOf(limit, now)
      const marker = w.elapsed === undefined ? undefined : w.elapsed * 100
      const resets =
        w.resetsIn === undefined ? '' : w.resetsIn <= 0 ? 'resets now' : `resets in ${duration(w.resetsIn)}`
      return line(
        w.name,
        // The card under the bar shows while the pointer is over the bar.
        <Box key={`meter-${limit.kind}`}>
          {hasSvg ? svg(meterSvg(140, w.used, marker), `${w.name} meter`) : <Text color="blue">{meterText(30, w.used)}</Text>}
          {w.passed !== undefined && (
            <Box
              position="absolute"
              top={1}
              left={0}
              width={44}
              display="none"
              hover={{ display: 'flex' }}
              borderStyle="round"
              borderDimColor
              backgroundColor="#2b2b2b"
              paddingX={1}
            >
              <Text color="#e5e5e5">{w.passed}</Text>
            </Box>
          )}
        </Box>,
        <Box flexDirection="row" gap={1}>
          <Box width={10}>
            <Text>{`${Math.round(w.used)}% used`}</Text>
          </Box>
          <Text dimColor>{w.leftAtReset === undefined ? '' : `~${w.leftAtReset}% left at reset`}</Text>
        </Box>,
        <Text dimColor>{resets}</Text>,
      )
    })

    const amount = (label: string, sum: ReturnType<typeof total>) => (
      <Text>
        <Text bold>{label}</Text> <Text dimColor>{`${dollars(sum.usd)} · ${compact(sum.tokens)} tokens`}</Text>
      </Text>
    )
    const trend = data
      ? line(
          'Trend',
          hasSvg
            ? svg(trendSvg(140, data.days.map(day => day.usd)), 'Cost per day for 30 days')
            : <Text color="blue">{trendText(data.days.map(day => day.usd))}</Text>,
          amount('Today', total(daysIn(data, 'today'))),
          amount('30 Days', total(daysIn(data, 'month'))),
        )
      : line('Trend', <Text dimColor>{failure ? `Scan failed: ${failure}` : 'Reading the transcripts...'}</Text>)

    return (
      <Box flexDirection="column">
        {meters}
        {trend}
      </Box>
    )
  })
}
