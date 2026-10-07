import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T12:00:00Z')

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

const days = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-09-${String(i + 8).padStart(2, '0')}`,
  usd: 0,
  tokens: 0,
  models: {} as Record<string, number>,
}))
days[28] = { date: '2026-10-06', usd: 6, tokens: 9_100_000, models: { 'claude-opus-5-5': 6 } }
days[29] = {
  date: '2026-10-07',
  usd: 53.36,
  tokens: 165_300_000,
  models: { 'claude-opus-5-5': 50, 'claude-fable-5-1': 3.36 },
}

test('the band shows cost, limits and totals on each surface', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/Users/test' })
  mock.store(on)
  on('process.run', () => ({
    value: {
    exitCode: 0,
    stdout: JSON.stringify({ today: '2026-10-07', days }),
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
    },
  }))
  on('session.usage', () => ({
    value: {
    startedAt: 0,
    context: { window: 1_000_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 6, resetsAt: new Date(NOW + 3 * 3600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 1, resetsAt: new Date(NOW + 28 * 3600_000).toISOString() },
    ],
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'claude-usage',
      surface,
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })
    await clock.advance(1)
    expect(await ui.find({ text: /^Session$/ })).toBeDefined()
    expect(await ui.find({ text: /left at reset/ })).toBeDefined()
    expect(await ui.find({ text: /\$53\.36 · 165\.3M tokens/ })).toBeDefined()
    expect(await ui.find({ text: /\$59\.36 · 174\.4M tokens/ })).toBeDefined()
    await ui.unmount()
  }
})
