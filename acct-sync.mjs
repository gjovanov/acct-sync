#!/usr/bin/env node
/**
 * acct-sync: carry Claude Code sessions from one account to another, cheaply.
 *
 * It reads transcripts, it never changes one. It never reads or copies credentials.
 * What it writes: handoff packs under <config dir>/handoffs/<project>/acct/, its own state.json,
 * and (only between two different config dirs) copies of the sessions you name.
 *
 * Usage and the reasoning behind every figure: README.md beside this file.
 * https://github.com/gjovanov/acct-sync (MIT)
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

// ───────────────────────────────────────────────────────────── paths and small helpers

// The home folder as Node reads it: USERPROFILE on Windows, HOME elsewhere, as Cache Keeper and handoff-guard read it.
const HOME = os.homedir()
const DEFAULT_DIR = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'))
const TOOL_FILE = fileURLToPath(import.meta.url)
const STATE_FILE = process.env.ACCT_SYNC_STATE || path.join(path.dirname(TOOL_FILE), 'state.json')
const SELF = `node ${fwd(TOOL_FILE)}`
// The slash command, without the slash, that has a session write a handoff of its own: plan and `handoff --ask` name
// it. The default is the author's own skill, as in handoff-guard; ACCT_SYNC_HANDOFF_COMMAND names yours.
const HANDOFF_COMMAND = String(process.env.ACCT_SYNC_HANDOFF_COMMAND || 'hub-handoff').trim().replace(/^\/+/, '') || 'hub-handoff'

function fwd(p) { return String(p).replace(/\\/g, '/') }
function die(msg, code = 2) { console.error(`acct-sync: ${msg}`); process.exit(code) }
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e })   // `| head` closing the pipe is not a failure
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
function exists(p) { try { fs.accessSync(p); return true } catch { return false } }
function clip(s, n) { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)} … [+${s.length - n} chars]` : s }
function oneLine(s, n) { return clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n) }
/** What an engine export left out to fit the 4 MiB a plugin may write, for the pack's Conversation row. */
function trimmedText(t) {
  if (!t) return ''
  const cut = t.resultChars ? `tool output and long text were cut (a tool's result to ${t.resultChars} characters)` : ''
  const dropped = t.droppedMessages ? `the oldest ${t.droppedMessages} of its ${t.messages ?? '?'} messages were left out` : ''
  return `; to fit the 4 MiB a plugin may write, ${[cut, dropped].filter(Boolean).join(' and ') || 'thinking and media were left out'}`
}
function tok(n) {
  if (n == null || Number.isNaN(n)) return '?'
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}
function usd(x) { return x >= 100 ? `$${x.toFixed(0)}` : `$${x.toFixed(2)}` }
function ago(ms) {
  if (!ms) return '?'
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 129600) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
function iso(ms) { return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '?' }
function estTokens(chars) { return Math.round(chars / 3.6) }
function table(rows, { right = [] } = {}) {
  const w = []
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] || 0, String(c).length) })
  return rows.map(r => r.map((c, i) => (right.includes(i) ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  ').trimEnd()).join('\n')
}

const BOOL = new Set(['json', 'dry-run', 'force', 'all-projects', 'live', 'shared', 'full', 'print', 'ask', 'with-memory',
  'verify', 'current', 'prompts', 'files', 'tools', 'no-embed', 'no-pack', 'help', 'all', 'case', 'results', 'write'])
function parseArgs(argv) {
  const pos = [], opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    if (!a.startsWith('--')) { pos.push(a); continue }
    const eq = a.indexOf('=')
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2)
    if (eq > 0) opt[k] = a.slice(eq + 1)
    else if (BOOL.has(k)) opt[k] = true
    else { const v = argv[i + 1]; if (v === undefined) die(`--${k} needs a value`); opt[k] = v; i++ }
  }
  return { pos, opt }
}
function duration(s, dflt) {
  if (s == null) return dflt
  const m = /^(\d+(?:\.\d+)?)([mhdw]?)$/.exec(String(s)); if (!m) die(`bad duration "${s}" (use 90m, 12h, 7d, 2w)`)
  return Number(m[1]) * ({ m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3, '': 86400e3 })[m[2]]
}
/**
 * When this machine last started. It counts time asleep (checked against Windows' own record of the boot, across
 * several sleeps), so a later value than a session's last record means a restart came after it. The reverse does
 * not hold: a Windows shutdown with Fast Startup ends every session and leaves this value where it was.
 */
function bootTime() { try { return Date.now() - os.uptime() * 1000 } catch { return 0 } }
/** JSON in plain ASCII, so that a shell reading it in another code page cannot garble a session's name. */
function asciiJson(x) { return JSON.stringify(x, null, 2).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) }

// ───────────────────────────────────────────────────────────── prices (USD per million input tokens)
// Source: Anthropic's published API prices as cached in Claude Code's claude-api skill on 2026-11-03.
// A cache write costs 2x input at the 1-hour TTL and 1.25x at 5 minutes; output costs 5x input.
// Override or extend with a prices.json beside this file: [["regex", {"in": 4, "read": 0.05}], ...]

const PRICES = [
  [/fable-5-2|mythos-5-2/, { in: 8, read: 0.025 }],
  [/fable-5-1|mythos-5-1/, { in: 10, read: 0.025 }],
  [/fable-5|mythos-5/, { in: 10, read: 0.1 }],
  [/opus-5-5/, { in: 4, read: 0.05 }],
  [/opus-5|opus-4-[5-8]/, { in: 5, read: 0.1 }],
  [/sonnet-5-5/, { in: 2, read: 0.05 }],
  [/sonnet-5/, { in: 2, read: 0.1 }],
  [/sonnet-4/, { in: 3, read: 0.1 }],
  [/haiku-5-5/, { in: 0.1, inOver100k: 0.5, read: 0.1 }],
  [/haiku-4-5/, { in: 1, read: 0.1 }],
]
const EXTRA_PRICES = (readJson(path.join(path.dirname(TOOL_FILE), 'prices.json')) || []).map(([re, p]) => [new RegExp(re), p])
function priceOf(model, ctx = 0) {
  const m = String(model || '')
  for (const [re, p] of [...EXTRA_PRICES, ...PRICES]) {
    if (re.test(m)) return { in: p.inOver100k && ctx > 100000 ? p.inOver100k : p.in, read: p.read, known: true }
  }
  return { in: 4, read: 0.05, known: false }
}

// ───────────────────────────────────────────────────────────── state: labels, share list, floors

