import { expect, test } from 'claude-code/testing'

import { DEFAULT_GATE, DEFAULT_MAIN, DEFAULT_USAGE, normalizeCard, recordCheck } from '../hooks/core'
import {
  HEARTBEAT_MS,
  ORPHAN_MS,
  STALE_MS,
  ago,
  alivePids,
  buildSnapshot,
  configDirOf,
  snapshotsDir,
  isSafeId,
  mergeRows,
  orphans,
  parseRegistry,
  parseSnapshot,
  snapshotKey,
  totals,
} from '../hooks/sessions'
import type { RegistryEntry } from '../hooks/sessions'
import type { Snapshot } from '../types'

const NOW = 1_800_000_000_000

const reg = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  pid: 100,
  sessionId: 'aaaa',
  cwd: '/work/app',
  name: 'app',
  status: 'idle',
  startedAt: NOW - 60_000,
  updatedAt: NOW - 30_000,
  ...over,
})

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  v: 1,
  sessionId: 'aaaa',
  at: NOW - 1000,
  model: 'claude-opus-5-5',
  isRunning: false,
  ctxPct: 40,
  costUsd: 1.5,
  agentsRunning: 0,
  agentsTotal: 0,
  pending: 0,
  denied: 0,
  agents: [],
  log: [],
  ...over,
})

const merge = (registry: RegistryEntry[], snaps: Snapshot[], over: object = {}) =>
  mergeRows({
    registry,
    snapshots: new Map(snaps.map(s => [s.sessionId, s])),
    alive: new Set(registry.map(r => r.pid)),
    now: NOW,
    selfId: null,
    isSelfShown: false,
    ...over,
  })

test('a snapshot carries counts and masked one-liners, never more than it should', () => {
  const card = normalizeCard({ id: 'x', description: 'review PASSWORD=hunter2 flow', status: 'running', ctx: 5000, steps: 3 })
  const gate = recordCheck(DEFAULT_GATE, { id: 'c1', tool: 'Bash', bucket: 'shell', verdict: 'ask', inSubagent: false, detail: 'ls', at: NOW })
  const s = buildSnapshot({
    sessionId: 'aaaa',
    now: NOW,
    main: { ...DEFAULT_MAIN, model: 'claude-opus-5-5', isRunning: true },
    usage: { ...DEFAULT_USAGE, costUsd: 2.5 },
    cards: [card],
    gate,
    log: Array.from({ length: 9 }, (_, i) => ({ at: NOW + i, who: 'main', text: `line ${i} token=abc123secret`, agentId: null, kind: 'info' as const })),
  })
  expect(s.agentsRunning).toBe(1)
  expect(s.pending).toBe(1)
  expect(s.costUsd).toBe(2.5)
  expect(s.log.length).toBe(5)
  expect(JSON.stringify(s)).not.toContain('hunter2')
})

test('what changed is judged without the write time, so a quiet session does not rewrite its file', () => {
  expect(snapshotKey(snap({ at: 1 }))).toBe(snapshotKey(snap({ at: 2 })))
  expect(snapshotKey(snap({ costUsd: 1 }))).not.toBe(snapshotKey(snap({ costUsd: 2 })))
  expect(HEARTBEAT_MS).toBeLessThan(STALE_MS)
})

test('a snapshot round-trips, and what cannot be read is refused rather than guessed at', () => {
  const s = snap({ agents: [{ title: 't', status: 'done', ctx: 1, steps: 2, spawnedAt: 3, endedAt: 4 }] })
  expect(parseSnapshot(JSON.stringify(s))).toEqual(s)
  expect(parseSnapshot('{"v":1,"sessionId":"a"')).toBeNull() // half-written
  expect(parseSnapshot(JSON.stringify({ ...s, v: 99 }))).toBeNull() // another version
  expect(parseSnapshot(JSON.stringify({ ...s, sessionId: '' }))).toBeNull()
  expect(parseSnapshot('[]')).toBeNull()
  // A field of the wrong type falls back, the rest still reads.
  expect(parseSnapshot(JSON.stringify({ ...s, costUsd: 'lots', agents: 'none' }))?.costUsd).toBeNull()
})

test('the registry entry is read as Claude Code writes it, named by folder when it has no name', () => {
  const text = JSON.stringify({ pid: 7, sessionId: 's1', cwd: '/a/b/proj', name: 'proj-1', status: 'idle', startedAt: 5, updatedAt: 9, extra: true })
  expect(parseRegistry(text)).toMatchObject({ pid: 7, sessionId: 's1', name: 'proj-1', status: 'idle', updatedAt: 9 })
  expect(parseRegistry(JSON.stringify({ pid: 7, sessionId: 's1', cwd: '/a/b/proj' }))?.name).toBe('proj')
  expect(parseRegistry(JSON.stringify({ pid: 7 }))).toBeNull()
  expect(parseRegistry('nope')).toBeNull()
})

test('only sessions whose process still runs get a row', () => {
  const rows = merge([reg({ pid: 1, sessionId: 'live' }), reg({ pid: 2, sessionId: 'dead' })], [], { alive: new Set([1]) })
  expect(rows.map(r => r.sessionId)).toEqual(['live'])
  expect([...alivePids('  101\n 7\n\nxx\n')]).toEqual([101, 7])
})

