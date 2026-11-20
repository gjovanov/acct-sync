// Synthetic Claude Code transcripts for the tests, in the record shapes Claude Code 2.1.322 writes. Nothing here comes
// from a real session: every id is made at run time, and every text is invented.
//
// Each test gets a throwaway home folder with its own `.claude` config folder, and runs acct-sync as a child process
// with USERPROFILE, HOME, CLAUDE_CONFIG_DIR and ACCT_SYNC_STATE pointing into it, so nothing reads or writes the real
// config folder.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'acct-sync.mjs')

/** A throwaway home folder: `<root>/home/.claude` is the config folder, `<root>/work/demo` the project folder. */
export function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-sync-test-'))
  const home = path.join(root, 'home')
  const config = path.join(home, '.claude')
  const cwd = path.join(root, 'work', 'demo')
  fs.mkdirSync(config, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const projectDir = path.join(config, 'projects', slug)
  fs.mkdirSync(projectDir, { recursive: true })
  const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: config, ACCT_SYNC_STATE: path.join(root, 'state.json') }
  delete env.ACCT_SYNC_HANDOFF_COMMAND
  delete env.CLAUDE_CODE_SESSION_ID
  return {
    root, home, config, cwd, projectDir, env,
    /** Run acct-sync with this home; returns stdout. `tool` runs another copy of the script on the same data. */
    run(args, { extraEnv = {}, tool = TOOL } = {}) {
      return execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 60_000 })
    },
    /** Write a transcript into the project folder; returns its path. */
    write(sid, records) {
      const file = path.join(projectDir, `${sid}.jsonl`)
      fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
      return file
    },
    /** The login Claude Code keeps in its global state file: ids only, made up. */
    login(organizationUuid) {
      fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: crypto.randomUUID(), organizationUuid, planDisplayName: 'Test plan' } }))
    },
    /** Claude Code's registry entry for a running session. The pid is this test process, which is alive. */
    running(sid, name) {
      fs.mkdirSync(path.join(config, 'sessions'), { recursive: true })
      fs.writeFileSync(path.join(config, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd, kind: 'interactive', status: 'idle', name }))
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }) },
  }
}

/** Builders for one session's records. `at(seconds)` is an ISO time `seconds` after `t0` (epoch ms). */
export function records({ sid, cwd, t0, model = 'claude-opus-5-5' }) {
  const base = { sessionId: sid, cwd, version: '2.1.322', gitBranch: 'main', userType: 'external', isSidechain: false }
  const at = s => new Date(t0 + s * 1000).toISOString()
  const usage = ctx => ({ input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: Math.max(0, ctx - 2070), output_tokens: 60, cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 } })
  let n = 0
  const id = () => `${++n}`
  return {
    at,
    prompt: (s, text) => ({ ...base, type: 'user', uuid: `u${id()}`, parentUuid: null, timestamp: at(s), message: { role: 'user', content: text } }),
    reply: (s, content, { ctx = 30000, stop = 'end_turn' } = {}) => {
      const k = id()
      return { ...base, type: 'assistant', uuid: `a${k}`, parentUuid: null, timestamp: at(s), requestId: `req_${k}`, message: { id: `msg_${k}`, type: 'message', role: 'assistant', model, stop_reason: stop, content, usage: usage(ctx) } }
    },
    text: t => ({ type: 'text', text: t }),
    tool: (toolId, name, input) => ({ type: 'tool_use', id: toolId, name, input }),
    result: (s, toolId, content, isError = false) => ({ ...base, type: 'user', uuid: `r${id()}`, parentUuid: null, timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, ...(isError ? { is_error: true } : {}), content }] } }),
    system: (s, subtype, content, extra = {}) => ({ ...base, type: 'system', subtype, uuid: `s${id()}`, parentUuid: null, timestamp: at(s), content, level: 'info', ...extra }),
    credential: (s, organizationUuid) => ({ ...base, type: 'attachment', uuid: `t${id()}`, parentUuid: null, timestamp: at(s), attachment: { type: 'credential_org', organizationUuid } }),
    queued: (s, text) => ({ ...base, type: 'attachment', uuid: `t${id()}`, parentUuid: null, timestamp: at(s), attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' } } }),
    compacted: (s, pre, post) => ({ ...base, type: 'system', subtype: 'compact_boundary', uuid: `s${id()}`, parentUuid: null, timestamp: at(s), content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post } }),
    title: t => ({ type: 'custom-title', customTitle: t, sessionId: sid }),
  }
}