let IDX = {}, IDX_DIRTY = false   // per session: who started it and whose credential it last used (see ownership())
function loadState() {
  const s = { v: 1, accounts: {}, shared: {}, floors: {}, idx: {}, packs: {}, ...(readJson(STATE_FILE) || {}) }
  IDX = s.idx
  return s
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  const tmp = `${STATE_FILE}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, STATE_FILE)
  IDX_DIRTY = false
}

// ───────────────────────────────────────────────────────────── logins and owners
// An "account" here is the organization a login bills to: that is what the prompt cache, the usage
// limits and the reasoning blocks are tied to. A personal plan has one organization per account.

/** A short, stable name for a login that gives away neither the address nor the ids. */
function fp(o) {
  const k = o?.organizationUuid || o?.accountUuid
  return k ? crypto.createHash('sha256').update(k).digest('hex').slice(0, 8) : '--------'
}
function sameOwner(a, b) {
  if (!a || !b) return false
  if (a.organizationUuid && b.organizationUuid) return a.organizationUuid === b.organizationUuid
  return Boolean(a.accountUuid) && a.accountUuid === b.accountUuid
}
/** Is `on` (where a session's requests last ran) the login `dest`? null when the records do not allow a comparison. */
function sameLogin(on, dest) {
  if (!on || !dest) return null
  if (on.organizationUuid && dest.organizationUuid) return on.organizationUuid === dest.organizationUuid
  if (on.accountUuid && dest.accountUuid) return on.accountUuid === dest.accountUuid
  return null
}
/** Claude Code keeps its global state file beside the config dir by default, inside it when CLAUDE_CONFIG_DIR is set. */
function globalConfigPath(configDir) {
  const inside = path.join(configDir, '.claude.json')
  if (exists(inside)) return inside
  const beside = path.join(HOME, '.claude.json')
  return path.resolve(configDir) === path.resolve(path.join(HOME, '.claude')) && exists(beside) ? beside : inside
}
function currentLogin(configDir = DEFAULT_DIR) {
  const j = readJson(globalConfigPath(configDir)); const a = j?.oauthAccount
  if (!a?.accountUuid) return null
  return {
    accountUuid: a.accountUuid, organizationUuid: a.organizationUuid || '',
    plan: a.planDisplayName || a.seatTier || a.organizationType || '',
    ownerAsk: Boolean(j.cachedGrowthBookFeatures?.tengu_bubbly_fountain),
  }
}
function labelFor(state, owner) {
  if (!owner?.organizationUuid && !owner?.accountUuid) return null
  for (const [name, a] of Object.entries(state.accounts)) if (sameOwner(a, owner)) return name
  return null
}
function ownerText(state, owner) {
  if (!owner?.organizationUuid && !owner?.accountUuid) return 'an unknown login'
  const l = labelFor(state, owner)
  return l ? `${l} (${fp(owner)})` : `login ${fp(owner)}`
}
function shortOwner(state, owner) { return labelFor(state, owner) || (owner ? fp(owner) : '?') }
/** "pro" when it has only run on one login, "pro→private" when another login continued it. */
function ownerCol(state, q) {
  const a = startedBy(q), b = runsOn(q)
  return a && b && !sameOwner(a, b) ? `${shortOwner(state, a)}→${shortOwner(state, b)}` : shortOwner(state, b)
}
function whoText(state, q) {
  const a = startedBy(q), b = runsOn(q)
  return a && b && !sameOwner(a, b) ? `started under ${ownerText(state, a)}, last ran on ${ownerText(state, b)}` : `ran under ${ownerText(state, b)}`
}
function accountByName(state, name) {
  if (!name) return null
  const a = state.accounts[name]
  if (a) return { name, ...a, configDir: path.resolve(a.configDir || DEFAULT_DIR) }
  die(`no account labelled "${name}". Known: ${Object.keys(state.accounts).join(', ') || '(none; run: label <name> --current)'}`)
}
function configDirs(state) {
  const set = new Set([DEFAULT_DIR])
  for (const a of Object.values(state.accounts)) if (a.configDir) set.add(path.resolve(a.configDir))
  return [...set].filter(d => exists(path.join(d, 'projects')))
}

// ───────────────────────────────────────────────────────────── finding sessions

function slugOf(cwd) { return String(cwd).replace(/[^a-zA-Z0-9]/g, '-') }
function projectDirs(configDir) {
  const root = path.join(configDir, 'projects')
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(root, d.name)) } catch { return [] }
}
function sessionFilesIn(projectDir) {
  let names = []
  try { names = fs.readdirSync(projectDir) } catch { return [] }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    const file = path.join(projectDir, n)
    try { const st = fs.statSync(file); if (st.isFile()) out.push({ sid: n.slice(0, -6), file, size: st.size, mtimeMs: st.mtimeMs, projectDir }) } catch { /* raced away */ }
  }
  return out
}
function projectFilter(configDir, spec) {
  if (!spec) return null
  const asPath = spec === '.' ? process.cwd() : spec
  const slug = /[\\/:]/.test(asPath) || spec === '.' ? slugOf(path.resolve(asPath)) : spec
  const dirs = projectDirs(configDir).filter(d => { const b = path.basename(d); return b === slug || b.toLowerCase().includes(String(spec).toLowerCase()) })
  const exact = dirs.filter(d => path.basename(d) === slug)
  return exact.length ? exact : dirs
}
function allSessions(state, { project, sinceMs } = {}) {
  const out = []
  for (const cd of configDirs(state)) {
    const dirs = project ? projectFilter(cd, project) : projectDirs(cd)
    for (const d of dirs) for (const s of sessionFilesIn(d)) if (!sinceMs || s.mtimeMs >= sinceMs) out.push({ ...s, configDir: cd })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}
function configDirOf(file) { return path.resolve(path.dirname(file), '..', '..') }

/**
 * A conversation Claude Code saved no transcript for, exported by a plugin from what the engine holds (Claude Code
 * saves none for a process started from inside another Claude session, which sets CLAUDE_CODE_CHILD_SESSION):
 * `{ sessionId, cwd, configDir?, exportedAt, startedAt?, lastTurnAt?, model?, title?, why?, usage?, handoffs?, trimmed?,
 * messages }`, the
 * messages in Messages API form (`$.session.messages({ as: 'api' })`). It is written out beside the export as transcript
 * records, so every reader here takes it, and the export is removed. Only the first and last record carry a time.
 */
function fromEngineExport(file) {
  let x; try { x = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { die(`${fwd(file)}: not readable as JSON (${e.message})`) }
  const sid = String(x?.sessionId || '')
  if (!/^[0-9a-f-]{36}$/i.test(sid) || !Array.isArray(x.messages)) die(`${fwd(file)}: not an engine export (it needs sessionId and messages)`)
  const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
  const META = /^(Caveat: The messages below were generated by the user while running local commands|Base directory for this skill:|\[Image: original \d+x\d+)/
  const COMPACTED = /^This session is being continued from a previous conversation/
  // Text the harness wrote, each piece a message of its own in a transcript: never part of a prompt beside it.
  const HARNESS = new RegExp(`^(<(command-name|command-message|command-args|local-command-|bash-input|bash-std|task-notification)|${META.source.slice(1)}|${COMPACTED.source.slice(1)})`)
  const base = { sessionId: sid, cwd: x.cwd || undefined, version: x.version || undefined, gitBranch: x.gitBranch || undefined }
  const recs = []
  if (x.title) recs.push({ type: 'custom-title', customTitle: String(x.title), sessionId: sid })
  const lastAssistant = x.messages.map(m => m?.role).lastIndexOf('assistant')
  // A prompt a schedule fired is the text the session gave CronCreate or ScheduleWakeup: a transcript marks it as the
  // system's, the engine's form does not. Matched on its start, which the export's cuts leave whole.
  const scheduled = []
  for (const m of x.messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      const p = b?.type === 'tool_use' && (b.name === 'CronCreate' || b.name === 'ScheduleWakeup') ? b.input?.prompt : null
      if (typeof p === 'string' && p.trim().length >= 8) scheduled.push(p.trim().slice(0, 200))
    }
  }
  x.messages.forEach((m, i) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content.filter(Boolean) : []
    if (m.role === 'assistant') {
      const message = { role: 'assistant', content: blocks, model: x.model || undefined }
      if (i === lastAssistant && x.usage) message.usage = x.usage
      recs.push({ type: 'assistant', ...base, message })
      return
    }
    // The engine folds reminders into a user message as text and merges the user messages that follow each other: tool
    // results, a command's echo and output, a notice, the prompt typed meanwhile. Split them back, one record each.
    const results = blocks.filter(b => b.type === 'tool_result')
    const rest = blocks.filter(b => b.type !== 'tool_result')
      .map(b => (b.type === 'text' ? { ...b, text: String(b.text || '').replace(REMINDER, '').trim() } : b))
      .filter(b => b.type !== 'text' || b.text)
    if (results.length) recs.push({ type: 'user', ...base, message: { role: 'user', content: results } })
    const groups = []
    for (const b of rest) {
      const own = b.type === 'text' && HARNESS.test(b.text)
      const prev = groups[groups.length - 1]
      if (prev && !own && !prev.own) prev.blocks.push(b); else groups.push({ own, blocks: [b] })
    }
    for (const g of groups) {
      const text = g.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
      const r = { type: 'user', ...base, message: { role: 'user', content: g.blocks } }
      if (COMPACTED.test(text)) r.isCompactSummary = true
      else if (META.test(text)) r.isMeta = true
      else if (text.includes('<task-notification>')) r.origin = { kind: 'task-notification' }
      else if (scheduled.some(p => text.startsWith(p))) Object.assign(r, { isMeta: true, promptSource: 'system' })
      recs.push(r)
    }
  })
  const at = ms => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : undefined)
  const first = recs.findIndex(r => r.type === 'user' || r.type === 'assistant')
  if (first >= 0 && at(x.startedAt)) recs[first].timestamp = at(x.startedAt)
  // The last turn's time goes on its last reply: what follows it can be a command typed since (the /pack-and-clear
  // that asked for this export is one), which is no turn.
  const lastReply = recs.map(r => r.type).lastIndexOf('assistant')
  if (lastReply > first && at(x.lastTurnAt)) recs[lastReply].timestamp = at(x.lastTurnAt)
  const out = path.join(path.dirname(file), `${sid}.jsonl`)
  fs.writeFileSync(out, recs.map(r => JSON.stringify(r)).join('\n') + '\n')
  try { fs.unlinkSync(file) } catch { /* the records are what counts */ }
  const st = fs.statSync(out)
  const configDir = x.configDir ? path.resolve(x.configDir) : configDirOf(out)
  return {
    sid, file: out, size: st.size, mtimeMs: st.mtimeMs, configDir,
    projectDir: x.cwd ? path.join(configDir, 'projects', slugOf(path.resolve(x.cwd))) : path.dirname(out),
    exported: {
      at: Number(x.exportedAt) || st.mtimeMs, why: x.why ? oneLine(x.why, 200) : null,
      // What the plugin knows of the session's handoffs, which the messages may not show: a compaction drops the turn
      // that wrote one. `turnsAfter` is the turns with work in them since (handoff-guard's count).
      handoffs: (Array.isArray(x.handoffs) ? x.handoffs : []).filter(h => h && typeof h.path === 'string')
        .map(h => ({ path: fwd(h.path), at: Number(h.at) || 0, turnsAfter: Number.isInteger(h.turnsAfter) ? h.turnsAfter : null })),
      // What the plugin cut to keep the export within the 4 MiB it may write: long pieces, then the oldest messages.
      trimmed: x.trimmed && typeof x.trimmed === 'object'
        ? { resultChars: Number(x.trimmed.resultChars) || null, droppedMessages: Number(x.trimmed.droppedMessages) || 0, messages: Number(x.trimmed.messages) || null }
        : null,
    },
  }
}

/** A session by id, unique id prefix, name, `.` (this session), transcript path, or engine export (above). */
function resolveSession(state, ref) {
  if (!ref) die('which session? Give an id, an id prefix, a name, or "." inside a session')
  if (ref === '.' || ref === 'current') {
    ref = process.env.CLAUDE_CODE_SESSION_ID || die('"." needs CLAUDE_CODE_SESSION_ID (run it inside a Claude Code session)')
  }
  if (/\.jsonl$/i.test(ref) && exists(ref)) {
    const file = path.resolve(ref); const st = fs.statSync(file)
    return { sid: path.basename(file, '.jsonl'), file, size: st.size, mtimeMs: st.mtimeMs, projectDir: path.dirname(file), configDir: configDirOf(file) }
  }
  if (/\.json$/i.test(ref) && exists(ref)) return fromEngineExport(path.resolve(ref))
  const all = allSessions(state)
  const low = ref.toLowerCase()
  if (/^[0-9a-f-]{4,36}$/.test(low)) {
    const hits = all.filter(s => s.sid.toLowerCase().startsWith(low))
    const sids = [...new Set(hits.map(h => h.sid))]
    if (sids.length === 1) return hits[0]          // newest copy when two config dirs hold it
    if (sids.length > 1) die(`"${ref}" matches ${sids.length} sessions: ${sids.slice(0, 6).map(s => s.slice(0, 13)).join(', ')}${sids.length > 6 ? ', …' : ''}`)
  }
  // A running session's name is in Claude Code's registry; a closed one's is in its transcript.
  for (const cd of configDirs(state)) for (const [sid, l] of liveSessions(cd)) if (l.name && l.name.toLowerCase() === low) { const hit = all.find(s => s.sid === sid); if (hit) return hit }
  const named = []
  for (const s of all.slice(0, 600)) {
    const q = quickInfo(s.file, s)
    if ([q.title, q.aiTitle].some(t => t && t.toLowerCase() === low)) named.push(s)
  }
  if (named.length) return named[0]
  die(`no session matches "${ref}"`)
}

// ───────────────────────────────────────────────────────────── reading a transcript's tail (fast facts)

function readTail(file, fileSize, window) {
  const len = Math.min(window, fileSize); const buf = Buffer.allocUnsafe(len)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, buf, 0, len, fileSize - len) } finally { fs.closeSync(fd) }
  let s = buf.toString('utf8')
  if (len < fileSize) { const i = s.indexOf('\n'); s = i >= 0 ? s.slice(i + 1) : '' }
  return s
}
function ctxOf(u) { return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) }
function ttlOf(u) {
  const c = u.cache_creation
  if (c?.ephemeral_1h_input_tokens > 0) return '1h'
  if (c?.ephemeral_5m_input_tokens > 0) return '5m'
  return null
}
const LIMIT_RE = /(hit your|reached your)[^.\n]{0,40}limit|usage limit|out of extra usage/i

// Two records say whose session this is. `session-owner` names the login that started it and is never
// rewritten when another login continues it. A `credential_org` attachment names the organization whose
// credential the requests use, and a new one is written when that changes: the last one is where the
// session's cache lives. Both can sit far from the end of a long transcript, so they are searched as bytes.
const PAT_OWNER = Buffer.from('{"type":"session-owner","accountUuid":"')
const PAT_CRED = Buffer.from('"type":"credential_org","organizationUuid":"')
const UUID = '[0-9a-f]{8}-[0-9a-f-]{27}'
function readAt(fd, pos, len, size) { const n = Math.max(0, Math.min(len, size - pos)); const b = Buffer.allocUnsafe(n); if (n) fs.readSync(fd, b, 0, n, pos); return b.toString('utf8') }
/** The last occurrence of each pattern inside [from, to), as the text that follows it. */
function searchBack(file, size, from, to, pats) {
  const found = pats.map(() => null); const CH = 8 * 1024 * 1024, OV = 256
  const fd = fs.openSync(file, 'r')
  try {
    for (let end = to; end > from && found.includes(null);) {
      const start = Math.max(from, end - CH); const len = Math.min(size, end + OV) - start
      const buf = Buffer.allocUnsafe(len); fs.readSync(fd, buf, 0, len, start)
      pats.forEach((p, i) => { if (found[i] !== null) return; const k = buf.lastIndexOf(p); if (k >= 0) found[i] = readAt(fd, start + k + p.length, 160, size) })
      end = start
    }
  } finally { fs.closeSync(fd) }
  return found
}
function firstCredOrg(file, size) {
  const len = Math.min(size, 3 * 1024 * 1024); const buf = Buffer.allocUnsafe(len)
  const fd = fs.openSync(file, 'r'); try { fs.readSync(fd, buf, 0, len, 0) } finally { fs.closeSync(fd) }
  const k = buf.indexOf(PAT_CRED); if (k < 0) return null
  return new RegExp(`^(${UUID})`).exec(buf.subarray(k + PAT_CRED.length, k + PAT_CRED.length + 40).toString('utf8'))?.[1] || null
}
const DEEP = 96 * 1024 * 1024
/** Fill q.owner (who started it), q.payer (whose credential it last used) and q.firstOrg, past the tail window if need be. */
function ownership(q, st, win) {
  const c = IDX[q.sid] && IDX[q.sid].size <= st.size ? IDX[q.sid] : null
  const winStart = Math.max(0, st.size - win)
  if (!q.owner && c?.owner) q.owner = c.owner
  if (!q.payer || !q.owner) {
    const lo = c ? Math.min(c.size, winStart) : Math.max(0, winStart - DEEP)
    if (lo < winStart) {
      const [o, p] = searchBack(q.file, st.size, lo, winStart, [PAT_OWNER, PAT_CRED])
      const om = o && new RegExp(`^(${UUID})","organizationUuid":"(${UUID})?`).exec(o)
      if (!q.owner && om) q.owner = { accountUuid: om[1], organizationUuid: om[2] || '' }
      const pm = p && new RegExp(`^(${UUID})`).exec(p)
      if (!q.payer && pm) q.payer = pm[1]
    }
    if (!q.payer && c?.payer) q.payer = c.payer
  }
  q.firstOrg = c && 'firstOrg' in c ? c.firstOrg : firstCredOrg(q.file, st.size)
  IDX_SEEN.add(q.sid)
  if (!c || c.size !== st.size || c.payer !== q.payer) { IDX[q.sid] = { size: st.size, owner: q.owner, payer: q.payer, firstOrg: q.firstOrg }; IDX_DIRTY = true }
}
const IDX_SEEN = new Set(), IDX_MAX = 4000
/** The index only saves re-reading; past a few thousand entries keep the sessions this run looked at. */
function pruneIndex() { if (Object.keys(IDX).length > IDX_MAX) for (const k of Object.keys(IDX)) if (!IDX_SEEN.has(k)) delete IDX[k] }
/** The login that started a session, and the one its requests last ran on (where its cache is). */
function startedBy(q) { return q.owner || (q.firstOrg ? { organizationUuid: q.firstOrg } : null) }
function runsOn(q) { return q.payer ? { organizationUuid: q.payer } : startedBy(q) }

const quickCache = new Map()
/** Owner, title, context size, model and last activity, read from the end of the file. */
function quickInfo(file, st) {
  st = st || fs.statSync(file)
  const key = `${file}|${st.size}|${st.mtimeMs}`
  if (quickCache.has(key)) return quickCache.get(key)
  let q, win = 512 * 1024
  for (;;) {
    q = { sid: path.basename(file, '.jsonl'), file, size: st.size, mtimeMs: st.mtimeMs, owner: null, payer: null, firstOrg: null, title: null, aiTitle: null,
      lastPrompt: null, lastTs: 0, usageTs: 0, model: null, ctx: null, post: null, ttl: null, cwd: null, gitBranch: null, effort: null, limitStop: null }
    for (const line of readTail(file, st.size, win).split('\n')) {
      if (line.length < 2 || line.startsWith('{"type":"api-request')) continue
      let j; try { j = JSON.parse(line) } catch { continue }
      const ts = j.timestamp ? Date.parse(j.timestamp) : 0
      if (ts > q.lastTs) q.lastTs = ts
      if (j.cwd) q.cwd = j.cwd
      if (j.gitBranch) q.gitBranch = j.gitBranch
      switch (j.type) {
        case 'attachment': if (j.attachment?.type === 'credential_org' && j.attachment.organizationUuid) q.payer = j.attachment.organizationUuid; break
        case 'session-owner': if (j.accountUuid) q.owner = { accountUuid: j.accountUuid, organizationUuid: j.organizationUuid || '' }; break
        case 'custom-title': q.title = j.customTitle; break
        case 'agent-name': q.title = q.title || j.agentName; break
        case 'ai-title': q.aiTitle = j.aiTitle; break
        case 'last-prompt': q.lastPrompt = j.lastPrompt; break
        case 'system':
          // A compaction with no request after it: the next request sends the summary, and none of it is cached anywhere yet.
          if (j.subtype === 'compact_boundary' && j.compactMetadata?.postTokens) q.post = j.compactMetadata.postTokens
          break
        case 'assistant': {
          if (j.isSidechain) break
          const m = j.message || {}
          if (m.model === '<synthetic>' || j.isApiErrorMessage) {
            const t = (m.content || []).map(b => b.text || '').join(' ')
            q.limitStop = LIMIT_RE.test(t) ? oneLine(t, 160) : null
            break
          }
          if (m.usage) { q.ctx = ctxOf(m.usage); q.model = m.model; q.ttl = ttlOf(m.usage) || q.ttl; q.usageTs = ts; q.effort = j.effort || j.perTurnEffort || q.effort; q.post = null; q.limitStop = null }
          break
        }
      }
    }
    if (q.ctx != null || q.post != null || win >= st.size || win >= 64 * 1024 * 1024) break
    win *= 4
  }
  if (!q.lastTs) q.lastTs = st.mtimeMs
  ownership(q, st, win)
  quickCache.set(key, q)
  return q
}

/** Cache Keeper's per-session snapshot, when that plugin is installed: the cache clock and the account's limits. */
function liveSnap(configDir, sid) { return readJson(path.join(configDir, 'cache-keeper', 'live', `${sid}.json`)) }
function cacheState(q, snap) {
  const ttl = /5m/.test(snap?.cache?.ttl || '') ? '5m' : (q.ttl || '1h')
  const ttlMs = ttl === '5m' ? 300e3 : 3600e3
  const lastAt = Math.max(snap?.cache?.lastAt || 0, q.usageTs || 0)
  if (!lastAt) return { known: false, warm: false, ttl, ttlMs, lastAt: 0, leftMs: 0 }
  const leftMs = lastAt + ttlMs - Date.now()
  return { known: true, warm: leftMs > 0, ttl, ttlMs, lastAt, leftMs }
}
/** `mine` false: the cache belongs to a login other than the one in use, so from here the session is cold whatever its clock says. */
function cacheText(c, mine) {
  if (!c.known) return 'cold?'
  if (!c.warm) return 'cold'
  const m = Math.floor(c.leftMs / 60e3)
  return mine === false ? `cold here, ${m}m there` : `warm ${m}m`
}
/**
 * Claude Code compacts a big idle session by itself shortly before its cache expires (2.1.322: at 90% of a
 * one-hour lifetime, from 200k tokens, and only while the account's usage status is "allowed").
 * Settings can turn that off or move the size; read the session's own settings files for the two keys.
 */
const idleCfg = new Map()
function idleCompaction(configDir, cwd) {
  const key = `${configDir}|${cwd || ''}`
  if (idleCfg.has(key)) return idleCfg.get(key)
  const files = [path.join(configDir, 'settings.json')]
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'))
  let idle = true, auto = true, off = false, minTokens = IDLE_COMPACT_MIN
  const yes = v => v != null && !/^(|0|false|no|off)$/i.test(String(v))
  for (const f of files) {
    const j = readJson(f); if (!j) continue
    if (typeof j.idleCompaction === 'boolean') idle = j.idleCompaction
    if (typeof j.autoCompactEnabled === 'boolean') auto = j.autoCompactEnabled
    const e = j.env || {}
    if (yes(e.DISABLE_COMPACT) || yes(e.DISABLE_AUTO_COMPACT)) off = true
    if (Number(e.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS) > 0) minTokens = Math.max(100000, Number(e.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS))
  }
  const res = { on: idle && auto && !off, minTokens }
  idleCfg.set(key, res)
  return res
}
/** Sessions with a live process, from Claude Code's own registry. */
function liveSessions(configDir) {
  const dir = path.join(configDir, 'sessions'); const map = new Map()
  let names = []; try { names = fs.readdirSync(dir) } catch { return map }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const j = readJson(path.join(dir, n)); if (!j?.sessionId || !j.pid) continue
    try { process.kill(j.pid, 0) } catch (e) { if (e.code !== 'EPERM') continue }
    map.set(j.sessionId, { pid: j.pid, status: j.status || '?', name: j.name || null, kind: j.kind || '' })
  }
  return map
}

// ───────────────────────────────────────────────────────────── the floor: what a fresh session costs here

async function firstTurnContext(file) {
  const stream = fs.createReadStream(file, { end: 8 * 1024 * 1024 })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.startsWith('{"parentUuid"') || !line.includes('"type":"assistant"')) continue
      let j; try { j = JSON.parse(line) } catch { continue }
      if (j.type === 'assistant' && !j.isSidechain && j.message?.usage && j.message.model !== '<synthetic>') return ctxOf(j.message.usage) - (j.message.usage.output_tokens || 0)
    }
  } catch { /* a truncated last line */ } finally { rl.close(); stream.destroy() }
  return null
}
/** Median first-turn prompt size of recent sessions in a project: system prompt, tools, CLAUDE.md, memory. */
async function floorFor(state, projectDir, { fresh = false } = {}) {
  const key = fwd(projectDir); const hit = state.floors[key]
  if (!fresh && hit && Date.now() - hit.at < 7 * 86400e3) return hit
  const files = sessionFilesIn(projectDir).filter(s => s.size > 20000 && s.size < 400e6).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 14)
  const vals = []
  for (const f of files) { const v = await firstTurnContext(f.file); if (v) vals.push(v) }
  vals.sort((a, b) => a - b)
  const res = vals.length ? { tokens: vals[Math.floor(vals.length / 2)], n: vals.length, at: Date.now(), known: true } : { tokens: 60000, n: 0, at: Date.now(), known: false }
  state.floors[key] = res
  try { saveState(state) } catch { /* read-only location: recompute next time */ }
  return res
}

// ───────────────────────────────────────────────────────────── the cost model

// All of these are in tokens. The measured ones come from the author's transcripts (2026-11-17, Claude Code 2.1.322);
// README.md says how each was taken, and `--pack`, `--turns` and prices.json change the rest.
const SUMMARY_OUT = 6000     // output of a compaction summary (estimate)
const HANDOFF_OUT = 3000     // output of a handoff the session writes itself (estimate)
const AFTER_COMPACT = 62000  // what a compacted session carries above the floor: summary, kept messages, files read back.
                             // Measured: median over 116 compactions of (context on the next turn - that session's first-turn context).
const RESUME_UNDER = AFTER_COMPACT + 8000   // a session with no more of its own than this is already the size a compaction would leave
const COMPACT_EXTRA = 13000  // the same measurement minus the compaction record's own postTokens
const SHARED_PREFIX = 34000  // system prompt and tools, the same for every session of a project: the cache read on a fresh session's first turn
const IDLE_COMPACT_MIN = 200000, IDLE_COMPACT_AT = 0.9
const HELPER_WRITE = 1.25    // compaction's own request is cached for five minutes, not the conversation's hour
// A compaction trades detail for tokens, so it is advised only where it saves a clear share. Below this the saving is
// inside the spread of what a compaction leaves behind (AFTER_COMPACT is a median), and the summary it has to write,
// or the reread of a cold conversation, can cost more than the smaller context saves.
const COMPACT_GAIN = 0.15
/** A /compact on the login it is leaving, cache warm: does it beat waking the whole conversation on the next login? */
function leavingPays(c) { return c.compactBeforeLeaving.after <= (1 - COMPACT_GAIN) * c.resume.after }
/** A /compact on arrival, cache cold: does it beat resuming the conversation as it is? */
function arrivalPays(c) { return c.compactOnArrival.after <= (1 - COMPACT_GAIN) * c.resume.after }
const lessThanResume = (c, x) => Math.round((1 - x.after / c.resume.after) * 100)

/** Context the next request sends: the last request's size, or an estimate when a compaction came after it. */
function ctxNow(q, floor) { return q.post != null ? floor.tokens + q.post + COMPACT_EXTRA : q.ctx }

function costModel({ ctx, floor, pack, model, ttl, turns, idle, warm }) {
  const p = priceOf(model, ctx); const w = ttl === '5m' ? 1.25 : 2; const r = p.read
  const fresh = floor + pack, small = floor + AFTER_COMPACT
  // A pause longer than the cache lifetime: a big session compacts itself just before it (a cheap read), a smaller one is rewritten whole.
  const selfCompacts = c => Boolean(idle?.on) && ttl !== '5m' && c >= idle.minTokens
  const wake = c => (selfCompacts(c) ? r * c + 5 * SUMMARY_OUT + w * small : w * c)
  const row = (first, per, c, there = 0) => ({ there, first, per, after: there + first + turns * per, rewake: wake(c) })
  const compactThere = (warm ? r : HELPER_WRITE) * ctx + 5 * SUMMARY_OUT
  return {
    p, w, turns, small, selfCompacts: selfCompacts(ctx),
    resume: row(w * ctx, r * ctx, ctx),
    fresh: row(w * fresh, r * fresh, fresh),
    compactOnArrival: row(HELPER_WRITE * ctx + 5 * SUMMARY_OUT + w * small, r * small, small),
    compactBeforeLeaving: row(w * small, r * small, small, compactThere),
    warmHandoff: r * ctx + 5 * HANDOFF_OUT,
    coldRequest: w * ctx,
    sharedPrefix: Math.min(SHARED_PREFIX, floor) * (w - r),
    dollars: t => (t * p.in) / 1e6,
  }
}
function money(c, t) { return t ? `${tok(t)} (${usd(c.dollars(t))})` : '-' }

/** Which row of the strategy applies to this session right now. */
function advise({ q, ctx, cache, login, floor, snap, live, idle, target }) {
  const own = (ctx ?? 0) - floor.tokens
  const on = runsOn(q)
  const mine = login && on ? sameOwner(on, login) : null   // true: its last requests ran on the login in use now
  const lim = snap?.limits
  const capped = Boolean(q.limitStop) || [lim?.fiveHour, lim?.sevenDay].some(x => x && x.pct >= 97 && x.resetsAt * (x.resetsAt < 1e12 ? 1000 : 1) > Date.now())
  // With the destination named, a session that last ran there and is still inside its cache lifetime is not cold after the change.
  const warmOnTarget = Boolean(target && on && sameOwner(on, target) && cache.warm)
  const base = { mine, capped, selfCompactInMs: null, warmOnTarget }
  if (ctx == null) return { ...base, act: 'resume', why: 'no request is recorded in it yet, so there is nothing to carry' }
  if (q.post != null) return { ...base, act: 'resume', why: 'it was compacted and has not run since, so its next turn sends the summary and costs the same on any login' }
  if (warmOnTarget) return { ...base, act: 'resume', why: `it last ran on ${target.name}, where its cache is warm for another ${Math.floor(cache.leftMs / 60e3)} min, so it wakes there at the read price` }
  if (own <= RESUME_UNDER) return { ...base, act: 'resume', why: `it holds ${tok(Math.max(own, 0))} of its own above the ${tok(floor.tokens)} a fresh session starts with, about what a compaction would leave (${tok(AFTER_COMPACT)}), so there is little to save` }
  if (mine === true && cache.warm && !capped) {
    const eta = live && idle.on && ctx >= idle.minTokens && cache.ttl === '1h' ? cache.lastAt + cache.ttlMs * IDLE_COMPACT_AT - Date.now() : 0
    return { ...base, act: 'warm', selfCompactInMs: eta > 0 ? eta : null, why: `it is still on its own login with a warm cache (${Math.floor(cache.leftMs / 60e3)} min left), so a summary is read from the cache, not rewritten` }
  }
  if (mine === true && capped) return { ...base, act: 'pack', why: 'its account is at its limit, so the session cannot summarise itself' }
  if (mine === true) return { ...base, act: 'pack', why: 'its cache is already cold: a summary request on this login would rewrite everything too' }
  if (mine === false) return { ...base, act: 'pack', why: 'its last requests ran on another login: the cache and the reasoning stay there' }
  return { ...base, act: 'pack', why: 'the transcript does not say which login it ran on, so assume a cold cache' }
}
const ACT_TEXT = { resume: 'resume as is', warm: '/compact, then switch', pack: 'pack + fresh session' }

// ───────────────────────────────────────────────────────────── reading a whole transcript

function userText(c) {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map(b => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : b.type === 'document' ? '[document]' : '')).filter(Boolean).join('\n')
}
/** What a main-thread user record is: a tool result, a prompt of some kind, or harness text to skip (null). */
function classifyUser(j) {
  const c = j.message?.content
  if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) return { kind: 'tool_result' }
  const text = userText(c).trim()
  if (j.isCompactSummary) return { kind: 'compact', text }
  if (!text) return null
  const ok = j.origin?.kind
  if (!j.isMeta) {
    const cmd = /<command-name>\/?([^<]+)<\/command-name>/.exec(text)
    if (cmd) { const a = /<command-args>([\s\S]*?)<\/command-args>/.exec(text); return { kind: 'command', text: `/${cmd[1].trim()}${a && a[1].trim() ? ` ${a[1].trim()}` : ''}` } }
    const sh = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)
    if (sh) return { kind: 'command', text: `! ${sh[1].trim()}` }
    if (/^<(local-command-|bash-std|command-message)/.test(text)) return null
  }
  if (ok === 'human') return { kind: 'human', text }
  if (ok === 'peer') return { kind: 'peer', text }
  if (ok === 'task-notification') return { kind: 'task', text }
  if (ok === 'auto-continuation') return { kind: 'auto', text }
  if (ok) return j.isMeta ? null : { kind: ok, text }
  if (j.isMeta) return j.promptSource === 'system' ? { kind: 'system', text } : null
  return { kind: 'human', text }
}
const PERSON = new Set(['human', 'command', 'plugin'])

function toolLine(name, input = {}) {
  const s = v => oneLine(v, 180)
  switch (name) {
    case 'Bash': case 'PowerShell': return `${name}: ${s(input.command)}${input.run_in_background ? ' [background]' : ''}`
    case 'Read': return `Read: ${fwd(input.file_path || '')}${input.offset ? ` @${input.offset}` : ''}`
    case 'Edit': case 'Write': case 'NotebookEdit': return `${name}: ${fwd(input.file_path || input.notebook_path || '')}`
    case 'Grep': return `Grep: /${s(input.pattern)}/ in ${fwd(input.path || '.')}`
    case 'Glob': return `Glob: ${s(input.pattern)}`
    case 'Agent': case 'Task': return `${name}(${input.subagent_type || 'general'}): ${s(input.description || input.prompt)}`
    case 'Skill': return `Skill: ${input.skill}${input.args ? ` ${s(input.args)}` : ''}`
    default: return `${name}: ${s(JSON.stringify(input))}`
  }
}
function resultText(b) {
  const c = b.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(x => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n')
  return ''
}
// The signs that Claude's question (AskUserQuestion) got no answer although the call has a result. Each is matched
// only where it belongs (a question's own result, a system line): the same words in another tool's output (a grep of
// a README) change nothing.
// - Cache Keeper's line when it holds the answer (a `system` `informational` record, before the call's result).
const HELD_LINE = /Cache Keeper held your answer to Claude's question\b/
// - Cache Keeper's deny (its core.ANSWER_HELD), where an engine keeps it as the call's result.
const HELD_ANSWER = /Cache Keeper held the answer\b/
// - The engine's result for a call that a plugin's turn.abort cut short (2.1.322: abort reason "turn-abort").
const TURN_ENDED = /^\s*\[Tool call did not complete: the turn was ended\b/
const NOTABLE = /\bgit\s+(commit|push|merge|rebase|tag|worktree\s+add|switch\s+-c|checkout\s+-b|cherry-pick|revert)\b|\bgh\s+(pr|issue|workflow|release|run)\s+(create|merge|close|comment|edit|run|ready)\b|\bkubectl\s+(apply|rollout|delete)\b/
const HANDOFF_PATH = /[\\/]\.claude[^\n]*[\\/](handoffs[\\/][^\n]+\.md|hub[\\/][^\n]*handoff[^\\/\n]*\.md)$/i
const PACK_PATH = /[\\/]handoffs[\\/][^\n]*[\\/]acct[\\/][^\\/\n]+\.md$/i
// HANDOFF_PATH matches every Markdown file in those folders, and most of them are side notes sessions keep there (PR
// bodies, step logs, drafts, release notes: 4320 of 5264 files on 2026-11-19). Only a handoff may stand in for the
// conversation. Under handoffs/ one is named for when it was written (<date>-<time>-<slug>.md, as the author's handoff
// skill names it), has "handoff" in its name, or opens on a "# Handoff" heading; under hub/ it has "handoff" in its name.
const HANDOFF_STAMP = /^(\d{4}-\d{2}-\d{2}|\d{8})[-T_ ]?\d{4}/
const HANDOFF_HEADING = /^#\s+([^\n]{0,40}?\s)?hand-?off\b/i
function isHandoffDoc(p) {
  const f = fwd(p)
  if (!HANDOFF_PATH.test(f) || /[\\/]acct[\\/]/i.test(f)) return false
  const base = path.posix.basename(f)
  if (/handoff/i.test(base) || HANDOFF_STAMP.test(base)) return true
  try {
    const fd = fs.openSync(f, 'r')
    try { const b = Buffer.alloc(240); const n = fs.readSync(fd, b, 0, 240, 0); return HANDOFF_HEADING.test(b.toString('utf8', 0, n).replace(/^\ufeff/, '')) } finally { fs.closeSync(fd) }
  } catch { return false }
}

/**
 * One pass over the transcript. Request records (most of the bytes) are skipped unparsed.
 * `onRecord(kind, record, turnNumber, extra)` lets `show` render while the same pass counts turns.
 */
async function scan(file, onRecord) {
  const st = fs.statSync(file)
  const d = {
    sid: path.basename(file, '.jsonl'), file, size: st.size, mtimeMs: st.mtimeMs,
    // lastTs is the last record of any kind; workTs the last of the conversation itself (a prompt, a tool result, a
    // reply). A slash command, a /clear, a resume or a reload adds records after the last turn and is no work.
    firstTs: 0, lastTs: 0, workTs: 0, cwd: null, gitBranch: null, version: null,
    owners: [], creds: [], title: null, aiTitle: null,
    turns: [], recentFinals: new Map(), notes: [],
    lastCompact: null, compactCount: 0, lastBoundary: null, away: [], thinkingDropped: null,
    files: new Map(), tools: new Map(), mcp: new Set(), skills: new Set(),
    notable: [], agents: [], background: [], cronsCreated: [], cronsFired: new Map(), wakeup: null,
    artifacts: [], prs: new Map(), sentFiles: 0, handoffWrites: [], packRead: null,
    usage: null, usageTs: 0, model: null, effort: null, ttl: null, costUsd: null,
    pending: new Map(), errors: [], limitStop: null, lastKind: null,
    // The conversation's last events, numbered: whether a call with no result was its last word (waitingQuestions).
    seq: 0, later: [],
  }
  // An event of the conversation: a reply's block, a tool's result (by the message that made the call), a compaction.
  const event = msg => { d.later.push({ seq: ++d.seq, msg }); if (d.later.length > 64) d.later.shift() }
  let recNo = 0              // an engine export's records carry no ids: one record is one message there
  const track = new Map()    // tool_use id -> what to do with its result
  const undo = new Map()     // a command's turn -> the state before it, should Claude Code or a hook answer it itself
  const launched = new Map() // tool_use id -> the subagent or background shell it started
  const byTask = new Map()   // the same jobs by the task id their launch reply gave
  // A job's end is written as a queue record when it happens, and again as a prompt or an attachment when the session
  // gets to read it. Any of the three marks the job as ended; the last one read wins, since an agent can be resumed.
  const noteEnd = (text, ts) => {
    if (typeof text !== 'string' || !text.includes('<task-notification>')) return
    const job = launched.get(/<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1]) || byTask.get(/<task-id>([^<]+)<\/task-id>/.exec(text)?.[1])
    if (!job) return
    job.status = /<status>([^<]+)<\/status>/.exec(text)?.[1] || 'stopped'; job.doneTs = ts || job.doneTs || job.ts
    const res = /<result>([\s\S]*?)(?:<\/result>|$)/.exec(text)?.[1] || /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]
    if (res) job.result = oneLine(res.replace(/^\s*\[harness:[^\]]*\][^\n]*\n?/, ''), 500)
  }
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  let turn = null
  // A command Claude Code or a hook answered itself asked the model nothing, so it is no turn: /pack-and-clear,
  // /use-latest-handoff, /model, a handoff command a plugin answered. Its output is the tell, and it comes before any
  // reply. In a transcript the output names the command as its parent; an engine export has no ids (parent null).
  const answeredLocally = parent => {
    const was = turn && undo.get(turn)
    if (!was || d.turns[d.turns.length - 1] !== turn || turn.final || turn.texts || turn.tools) return
    if (parent !== null && parent !== was.uuid) return
    d.turns.pop()
    undo.delete(turn)
    turn = was.turn
    d.lastKind = was.kind
    d.workTs = was.workTs
  }
  for await (const line of rl) {
    if (line.length < 2 || line.startsWith('{"type":"api-request')) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    recNo++
    const ts = j.timestamp ? Date.parse(j.timestamp) : 0
    if (ts) { if (!d.firstTs) d.firstTs = ts; if (ts > d.lastTs) d.lastTs = ts }
    if (j.cwd) d.cwd = j.cwd
    if (j.gitBranch) d.gitBranch = j.gitBranch
    if (j.version) d.version = j.version
    switch (j.type) {
      case 'session-owner': {
        const o = { accountUuid: j.accountUuid, organizationUuid: j.organizationUuid || '' }
        const last = d.owners[d.owners.length - 1]
        if (o.accountUuid && !(last && last.accountUuid === o.accountUuid && last.organizationUuid === o.organizationUuid)) d.owners.push({ ...o, atTurn: d.turns.length })
        break
      }
      case 'attachment': {
        const a = j.attachment || {}
        if (a.type === 'credential_org' && a.organizationUuid) { if (d.creds[d.creds.length - 1]?.organizationUuid !== a.organizationUuid) d.creds.push({ organizationUuid: a.organizationUuid, ts, atTurn: d.turns.length }) }
        else if (a.type === 'queued_command') {
          noteEnd(a.prompt, ts)
          // What arrived while Claude worked is delivered inside the turn as this attachment, never as a user record:
          // the person's prompt typed meanwhile ("go with rented"), or a peer session's message, is a turn like any other.
          const from = a.origin?.kind === 'human' || a.humanTurn === true ? 'human' : a.origin?.kind === 'peer' ? 'peer' : null
          const text = (typeof a.prompt === 'string' ? a.prompt : userText(a.prompt)).trim()
          if (from && !j.isSidechain && (a.commandMode ?? 'prompt') === 'prompt' && text && !text.includes('<task-notification>')) {
            turn = { n: d.turns.length + 1, kind: from, ts, text: PERSON.has(from) ? clip(text, 12000) : clip(text, 500), final: null, texts: 0, tools: 0 }
            d.turns.push(turn)
            d.lastKind = from
            if (ts > d.workTs) d.workTs = ts
            onRecord?.('prompt', j, turn.n, { kind: from, text })
          }
        }
        else if (a.type === 'task_status' && byTask.has(a.taskId)) byTask.get(a.taskId).seen = { status: a.status, note: oneLine(a.deltaSummary, 120), ts }
        break
      }
      case 'queue-operation': if (j.operation === 'enqueue') noteEnd(j.content, ts); break
      case 'custom-title': d.title = j.customTitle; break
      case 'agent-name': d.title = d.title || j.agentName; break
      case 'ai-title': d.aiTitle = j.aiTitle; break
      case 'pr-link': if (j.prUrl) d.prs.set(j.prUrl, { number: j.prNumber, repo: j.prRepository, ts: j.timestamp }); break
      case 'cost-state': if (typeof j.totalCostUSD === 'number') d.costUsd = j.totalCostUSD; break
      case 'system': {
        if (j.isSidechain) break
        if (j.subtype === 'local_command') answeredLocally(j.parentUuid || '')
        if (j.subtype === 'compact_boundary') { d.compactCount++; d.lastBoundary = { ts, pre: j.compactMetadata?.preTokens, post: j.compactMetadata?.postTokens, trigger: j.compactMetadata?.trigger } }
        else if (j.subtype === 'away_summary' && j.content) { d.away.push({ ts, text: j.content }); if (d.away.length > 3) d.away.shift() }
        else if (j.subtype === 'informational' && /thinking from another organization/i.test(j.content || '')) d.thinkingDropped = ts
        else if (j.subtype === 'informational' && HELD_LINE.test(j.content || '')) {
          // Cache Keeper held the person's answer: the newest question of this turn still pending is the one it held.
          const q = [...d.pending.values()].filter(p => p.ask && p.turn === (turn?.n ?? 0)).at(-1)
          if (q && !q.held) { q.held = true; q.heldTs = ts }
        }
        else if (j.subtype === 'scheduled_task_fire') d.cronsFired.set(j.taskId || j.cron, { cron: j.cron, prompt: oneLine(j.prompt, 240), ts, fires: (d.cronsFired.get(j.taskId || j.cron)?.fires || 0) + 1 })
        onRecord?.('system', j, d.turns.length)
        break
      }
      case 'user': {
        if (j.isSidechain) break
        const k = classifyUser(j)
        if (!k) {
          // The form an engine export has: the command's output as a user message right after it.
          if (/^<local-command-(stdout|stderr)>/.test(userText(j.message?.content).trim())) answeredLocally(null)
          break
        }
        const before = { turn, kind: d.lastKind, workTs: d.workTs, uuid: j.uuid || null }
        // A compaction is the engine's, and its summary can carry a time hours after the turn it follows.
        if (ts > d.workTs && k.kind !== 'compact') d.workTs = ts
        if (k.kind === 'tool_result') {
          for (const b of j.message.content) {
            if (b.type !== 'tool_result') continue
            const p = d.pending.get(b.tool_use_id)
            // A question to the person that got no answer stays pending ("kept"), and its result is no error: the
            // turn was ended under the open dialog (the engine's placeholder for a call that a plugin's turn.abort cut
            // short, which is what Cache Keeper's hold leaves on 2.1.322), or Cache Keeper's own deny is the result.
            // Held (Cache Keeper's line came first, or its deny): the person sends the answer as their next message.
            const said = p?.ask ? resultText(b) : ''
            const kept = Boolean(p?.ask) && (p.held === true || HELD_ANSWER.test(said) || TURN_ENDED.test(said))
            if (kept) { p.kept = true; if (!p.held && HELD_ANSWER.test(said)) { p.held = true; p.heldTs = ts } } else d.pending.delete(b.tool_use_id)
            event(p?.msg ?? null)
            const t = track.get(b.tool_use_id)
            if (t || (b.is_error && !kept)) {
              const text = resultText(b)
              if (t?.artifact) { const u = /https:\/\/claude\.ai\/[^\s"')\]]+/.exec(text); if (u) t.artifact.url = u[0] }
              const job = t?.agent || t?.shell
              const taskId = job && /\b(?:agentId|ID):\s*([A-Za-z0-9_-]{6,})/.exec(text)?.[1]
              if (taskId) byTask.set(taskId, job)
              if (t?.agent) { if (/^\s*Async agent launched/i.test(text)) t.agent.background = true; else if (!t.agent.status) { t.agent.result = oneLine(text, 500); t.agent.status = 'returned'; t.agent.doneTs = ts } }
              if (b.is_error) { d.errors.push({ ts, tool: p?.name || '?', text: oneLine(text, 400) }); if (d.errors.length > 4) d.errors.shift() }
              track.delete(b.tool_use_id)
            }
          }
          d.lastKind = 'tool_result'
          onRecord?.('tool_result', j, d.turns.length)
          break
        }
        if (k.kind === 'compact') { d.lastCompact = { ts, text: k.text, turn: d.turns.length }; event(null); onRecord?.('compact', j, d.turns.length, k); break }
        if (k.kind === 'task') noteEnd(k.text, ts)
        turn = { n: d.turns.length + 1, kind: k.kind, ts, text: PERSON.has(k.kind) ? clip(k.text, 12000) : clip(k.text, 500), final: null, texts: 0, tools: 0 }
        if (k.kind === 'command' && k.text.startsWith('/')) undo.set(turn, before)
        d.turns.push(turn)
        d.lastKind = k.kind
        onRecord?.('prompt', j, turn.n, k)
        break
      }
      case 'assistant': {
        if (j.isSidechain) break
        if (ts > d.workTs) d.workTs = ts
        const m = j.message || {}
        const blocks = Array.isArray(m.content) ? m.content : []
        if (m.model === '<synthetic>' || j.isApiErrorMessage) {
          const t = blocks.map(b => b.text || '').join(' ')
          d.limitStop = LIMIT_RE.test(t) ? { ts, text: oneLine(t, 240) } : d.limitStop
          d.lastKind = 'notice'
          event(null)
          onRecord?.('notice', j, d.turns.length)
          break
        }
        if (m.usage) { d.usage = m.usage; d.usageTs = ts; d.model = m.model; d.ttl = ttlOf(m.usage) || d.ttl; d.effort = j.effort || j.perTurnEffort || d.effort; d.limitStop = null }
        // A transcript writes each block of a reply as a record of its own, under the reply's id.
        const msg = m.id || j.uuid || `record ${recNo}`
        for (const b of blocks) {
          if (b.type === 'text' && b.text?.trim()) {
            event(msg)
            if (turn) {
              turn.texts++; turn.final = oneLine(b.text, 600)
              d.recentFinals.set(turn.n, b.text)
              for (const n of d.recentFinals.keys()) if (n < turn.n - 3) d.recentFinals.delete(n)
            }
            d.notes.push({ turn: turn?.n || 0, ts, text: b.text }); if (d.notes.length > 8) d.notes.shift()
            d.lastKind = 'text'
          } else if (b.type === 'tool_use') {
            const inp = b.input || {}
            if (turn) turn.tools++
            d.tools.set(b.name, (d.tools.get(b.name) || 0) + 1)
            event(msg)
            // A question to the person keeps its whole input: a pack shows it in full while it waits for the answer.
            const ask = b.name === 'AskUserQuestion' && Array.isArray(inp.questions) && inp.questions.length ? inp.questions : null
            d.pending.set(b.id, { name: b.name, line: toolLine(b.name, inp), ts, msg, seq: d.seq, turn: turn?.n ?? 0, ask })
            d.lastKind = 'tool_use'
            const mcp = /^mcp__(.+?)__/.exec(b.name); if (mcp) d.mcp.add(mcp[1])
            if (b.name === 'Edit' || b.name === 'Write' || b.name === 'NotebookEdit') {
              const fpath = fwd(inp.file_path || inp.notebook_path || '')
              if (fpath) {
                const f = d.files.get(fpath) || { n: 0, ts: 0 }; f.n++; f.ts = ts; d.files.set(fpath, f)
                if (HANDOFF_PATH.test(fpath) && !/[\\/]acct[\\/]/.test(fpath)) d.handoffWrites.push({ path: fpath, ts, turn: d.turns.length })
              }
            } else if (b.name === 'Bash' || b.name === 'PowerShell') {
              const cmd = String(inp.command || '')
              if (inp.run_in_background) { const sh = { ts, cmd: oneLine(cmd, 200), desc: inp.description || '', status: null }; d.background.push(sh); launched.set(b.id, sh); track.set(b.id, { shell: sh }); if (d.background.length > 40) d.background.shift() }
              if (NOTABLE.test(cmd)) { d.notable.push({ ts, cmd: oneLine(cmd, 220) }); if (d.notable.length > 20) d.notable.shift() }
            } else if (b.name === 'Agent' || b.name === 'Task') {
              const a = { ts, type: inp.subagent_type || 'general', desc: oneLine(inp.description || inp.prompt, 120), background: Boolean(inp.run_in_background), result: null, status: null }
              d.agents.push(a); launched.set(b.id, a); if (d.agents.length > 60) d.agents.shift(); track.set(b.id, { agent: a })
            } else if (b.name === 'Artifact' && (!inp.action || inp.action === 'publish') && inp.file_path) {
              const fpath = fwd(inp.file_path)
              let a = d.artifacts.find(x => x.file === fpath)
              if (!a) { a = { file: fpath, url: inp.url || null, ts }; d.artifacts.push(a) }
              a.ts = ts; track.set(b.id, { artifact: a })
            } else if (b.name === 'CronCreate') d.cronsCreated.push({ ts, cron: inp.cron || inp.schedule || '', prompt: oneLine(inp.prompt, 200) })
            else if (b.name === 'ScheduleWakeup') d.wakeup = inp.stop ? null : { ts, delay: inp.delaySeconds, reason: oneLine(inp.reason, 160) }
            else if (b.name === 'Skill' && inp.skill) d.skills.add(inp.skill)
            else if (b.name === 'SendUserFile') d.sentFiles++
            // A session woken from a pack reads it in its first turn, without the path ever being typed: see lineage().
            else if (b.name === 'Read' && !d.packRead && d.turns.length <= 1 && PACK_PATH.test(String(inp.file_path || ''))) d.packRead = fwd(inp.file_path)
          }
        }
        onRecord?.('assistant', j, d.turns.length)
        break
      }
    }
  }
  d.ctx = d.usage ? ctxOf(d.usage) : null
  // Compacted with no request since: the next request sends the summary. makePack turns this into a context estimate.
  d.post = d.lastBoundary && d.lastBoundary.ts >= d.usageTs && d.lastBoundary.post ? d.lastBoundary.post : null
  return d
}

// ───────────────────────────────────────────────────────────── the handoff pack

function projectName(cwd) { return cwd ? path.basename(path.resolve(cwd)) : 'no-project' }
function slugify(s, sid) {
  const w = String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5)
  return w.length ? w.join('-') : sid.slice(0, 8)
}
/**
 * The newest handoff the session itself wrote: a handoff document it wrote, or a brief a plugin took from a fork of it.
 * A conversation exported from the engine has no times: there a write is placed by its turn (and dated by the file),
 * and what came after a brief is unknown (null).
 */
function modelHandoff(d, configDir) {
  const cands = []
  const mtime = p => { try { return fs.statSync(p).mtimeMs } catch { return 0 } }
  for (const h of d.handoffWrites) if (exists(h.path) && isHandoffDoc(h.path)) cands.push({ path: h.path, ts: h.ts || mtime(h.path), turn: h.turn, how: 'written by the session' })
  for (const h of d.exported?.handoffs || []) {
    if (cands.some(c => c.path.toLowerCase() === h.path.toLowerCase()) || !exists(h.path) || !isHandoffDoc(h.path)) continue
    cands.push({ path: h.path, ts: h.at || mtime(h.path), turn: null, known: h.turnsAfter, how: 'written by the session, before what the export holds' })
  }
  for (const dir of ['autohandoff/briefs', 'cache-keeper/handoffs']) {
    const full = path.join(configDir, dir)
    let names = []; try { names = fs.readdirSync(full) } catch { continue }
    for (const n of names) if (n.endsWith(`-${d.sid.slice(0, 8)}.md`)) { const p = path.join(full, n); cands.push({ path: fwd(p), ts: mtime(p), turn: null, how: 'a brief taken from a fork of the session' }) }
  }
  if (!cands.length) return null
  const best = cands.sort((a, b) => b.ts - a.ts || (b.turn ?? -1) - (a.turn ?? -1))[0]
  const after = !d.exported ? d.turns.filter(t => t.ts > best.ts) : best.turn != null ? d.turns.filter(t => t.n > best.turn) : null
  return {
    ...best, text: fs.readFileSync(best.path, 'utf8'),
    promptsAfter: after ? after.filter(t => PERSON.has(t.kind)).length : null,
    turnsAfter: after ? after.length : best.known ?? null,
    minutesAfter: (d.workTs || d.lastTs) ? Math.max(0, Math.round(((d.workTs || d.lastTs) - best.ts) / 60e3)) : null,
  }
}
/** Push an embedded document's headings below the pack's own, leaving code blocks alone. */
function demote(md, by = 2) {
  let fence = false
  return md.split('\n').map(l => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return l }
    const m = !fence && /^(#{1,6})(\s+\S.*)$/.exec(l)
    return m ? `${'#'.repeat(Math.min(6, m[1].length + by))}${m[2]}` : l
  }).join('\n')
}
/** Packs this session was itself started from, found in what the person typed: the chain back across accounts. */
function lineage(d) {
  const out = []
  const add = p => {
    const head = (() => { try { return fs.readFileSync(p, 'utf8').slice(0, 600) } catch { return '' } })()
    const from = /acct-sync pack: session=([0-9a-f-]{36})/.exec(head)
    out.push({ pack: fwd(p), from: from ? from[1] : null })
  }
  for (const t of d.turns.slice(0, 6)) {
    const m = /([A-Za-z]:)?[^\s"'`<>]*[\\/]handoffs[\\/][^\s"'`<>]*[\\/]acct[\\/][^\s"'`<>]*\.md/.exec(t.text || '')
    if (m) { add(m[0]); break }
  }
  // wake starts a session with the path in its system prompt, not in a prompt: there the link is the pack it read first.
  if (!out.length && d.packRead) add(d.packRead)
  return out
}
function openTasks(configDir, sid) {
  const dir = path.join(configDir, 'tasks', sid); let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const n of names) { const j = readJson(path.join(dir, n)); if (j?.subject && j.status && j.status !== 'completed' && j.status !== 'deleted') out.push(j) }
  return out
}