test('sessions that need you come first, then busy, then idle, latest activity first', () => {
  const rows = merge(
    [
      reg({ pid: 1, sessionId: 'idle-old', name: 'a', updatedAt: NOW - 90_000 }),
      reg({ pid: 2, sessionId: 'idle-new', name: 'b', updatedAt: NOW - 5_000 }),
      reg({ pid: 3, sessionId: 'busy', name: 'c' }),
      reg({ pid: 4, sessionId: 'asks', name: 'd' }),
      reg({ pid: 5, sessionId: 'nodeck-busy', name: 'e', status: 'busy' }),
    ],
    [snap({ sessionId: 'busy', isRunning: true }), snap({ sessionId: 'asks', pending: 2 }), snap({ sessionId: 'idle-new', at: NOW - 5_000 }), snap({ sessionId: 'idle-old', at: NOW - 90_000 })],
  )
  expect(rows.map(r => r.sessionId)).toEqual(['asks', 'busy', 'nodeck-busy', 'idle-new', 'idle-old'])
  expect(rows.map(r => r.state)).toEqual(['needs-you', 'busy', 'busy', 'idle', 'idle'])
})

test('a running agent makes its session busy even when the main loop waits', () => {
  expect(merge([reg()], [snap({ agentsRunning: 1, agentsTotal: 1 })])[0]?.state).toBe('busy')
})

test('a session without Flightdeck still shows, from the registry alone', () => {
  const row = merge([reg({ status: 'busy' })], [])[0]
  expect(row).toMatchObject({ hasDeck: false, snap: null, state: 'busy', isStale: false })
})

test('a deck that went quiet is marked stale; the hub leaves itself out unless asked', () => {
  expect(merge([reg()], [snap({ at: NOW - STALE_MS - 1 })])[0]?.isStale).toBe(true)
  expect(merge([reg()], [snap({ at: NOW - 1000 })])[0]?.isStale).toBe(false)
  expect(merge([reg()], [], { selfId: 'aaaa' })).toEqual([])
  expect(merge([reg()], [], { selfId: 'aaaa', isSelfShown: true }).length).toBe(1)
})

test('totals add up the rows', () => {
  const rows = merge(
    [reg({ pid: 1, sessionId: 'a' }), reg({ pid: 2, sessionId: 'b' })],
    [snap({ sessionId: 'a', costUsd: 1, agentsRunning: 2, agentsTotal: 2, pending: 1 }), snap({ sessionId: 'b', costUsd: 2.5, isRunning: true })],
  )
  expect(totals(rows)).toEqual({ sessions: 2, needsYou: 1, busy: 1, agents: 2, costUsd: 3.5 })
})

test('leftover snapshot files are deleted only when their session is gone and they are old', () => {
  const files = [
    { name: 'live.json', mtimeMs: NOW - ORPHAN_MS - 1 },
    { name: 'gone-old.json', mtimeMs: NOW - ORPHAN_MS - 1 },
    { name: 'gone-new.json', mtimeMs: NOW - 1000 },
    { name: 'notes.txt', mtimeMs: 0 },
  ]
  expect(orphans(files, new Set(['live']), NOW)).toEqual(['gone-old.json'])
})

test('paths follow the config dir, and an id is checked before it names a file', () => {
  expect(configDirOf({ configDir: '/c', home: '/h' })).toBe('/c')
  expect(configDirOf({ configDir: '', home: '/h' })).toBe('/h/.claude')
  // Snapshots sit under ~/.claude for every session, so sessions in different config dirs see each other.
  expect(snapshotsDir('/h')).toBe('/h/.claude/flightdeck/sessions')
  expect(snapshotsDir(undefined)).toBe('~/.claude/flightdeck/sessions')
  expect(isSafeId('5648a060-ccb3-4ed0-b179-61ac20dbefb5')).toBe(true)
  expect(isSafeId('../../etc/passwd')).toBe(false)
  expect(isSafeId('')).toBe(false)
})

test('ages read as a glance wants them', () => {
  expect(ago(NOW - 1000, NOW)).toBe('now')
  expect(ago(NOW - 42_000, NOW)).toBe('42s')
  expect(ago(NOW - 5 * 60_000, NOW)).toBe('5m')
  expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3h')
  expect(ago(NOW - 3 * 86_400_000, NOW)).toBe('3d')
})

// ---------------------------------------------------------------- the pane

type Drawn = { type: string; children?: unknown[] }
const isDrawn = (n: unknown): n is Drawn => typeof n === 'object' && n !== null && typeof (n as Drawn).type === 'string'
const textOf = (n: unknown): string =>
  typeof n === 'string' || typeof n === 'number' ? String(n) : isDrawn(n) ? (n.children ?? []).map(textOf).join('') : ''

const hubPane = (bodyColumns: number) => ({
  plugin: 'flightdeck',
  component: 'Pane' as const,
  requestId: 'flightdeck-all',
  props: { title: 'Flightdeck · all sessions', isFocused: true, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
})

test('the all-sessions pane draws at every width, before any poll has found anything', async ($, on) => {
  for (const width of [24, 40, 64, 96, 140]) {
    const ui = await $.ui.mount({ ...hubPane(width), surface: 'terminal' })
    const text = textOf(await ui.drawn())
    expect(text).toContain('ALL SESSIONS')
    await ui.unmount()
  }
})
