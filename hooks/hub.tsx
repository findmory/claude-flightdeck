// The all-sessions hub. Every session running Flightdeck publishes a small snapshot of itself to
// `~/.claude/flightdeck/sessions/<session id>.json`; `/flightdeck all` opens a pane, in any Claude
// Code instance, that reads those files beside Claude Code's own session registry and draws one row
// per live session. Each session's own pane is unchanged.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { HubRow, HubState, HubView, Snapshot } from '../types'
import {
  DEFAULT_GATE,
  DEFAULT_MAIN,
  DEFAULT_USAGE,
  PALETTES,
  fmtUsd,
  gauge,
  kTokens,
  listOf,
  normalize,
  normalizeCard,
  normalizeGate,
  normalizeLog,
  plural,
  prettyModel,
  shorten,
} from './core'
import type { Config } from './core'
import {
  alivePids,
  ago,
  applyAskGrace,
  buildSnapshot,
  configDirOf,
  HEARTBEAT_MS,
  isSafeId,
  mergeRows,
  orphans,
  parseRegistry,
  parseSnapshot,
  registryDir,
  snapshotKey,
  snapshotsDir,
  totals,
} from './sessions'
import type { RegistryEntry } from './sessions'

export const HUB_PANE = 'flightdeck-all'
const POLL_MS = 2000
const PUBLISH_MS = 2000

// The same values the session's own pane keeps: read here to build the snapshot, never written.
const main = atom({ plugin: 'flightdeck', key: 'main' } as const, DEFAULT_MAIN)
const usage = atom({ plugin: 'flightdeck', key: 'usage' } as const, DEFAULT_USAGE)
const gate = atom({ plugin: 'flightdeck', key: 'gate' } as const, DEFAULT_GATE)
const agents = atom({ plugin: 'flightdeck', key: 'agents' } as const, [])
const log = atom({ plugin: 'flightdeck', key: 'log' } as const, [])

const DEFAULT_HUB: HubState = { rows: [], at: 0, error: null, selfId: null, isOpen: false }
const DEFAULT_HUB_VIEW: HubView = { expanded: null }
const hub = atom({ plugin: 'flightdeck', key: 'hub' } as const, DEFAULT_HUB)
const hubView = atom({ plugin: 'flightdeck', key: 'hubView' } as const, DEFAULT_HUB_VIEW)

type Timer = { cancel: () => void }
// The module's own variables start over at a reload, and so do the timers, which the engine drops.
let publishTimer: Timer | null = null
let pollTimer: Timer | null = null
let lastKey = ''
let lastWrite = 0
let lastId = ''
let isLocked = false
// When each session's pending ask was first seen: see `applyAskGrace`.
const askSeen = new Map<string, number>()

async function configDir($: EngineInterface) {
  const [configDir, home] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined), $.env.get('HOME').catch(() => undefined)])
  return configDirOf({ configDir, home })
}

async function snapshotsPath($: EngineInterface) {
  return snapshotsDir(await $.env.get('HOME').catch(() => undefined))
}

async function remove($: EngineInterface, path: string) {
  await $.process.run(['rm', '-f', path]).catch(() => undefined)
}

// ---------------------------------------------------------------- publishing

/** Writes this session's snapshot when something changed, or the heartbeat is due. */
async function publish($: EngineInterface) {
  const [id, now, m, u, rawCards, rawGate, rawLog, dir] = await Promise.all([
    $.session.id(),
    $.clock.now(),
    read($, main),
    read($, usage),
    read($, agents),
    read($, gate),
    read($, log),
    snapshotsPath($),
  ])
  if (!isSafeId(id)) return
  const snap = buildSnapshot({
    sessionId: id,
    now,
    main: normalize(DEFAULT_MAIN, m),
    usage: normalize(DEFAULT_USAGE, u),
    cards: listOf<unknown>(rawCards).map(normalizeCard),
    gate: normalizeGate(rawGate),
    log: normalizeLog(rawLog),
  })
  const key = snapshotKey(snap)
  if (id === lastId && key === lastKey && now - lastWrite < HEARTBEAT_MS) return
  // After a /clear the process goes on under a new id: the old id's file would show a session twice.
  if (lastId !== '' && lastId !== id) await remove($, `${dir}/${lastId}.json`)
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify(snap))
  if (!isLocked) {
    // The snapshots are for the person who runs the sessions: close the folder to anyone else.
    isLocked = true
    await $.process.run(['chmod', '700', dir, dir.replace(/\/sessions$/, '')]).catch(() => undefined)
  }
  lastId = id
  lastKey = key
  lastWrite = now
}