// ── Claude's question (AskUserQuestion) and what can follow it: the cases a pack's "Where it stopped" must tell apart.

export const QUESTIONS = [{ question: 'Which color should the status badge be?', header: 'Badge', multiSelect: false, options: [{ label: 'Green', description: 'A green badge.' }, { label: 'Blue', description: 'A blue badge.' }] }]
// Cache Keeper's deny when it holds the answer, where an engine keeps it as the call's result.
export const DENY = 'Cache Keeper held the answer: the prompt cache was cold, so the turn was ended before the answer was read. The person sends it as their next message, here or in a fresh session.'
export const ANSWER = 'User has answered your questions: "Which color should the status badge be?"="Green". You can now continue with the user\'s answers in mind.'
// The engine's result for a call that a plugin's turn.abort cut short (2.1.322), and Cache Keeper's line before it.
export const TURN_ENDED = '[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]'
export const HELD_LINE = "cache-keeper: Cache Keeper held your answer to Claude's question (the cache was cold) and ended the turn: it is in the prompt."
export const PROMPT = 'Add a status badge to the README, and ask me which color it should be.'
const HELD_TEXT = 'My answer to its question:\nWhich color should the status badge be? Green'

export const QUESTION_CASES = {
  A: 'held: the deny is the question\'s result',
  B: 'open: the question has no result',
  C: 'held, then the person sent the answer',
  D: 'held: the deny as text blocks, no is_error',
  E: 'the deny\'s words in a Bash output',
  F: 'answered the ordinary way',
  G: 'the deny on a Bash call',
  R: 'held: Cache Keeper\'s line and the engine\'s turn-ended result',
  S: 'the turn ended, no line from Cache Keeper',
  T: 'the turn ended under a Bash call',
  U: 'R, then the person sent the answer',
}

/** One question case as transcript records. */
export function questionCase(kase, { sid, cwd }) {
  const r = records({ sid, cwd, t0: Date.parse('2026-11-20T17:00:00Z'), model: 'claude-haiku-5-5' })
  const ask = r.tool('toolu_1', 'AskUserQuestion', { questions: QUESTIONS })
  const out = [r.prompt(0, PROMPT)]
  const local = (s, name, stdout) => {
    const cmd = r.system(s, 'local_command', `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`)
    return [cmd, r.system(s, 'local_command', `<local-command-stdout>${stdout}</local-command-stdout>`, { parentUuid: cmd.uuid })]
  }
  switch (kase) {
    case 'A': out.push(r.reply(4, [ask], { stop: 'tool_use' }), r.result(200, 'toolu_1', DENY, true)); break
    case 'B': out.push(r.reply(4, [ask], { stop: 'tool_use' })); break
    case 'C': out.push(r.reply(4, [ask], { stop: 'tool_use' }), r.result(200, 'toolu_1', DENY, true), r.prompt(300, HELD_TEXT), r.reply(305, [r.text('Green it is.')])); break
    case 'D': out.push(r.reply(4, [ask], { stop: 'tool_use' }), r.result(200, 'toolu_1', [{ type: 'text', text: DENY }])); break
    case 'E': out.push(r.reply(4, [r.tool('toolu_2', 'Bash', { command: 'grep -n held README.md' })], { stop: 'tool_use' }), r.result(6, 'toolu_2', `README.md:132: ${DENY}`), r.reply(9, [r.text('Found it.')])); break
    case 'F': out.push(r.reply(4, [ask], { stop: 'tool_use' }), r.result(30, 'toolu_1', ANSWER), r.reply(33, [r.text('Green it is.')])); break
    case 'G': out.push(r.reply(4, [r.tool('toolu_2', 'Bash', { command: 'echo x' })], { stop: 'tool_use' }), r.result(6, 'toolu_2', DENY, true)); break
    case 'R':
    case 'U':
      out.push(
        r.reply(4, [ask], { stop: 'tool_use' }),
        r.system(158, 'informational', HELD_LINE),
        { ...r.result(158, 'toolu_1', TURN_ENDED, true), toolUseResult: TURN_ENDED, toolDenialKind: 'interrupted' },
        { type: 'attachment', sessionId: sid, timestamp: r.at(158), attachment: { type: 'hook_success' } },
        ...local(226, 'cache-keeper', 'Cache Keeper'),
        ...local(261, 'pack-and-clear', 'Pack & Clear: it runs once Claude is idle'),
        { type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: r.at(263), content: '/clear' },
        { type: 'queue-operation', operation: 'dequeue', sessionId: sid, timestamp: r.at(263) },
      )
      if (kase === 'U') out.push(r.prompt(300, HELD_TEXT), r.reply(305, [r.text('Green it is.')]))
      break
    case 'S': out.push(r.reply(4, [ask], { stop: 'tool_use' }), { ...r.result(158, 'toolu_1', TURN_ENDED, true), toolUseResult: TURN_ENDED, toolDenialKind: 'interrupted' }); break
    case 'T': out.push(r.reply(4, [r.tool('toolu_2', 'Bash', { command: 'sleep 60' })], { stop: 'tool_use' }), { ...r.result(30, 'toolu_2', TURN_ENDED, true), toolUseResult: TURN_ENDED, toolDenialKind: 'interrupted' }); break
    default: throw new Error(`no case ${kase}`)
  }
  return out
}