/**
 * The questions the session put to the person (AskUserQuestion) that never got an answer, when they were its last
 * word: asked in the last turn, with nothing after them but the other calls of the same reply and their results. A
 * call with no result that the conversation went past (a rewind, a resume that wrote none) is not one.
 */
function waitingQuestions(d) {
  const last = d.turns[d.turns.length - 1]?.n ?? 0
  return [...d.pending.values()].filter(p => p.ask && p.turn === last && d.later.every(e => e.seq <= p.seq || e.msg === p.msg))
}
// A question is short (the author's 30 days to 2026-11-20: at most 926 characters, an option's description 631, a
// label 102), so a pack keeps it whole at every level. These caps only bound an input no question has come near. A
// preview (a mockup an option shows when picked: at most 2382) is cut at 1500, and the lookup that prints it whole is
// named.
const ASK_CAPS = { question: 4000, header: 120, label: 400, description: 2000, preview: 1500 }
/** Each question as Markdown: its header, whether several options may be picked, every option with its description. */
function questionsText(questions, caps = ASK_CAPS) {
  const flat = (s, n) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n)
  const qs = questions.filter(q => q && typeof q === 'object')
  let cut = false
  const parts = qs.map((q, i) => {
    const header = flat(q.header, caps.header)
    const title = `**Question${qs.length > 1 ? ` ${i + 1} of ${qs.length}` : ''}${header ? `: ${header}` : ''}** (${q.multiSelect === true ? 'several may be picked' : 'pick one'})`
    const text = clip(String(q.question ?? '').trim(), caps.question).replace(/^/gm, '> ')
    const opts = (Array.isArray(q.options) ? q.options : []).filter(o => o && typeof o === 'object').map(o => {
      const desc = clip(String(o.description ?? '').trim(), caps.description).replace(/\n/g, '\n  ')
      let line = `- **${flat(o.label, caps.label) || '(no label)'}**${desc ? `: ${desc}` : ''}`
      const pv = typeof o.preview === 'string' ? o.preview.replace(/\s+$/, '') : ''
      if (pv) {
        if (pv.length > caps.preview) cut = true
        const fence = '`'.repeat(Math.max(3, ...[...pv.matchAll(/`+/g)].map(m => m[0].length + 1)))
        line += `\n\n  Its preview:\n\n  ${fence}\n${clip(pv, caps.preview).replace(/^/gm, '  ')}\n  ${fence}`
      }
      return line
    })
    return `${title}\n\n${text}\n\n${opts.length ? opts.join('\n') : '- (no options: the answer is the person\'s own words)'}`
  })
  return { text: parts.join('\n\n'), count: qs.length, cut }
}
/** The same for `show`, whole: what the person saw. */
function questionsLines(questions) {
  const qs = questions.filter(q => q && typeof q === 'object')
  const out = [`  ▸ AskUserQuestion, ${qs.length} question${qs.length === 1 ? '' : 's'}:`]
  qs.forEach((q, i) => {
    const header = String(q.header ?? '').replace(/\s+/g, ' ').trim()
    out.push(`    ${i + 1}. ${header ? `${header} ` : ''}(${q.multiSelect === true ? 'several may be picked' : 'pick one'})`)
    out.push(String(q.question ?? '').trim().replace(/^/gm, '       '))
    for (const o of Array.isArray(q.options) ? q.options : []) {
      if (!o || typeof o !== 'object') continue
      const desc = String(o.description ?? '').trim()
      out.push(`       - ${String(o.label ?? '').replace(/\s+/g, ' ').trim()}${desc ? `: ${desc.replace(/\n/g, '\n         ')}` : ''}`)
      if (typeof o.preview === 'string' && o.preview.trim()) out.push(`         preview:\n${o.preview.replace(/\s+$/, '').replace(/^/gm, '           ')}`)
    }
  })
  return out.join('\n')
}

function buildPack(d, ctx) {
  const { state, configDir, target, floor, login, level, embed, live } = ctx
  const when = t => iso(t).slice(5, 16)
  const started = d.owners[0] || d.creds[0] || null
  const ranOn = d.creds[d.creds.length - 1] || started
  const moved = started && ranOn && !sameOwner(started, ranOn)
  const title = d.title || d.aiTitle || `session ${d.sid.slice(0, 8)}`
  const sid8 = d.sid.slice(0, 8)
  // How the lookups below name it: an exported conversation is found by its path, a transcript by its id.
  const ref = d.exported ? `"${fwd(d.file)}"` : sid8
  // Who reads this: a session on another account (a switch), one on the account it ran on after its process ended (a
  // restart), or the fresh conversation /clear started in the same process, once the old one's cache had gone cold (a clear).
  const cleared = ctx.kind === 'clear'
  const sw = ctx.kind !== 'restart' && !cleared
  const same = ctx.same ?? null
  const boot = bootTime()
  const rebooted = !cleared && !live && d.lastTs > 0 && boot > d.lastTs + 60e3
  const onDisk = d.exported
    ? `. Claude Code saved no transcript for that session${d.exported.why ? ` (${d.exported.why})` : ''}, so the conversation as the engine held it when this file was built is in \`${fwd(d.file)}\`, without times: a time below may read ?.`
    : ', and the whole conversation is still on disk.'
  const L = [], sec = (h, body) => { if (body && body.trim()) L.push(`## ${h}\n\n${body.trim()}\n`) }
  const promptClip = [6000, 4000, 2000, 1200][level], finalClip = [8000, 6000, 3500, 2000][level], timelineMax = [40, 24, 12, 6][level]
  const person = d.turns.filter(t => PERSON.has(t.kind))
  const mh = embed ? modelHandoff(d, configDir) : null
  const chain = lineage(d)
  const asked = waitingQuestions(d)

  L.push(`# ${sw ? 'Account-switch handoff' : cleared ? 'Handoff after /clear' : 'Restart handoff'}: ${title}\n`)
  L.push(`<!-- acct-sync pack: session=${d.sid} kind=${sw ? 'switch' : cleared ? 'clear' : 'restart'} -->`)
  // After /clear the login is the one this process runs on, whatever the transcript recorded (an export records none).
  const ranText = moved ? `was started under ${ownerText(state, started)} and last ran on ${ownerText(state, ranOn)}` : cleared && !ranOn ? 'ran in this process, on the login it still runs on' : `ran under ${ownerText(state, ranOn)}`
  L.push(`Built by acct-sync on ${iso(Date.now())} from session \`${d.sid}\`, which ${ranText}${target ? `, for ${target.name}` : ''}. The script wrote this file without calling a model${mh ? '; the section "Handoff the session wrote" is the session\'s own words' : ''}.\n`)

  // What the reader has to know about its own situation, before anything about the work.
  const carry = []
  carry.push(sw
    ? `This file hands over work from another Claude Code session, so that it can go on under a different Claude account. Neither that account's prompt cache nor the session's reasoning crosses accounts, so the work comes to you as this file instead of a ${tok(d.ctx)}-token conversation. What you need to start is below${onDisk}`
    : cleared
      ? `This file hands over work from the Claude Code session that ran in this terminal until /clear ended its conversation. Its prompt cache had run out, so its next turn would have sent all ${tok(d.ctx)} tokens of it again, uncached. You are the fresh conversation /clear started, in the same process and on the same login. What you need to start is below${onDisk}`
      : `This file hands over work from an earlier Claude Code session ${live ? 'that was still running when the file was written' : `whose process is gone${rebooted ? `: this machine restarted at ${iso(boot)}, after its last activity` : ''}`}. You are a fresh session, started from this file instead of that ${tok(d.ctx)}-token conversation: once a session's prompt cache has run out, loading the conversation again means sending all of it uncached. What you need to start is below${onDisk}${same === null ? ' Whether the login in use is the one that session ran on is not recorded.' : ''}`)
  if (asked.length) carry.push(`- **It stopped on a question to the person that has no answer yet.** The question comes first under "Where it stopped": get the answer before you go on with the work.`)
  carry.push(`- Look a detail up instead of loading the conversation. Each of these prints a small slice: \`${SELF} show ${ref} --grep "<regex>"\`, \`--turn <n>\`, \`--last <n>\`, \`--prompts\`, \`--files\`. Turn numbers below are the ones \`--turn\` takes.`)
  carry.push(`- For a broad question about it ("what was tried for X?"), give the lookup to a subagent on a cheaper model and take its answer: \`${SELF} render ${ref} --out <file>\` writes the conversation without tool output for it to read.`)
  carry.push(`- Files, branches and worktrees are as the session left them at ${iso(d.lastTs)}. Check one before you rely on what this file says about it.`)
  carry.push(sw
    ? `- Usage percentages, reset times and "wait until" lines below belong to the other account. Read this account's own usage before acting on any of them.`
    : `- Usage percentages, reset times and "wait until" lines below were true when they were written, ${iso(d.lastTs)} at the latest. Read the account's usage as it is now before acting on any of them.`)
  sec('For the session that picks this up', carry.join('\n'))

  const rows = [
    ['Working directory', `\`${fwd(d.cwd || '?')}\`${d.gitBranch ? ` (branch \`${d.gitBranch}\` when last seen)` : ''}`],
    ['Ran on', `${d.model || '?'}${d.effort ? `, effort ${d.effort}` : ''}, Claude Code ${d.version || '?'}`],
    ['Size', `${d.turns.length} turn${d.turns.length === 1 ? '' : 's'} (${person.length} from the person), ${tok(d.ctx)} tokens of context at the end${d.compactCount ? `, compacted ${d.compactCount}×` : ''}${d.costUsd ? `, ${usd(d.costUsd)} at API prices` : ''}`],
    ['Active', `${iso(d.firstTs)} to ${iso(d.lastTs)}`],
    d.exported
      ? ['Conversation', `\`${fwd(d.file)}\`, exported from the engine at ${iso(d.exported.at)}: Claude Code saved no transcript${trimmedText(d.exported.trimmed)}`]
      : ['Transcript', `\`${fwd(d.file)}\``],
  ]
  if (d.creds.length > 1) rows.push(['Logins', `its requests have run on ${new Set(d.creds.map(c => c.organizationUuid)).size} logins: ${d.creds.slice(-4).map(c => `${ownerText(state, c)} from turn ${c.atTurn + 1} (${iso(c.ts)})`).join(', then ')}`])
  if (chain.length) rows.push(['Continues', chain.map(c => `${c.from ? `session \`${c.from.slice(0, 8)}\` ` : ''}through \`${c.pack}\``).join('; ')])
  sec('State', rows.map(r => `- **${r[0]}:** ${r[1]}`).join('\n'))

  // The person's own words are the requirements: keep them verbatim.
  if (person.length) {
    const keep = person.length <= 34 ? person : [...person.slice(0, 4), ...person.slice(-28)]
    const lines = keep.map(t => `**#${t.n}** (${iso(t.ts)}${t.kind === 'human' ? '' : `, ${t.kind}`})\n${clip(t.text, promptClip).replace(/^/gm, '> ')}`)
    if (keep.length < person.length) lines.splice(4, 0, `_… ${person.length - keep.length} prompts in between left out: \`${SELF} show ${ref} --prompts\`_`)
    sec('What the person asked, in their words', lines.join('\n\n'))
  }

  if (mh) {
    const stale = mh.turnsAfter == null
      ? ' Whether the session went on after it is not known (the exported conversation has no times), so read "Where it stopped" below as the newer account where the two differ.'
      : mh.turnsAfter || mh.minutesAfter > 2
        ? ` The session went on after writing it (${mh.minutesAfter ?? '?'} min, ${mh.turnsAfter} more turn${mh.turnsAfter === 1 ? '' : 's'}${mh.promptsAfter == null ? ' with work in them' : `, ${mh.promptsAfter} of them from the person`}), so "Where it stopped" below is newer where the two differ.`
        : ' Nothing happened in the session after it.'
    sec('Handoff the session wrote', `From \`${mh.path}\` (${mh.how}, last written ${iso(mh.ts)}).${stale} Its own headings appear two levels down, from here to the next \`##\`.\n\n${clip(demote(mh.text.trim()), [40000, 30000, 16000, 8000][level])}`)
  } else if (d.lastCompact) {
    const after = d.turns.length - d.lastCompact.turn
    sec('Summary from the last compaction', `Claude Code's own summary, written at ${iso(d.lastCompact.ts)} when the context was compacted; ${after} turn${after === 1 ? '' : 's'} came after it.\n\n${clip(demote(d.lastCompact.text), [30000, 20000, 10000, 5000][level])}`)
  }
  if (d.away.length && level < 3) sec('Recaps the session wrote along the way', d.away.slice(mh ? -1 : -3).map(a => `- ${iso(a.ts)}: ${oneLine(a.text, 900)}`).join('\n'))

  // Where it stopped. A question the session was waiting on comes first: the person answers it from here.
  const stop = []
  const lastTurn = d.turns[d.turns.length - 1]
  if (asked.length) {
    const qs = questionsText(asked.flatMap(p => p.ask))
    const many = qs.count > 1, them = many ? 'them' : 'it'
    const at = asked[0].ts ? `, ${iso(asked[0].ts)}` : ''
    const lead = `**${live ? 'When this file was written, the session was' : 'The session stopped while it was'} waiting on the person's answer to ${many ? `${qs.count} questions` : 'a question'}** (AskUserQuestion in turn #${asked[0].turn || '?'}${at}).`
    const heldAt = asked.find(p => p.held)?.heldTs
    const none = heldAt !== undefined
      ? `Cache Keeper held the person's answer${heldAt ? ` at ${iso(heldAt)}` : ''}: the prompt cache had gone cold, so the turn was ended before the answer was read, and nothing after ${them} ran. The person sends that answer as their next message.`
      : live ? `No answer had reached it, so nothing after ${them} had run.` : `No answer reached it, so nothing after ${them} ran.`
    const todo = `Unless a message from the person to you already answers ${them}, put ${them} to the person again, with the same options, and go on from the answer${many ? 's' : ''}. An option marked (Recommended) was the old session's suggestion, not the person's choice, and the person may answer in their own words.`
    const whole = qs.cut ? ` A preview below is cut: \`${SELF} show ${ref} --turn ${asked[0].turn}\` prints ${them} whole.` : ''
    stop.push(`${lead} ${none} ${todo}${whole}\n\n${qs.text}`)
  }
  if (live) stop.push(`The session's process was still running (${live.status}) when this file was written, so this is a snapshot taken at ${iso(d.lastTs)}: anything it did after that is not here. Two sessions working the same files at once undo each other, so find out whether it is still going before you change anything.`)
  if (rebooted) stop.push(`This machine restarted at ${iso(boot)}, after the session's last activity: the session was not closed, it was cut off where the lines below leave it.`)
  if (d.limitStop) stop.push(`It ended on a usage-limit reply at ${iso(d.limitStop.ts)}: "${d.limitStop.text}". The work in flight was cut off, not finished.`)
  // Every other call with no result, as before: what it was doing is unknown.
  // A kept question the conversation went past (the person sent the answer, a later turn ran) is answered: no open call.
  const open = [...d.pending.values()].filter(p => !asked.includes(p) && !p.kept)
  const calls = open.slice(-3).map(p => `\`${oneLine(p.line, 140)}\``).join('; ')
  const besides = asked.length ? 'Besides the question, ' : ''
  if (open.length && live?.status === 'busy') stop.push(`${besides ? `${besides}it` : 'It'} was in the middle of a turn, with ${open.length} tool call${open.length > 1 ? 's' : ''} in flight: ${calls}.`)
  else if (open.length) stop.push(`${besides || 'It stopped inside a turn: '}${open.length} tool call${open.length > 1 ? 's have' : ' has'} no result (${calls}). Treat what ${open.length > 1 ? 'they were' : 'it was'} doing as unknown until checked.`)
  else if (asked.length) { /* the turn waits on the question: it neither ran to its end nor lacks an answer of its own */ }
  else if (lastTurn && !lastTurn.final && !d.limitStop) stop.push(`The last prompt (#${lastTurn.n}, ${lastTurn.kind}) has no answer in the transcript.`)
  else if (!d.limitStop) stop.push(`The last turn (#${lastTurn?.n ?? '?'}) ran to its end at ${iso(d.workTs || d.lastTs)}.`)
  const finals = [...d.recentFinals.entries()].sort((a, b) => a[0] - b[0]).slice(-(level < 2 ? 2 : 1))
  for (const [n, text] of finals) stop.push(`**The session's last message in turn #${n}:**\n\n${clip(text.trim(), finalClip).replace(/^/gm, '> ')}`)
  const lastN = finals.length ? finals[finals.length - 1][0] : 0
  const earlier = d.notes.filter(x => x.turn === lastN).slice(0, -1).slice(-3)
  if (earlier.length && level < 2) stop.push(`Earlier notes in that turn:\n${earlier.map(x => `- ${oneLine(x.text, 500)}`).join('\n')}`)
  if (d.errors.length) stop.push(`Last tool errors:\n${d.errors.slice(-3).map(e => `- ${iso(e.ts)} ${e.tool}: ${e.text}`).join('\n')}`)
  sec('Where it stopped', stop.join('\n\n'))

  // Timeline: each prompt and what came of it.
  if (d.turns.length > 1 && !(mh && mh.turnsAfter === 0 && level > 0)) {
    const shown = new Set(person.slice(-timelineMax).map(t => t.n))
    for (const t of d.turns.slice(-Math.min(8, timelineMax))) shown.add(t.n)
    const lines = []; let skipped = {}
    const flush = () => { const k = Object.entries(skipped); if (k.length) lines.push(`- _(${k.map(([a, b]) => `${b} ${a}`).join(', ')} not shown)_`); skipped = {} }
    for (const t of d.turns) {
      if (!shown.has(t.n)) { skipped[t.kind] = (skipped[t.kind] || 0) + 1; continue }
      flush()
      lines.push(`- **#${t.n}** ${iso(t.ts).slice(5, 16)} ${t.kind}: ${oneLine(t.text, 170)}${t.final ? `\n  → ${oneLine(t.final, 260)}` : t.tools ? `\n  → (${t.tools} tool calls, no closing message)` : ''}`)
    }
    flush()
    sec('Timeline', lines.join('\n'))
  }

  if (d.files.size) {
    const fl = [...d.files.entries()].sort((a, b) => b[1].ts - a[1].ts)
    sec('Files this session edited', `${fl.slice(0, 40).map(([f, v]) => `- \`${f}\` (${v.n}×${v.ts ? `, last ${iso(v.ts).slice(5, 16)}` : ''})`).join('\n')}${fl.length > 40 ? `\n- … ${fl.length - 40} more: \`${SELF} show ${ref} --files\`` : ''}`)
  }
  const refs = []
  for (const [url, p] of d.prs) refs.push(`- PR ${url}`)
  for (const n of d.notable.slice(-12)) refs.push(`- ${iso(n.ts).slice(5, 16)} \`${n.cmd}\``)
  sec('Pull requests and commands that changed something outside the session', refs.join('\n'))

  // Background work: what has no ending in the transcript first, since that is what may still be running.
  const bg = []
  const seen = j => (j.seen ? ` (${j.seen.status} when last reported, ${when(j.seen.ts)}${j.seen.note ? `: ${j.seen.note}` : ''})` : '')
  for (const a of d.agents.filter(a => a.background && !a.status).slice(-12)) bg.push(`- subagent (${a.type}) started ${when(a.ts)}: ${a.desc}${seen(a)}`)
  for (const b of d.background.filter(b => !b.status).slice(-6)) bg.push(`- background shell started ${when(b.ts)}${b.desc ? ` (${oneLine(b.desc, 90)})` : ''}: \`${b.cmd}\`${seen(b)}`)
  for (const c of d.cronsCreated.slice(-6)) bg.push(`- scheduled (${c.cron}) ${when(c.ts)}: ${c.prompt}`)
  for (const c of [...d.cronsFired.values()].slice(-4)) bg.push(`- a schedule fired ${c.fires}×, last ${when(c.ts)} (${c.cron}): ${c.prompt}`)
  if (d.wakeup) bg.push(`- a wake-up was pending (${d.wakeup.delay}s from ${when(d.wakeup.ts)}): ${d.wakeup.reason}`)
  if (bg.length) sec('Background work with no ending in the transcript', `Each of these was started by the old session and never reported back there. ${cleared
    ? '/clear ends a conversation, not its process: the shells, subagents and schedules it started keep running, and their notices come to this conversation. Find out whether one is still going before you start it again: two copies of a job undo each other.'
    : rebooted
      ? 'This machine has restarted since, so nothing it started here is running any more: its subagents, shells, schedules and wake-ups ended with it. Work it started somewhere else (a CI run, a job on another host) went on without it. Start again what the work still needs.'
      : 'It may still be running, and its result goes to that session\'s process, not to you: if that process is gone, so are its schedules and shells.'}\n\n${bg.join('\n')}`)
  const fin = d.agents.filter(a => a.status).sort((a, b) => a.doneTs - b.doneTs).slice(-[8, 6, 4, 2][level])
  if (fin.length) sec('Subagent results it already had', fin.map(a => `- (${a.type}) ${a.desc}: ${a.status} ${when(a.doneTs)}${a.result ? `\n  ${a.result}` : ''}`).join('\n'))

  const tasks = openTasks(configDir, d.sid)
  if (tasks.length) sec('Open items on its task list', tasks.slice(0, 20).map(t => `- [${t.status}] ${t.subject}`).join('\n'))

  // What the reader does not have. Account-bound state only where the account changed; say only what applies.
  const lost = []
  const pages = d.artifacts.map(a => `  - \`${a.file}\`${a.url ? ` was ${a.url}` : ''}`).join('\n')
  if (sw) {
    if (d.artifacts.length) lost.push(`- **Published pages.** These belong to the other account; an update from here is refused as if the page were deleted. Publish a new page from the same file and say that the link changed:\n${pages}`)
    const hosted = [...d.mcp].filter(s => /^claude[_-]ai|^claude_ai/i.test(s))
    if (hosted.length) lost.push(`- **Connectors from the claude.ai account** (${hosted.join(', ')}): connected per account, so they may be missing or point at other data here.`)
    if (d.mcp.has('claude-in-chrome')) lost.push('- **The Chrome extension** pairs with a claude.ai login. If browser tools answer "not connected", ask the person to reconnect it (`/mcp`) rather than retrying.')
    if (d.sentFiles) lost.push('- **Sending files to the person\'s other devices** goes through Remote Control, which a login change disconnects. Give full local paths until they turn it on again.')
    if (d.thinkingDropped) lost.push(`- This session already crossed accounts once (${iso(d.thinkingDropped)}): Claude Code reported that thinking from another organization could not be used.`)
    lost.push('- **Reasoning.** The earlier thinking is unreadable from another organization even on a full resume, so conclusions here are stated without their derivation. Re-derive one before you build on it if it is load-bearing.')
  } else {
    if (d.artifacts.length) lost.push(`- **Published pages.** ${same === null ? 'If the login in use is the account that published them, they' : 'They are still this account\'s and'} can be updated, but not unseen: read a page by its link first, then publish to that link, so that the link stays the same.\n${pages}`)
    lost.push('- **Reasoning.** The earlier thinking stays in the old conversation and is not in this file, so conclusions here are stated without their derivation. Re-derive one before you build on it if it is load-bearing.')
  }
  lost.push(`- **The session's id.** You are a new session with an id of your own. Whatever addressed the old one by its id (\`${sid8}\`)${cleared ? '' : ' or by its name'} does not reach you until it is told.`)
  sec(sw ? 'What does not cross to this account' : 'What a fresh session does not have', lost.join('\n'))

  if (floor) L.push(`<!-- floor ${floor.tokens} ctx ${d.ctx} login ${login ? fp(login) : '?'} level ${level} -->`)
  return L.join('\n')
}

async function makePack(state, s, opt) {
  const d = await scan(s.file)
  if (s.exported) d.exported = s.exported
  const configDir = s.configDir || configDirOf(s.file)
  const target = opt.to ? accountByName(state, opt.to) : null
  const floor = await floorFor(state, s.projectDir || path.dirname(s.file))
  if (d.post != null) d.ctx = floor.tokens + d.post + COMPACT_EXTRA
  const login = currentLogin(configDir)
  // A clear's reader is the conversation /clear starts in the session's own process, on its login: the process is
  // running when the pack is built, and it is not another session working beside the reader.
  const cleared = opt.kind === 'clear'
  const live = cleared ? null : liveSessions(configDir).get(d.sid) || null
  // A pack from handoff or sync is for the other account. wake asks ('auto'): its reader is on the login in use,
  // or the one named with --to, and that may be the login the session ran on.
  const same = cleared ? true : sameLogin(d.creds[d.creds.length - 1] || d.owners[0] || null, target || login)
  const kind = opt.kind === 'auto' ? (same === false ? 'switch' : 'restart') : (opt.kind || 'switch')
  if (!['switch', 'restart', 'clear'].includes(kind)) die(`--kind ${kind}: one of switch, restart, clear, auto`)
  const budget = Number(opt.budget || 14000) * 3.6
  let text = '', level = 0
  for (; level < 4; level++) { text = buildPack(d, { state, configDir, target, floor, login, level, live, kind, same, embed: !opt['no-embed'] }); if (text.length <= budget) break }
  level = Math.min(level, 3)
  // Its own folder beside the project's handoffs, so tools that take "the newest handoff" there never pick a pack up.
  const outDir = path.join(target?.configDir || configDir, 'handoffs', projectName(d.cwd), 'acct')
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')
  const out = opt.out ? path.resolve(opt.out) : path.join(outDir, `${stamp}-${slugify(d.title || d.aiTitle, d.sid)}-${d.sid.slice(0, 8)}.md`)
  return { d, text, out, level, floor, target, live, configDir, kind, same, tokens: estTokens(text.length) }
}
function launchLines(d, pack, target, { live } = {}) {
  const env = target && path.resolve(target.configDir) !== DEFAULT_DIR ? `CLAUDE_CONFIG_DIR="${fwd(target.configDir)}" ` : ''
  const say = `Read ${fwd(pack)} and continue that work. It is a handoff from a session on my other account.`
  const out = []
  if (live) out.push(`  in the running session, after the login changed:  /clear   then send:  ${say}`)
  out.push(`  fresh session:   cd "${fwd(d.cwd || '.')}" && ${env}claude "${say}"`)
  out.push(`  full resume:     cd "${fwd(d.cwd || '.')}" && ${env}claude --resume ${d.sid}`)
  return out
}

// ───────────────────────────────────────────────────────────── commands

async function cmdAccounts(state, opt) {
  const rows = [['label', 'login', 'plan', 'config dir', 'sessions last run on it (30d)', 'last used']]
  const seen = new Map()
  const since = Date.now() - 30 * 86400e3
  for (const s of allSessions(state, { sinceMs: since }).slice(0, 400)) {
    const q = quickInfo(s.file, s); const on = runsOn(q); if (!on) continue
    const k = `${on.organizationUuid || on.accountUuid}|${s.configDir}`
    const e = seen.get(k) || { owner: on, configDir: s.configDir, n: 0, last: 0 }
    e.n++; e.last = Math.max(e.last, q.lastTs); seen.set(k, e)
  }
  const logins = new Map(configDirs(state).map(cd => [cd, currentLogin(cd)]))
  for (const e of [...seen.values()].sort((a, b) => b.last - a.last)) {
    const cur = logins.get(e.configDir)
    rows.push([labelFor(state, e.owner) || '-', `${fp(e.owner)}${cur && sameOwner(cur, e.owner) ? ' ← logged in' : ''}`, cur && sameOwner(cur, e.owner) ? cur.plan : '', fwd(e.configDir), e.n, `${ago(e.last)} ago`])
  }
  for (const [name, a] of Object.entries(state.accounts)) if (![...seen.values()].some(e => sameOwner(e.owner, a))) rows.push([name, fp(a), a.plan || '', fwd(a.configDir || DEFAULT_DIR), 0, '-'])
  if (opt.json) return console.log(JSON.stringify({ accounts: state.accounts, seen: [...seen.values()].map(e => ({ fp: fp(e.owner), label: labelFor(state, e.owner), configDir: fwd(e.configDir), sessions: e.n, last: e.last })) }, null, 2))
  console.log(table(rows, { right: [4] }))
  const cur = logins.get(DEFAULT_DIR)
  console.log(`\nLogged in now (${fwd(DEFAULT_DIR)}): ${cur ? `${ownerText(state, cur)}, ${cur.plan || 'plan unknown'}` : 'no claude.ai login found'}`)
  if (cur && !labelFor(state, cur)) console.log(`It has no label yet:  ${SELF} label <name> --current`)
  console.log(cur?.ownerAsk
    ? 'Claude Code asks before continuing a session another login started (exit / log back in / copy) on this install.'
    : 'Claude Code records which login started each session; on this install it does not ask before another login continues one.')
}

function cmdLabel(state, pos, opt) {
  const name = pos[0] || die('label <name> [--current | --owner <fingerprint prefix>] [--config-dir <dir>]')
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(name)) die('a label is letters, digits, - and _')
  const configDir = path.resolve(opt['config-dir'] || state.accounts[name]?.configDir || DEFAULT_DIR)
  let owner
  if (opt.owner) {
    const hits = new Map()
    for (const s of allSessions(state, { sinceMs: Date.now() - 90 * 86400e3 }).slice(0, 800)) {
      const q = quickInfo(s.file, s)
      for (const o of [q.owner, runsOn(q)]) if (o && fp(o).startsWith(opt.owner.toLowerCase())) hits.set(fp(o), { ...(hits.get(fp(o)) || {}), ...o })
    }
    if (hits.size !== 1) die(hits.size ? `"${opt.owner}" matches ${hits.size} logins` : `no session in the last 90 days ran on a login with fingerprint ${opt.owner}…`)
    owner = [...hits.values()][0]
  } else {
    const cur = currentLogin(configDir) || die(`no claude.ai login found in ${fwd(configDir)}`)
    owner = { accountUuid: cur.accountUuid, organizationUuid: cur.organizationUuid, plan: cur.plan }
  }
  for (const [n, a] of Object.entries(state.accounts)) if (n !== name && sameOwner(a, owner)) delete state.accounts[n]
  state.accounts[name] = { accountUuid: owner.accountUuid || '', organizationUuid: owner.organizationUuid || '', plan: owner.plan || state.accounts[name]?.plan || '', configDir: fwd(configDir) }
  saveState(state)
  console.log(`${name} = login ${fp(owner)} (config dir ${fwd(configDir)})`)
}

const logins = new Map()
function loginOf(cd) { if (!logins.has(cd)) logins.set(cd, currentLogin(cd)); return logins.get(cd) }

async function rowsFor(state, sessions, opt) {
  const turns = Number(opt.turns || 10)
  const target = opt.to ? accountByName(state, opt.to) : null
  const out = []
  const lives = new Map()
  for (const s of sessions) {
    const q = quickInfo(s.file, s)
    const cd = s.configDir || configDirOf(s.file)
    if (!lives.has(cd)) lives.set(cd, liveSessions(cd))
    const live = lives.get(cd).get(s.sid) || null
    const snap = liveSnap(cd, s.sid)
    const floor = await floorFor(state, s.projectDir || path.dirname(s.file))
    const cache = cacheState(q, snap)
    const model = q.model || snap?.model
    const ctx = ctxNow(q, floor)
    const idle = idleCompaction(cd, q.cwd)
    const advice = advise({ q, ctx, cache, login: loginOf(cd), floor, snap, live, idle, target })
    const c = ctx != null ? costModel({ ctx, floor: floor.tokens, pack: Number(opt.pack || 11000), model, ttl: cache.ttl, turns, idle, warm: cache.warm && advice.mine !== false }) : null
    // advise() sorts by size and cache state; the prices decide whether a compaction is worth what its summary drops.
    if (c && advice.act === 'warm' && !leavingPays(c)) {
      const g = lessThanResume(c, c.compactBeforeLeaving)
      advice.act = 'resume'; advice.selfCompactInMs = null
      advice.why = `a /compact first would ${g > 0 ? `save ${g}% over ${turns} turns` : 'cost more than it saves'}: it holds ${tok(ctx - floor.tokens)} of its own, a compaction leaves about ${tok(AFTER_COMPACT)}, and the summary has to be written. Under ${Math.round(COMPACT_GAIN * 100)}% that is not worth the detail a summary drops`
    }
    if (c && advice.act === 'pack') advice.onArrival = arrivalPays(c) ? 'compact' : 'resume'
    out.push({ s, q, cd, snap, floor, cache, c, ctx, model, live, idle, advice })
  }
  return { rows: out, login: loginOf(DEFAULT_DIR), turns }
}
function sessionName(r, n = 34) { return oneLine(r.live?.name || r.q.title || r.q.aiTitle || r.q.lastPrompt || '(untitled)', n) }

async function cmdLs(state, opt) {
  const sinceMs = Date.now() - duration(opt.since, 14 * 86400e3)
  let list = allSessions(state, { project: opt['all-projects'] ? null : (opt.project || '.'), sinceMs })
  if (!list.length && !opt.project && !opt['all-projects']) list = allSessions(state, { sinceMs })
  if (opt.shared) list = list.filter(s => state.shared[s.sid])
  if (opt.live) { const lv = new Set(); for (const cd of configDirs(state)) for (const k of liveSessions(cd).keys()) lv.add(k); list = list.filter(s => lv.has(s.sid)) }
  const limit = Number(opt.limit || 25)
  let { rows } = await rowsFor(state, list.slice(0, opt.owner ? 400 : limit), opt)
  if (opt.owner) rows = rows.filter(r => [startedBy(r.q), runsOn(r.q)].some(o => o && (labelFor(state, o) === opt.owner || fp(o).startsWith(opt.owner)))).slice(0, limit)
  if (opt.json) return console.log(JSON.stringify(rows.map(r => ({ sid: r.s.sid, name: sessionName(r, 200), startedBy: startedBy(r.q) && shortOwner(state, startedBy(r.q)), runsOn: runsOn(r.q) && shortOwner(state, runsOn(r.q)), model: r.model, ctx: r.ctx, cache: r.cache, lastTs: r.q.lastTs, live: r.live, shared: Boolean(state.shared[r.s.sid]), advice: r.advice.act, file: fwd(r.s.file) })), null, 2))
  const t = [['id', 'name', 'login', 'model', 'ctx', 'cache', 'idle', 'cold resume', 'via pack', 'do']]
  for (const r of rows) {
    t.push([`${r.s.sid.slice(0, 8)}${state.shared[r.s.sid] ? '*' : ''}`, sessionName(r), ownerCol(state, r.q),
      String(r.model || '?').replace(/^claude-/, ''), tok(r.ctx), `${cacheText(r.cache, r.advice.mine)}${r.live ? ` ${r.live.status}` : ''}`, ago(r.q.lastTs),
      r.c ? usd(r.c.dollars(r.c.resume.first)) : '?', r.c ? usd(r.c.dollars(r.c.fresh.first)) : '?', ACT_TEXT[r.advice.act]])
  }
  console.log(table(t, { right: [4, 6, 7, 8] }))
  console.log(`\n${rows.length} of ${list.length} sessions${opt.project || opt['all-projects'] ? '' : ' in this project'} active in the window. * = on the share list. login a→b = started under a, last ran on b.`)
  console.log('"cold resume" and "via pack" are the first turn on a login other than the one it last ran on, at API prices.')
}

/** What the session has written about itself, and how much happened after it: what a pack can lean on. */
function ownSummary(d, configDir) {
  const mh = modelHandoff(d, configDir)
  if (mh) return { what: `the handoff it wrote at ${iso(mh.ts)}`, after: mh.turnsAfter }
  if (d.lastCompact) return { what: `Claude Code's compaction summary of ${iso(d.lastCompact.ts)}`, after: d.turns.length - d.lastCompact.turn }
  return null
}

async function cmdPlan(state, pos, opt) {
  if (!pos.length) return planAll(state, opt)
  const s = resolveSession(state, pos[0])
  const { rows, turns } = await rowsFor(state, [s], opt)
  const r = rows[0], c = r.c, sid8 = s.sid.slice(0, 8)
  const d = await scan(s.file)
  const own = ownSummary(d, r.cd)
  if (opt.json) return console.log(JSON.stringify({ sid: s.sid, ctx: r.ctx, floor: r.floor.tokens, model: r.model, cache: r.cache, live: r.live, idleCompaction: r.idle, advice: r.advice, ownSummary: own, costs: c && { resume: c.resume, fresh: c.fresh, compactBeforeLeaving: c.compactBeforeLeaving, compactOnArrival: c.compactOnArrival, warmHandoff: c.warmHandoff, pricePerMTok: c.p.in } }, null, 2))
  console.log(`${s.sid}  "${sessionName(r, 60)}"`)
  console.log(`  ${fwd(r.q.cwd || path.basename(path.dirname(s.file)))} · ${whoText(state, r.q)} · ${r.model || 'model ?'}${r.live ? ` · running (${r.live.status})` : ''}`)
  console.log(`  context ${tok(r.ctx)} tokens${r.q.post != null ? ' (compacted, nothing sent since: an estimate)' : ''} · cache: ${cacheText(r.cache, r.advice.mine)} (${r.cache.ttl} lifetime) · a fresh session in this project starts at ${tok(r.floor.tokens)}${r.floor.known ? ` (median of ${r.floor.n})` : ' (assumed)'}`)
  if (r.snap?.limits) { const l = r.snap.limits; console.log(`  its account when it last answered: 5h ${l.fiveHour?.pct ?? '-'}%, 7d ${l.sevenDay?.pct ?? '-'}%${r.advice.capped ? '  ← at its limit' : ''}`) }
  console.log(`  in its own words: ${own ? `${own.what}, ${own.after ? `${own.after} turn${own.after > 1 ? 's' : ''} before the end` : 'with nothing after it'}` : 'nothing yet (no handoff written, never compacted)'}`)
  if (!c) return console.log('\n  No request with usage found in the transcript, so there is nothing to price. A pack costs no tokens to make either way.')
  console.log(`\nOn a login other than the one it last ran on, none of it is in the cache. Figures are input tokens at ${r.model || 'this model'}'s price ($${c.p.in}/MTok${c.p.known ? '' : ', assumed'}); dollars are API prices, and a subscription's limits are used in the same proportions. Output is the same on every path and left out.\n`)
  const t = [['path', 'on the login it has', 'first turn on the next', 'each later turn', `after ${turns} turns`, 'a wake after the cache expired']]
  const add = (name, x) => t.push([name, money(c, x.there), money(c, x.first), money(c, x.per), money(c, x.after), money(c, x.rewake)])
  add('resume the whole conversation', c.resume)
  add('fresh session from a pack', c.fresh)
  add('/compact before leaving, same session after', c.compactBeforeLeaving)
  add('resume, then /compact before anything else', c.compactOnArrival)
  console.log(table(t, { right: [1, 2, 3, 4, 5] }))
  const warmThere = r.cache.warm && r.advice.mine !== false
  console.log(`\n  /compact before leaving is priced with its cache ${warmThere ? 'warm (a read)' : 'cold (a rewrite), since that is its state now'}. A compacted session is taken as ${tok(c.small)}: the fresh-session size plus the ${tok(AFTER_COMPACT)} a compaction left behind on the author's machine (median of 116).`)
  console.log(`  ${r.idle.on ? `Last column: Claude Code compacts an idle session of ${tok(r.idle.minTokens)} or more by itself shortly before its cache expires, so a big session wakes small. It skips that while the account is near its limit; then a wake rewrites everything.` : 'Last column: idle compaction is off in this session\'s settings, so a wake after the cache expired rewrites the whole context.'}`)
  console.log(`  The first session woken on a login also writes the ${tok(SHARED_PREFIX)} every session of a project shares (${money(c, c.sharedPrefix)} more than reading it); the others read it once that first answer has begun.`)
  const less = x => lessThanResume(c, x)
  const thin = r.advice.act === 'pack' && thinSummary(own)
  const viaCompact = r.advice.onArrival === 'compact'
  console.log(`\nDo: ${thin ? `${viaCompact ? 'resume, then /compact before anything else' : 'resume it as it is'} (or a pack, when a rough picture is enough)` : ACT_TEXT[r.advice.act]}. Why: ${r.advice.why}.`)
  if (r.advice.act === 'warm') {
    console.log(`  1. In the session, as the last thing on this login:  /compact     (${less(c.compactBeforeLeaving)}% less than a full resume over ${turns} turns)${r.live?.status === 'busy' ? '\n     It is mid-turn now: wait for the turn to end.' : ''}`)
    if (r.advice.selfCompactInMs) console.log(`     Left alone it compacts itself in ${Math.ceil(r.advice.selfCompactInMs / 60e3)} min, unless the account is near its limit by then.`)
    console.log('  2. Change login and carry on in the same session: it keeps its name, tasks, schedules and background work.')
    console.log(`  To start clean instead: /${HANDOFF_COMMAND} there (${money(c, c.warmHandoff)}), then  ${SELF} handoff ${sid8}  and a fresh session from the pack (${less(c.fresh)}% less).`)
  } else if (r.advice.act === 'pack') {
    const carries = own ? `${own.what}${own.after ? `, and the ${own.after} turn${own.after > 1 ? 's' : ''} after it as one line each` : ''}` : 'the prompts, the last messages and a timeline, but nothing in the session\'s own words'
    // The way across that keeps the work itself. A /compact on arrival rereads the whole cold conversation to write
    // its summary, so it is named only where that still beats resuming as it is; a mid-size session resumes whole.
    const resumeCmd = `cd "${fwd(r.q.cwd || '.')}" && claude --resume ${s.sid}`
    const g = less(c.compactOnArrival)
    const arrive = viaCompact
      ? `${r.live ? 'in the session, as the first thing after the login changed' : `${resumeCmd}   then, before any prompt`}:  /compact`
      : r.live ? 'carry on in the session as it is' : resumeCmd
    const arriveCost = viaCompact
      ? `${money(c, c.compactOnArrival.first)} once, ${g}% less than a full resume over ${turns} turns; the summary is written from the whole conversation`
      : `${money(c, c.resume.first)} on its first turn, nothing dropped; a /compact on arrival (${money(c, c.compactOnArrival.first)}) would ${g > 0 ? `save only ${g}% over ${turns} turns` : 'cost more than it saves at this size'}`
    if (thin) {
      // Nothing recent in the session's own words: a digest would drop too much, so pay once for the real thing.
      console.log(`  The session has written nothing about itself ${own ? `for ${own.after} turns` : 'at all'}, so a pack would carry ${carries}. That is thin for work in progress.`)
      console.log(`  For the work itself:  ${arrive}`)
      console.log(`     ${arriveCost}.`)
      console.log(`  Cheapest, when a rough picture is enough:  ${SELF} handoff ${sid8}${opt.to ? ` --to ${opt.to}` : ''}   (no model call, ${less(c.fresh)}% less), with details looked up from the transcript as needed.`)
    } else {
      console.log(`  1. ${SELF} handoff ${sid8}${opt.to ? ` --to ${opt.to}` : ''}     (no model call; ${less(c.fresh)}% less than a full resume over ${turns} turns)`)
      console.log('  2. Then one of:'); for (const l of launchLines({ cwd: r.q.cwd, sid: s.sid }, '<the pack it names>', opt.to ? accountByName(state, opt.to) : null, { live: Boolean(r.live) })) console.log(`   ${l}`)
      console.log(`  The pack carries ${carries}.`)
      console.log(`  If that is too thin for this work:  ${arrive}   (${arriveCost}).`)
    }
  } else console.log(r.live ? '  Nothing to do first: carry on in the session after the login change.' : `  cd "${fwd(r.q.cwd || '.')}" && claude --resume ${s.sid}`)
}
/** A pack leans on what the session last wrote about itself. Past this many turns since, it is mostly one-line results. */
const THIN_AFTER = 12
function thinSummary(own) { return !own || own.after > THIN_AFTER }

async function planAll(state, opt) {
  const lv = new Set(); for (const cd of configDirs(state)) for (const k of liveSessions(cd).keys()) lv.add(k)
  const list = allSessions(state, { sinceMs: Date.now() - 30 * 86400e3 }).filter(s => lv.has(s.sid) || state.shared[s.sid])
  if (!list.length) return console.log('No running sessions and nothing on the share list.')
  const { rows, login } = await rowsFor(state, list, opt)
  rows.sort((a, b) => (b.c?.resume.first || 0) * (b.c?.p.in || 0) - (a.c?.resume.first || 0) * (a.c?.p.in || 0))
  if (opt.json) return console.log(JSON.stringify(rows.map(r => ({ sid: r.s.sid, name: sessionName(r, 200), ctx: r.ctx, model: r.model, cache: r.cache, live: r.live, advice: r.advice, resumeUsd: r.c?.dollars(r.c.resume.first), compactFirstUsd: r.c?.dollars(r.c.compactBeforeLeaving.there + r.c.compactBeforeLeaving.first), packUsd: r.c?.dollars(r.c.fresh.first) })), null, 2))
  const t = [['id', 'name', 'login', 'model', 'ctx', 'cache', 'next turn, as it is', '/compact first', 'via pack', 'do before the switch']]
  let sumCold = 0, sumPlan = 0, sumStay = 0, tokCold = 0, tokPlan = 0
  for (const r of rows) {
    const c = r.c
    const cold = !c ? 0 : r.advice.warmOnTarget ? c.p.read * r.ctx : c.resume.first
    const pack = c ? c.fresh.first : 0, compact = c ? c.compactBeforeLeaving.there + c.compactBeforeLeaving.first : 0
    const planned = r.advice.act === 'resume' ? cold : r.advice.act === 'warm' ? compact : pack
    const $ = x => (c ? c.dollars(x) : 0)
    sumCold += $(cold); sumPlan += $(planned); tokCold += cold; tokPlan += planned
    sumStay += $(c && r.cache.warm && r.advice.mine !== false ? c.p.read * r.ctx : cold)
    const eta = r.advice.selfCompactInMs ? ` (by itself in ${Math.ceil(r.advice.selfCompactInMs / 60e3)}m)` : ''
    t.push([`${r.s.sid.slice(0, 8)}${state.shared[r.s.sid] ? '*' : ''}`, sessionName(r, 30), ownerCol(state, r.q), String(r.model || '?').replace(/^claude-/, ''),
      tok(r.ctx), `${cacheText(r.cache, r.advice.mine)}${r.live ? ` ${r.live.status}` : ''}`, c ? usd($(cold)) : '?', c && r.advice.act === 'warm' ? usd($(compact)) : '-', c ? usd($(pack)) : '?',
      r.advice.act === 'resume' ? 'nothing' : r.advice.act === 'warm' ? `/compact${eta}` : `pack (or ${r.advice.onArrival === 'compact' ? '/compact on arrival' : 'resume it as it is'})`])
  }
  console.log(table(t, { right: [4, 6, 7, 8] }))
  const change = opt.to ? `a change to ${opt.to}` : 'a login change'
  console.log(`\n${rows.length} sessions (running, or on the share list *). Logged in now: ${login ? ownerText(state, login) : '?'}. Dollars are API prices; a subscription's limits are used in the same proportions.`)
  console.log(`One more turn in each:  where they are now ${usd(sumStay)}  ·  after ${change}, as they are ${usd(sumCold)} (${tok(tokCold)} input-equivalent tokens)  ·  after ${change} with the last column done first ${usd(sumPlan)} (${tok(tokPlan)}).`)
  if (!opt.to) console.log('Name the destination (--to <label>) and sessions still warm there are counted as warm.')
  console.log('After the change, wake one, wait for its first words, then the rest: each later one reads what all sessions of a project share, where the first had to write it.')
  console.log('A closed session costs nothing until it is opened. A running one of 200k or more compacts itself 54 minutes after its last request, though not while its account is close to a limit. Whether that request can go out on the new login, uncached, is not established. So compact or clear the big ones before the change instead of leaving them.')
}

async function cmdHandoff(state, pos, opt) {
  const s = resolveSession(state, pos[0] || '.')
  if (opt.ask) {
    const q = quickInfo(s.file, s)
    const dir = fwd(path.join(DEFAULT_DIR, 'handoffs', projectName(q.cwd)))
    console.log(`While this session's account still answers and its cache is warm, a handoff in its own words costs one cache read. In the session:\n\n  /${HANDOFF_COMMAND}\n\nor, where that skill is not installed, send:\n\n  Write a handoff for a fresh session that will continue this work with none of this conversation. Save it under ${dir}/ as <UTC date-time>-<three-word-slug>.md with the Write tool. Headings, in this order, dropping any that would be empty: Goal, Status, Decisions, Dead ends, Files, Verification, Next steps, Open questions. Use exact paths, commands, identifiers and error text. Record every standing instruction I gave. Make the first next step specific enough to start on at once. Then stop.\n\nThen run:  ${SELF} handoff ${s.sid.slice(0, 8)}   (it finds that file and builds the pack around it)`)
    return
  }
  const p = await makePack(state, s, opt)
  if (opt.print) return process.stdout.write(p.text)
  fs.mkdirSync(path.dirname(p.out), { recursive: true })
  fs.writeFileSync(p.out, p.text)
  if (state.shared[s.sid]) { state.shared[s.sid].lastPack = { path: fwd(p.out), at: Date.now(), size: s.size }; saveState(state) }
  const c = costModel({ ctx: p.d.ctx || 0, floor: p.floor.tokens, pack: p.tokens, model: p.d.model, ttl: p.d.ttl, turns: 10, idle: { on: false, minTokens: IDLE_COMPACT_MIN }, warm: false })
  const live = Boolean(p.live)
  if (opt.json) return console.log(JSON.stringify({ pack: fwd(p.out), tokens: p.tokens, level: p.level, sid: s.sid, ctx: p.d.ctx }, null, 2))
  console.log(`pack: ${fwd(p.out)}`)
  console.log(`  ≈${tok(p.tokens)} tokens${p.level ? ` (trimmed to fit, level ${p.level} of 3; --budget <tokens> to change)` : ''}, from ${p.d.turns.length} turns and ${tok(p.d.ctx)} tokens of context; no model call`)
  if (p.d.ctx) console.log(`  first turn on another account: ${money(c, c.fresh.first)} from the pack, ${money(c, c.resume.first)} on a full resume`)
  const own = ownSummary(p.d, p.configDir)
  if (thinSummary(own) && p.d.ctx > p.floor.tokens + RESUME_UNDER) console.log(`  thin: the session wrote nothing about itself ${own ? `in its last ${own.after} turns` : 'at all'}, so this pack rests on prompts, last messages and one-line results. For work in progress, ${arrivalPays(c) ? `resume and run /compact before any prompt instead (${money(c, c.compactOnArrival.first)} once)` : `resume it as it is instead (${money(c, c.resume.first)} on its first turn; at this size a /compact on arrival saves too little)`}.`)
  for (const l of launchLines(p.d, p.out, p.target, { live })) console.log(l)
}

function cmdShare(state, pos, on) {
  if (!pos.length) die(`${on ? 'share' : 'unshare'} <session> [<session> …]`)
  for (const ref of pos) {
    const s = resolveSession(state, ref)
    if (on) state.shared[s.sid] = { ...(state.shared[s.sid] || {}), project: fwd(s.projectDir), addedAt: state.shared[s.sid]?.addedAt || Date.now() }
    else delete state.shared[s.sid]
    console.log(`${on ? 'shared' : 'no longer shared'}: ${s.sid}`)
  }
  saveState(state)
}

// ── copying between two config dirs (only when the accounts live in different ones)

function completeLength(file, size) {
  if (!size) return 0
  const win = Math.min(size, 4 * 1024 * 1024); const buf = Buffer.allocUnsafe(win)
  const fd = fs.openSync(file, 'r'); try { fs.readSync(fd, buf, 0, win, size - win) } finally { fs.closeSync(fd) }
  const i = buf.lastIndexOf(10)
  return i < 0 ? (win === size ? 0 : size) : size - win + i + 1
}
function sliceHash(file, start, len) {
  const buf = Buffer.allocUnsafe(len); const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, buf, 0, len, start) } finally { fs.closeSync(fd) }
  return crypto.createHash('sha1').update(buf).digest('hex')
}
function fullHash(file, len) {
  const h = crypto.createHash('sha1'); const fd = fs.openSync(file, 'r'); const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
  try { for (let pos = 0; pos < len;) { const n = fs.readSync(fd, buf, 0, Math.min(buf.length, len - pos), pos); if (!n) break; h.update(buf.subarray(0, n)); pos += n } } finally { fs.closeSync(fd) }
  return h.digest('hex')
}
/** Is the first `len` bytes of `a` the same as the first `len` bytes of `b`? Sampled at both ends unless verify. */
function samePrefix(a, b, len, verify) {
  if (len === 0) return true
  if (verify) return fullHash(a, len) === fullHash(b, len)
  const k = Math.min(len, 256 * 1024)
  return sliceHash(a, 0, k) === sliceHash(b, 0, k) && sliceHash(a, len - k, k) === sliceHash(b, len - k, k)
}
function copyRange(src, dst, start, end, append) {
  const BUF = 8 * 1024 * 1024; const buf = Buffer.allocUnsafe(BUF)
  const i = fs.openSync(src, 'r'); const o = fs.openSync(dst, append ? 'a' : 'w')
  try { for (let pos = start; pos < end;) { const n = fs.readSync(i, buf, 0, Math.min(BUF, end - pos), pos); if (!n) break; fs.writeSync(o, buf, 0, n); pos += n } } finally { fs.closeSync(i); fs.closeSync(o) }
}
function copyTree(src, dst, dry) {
  let n = 0
  let ents = []; try { ents = fs.readdirSync(src, { withFileTypes: true }) } catch { return 0 }
  for (const e of ents) {
    const a = path.join(src, e.name), b = path.join(dst, e.name)
    if (e.isDirectory()) { n += copyTree(a, b, dry); continue }
    if (!e.isFile()) continue
    const sa = fs.statSync(a); let sb = null; try { sb = fs.statSync(b) } catch { /* new */ }
    if (sb && sb.size === sa.size && sb.mtimeMs >= sa.mtimeMs - 2000) continue   // file systems round times differently
    n++
    if (dry) continue
    fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(a, b); fs.utimesSync(b, sa.atime, sa.mtime)
  }
  return n
}
function copySession(s, dstConfigDir, { force, dry, verify, memory }) {
  const slug = path.basename(s.projectDir)
  const dstDir = path.join(dstConfigDir, 'projects', slug); const dst = path.join(dstDir, `${s.sid}.jsonl`)
  if (liveSessions(dstConfigDir).has(s.sid)) return { action: 'skipped: it is running in the target', bytes: 0 }
  const len = completeLength(s.file, s.size)
  let action, bytes = 0
  const st = (() => { try { return fs.statSync(dst) } catch { return null } })()
  const write = (start, append) => { bytes = len - start; if (dry) return; fs.mkdirSync(dstDir, { recursive: true }); copyRange(s.file, dst, start, len, append); const t = fs.statSync(s.file); fs.utimesSync(dst, t.atime, t.mtime) }
  if (!st) { action = 'copied'; write(0, false) }
  else if (st.size === len && samePrefix(s.file, dst, len, verify)) action = 'up to date'
  else if (st.size < len && samePrefix(s.file, dst, st.size, verify)) { action = 'extended'; write(st.size, true) }
  else if (st.size > len && samePrefix(s.file, dst, len, verify)) action = 'skipped: the target copy is ahead (sync the other way)'
  else if (!force) action = 'skipped: the two copies diverged (both were continued); --force keeps a .bak of the target and overwrites it'
  else { action = 'overwritten (backup kept)'; if (!dry) fs.copyFileSync(dst, `${dst}.bak-${Date.now()}`); write(0, false) }
  let side = 0
  if (!action.startsWith('skipped')) {
    side = copyTree(path.join(s.projectDir, s.sid), path.join(dstDir, s.sid), dry)
    if (memory) side += copyTree(path.join(s.projectDir, 'memory'), path.join(dstDir, 'memory'), dry)
  }
  return { action, bytes, side }
}

async function cmdSync(state, pos, opt) {
  const target = opt.to ? accountByName(state, opt.to) : null
  const refs = pos.length ? pos : Object.keys(state.shared)
  if (!refs.length) die('nothing to sync: name sessions, or put some on the share list first (share <session> …)')
  const dry = Boolean(opt['dry-run'])
  for (const ref of refs) {
    let s; try { s = resolveSession(state, ref) } catch { s = null }
    if (!s) { console.log(`${String(ref).slice(0, 8)}  not found (deleted?)`); continue }
    if (opt.from && path.resolve(accountByName(state, opt.from).configDir) !== path.resolve(s.configDir)) {
      const src = allSessions(state).find(x => x.sid === s.sid && path.resolve(x.configDir) === path.resolve(accountByName(state, opt.from).configDir))
      if (src) s = src
    }
    const q = quickInfo(s.file, s)
    console.log(`${s.sid.slice(0, 8)}  "${oneLine(q.title || q.aiTitle || q.lastPrompt || '', 60)}"  ${tok(q.ctx)} tokens, ${whoText(state, q)}`)
    if (target && path.resolve(target.configDir) !== path.resolve(s.configDir)) {
      const r = copySession(s, target.configDir, { force: opt.force, dry, verify: opt.verify, memory: opt['with-memory'] })
      console.log(`  transcript → ${fwd(target.configDir)}: ${r.action}${r.bytes ? ` (${(r.bytes / 1e6).toFixed(1)} MB${r.side ? `, ${r.side} side files` : ''})` : ''}${dry ? ' [dry run]' : ''}`)
    } else console.log(`  transcript: both logins use ${fwd(s.configDir)}, so there is nothing to copy`)
    if (opt['no-pack']) continue
    const sh = state.shared[s.sid]
    if (sh?.lastPack && sh.lastPack.size === s.size && exists(sh.lastPack.path)) { console.log(`  pack: unchanged since ${iso(sh.lastPack.at)}: ${sh.lastPack.path}`); continue }
    const p = await makePack(state, s, opt)
    if (!dry) {
      fs.mkdirSync(path.dirname(p.out), { recursive: true }); fs.writeFileSync(p.out, p.text)
      if (sh) { sh.lastPack = { path: fwd(p.out), at: Date.now(), size: s.size }; saveState(state) }
    }
    console.log(`  pack: ${fwd(p.out)} (≈${tok(p.tokens)} tokens)${dry ? ' [dry run, not written]' : ''}`)
    for (const l of launchLines(p.d, p.out, target)) console.log(`  ${l}`)
  }
}

// ── wake: bring back sessions whose process is gone (a restart, a lost terminal), on the login in use

const WAKE_MODES = ['auto', 'handoff', 'resume']
/** A name for the session that carries on: the old one's own title, cut plainly. */
function wakeName(d, q) {
  const n = String(d?.title || d?.aiTitle || q.title || q.aiTitle || '').replace(/["`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return n ? n.slice(0, 60).trim() : null
}
/**
 * The line a session woken from a pack is started with (claude --append-system-prompt). It makes the session read
 * the pack on its first message and not before, so a woken tab costs nothing until it is used. No double quotes,
 * backticks or dollar signs: the text travels as one command-line argument through whatever shell opens the tab.
 * The line is part of the system prompt for as long as the process runs, so every conversation in it sees it, the
 * ones after a /clear too. Cache Keeper's Pack & Clear and Use Latest Handoff each run a /clear and put a brief of
 * their own in the new conversation's first prompt, and on 2026-11-20 such a conversation read the superseded pack
 * again (about 13k tokens). So the line holds only for the conversation the process started with. The engine records
 * a /clear at the start of the conversation it begins, as <command-name>/clear</command-name>, which is the tell.
 */
function wakeAppend(sid, name, pack) {
  const plain = String(name || '').replace(/["'`$\\\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  const who = plain ? `${sid.slice(0, 8)}, named '${plain}'` : sid.slice(0, 8)
  return `This session was started to carry on the work of an earlier Claude Code session (${who}) whose conversation is not loaded here. Its handoff is the file '${fwd(pack)}'. This holds only for the conversation the session started with: a conversation that begins with /clear (recorded at its start as <command-name>/clear</command-name>) has a brief of its own, and for it this pointer is spent, so do not read the file there unless that conversation asks for it. When the first message of this conversation arrives, read that file in full before you act on the message, then act on it with the handoff as the record of the work so far. Do this once: later in the conversation, also after a compaction, open the file again only when you need a detail from it.`
}
/**
 * How one closed session comes back: the whole conversation (resume), or a fresh session that reads a pack
 * (handoff). Unlike plan there is nothing to do on the old login first, because the process is gone.
 */
function wakeAdvice({ mode, q, ctx, floor, cache, same, c, own, packCtx }) {
  const base = { thin: false, compactFirst: false }
  if (ctx == null) return { ...base, route: 'resume', why: 'no request is recorded in it, so there is nothing to carry' }
  if (mode === 'resume') return { ...base, route: 'resume', why: 'a full resume was asked for' }
  if (packCtx >= ctx) return { ...base, route: 'resume', why: `it holds ${tok(ctx)}, no more than a fresh session with its handoff would (${tok(packCtx)})` }
  const thin = thinSummary(own)
  const sizes = `a fresh session sends ${tok(packCtx)} where a resume sends ${tok(ctx)}`
  if (mode === 'handoff') return { ...base, thin, route: 'handoff', why: `a handoff was asked for: ${sizes}` }
  if (q.post != null) return { ...base, route: 'resume', why: 'it was compacted and has not run since, so its next turn sends the summary, which is small already' }
  if (same === true && cache.warm) return { ...base, route: 'resume', why: `its cache on this login is warm for another ${Math.floor(cache.leftMs / 60e3)} min, so the whole conversation is read at the read price` }
  const ownTok = ctx - floor.tokens
  if (ownTok <= RESUME_UNDER) return { ...base, route: 'resume', why: `it holds ${tok(Math.max(ownTok, 0))} of its own above the ${tok(floor.tokens)} a fresh session starts with, so there is little to save` }
  if (thin) return { ...base, thin, compactFirst: arrivalPays(c), route: 'resume', why: `it has written nothing about itself ${own ? `in its last ${own.after} turns` : 'at all'}, so a handoff would rest on prompts and one-line results` }
  return { ...base, route: 'handoff', why: `its cache is ${same === false ? 'on another login' : 'cold'} and it has ${own.what}${own.after ? `, ${own.after} turn${own.after > 1 ? 's' : ''} before its end` : ''}: ${sizes}` }
}
function prunePacks(state) {
  const keys = Object.keys(state.packs)
  if (keys.length > 300) for (const k of keys) if (!exists(state.packs[k].path)) delete state.packs[k]
}
function wakeJson(state, r) {
  if (r.missing) return { sid: r.sid, missing: true, route: 'resume', why: r.why }
  const d = r.p?.d, name = wakeName(d, r.q), on = runsOn(r.q)
  const usdOf = t => Number(r.c.dollars(t).toFixed(2))
  return {
    sid: r.s.sid, name, shown: sessionName(r, 80), cwd: r.q.cwd || d?.cwd || null, model: r.model || null, effort: r.q.effort || null,
    lastTs: r.q.lastTs, live: r.live ? r.live.status : null,
    ctx: r.ctx, cache: cacheText(r.cache, r.same), login: on ? shortOwner(state, on) : null, sameLogin: r.same,
    route: r.advice.route, why: r.advice.why, thin: r.advice.thin, compactFirst: r.advice.compactFirst, auto: r.auto.route,
    // No pack was built in mode resume, so there is no handoff size to report, only the resume's.
    sends: r.c ? { resume: r.ctx, handoff: r.p ? r.packCtx : null } : null,
    usd: r.c ? { resume: usdOf(r.first.resume), handoff: r.p ? usdOf(r.first.handoff) : null } : null,
    pack: r.p ? { tokens: r.p.tokens, level: r.p.level, kind: r.p.kind, path: r.packPath || null, reused: Boolean(r.reused) } : null,
    append: r.packPath ? wakeAppend(r.s.sid, name, r.packPath) : null,
  }
}

async function cmdWake(state, pos, opt) {
  const mode = opt.mode || 'auto'
  if (!WAKE_MODES.includes(mode)) die(`--mode is one of: ${WAKE_MODES.join(', ')}`)
  const turns = Number(opt.turns || 10), budget = Number(opt.budget || 14000)
  const target = opt.to ? accountByName(state, opt.to) : null
  if (target && path.resolve(target.configDir) !== DEFAULT_DIR) die(`"${opt.to}" has its own config dir (${fwd(target.configDir)}). wake works inside one config dir: copy the sessions there (sync --to ${opt.to}), then run wake with CLAUDE_CONFIG_DIR set to it`)
  const login = loginOf(DEFAULT_DIR)
  const dest = target || login

  // Which sessions. Ids come from crestore by the dozen, so one that is gone is reported in its row, not fatal.
  let list
  if (pos.length) {
    const all = allSessions(state)
    list = pos.map(ref => {
      const low = String(ref).toLowerCase()
      if (!/^[0-9a-f-]{4,36}$/.test(low)) return resolveSession(state, ref)
      const hits = all.filter(s => s.sid.toLowerCase().startsWith(low)); const sids = new Set(hits.map(h => h.sid))
      return sids.size === 1 ? hits[0] : { missing: true, sid: ref, why: sids.size ? `"${ref}" matches ${sids.size} sessions` : 'no transcript found' }
    })
  } else {
    const lv = new Set(); for (const cd of configDirs(state)) for (const k of liveSessions(cd).keys()) lv.add(k)
    list = allSessions(state, { project: opt.project, sinceMs: Date.now() - duration(opt.since, 3 * 86400e3) }).filter(s => !lv.has(s.sid)).slice(0, Number(opt.limit || 40))
    if (!list.length) return console.log(opt.json ? asciiJson({ login: null, to: null, mode, turns, sessions: [] }) : 'No closed session was active in that window (--since 7d widens it).')
  }

  const lives = new Map(), rows = []
  for (const s of list) {
    if (s.missing) { rows.push(s); continue }
    const cd = s.configDir || configDirOf(s.file)
    if (!lives.has(cd)) lives.set(cd, liveSessions(cd))
    const live = lives.get(cd).get(s.sid) || null
    const q = quickInfo(s.file, s)
    const snap = liveSnap(cd, s.sid)
    const floor = await floorFor(state, s.projectDir || path.dirname(s.file))
    const cache = cacheState(q, snap)
    const model = q.model || snap?.model
    const ctx = ctxNow(q, floor)
    // The pack is built here, in memory: its real size decides, and it is cheap (no model call, one pass over the file).
    // A plain resume needs none, so that mode skips the pass and only marks the sessions a handoff could pay for.
    const p = ctx != null && mode !== 'resume' ? await makePack(state, s, { to: opt.to, budget: opt.budget, 'no-embed': opt['no-embed'], kind: 'auto' }) : null
    const same = p ? p.same : sameLogin(runsOn(q), dest)
    const own = p ? ownSummary(p.d, cd) : null
    const packTokens = p ? p.tokens : Number(opt.pack || 11000)
    const packCtx = floor.tokens + packTokens
    const warmHere = same === true && cache.warm
    const c = ctx != null ? costModel({ ctx, floor: floor.tokens, pack: packTokens, model, ttl: cache.ttl, turns, idle: idleCompaction(cd, q.cwd), warm: warmHere }) : null
    const first = c ? { resume: warmHere ? c.p.read * ctx : c.resume.first, handoff: c.fresh.first } : null
    const facts = { q, ctx, floor, cache, same, c, own, packCtx }
    const advice = wakeAdvice({ mode, ...facts })
    const large = ctx != null && q.post == null && !warmHere && ctx - floor.tokens > RESUME_UNDER
    const auto = mode === 'auto' ? advice : mode === 'resume' ? { route: large ? 'maybe' : 'resume' } : wakeAdvice({ mode: 'auto', ...facts })
    rows.push({ s, q, cd, live, floor, cache, model, ctx, p, same, own, c, first, packCtx, advice, auto })
  }

  if (opt.write) {
    const destFp = dest ? fp(dest) : '', boot = bootTime()
    let dirty = false
    for (const r of rows) {
      if (r.missing || r.advice.route !== 'handoff') continue
      // The same closed session, asked for twice (a second crestore run): its transcript has not changed, nor has its pack.
      const prev = state.packs[r.s.sid]
      if (prev && prev.size === r.s.size && prev.kind === r.p.kind && prev.dest === destFp && prev.budget === budget && prev.live === Boolean(r.p.live) && prev.at >= boot && exists(prev.path)) { r.packPath = prev.path; r.reused = true; continue }
      fs.mkdirSync(path.dirname(r.p.out), { recursive: true }); fs.writeFileSync(r.p.out, r.p.text)
      r.packPath = fwd(r.p.out)
      state.packs[r.s.sid] = { path: r.packPath, at: Date.now(), size: r.s.size, kind: r.p.kind, dest: destFp, budget, live: Boolean(r.p.live), tokens: r.p.tokens }
      dirty = true
    }
    if (dirty) { prunePacks(state); try { saveState(state) } catch { /* the index only saves writing a pack twice */ } }
  }

  if (opt.json) return console.log(asciiJson({ login: login ? { fp: fp(login), label: labelFor(state, login), plan: login.plan || null } : null, to: target ? target.name : null, mode, turns, sessions: rows.map(r => wakeJson(state, r)) }))

  const t = [['id', 'name', 'login', 'model', 'ctx', 'cache', 'last', 'a resume sends', 'a handoff sends', 'do']]
  let sumResume = 0, sumDo = 0, nHandoff = 0
  for (const r of rows) {
    if (r.missing) { t.push([String(r.sid).slice(0, 8), `(${r.why})`, '', '', '', '', '', '', '', '-']); continue }
    const $ = x => usd(r.c.dollars(x))
    t.push([r.s.sid.slice(0, 8), sessionName(r, 30), ownerCol(state, r.q), String(r.model || '?').replace(/^claude-/, ''), tok(r.ctx), `${cacheText(r.cache, r.same)}${r.live ? ` ${r.live.status}` : ''}`, ago(r.q.lastTs),
      r.c ? `${tok(r.ctx)} (${$(r.first.resume)})` : '?', r.p ? `${tok(r.packCtx)} (${$(r.first.handoff)})` : r.c ? '-' : '?',
      r.advice.route === 'handoff' ? `handoff${r.advice.thin ? ' (thin)' : ''}` : `resume${r.advice.compactFirst ? ', then /compact' : ''}`])
    if (!r.c) continue
    sumResume += r.c.dollars(r.first.resume); sumDo += r.c.dollars(r.advice.route === 'handoff' ? r.first.handoff : r.first.resume)
    if (r.advice.route === 'handoff') nHandoff++
  }
  console.log(table(t, { right: [4, 7, 8] }))
  console.log(`\n${rows.length} session${rows.length === 1 ? '' : 's'}, mode ${mode}. Logged in now: ${login ? ownerText(state, login) : '?'}${target ? `, planned for ${target.name}` : ''}. Dollars are the first turn at API prices; a subscription's limits are used in the same proportions.`)
  if (mode === 'resume') {
    const large = rows.filter(r => r.auto?.route === 'maybe').length
    console.log(`First turn of each, all resumed: ${usd(sumResume)}.${large ? ` ${large} of them ${large === 1 ? 'is' : 'are'} large and no longer cached: --mode auto builds ${large === 1 ? 'its pack' : 'their packs'} and says which would start smaller from a handoff.` : ''}`)
  } else console.log(`First turn of each:  all resumed ${usd(sumResume)}  ·  with the last column ${usd(sumDo)} (${nHandoff} from a handoff).`)
  if (!pos.length) console.log(`These are the closed sessions active in the last ${opt.since || '3d'}, the ones you ended yourself among them. crestore lists only those that did not end cleanly.`)
  console.log('resume: the whole conversation again, under its own session id. handoff: a fresh session that reads a pack on its first message, so it has a new id; the old conversation stays on disk and can still be resumed.')
  if (rows.some(r => r.advice?.compactFirst)) console.log('"resume, then /compact": it has too little in its own words for a handoff, and is large enough that a /compact before the first prompt pays.')
  if (rows.some(r => r.advice?.thin && r.advice.route === 'handoff')) console.log('"(thin)": the session wrote nothing about itself lately, so that pack rests on prompts, last messages and one-line results.')
  const say = r => `cd "${fwd(r.q.cwd || '.')}" && claude${wakeName(r.p?.d, r.q) ? ` -n "${wakeName(r.p?.d, r.q).replace(/[$\\]/g, ' ')}"` : ''} --append-system-prompt "${wakeAppend(r.s.sid, wakeName(r.p?.d, r.q), r.packPath)}"`
  if (opt.write) for (const r of rows) if (r.packPath) console.log(`\n${r.s.sid.slice(0, 8)}  pack${r.reused ? ' (unchanged, kept)' : ''}: ${r.packPath} (≈${tok(r.p.tokens)} tokens)\n  ${say(r)}`)
  if (rows.length === 1 && !rows[0].missing) {
    const r = rows[0]
    console.log(`\nWhy: ${r.advice.why}.`)
    console.log(`  full resume:  cd "${fwd(r.q.cwd || '.')}" && claude --resume ${r.s.sid}`)
    if (!r.packPath && r.advice.route === 'handoff') console.log(`  from a handoff:  add --write, and the pack is written and the command to start from it printed`)
  }
  console.log(`\nAfter a restart, crestore -From ${mode === 'resume' ? 'auto' : mode} does this for the sessions the restart closed, one tab each.`)
}

// ── show: small slices of a transcript, for looking a detail up without loading the conversation

function renderRecord(kind, j, extra, { maxChars = 700, results = true, brief = false } = {}) {
  const out = []
  const ts = j.timestamp ? j.timestamp.slice(5, 16).replace('T', ' ') : ''
  if (kind === 'prompt') out.push(`\n── #${extra.n} ${extra.kind} ${ts} ${'─'.repeat(20)}\n${brief && !PERSON.has(extra.kind) ? clip(extra.text, 1500) : extra.text}`)
  else if (kind === 'compact') out.push(`\n[compaction summary ${ts}]\n${clip(extra.text, brief ? 3000 : maxChars * 8)}`)
  else if (kind === 'notice') out.push(`[notice ${ts}] ${oneLine((j.message?.content || []).map(b => b.text || '').join(' '), 300)}`)
  else if (kind === 'system') { if (j.subtype === 'away_summary') out.push(`[recap ${ts}] ${j.content}`); else if (j.subtype === 'compact_boundary') out.push(`[context compacted ${ts}: ${tok(j.compactMetadata?.preTokens)} → ${tok(j.compactMetadata?.postTokens)}]`) }
  else if (kind === 'assistant') {
    for (const b of j.message?.content || []) {
      if (b.type === 'text' && b.text?.trim()) out.push(`\nassistant ${ts}:\n${b.text.trim()}`)
      // A question to the person is printed whole, every option with its description: it is short.
      else if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions) && b.input.questions.length) out.push(questionsLines(b.input.questions))
      else if (b.type === 'tool_use') out.push(`  ▸ ${toolLine(b.name, b.input)}`)
    }
  } else if (kind === 'tool_result' && results) {
    for (const b of j.message.content) if (b.type === 'tool_result') { const t = resultText(b).trim(); if (t) out.push(`  ◂ ${b.is_error ? 'ERROR ' : ''}${clip(t, maxChars).replace(/\n/g, '\n    ')}`) }
  }
  return out.join('\n')
}

const SHOW_CAP = 60000   // characters a lookup prints before it cuts: about 17k tokens

async function cmdShow(state, pos, opt, whole = false) {
  const s = resolveSession(state, pos[0] || '.')
  // `render` is for a reader that takes the whole thing: prompts, what the session said and one line per tool call.
  const look = { maxChars: opt.full ? Infinity : Number(opt['max-chars'] || (whole ? 300 : 700)), results: whole ? Boolean(opt.results) : true, brief: whole }
  if (opt.prompts || opt.files || opt.tools) {
    const d = await scan(s.file)
    if (opt.prompts) for (const t of d.turns) { if (!opt.all && !PERSON.has(t.kind)) continue; console.log(`#${t.n} ${t.kind} ${iso(t.ts)}\n${opt.full ? t.text : clip(t.text, 600)}\n`) }
    if (opt.files) for (const [f, v] of [...d.files.entries()].sort((a, b) => b[1].ts - a[1].ts)) console.log(`${String(v.n).padStart(3)}×  ${iso(v.ts)}  ${f}`)
    if (opt.tools) for (const [n, c] of [...d.tools.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(c).padStart(5)}  ${n}`)
    return
  }
  let from = 1, to = Infinity, lastN = 0, re = null
  if (opt.turn) { from = to = Number(opt.turn) }
  else if (opt.turns) { const m = /^(\d+)-(\d+)?$/.exec(opt.turns) || die('--turns a-b'); from = Number(m[1]); to = m[2] ? Number(m[2]) : Infinity }
  else if (opt.last) lastN = Number(opt.last)
  else if (opt.grep) { try { re = new RegExp(opt.grep, opt.case ? '' : 'i') } catch (e) { die(`bad --grep: ${e.message}`) } }
  else if (!whole) lastN = 2
  const ring = new Map(); let hits = 0; const maxHits = Number(opt.max || 30)
  const out = whole && opt.out ? fs.createWriteStream(path.resolve(opt.out)) : null
  const buf = []; let chars = 0
  const emit = text => { if (!text) return; chars += text.length + 1; if (out) out.write(`${text}\n`); else buf.push(text) }
  let cur = 0, curKind = ''
  await scan(s.file, (kind, j, n, extra) => {
    if (kind === 'prompt') { cur = n; curKind = extra.kind; extra = { ...extra, n } }
    if (re) {
      if (hits >= maxHits) return
      const text = renderRecord(kind, j, extra, { maxChars: Infinity })
      if (!text || !re.test(text)) return
      const lines = text.split('\n')
      lines.forEach((ln, i) => {
        if (hits >= maxHits || !re.test(ln)) return
        hits++
        emit(`#${cur} ${curKind || '-'} ${j.timestamp ? j.timestamp.slice(5, 16).replace('T', ' ') : ''} [${kind}]`)
        for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 1); k++) emit(`  ${k === i ? '›' : ' '} ${clip(lines[k], 400)}`)
      })
      return
    }
    if (cur < from && !lastN) return
    const text = renderRecord(kind, j, extra, look)
    if (!text) return
    if (lastN) { const a = ring.get(cur) || []; a.push(text); ring.set(cur, a); for (const k of ring.keys()) if (k < cur - lastN + 1) ring.delete(k); return }
    if (cur <= to) emit(text)
  })
  if (lastN) for (const k of [...ring.keys()].sort((a, b) => a - b)) for (const t of ring.get(k)) emit(t)
  if (out) { await new Promise(r => out.end(r)); console.error(`wrote ${fwd(path.resolve(opt.out))}: ${chars} chars, ≈${tok(estTokens(chars))} tokens`); return }
  // A lookup is meant to stay small. A long turn keeps its end for --last (the newest part) and its start otherwise.
  let text = buf.join('\n')
  if (!whole && !opt.full && !re && text.length > SHOW_CAP) {
    const note = `[${text.length} characters in all; ${lastN ? 'the end' : 'the start'} is shown. Narrow it with --grep, or add --full.]`
    text = lastN ? `${note}\n…${text.slice(-SHOW_CAP)}` : `${text.slice(0, SHOW_CAP)}…\n${note}`
  }
  if (text) console.log(text)
  if (re && !hits) console.log(`no match for /${opt.grep}/ in the main thread of ${s.sid.slice(0, 8)}`)
  if (re && hits >= maxHits) console.log(`… stopped at ${maxHits} matches (--max <n> for more)`)
}