function startPolling($: EngineInterface) {
  pollTimer?.cancel()
  void poll($).catch(() => undefined)
  pollTimer = $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
}

/**
 * Starts publishing this session's snapshot, and polling again when the hub pane was open: a reload drops
 * the timers but runs `session.start` again. Called from the one `session.start` hook, which a plugin may have only once.
 */
export async function startHub($: EngineInterface) {
  publishTimer?.cancel()
  void publish($).catch(() => undefined)
  publishTimer = $.clock.every(PUBLISH_MS, () => void publish($).catch(() => undefined))
  if (await isHubOpen($)) startPolling($)
}

/** Whether `/flightdeck all` opened the hub in this session, and it was not closed since. */
export async function isHubOpen($: EngineInterface) {
  return normalize(DEFAULT_HUB, await read($, hub)).isOpen
}

/** Stops publishing and removes this session's snapshot. A `/clear` goes on under a new id, so it is left to the next publish. */
export async function stopPublisher($: EngineInterface, reason: string) {
  if (reason === 'clear') return
  pollTimer?.cancel()
  pollTimer = null
  publishTimer?.cancel()
  publishTimer = null
  if (lastId !== '') await remove($, `${await snapshotsPath($)}/${lastId}.json`)
  lastId = ''
  lastKey = ''
}

// ---------------------------------------------------------------- reading

async function readAll<T>($: EngineInterface, dir: string, parse: (text: string) => T | null): Promise<T[]> {
  const entries = await $.fs.list(dir)
  const out = await Promise.all(
    entries
      .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
      .map(async f => {
        try {
          return parse(await $.fs.read(`${dir}/${f.name}`))
        } catch {
          // Gone between the listing and the read, or half-written: this tick goes without it.
          return null
        }
      }),
  )
  return out.filter((x): x is Awaited<T> => x !== null) as T[]
}

async function poll($: EngineInterface) {
  const dir = await configDir($)
  const snapDir = await snapshotsPath($)
  const now = await $.clock.now()
  let registry: RegistryEntry[] = []
  let error: string | null = null
  try {
    registry = await readAll($, registryDir(dir), parseRegistry)
  } catch {
    error = `cannot read ${registryDir(dir)}`
  }
  const snaps = await readAll<Snapshot>($, snapDir, parseSnapshot).catch(() => [] as Snapshot[])
  const pids = registry.map(r => r.pid).filter(p => p > 0)
  const ps = pids.length > 0 ? await $.process.run(['ps', '-p', pids.join(','), '-o', 'pid=']).catch(() => null) : null
  const selfId = await $.session.id().catch(() => null)
  const merged = mergeRows({
    registry,
    snapshots: new Map(snaps.map(s => [s.sessionId, s])),
    alive: alivePids(ps?.stdout ?? ''),
    now,
    selfId,
    isSelfShown: false,
  })
  // An ask the classifier clears in a moment is not you: it counts once it has waited a few seconds.
  const rows = applyAskGrace(merged, askSeen, now)
  await update($, hub, x => ({ ...normalize(DEFAULT_HUB, x), rows, at: now, error, selfId }))
  // Files of sessions that ended without cleaning up (a crash, a kill).
  const files = await $.fs.list(snapDir).catch(() => [])
  const gone = orphans(
    files.map(f => ({ name: f.name, mtimeMs: f.mtimeMs })),
    // Live sessions' files stay; this session is left out of the rows but is live.
    new Set([...rows.map(r => r.sessionId), ...(selfId ? [selfId] : [])]),
    now,
  )
  for (const name of gone) if (isSafeId(name.slice(0, -5))) await remove($, `${snapDir}/${name}`)
}

