// The all-sessions hub's pure half: the snapshot each session publishes, the registry entry Claude Code
// keeps for each live session, and how the two merge into the rows the hub draws. No `$` in here.

import type { AgentCard, Gate, HubRow, LogLine, Main, RowState, Snapshot, Usage } from '../types'
import { cardTitle, contextFill, gateSummary, redact, shorten } from './core'

export const SNAP_VERSION = 1
/** A snapshot is rewritten at least this often while its session lives, changed or not. */
export const HEARTBEAT_MS = 15_000
/** A snapshot older than this, for a session the registry still lists, is drawn dim: its deck went quiet. */
export const STALE_MS = 45_000
/** A snapshot whose registry entry has been gone this long is deleted by the hub. */
export const ORPHAN_MS = 60 * 60 * 1000
/**
 * A session's pending ask counts as "needs you" only after it has been pending this long. An ask is put to the
 * decider, which in auto mode is the classifier, not you: it holds a call for a moment and clears it, as it
 * does at the start of nearly every session. A call that really waits on you is still pending after this.
 */
export const ASK_GRACE_MS = 8_000

/** The fields of Claude Code's own `sessions/<pid>.json` the hub reads. */
export type RegistryEntry = {
  pid: number
  sessionId: string
  cwd: string
  name: string
  /** What the registry says: 'idle', or something else while it works. Absent in older builds. */
  status: string | null
  startedAt: number
  updatedAt: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)

// ---------------------------------------------------------------- publishing

const MAX_AGENTS = 6
const MAX_LINES = 5

export type SnapshotInput = {
  sessionId: string
  now: number
  main: Main
  usage: Usage
  cards: AgentCard[]
  gate: Gate
  log: LogLine[]
}

/** What goes in the file: counts, names and one-line activity, credentials masked. No prompts, no file contents. */
export function buildSnapshot(i: SnapshotInput): Snapshot {
  const g = gateSummary(i.gate)
  const running = i.cards.filter(c => c.status === 'running')
  // Running agents first, then the most recent of the rest.
  const shown = [...running, ...i.cards.filter(c => c.status !== 'running').reverse()].slice(0, MAX_AGENTS)
  return {
    v: SNAP_VERSION,
    sessionId: i.sessionId,
    at: i.now,
    model: i.main.model,
    isRunning: i.main.isRunning,
    ctxPct: contextFill(i.usage).pct,
    costUsd: i.usage.costUsd,
    agentsRunning: running.length,
    agentsTotal: i.cards.length,
    pending: g.ask,
    denied: g.deny,
    agents: shown.map(c => ({
      title: redact(shorten(cardTitle(c), 60)),
      status: c.status,
      ctx: c.ctx,
      steps: c.steps,
      spawnedAt: c.spawnedAt,
      endedAt: c.endedAt,
    })),
    log: i.log.slice(-MAX_LINES).map(l => ({ at: l.at, who: shorten(l.who, 20), text: redact(shorten(l.text, 120)), isError: l.kind === 'error' })),
  }
}

/** The text a snapshot is compared by: everything but when it was written. */
export const snapshotKey = (s: Snapshot) => JSON.stringify({ ...s, at: 0 })

// ---------------------------------------------------------------- reading

/** A snapshot file's text, or null when it is not one this build can read (half-written, other version, other shape). */
export function parseSnapshot(text: string): Snapshot | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw.v !== SNAP_VERSION || typeof raw.sessionId !== 'string' || raw.sessionId === '') return null
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isObject) : [])
  return {
    v: SNAP_VERSION,
    sessionId: raw.sessionId,
    at: num(raw.at, 0),
    model: str(raw.model),
    isRunning: raw.isRunning === true,
    ctxPct: numOrNull(raw.ctxPct),
    costUsd: numOrNull(raw.costUsd),
    agentsRunning: num(raw.agentsRunning, 0),
    agentsTotal: num(raw.agentsTotal, 0),
    pending: num(raw.pending, 0),
    denied: num(raw.denied, 0),
    agents: list(raw.agents).map(a => ({
      title: str(a.title, 'agent'),
      status: str(a.status, 'running'),
      ctx: num(a.ctx, 0),
      steps: num(a.steps, 0),
      spawnedAt: num(a.spawnedAt, 0),
      endedAt: numOrNull(a.endedAt),
    })),
    log: list(raw.log).map(l => ({ at: num(l.at, 0), who: str(l.who), text: str(l.text), isError: l.isError === true })),
  }
}

/** A registry file's text, or null when it names no session. */
export function parseRegistry(text: string): RegistryEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || typeof raw.sessionId !== 'string' || raw.sessionId === '') return null
  const cwd = str(raw.cwd)
  return {
    pid: num(raw.pid, 0),
    sessionId: raw.sessionId,
    cwd,
    name: str(raw.name) || cwd.split('/').filter(Boolean).pop() || raw.sessionId.slice(0, 8),
    status: typeof raw.status === 'string' ? raw.status : null,
    startedAt: num(raw.startedAt, 0),
    updatedAt: num(raw.updatedAt, num(raw.startedAt, 0)),
  }
}