/**
 * A small projects folder for `plan` and `wake`: five sessions of one project, all on the login in use but one.
 * - small: 90k of context, about what a fresh session plus a compaction holds: nothing to save.
 * - bigcold: 480k, its cache long cold, with a handoff it wrote itself one turn before its end.
 * - warm: 300k, its last request 5 minutes ago, and its process running.
 * - compacted: compacted after its last request, nothing sent since.
 * - other: 400k, its requests last ran on another login.
 * All but the running one go on the share list, so that `plan` lists them.
 */
export function planFixture(h) {
  const org = crypto.randomUUID(), otherOrg = crypto.randomUUID()
  h.login(org)
  const now = Date.now(), hour = 3600e3
  const sids = { small: crypto.randomUUID(), bigcold: crypto.randomUUID(), warm: crypto.randomUUID(), compacted: crypto.randomUUID(), other: crypto.randomUUID() }
  const session = (name, { t0, ctx, cred, extra = () => [] }) => {
    const r = records({ sid: sids[name], cwd: h.cwd, t0 })
    const recs = [r.title(`demo ${name}`), r.credential(0, cred), r.prompt(1, `Work on the ${name} part of the demo.`), r.reply(5, [r.text(`Started on the ${name} part.`)], { ctx: Math.round(ctx * 0.6) })]
    recs.push(...extra(r))
    recs.push(r.prompt(600, `Carry on with the ${name} part.`), r.reply(610, [r.text(`The ${name} part is done.`)], { ctx }))
    return h.write(sids[name], recs)
  }
  session('small', { t0: now - 3 * hour, ctx: 90000, cred: org })
  // The handoff it wrote: a Markdown file under <config>/handoffs/<project>/, named for when it was written.
  const handoff = path.join(h.config, 'handoffs', 'demo', '2026-11-20-1200-demo-bigcold-handoff.md')
  fs.mkdirSync(path.dirname(handoff), { recursive: true })
  fs.writeFileSync(handoff, '# Handoff: demo bigcold\n\n## Goal\n\nFinish the bigcold part of the demo.\n\n## Next steps\n\n1. Run the tests.\n')
  session('bigcold', {
    t0: now - 6 * hour, ctx: 480000, cred: org,
    extra: r => [r.reply(300, [r.tool('toolu_w', 'Write', { file_path: handoff.replace(/\\/g, '/'), content: '# Handoff' })], { ctx: 400000, stop: 'tool_use' }), r.result(302, 'toolu_w', 'File created successfully'), r.reply(303, [r.text('Handoff written.')], { ctx: 401000 })],
  })
  session('warm', { t0: now - 910e3, ctx: 300000, cred: org })
  h.running(sids.warm, 'demo warm')
  const comp = records({ sid: sids.compacted, cwd: h.cwd, t0: now - 5 * hour })
  h.write(sids.compacted, [comp.title('demo compacted'), comp.credential(0, org), comp.prompt(1, 'Work on the compacted part of the demo.'), comp.reply(5, [comp.text('Done for now.')], { ctx: 350000 }), comp.compacted(60, 350000, 40000)])
  session('other', { t0: now - 4 * hour, ctx: 400000, cred: otherOrg })
  return { sids, handoff }
}

/** A pack's section by its heading, up to the next `## `. */
export function section(pack, heading) {
  const start = pack.indexOf(`\n## ${heading}\n`)
  if (start < 0) return null
  const next = pack.indexOf('\n## ', start + 4)
  return pack.slice(start + 1, next < 0 ? undefined : next)
}