// ---------------------------------------------------------------- commands

export async function openHub($: EngineInterface) {
  await update($, hub, x => ({ ...normalize(DEFAULT_HUB, x), isOpen: true }))
  startPolling($)
  return $.ui.open({ id: HUB_PANE, title: 'Flightdeck · all sessions', columns: 96, rows: 14 })
}

export async function closeHub($: EngineInterface) {
  pollTimer?.cancel()
  pollTimer = null
  await update($, hub, x => ({ ...normalize(DEFAULT_HUB, x), isOpen: false }))
  await $.ui.close({ id: HUB_PANE })
}

// ---------------------------------------------------------------- hooks

export function registerHub(on: On, cfg: Config) {
  const C = PALETTES[cfg.palette]

  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Not `h`: JSX compiles against a global of that name.
    const [storedHub, storedView] = await Promise.all([read($, hub), read($, hubView)])
    const state = normalize(DEFAULT_HUB, storedHub)
    const view = normalize(DEFAULT_HUB_VIEW, storedView)
    const rows = listOf<HubRow>(state.rows)
    const W = Math.max(24, e.props.bodyColumns)
    const now = state.at || (await $.clock.now())
    const t = totals(rows)

    const stateColor = (r: HubRow) => (r.state === 'needs-you' ? C.amber : r.state === 'busy' ? C.main : undefined)
    const stateGlyph = (r: HubRow) => (r.state === 'needs-you' ? '⚠' : r.state === 'busy' ? '●' : '›')
    const toggle = (id: string) => () => update($, hubView, x => ({ expanded: normalize(DEFAULT_HUB_VIEW, x).expanded === id ? null : id }))

    // Columns appear as the pane widens: name, context and cost always; model and agents from 64; the last thing it did from 96.
    const nameW = W >= 96 ? 24 : W >= 64 ? Math.min(28, W - 52) : Math.max(8, W - 28)
    const showModel = W >= 64
    const showLast = W >= 96

    const rowOf = (r: HubRow, i: number) => {
      const s = r.snap
      const dim = r.isStale || !r.hasDeck
      const lastLine = s?.log[s.log.length - 1]
      const fill = s?.ctxPct ?? null
      const g = fill !== null ? gauge(fill, 5) : null
      const restW = Math.max(0, W - (nameW + 4 + 10 + 8 + (showModel ? 24 : 0)))
      return (
        <Box flexDirection="column">
          <Box columnGap={1}>
            <Box width={3} flexShrink={0}>
              <Text color={stateColor(r)} dimColor={r.state === 'idle'} bold={r.state !== 'idle'} wrap="truncate">
                {` ${stateGlyph(r)} `}
              </Text>
            </Box>
            <Box width={nameW} flexShrink={0}>
              <Button key={`row-${r.sessionId}`} plain hotkey={i < 9 ? String(i + 1) : undefined} label={shorten(r.name, i < 9 ? nameW - 4 : nameW - 1)} onPress={toggle(r.sessionId)}>
                {r.state === 'needs-you' ? <Text color={C.amber} bold>{shorten(r.name, i < 9 ? nameW - 4 : nameW - 1)}</Text> : shorten(r.name, i < 9 ? nameW - 4 : nameW - 1)}
              </Button>
            </Box>
            {showModel ? (
              <Box width={11} flexShrink={0}>
                <Text dimColor wrap="truncate">
                  {s ? prettyModel(s.model) : 'no deck'}
                </Text>
              </Box>
            ) : null}
            <Box width={10} flexShrink={0}>
              {g ? (
                <Text>
                  <Text color={(fill ?? 0) >= 80 ? C.warn : C.main}>{g.on}</Text>
                  <Text color={C.faint}>{g.off}</Text>
                  <Text dimColor>{` ${Math.round(fill ?? 0)}%`}</Text>
                </Text>
              ) : (
                <Text color={C.faint}>—</Text>
              )}
            </Box>
            <Box width={7} flexShrink={0}>
              <Text dimColor>{s?.costUsd != null ? fmtUsd(s.costUsd) : ''}</Text>
            </Box>
            {showModel ? (
              <Box width={10} flexShrink={0}>
                {s && s.pending > 0 ? (
                  <Text color={C.amber} bold inverse>{` ⚠ ${s.pending} ask `}</Text>
                ) : s && s.agentsTotal > 0 ? (
                  <Text color={s.agentsRunning > 0 ? C.agent : C.dim}>{`◐ ${s.agentsRunning}/${s.agentsTotal}`}</Text>
                ) : null}
              </Box>
            ) : null}
            <Box width={4} flexShrink={0}>
              <Text color={C.faint}>{ago(r.activeAt, now)}</Text>
            </Box>
            {showLast && restW > 8 ? (
              <Text dimColor={dim} color={lastLine?.isError ? C.warn : undefined} wrap="truncate">
                {lastLine ? shorten(`${lastLine.who}: ${lastLine.text}`, restW) : ''}
              </Text>
            ) : null}
          </Box>
          {view.expanded === r.sessionId ? detail(r) : null}
        </Box>
      )
    }

    const detail = (r: HubRow) => {
      const s = r.snap
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1} width={W}>
          <Text dimColor wrap="truncate">{`${r.cwd} · pid ${r.pid}${r.isStale ? ' · deck quiet' : ''}`}</Text>
          {!s ? <Text color={C.faint}>Flightdeck is not running in this session; only Claude Code's own status shows.</Text> : null}
          {s && s.agents.length === 0 ? <Text color={C.faint}>no agents</Text> : null}
          {s?.agents.map(a => (
            <Box columnGap={1}>
              <Text color={a.status === 'failed' ? C.warn : a.status === 'done' ? C.gate : C.agent}>
                {a.status === 'running' ? '◐' : a.status === 'done' ? '✓' : a.status === 'failed' ? '✗' : '■'}
              </Text>
              <Box width={Math.max(8, W - 30)} flexShrink={0}>
                <Text wrap="truncate">{a.title}</Text>
              </Box>
              <Text dimColor>{`ctx ${kTokens(a.ctx)} · ${plural(a.steps, 'step')}`}</Text>
            </Box>
          ))}
          {s?.log.map(l => (
            <Text color={l.isError ? C.warn : C.faint} wrap="truncate">
              {`${ago(l.at, now).padStart(3)} ${l.who}: ${l.text}`}
            </Text>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={W}>
        <Box columnGap={2}>
          <Text bold>ALL SESSIONS</Text>
          <Text dimColor wrap="truncate">
            {[
              plural(t.sessions, 'session'),
              t.needsYou > 0 ? `${t.needsYou} need you` : null,
              t.busy > 0 ? `${t.busy} busy` : null,
              t.agents > 0 ? plural(t.agents, 'agent') : null,
              t.costUsd > 0 ? fmtUsd(t.costUsd) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Box>
        {t.needsYou > 0 ? (
          <Text color={C.amber} bold inverse wrap="truncate">
            {` ⚠ ${t.needsYou === 1 ? '1 session is' : `${t.needsYou} sessions are`} waiting on you `}
          </Text>
        ) : null}
        {state.error ? <Text color={C.warn} wrap="truncate">{state.error}</Text> : null}
        {state.at === 0 ? <Text color={C.faint}>reading sessions…</Text> : null}
        {state.at !== 0 && rows.length === 0 && !state.error ? (
          <Text color={C.faint} wrap="wrap">
            No other live Claude Code sessions found. Sessions running Flightdeck show their context, cost and agents here.
          </Text>
        ) : null}
        {rows.map(rowOf)}
      </Box>
    )
  }).catch(($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" width={Math.max(20, e.props.bodyColumns)}>
        <Text bold>ALL SESSIONS</Text>
        <Text color={C.warn} wrap="wrap">{`draw failed (${next.error.kind}): ${next.error.message ?? 'no message'}`}</Text>
      </Box>
    )
  })
}