/** The ids of the pids in `ps -p … -o pid=`'s output: the sessions' processes that still run. */
export const alivePids = (psOutput: string) =>
  new Set(
    psOutput
      .split('\n')
      .map(l => Number(l.trim()))
      .filter(n => Number.isInteger(n) && n > 0),
  )

// ---------------------------------------------------------------- merging

const ORDER: Record<RowState, number> = { 'needs-you': 0, busy: 1, idle: 2 }

export type MergeInput = {
  registry: RegistryEntry[]
  snapshots: Map<string, Snapshot>
  /** Pids found running; a registry entry whose pid is not here is a session that has ended. */
  alive: Set<number>
  now: number
  /** The hub's own session, left out unless `isSelfShown`. */
  selfId: string | null
  isSelfShown: boolean
}

/** One row per live session, sessions that need you first, then busy, then idle; the latest activity first within each. */
export function mergeRows(i: MergeInput): HubRow[] {
  const rows: HubRow[] = []
  for (const r of i.registry) {
    if (!i.alive.has(r.pid)) continue
    if (!i.isSelfShown && r.sessionId === i.selfId) continue
    const snap = i.snapshots.get(r.sessionId) ?? null
    const state: RowState = snap
      ? snap.pending > 0
        ? 'needs-you'
        : snap.isRunning || snap.agentsRunning > 0
          ? 'busy'
          : 'idle'
      : r.status !== null && r.status !== 'idle'
        ? 'busy'
        : 'idle'
    const activeAt = Math.max(r.updatedAt, snap?.at ?? 0)
    rows.push({
      sessionId: r.sessionId,
      name: r.name,
      cwd: r.cwd,
      pid: r.pid,
      state,
      hasDeck: snap !== null,
      isStale: snap !== null && i.now - snap.at > STALE_MS,
      snap,
      activeAt,
    })
  }
  return rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.activeAt - a.activeAt || a.name.localeCompare(b.name))
}

/**
 * Holds back sessions whose ask is younger than `ASK_GRACE_MS`: they show as busy, not as needing you.
 * `seen` maps a session id to when its ask was first seen and is kept by the caller between polls; this
 * writes to it. A session whose ask is gone has its entry dropped, so the next ask starts its own clock.
 */
export function applyAskGrace(rows: HubRow[], seen: Map<string, number>, now: number): HubRow[] {
  const asking = new Set<string>()
  const out = rows.map(r => {
    if (!r.snap || r.snap.pending <= 0) return r
    asking.add(r.sessionId)
    const since = seen.get(r.sessionId) ?? now
    seen.set(r.sessionId, since)
    return r.state === 'needs-you' && now - since < ASK_GRACE_MS ? { ...r, state: 'busy' as const } : r
  })
  for (const id of [...seen.keys()]) if (!asking.has(id)) seen.delete(id)
  return out
}

/** Snapshot file names (`<id>.json`) with no live session behind them, and old enough to delete. */
export function orphans(files: { name: string; mtimeMs: number }[], liveIds: Set<string>, now: number): string[] {
  return files
    .filter(f => f.name.endsWith('.json') && !liveIds.has(f.name.slice(0, -5)) && now - f.mtimeMs > ORPHAN_MS)
    .map(f => f.name)
}

export const totals = (rows: HubRow[]) => ({
  sessions: rows.length,
  needsYou: rows.filter(r => r.state === 'needs-you').length,
  busy: rows.filter(r => r.state === 'busy').length,
  agents: rows.reduce((n, r) => n + (r.snap?.agentsRunning ?? 0), 0),
  costUsd: rows.reduce((n, r) => n + (r.snap?.costUsd ?? 0), 0),
})

/** "4s", "3m", "2h", "5d" ago. */
export function ago(ms: number, now: number) {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

// ---------------------------------------------------------------- paths

/** Where Claude Code keeps its state: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const configDirOf = (env: { configDir?: unknown; home?: unknown }) =>
  typeof env.configDir === 'string' && env.configDir !== ''
    ? env.configDir
    : `${typeof env.home === 'string' && env.home !== '' ? env.home : '~'}/.claude`

/**
 * Where every session publishes its snapshot: under `~/.claude`, whatever `CLAUDE_CONFIG_DIR` says, so sessions in
 * different config dirs find each other. The registry is Claude Code's own and stays in the config dir.
 */
export const snapshotsDir = (home: unknown) => `${typeof home === 'string' && home !== '' ? home : '~'}/.claude/flightdeck/sessions`
export const registryDir = (configDir: string) => `${configDir}/sessions`
/** Ids come from Claude Code, but the file name is built from one: keep it to a plain name. */
export const isSafeId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id)