const HELP = `acct-sync: carry Claude Code sessions from one account to another, cheaply.

  plan                         every running or shared session: what its next turn costs after a login change, and what to do first
  plan <session>               one session, path by path, with the cheapest way across that keeps its quality
  handoff <session> [--to A]   write a handoff pack for the next account (no model call). --ask: how to get the session's own handoff first.
                               --kind switch (the default) | restart | clear | auto: who reads it (clear: the conversation /clear
                               starts in the same process; Cache Keeper's Pack & Clear). <session> may be an engine export (.json)
  sync [<session> …] [--to A]  packs for the named (or shared) sessions; copies transcripts when A has its own config dir
                               (--from A, --dry-run, --with-memory, --verify, --force, --no-pack)
  wake [<session> …] [--mode auto|handoff|resume] [--write] [--to A]
                               sessions whose process is gone (a restart, a lost terminal): resume each whole, or start it fresh
                               from a pack. --write writes the packs and prints how to start from them. With no names: closed
                               sessions active in the last 3 days (--since, --limit, --project). crestore -From uses this
  share | unshare <session> …  keep a list of the sessions that matter on both accounts (sync with no names uses it); shared lists them
  ls [--project P] [--since 7d] [--owner A] [--live] [--shared] [--all-projects] [--limit N]
  show <session> --grep RE | --turn N | --turns A-B | --last N | --prompts | --files | --tools   [--full]
  render <session> --out F     prompts, the session's messages and one line per tool call, for a cheaper reader (--results adds tool output)
  accounts                     the logins sessions here have run on, and the one in use
  label <name> --current       name the login in use (or --owner <fingerprint>; --config-dir <dir> when it has its own)

A session is an id, a unique id prefix, a session name, or "." inside a running session. Most commands take --json.
It never changes a transcript and never reads credentials. README.md beside this file has the strategy and the measurements.
Settings, from the environment: CLAUDE_CONFIG_DIR, ACCT_SYNC_STATE, ACCT_SYNC_HANDOFF_COMMAND (README.md, Settings).`

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, opt } = parseArgs(rest)
  if (!cmd || cmd === 'help' || cmd === '--help' || opt.help) return console.log(HELP)
  const state = loadState()
  try { await run(state, cmd, pos, opt) } finally {
    if (IDX_DIRTY) { try { pruneIndex(); saveState({ ...readStateForMerge(state), idx: IDX }) } catch { /* the index is only a speed-up */ } }
  }
}
/** Another acct-sync may have written labels or the share list meanwhile: keep its copy of those, add our index. */
function readStateForMerge(state) { const disk = readJson(STATE_FILE); return disk ? { ...state, accounts: disk.accounts || state.accounts, shared: disk.shared || state.shared } : state }
async function run(state, cmd, pos, opt) {
  switch (cmd) {
    case 'accounts': return cmdAccounts(state, opt)
    case 'label': return cmdLabel(state, pos, opt)
    case 'ls': return cmdLs(state, opt)
    case 'plan': return cmdPlan(state, pos, opt)
    case 'handoff': return cmdHandoff(state, pos, opt)
    case 'sync': return cmdSync(state, pos, opt)
    case 'wake': return cmdWake(state, pos, opt)
    case 'share': return cmdShare(state, pos, true)
    case 'unshare': return cmdShare(state, pos, false)
    case 'shared': return cmdLs(state, { ...opt, shared: true, 'all-projects': true, since: opt.since || '365d' })
    case 'show': return cmdShow(state, pos, opt)
    case 'render': return cmdShow(state, pos, opt, true)
    default: die(`unknown command "${cmd}". Run it with no arguments for the list.`)
  }
}
main().catch(e => { console.error(`acct-sync: ${e.stack || e.message}`); process.exit(1) })
