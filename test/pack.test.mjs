// The pack: what `handoff` builds from a transcript, without a model call. Synthetic transcripts only (test/synth.mjs).
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { makeHome, planFixture, questionCase, records, section, PROMPT, QUESTION_CASES, QUESTIONS } from './synth.mjs'

let h
before(() => { h = makeHome() })
after(() => h.cleanup())

/** Build one question case and return its pack, as Cache Keeper's Pack & Clear asks for it (`--kind clear`). */
function packOf(kase, kind = 'clear') {
  const sid = crypto.randomUUID()
  const file = h.write(sid, questionCase(kase, { sid, cwd: h.cwd }))
  return { sid, pack: h.run(['handoff', file, '--kind', kind, '--print']) }
}

// What "Where it stopped" must say in each case. waiting: the question comes first, whole, and the reader is told to get
// the answer; held: Cache Keeper held the answer, which the person sends next; open: no answer reached it; ended: the
// last turn ran to its end; unanswered: the last prompt has no answer; error: the tool error listed.
const EXPECT = {
  A: { waiting: true, held: true },
  B: { waiting: true, open: true },
  C: { ended: '#2' },
  D: { waiting: true, held: true },
  E: { ended: '#1' },
  F: { ended: '#1' },
  G: { unanswered: true, error: 'Bash: Cache Keeper held the answer' },
  R: { waiting: true, held: true },
  S: { waiting: true, open: true },
  T: { unanswered: true, error: 'Bash: [Tool call did not complete' },
  U: { ended: '#2' },
}

describe('Where it stopped', () => {
  for (const [kase, name] of Object.entries(QUESTION_CASES)) {
    it(`${kase}: ${name}`, () => {
      const { pack } = packOf(kase)
      const stop = section(pack, 'Where it stopped')
      assert.ok(stop, 'the pack has a "Where it stopped" section')
      const e = EXPECT[kase]
      const block = stop.includes('**Question: Badge** (pick one)') && stop.includes(`> ${QUESTIONS[0].question}`)
        && stop.includes('- **Green**: A green badge.') && stop.includes('- **Blue**: A blue badge.')
      assert.equal(/waiting on the person's answer to a question/.test(stop), Boolean(e.waiting), 'waiting on the question')
      assert.equal(block, Boolean(e.waiting), 'the question shown whole, every option with its description')
      assert.equal(/Cache Keeper held the person's answer at /.test(stop), Boolean(e.held), 'held by Cache Keeper')
      if (e.held) assert.match(stop, /The person sends that answer as their next message\./)
      assert.equal(/No answer reached it, so nothing after it ran\./.test(stop), Boolean(e.open), 'no answer reached it')
      assert.equal(/ran to its end at/.test(stop), Boolean(e.ended), 'the last turn ran to its end')
      if (e.ended) assert.match(stop, new RegExp(`The last turn \\(${e.ended}\\) ran to its end`))
      assert.equal(/The last prompt \(#1, human\) has no answer in the transcript\./.test(stop), Boolean(e.unanswered), 'the last prompt has no answer')
      assert.equal(stop.includes('Last tool errors:'), Boolean(e.error), 'tool errors listed')
      if (e.error) assert.ok(stop.includes(e.error), `the error names ${e.error}`)
      // A question's own result is never a tool error, and the question is never "a call with no result".
      assert.doesNotMatch(stop, /AskUserQuestion: (Cache Keeper held the answer|\[Tool call did not complete)/)
      assert.doesNotMatch(stop, /tool calls? (have|has) no result/)
      // The top of the pack points at a waiting question too.
      assert.equal(pack.includes('It stopped on a question to the person that has no answer yet.'), Boolean(e.waiting))
    })
  }
})

describe('the pack', () => {
  it('words itself for who reads it: a switch, a restart, or the conversation /clear starts', () => {
    const cases = [
      ['switch', '# Account-switch handoff: ', 'What does not cross to this account'],
      ['restart', '# Restart handoff: ', 'What a fresh session does not have'],
      ['clear', '# Handoff after /clear: ', 'What a fresh session does not have'],
    ]
    for (const [kind, title, lost] of cases) {
      const { sid, pack } = packOf('F', kind)
      assert.ok(pack.startsWith(title), `${kind}: its title`)
      assert.ok(pack.includes(`<!-- acct-sync pack: session=${sid} kind=${kind} -->`), `${kind}: the marker a later pack follows back`)
      assert.ok(section(pack, lost), `${kind}: ${lost}`)
      for (const s of ['For the session that picks this up', 'State', 'What the person asked, in their words', 'Where it stopped']) assert.ok(section(pack, s), `${kind}: ${s}`)
    }
  })

  it('keeps the person\'s prompts word for word, one typed while Claude worked among them', () => {
    const sid = crypto.randomUUID()
    const r = records({ sid, cwd: h.cwd, t0: Date.parse('2026-11-20T10:00:00Z') })
    const file = h.write(sid, [
      r.prompt(0, PROMPT),
      r.reply(5, [r.tool('toolu_1', 'Bash', { command: 'ls' })], { stop: 'tool_use' }),
      // Claude Code delivers a prompt typed during a turn inside the turn, as an attachment, never as a user record.
      r.queued(8, 'Make it blue, and keep it small.'),
      r.result(9, 'toolu_1', 'README.md'),
      r.reply(12, [r.text('A small blue badge is in.')]),
    ])
    const asked = section(h.run(['handoff', file, '--kind', 'restart', '--print']), 'What the person asked, in their words')
    assert.ok(asked.includes(`> ${PROMPT}`))
    assert.ok(asked.includes('> Make it blue, and keep it small.'))
  })

  it('counts no turn for a command Claude Code answered itself', () => {
    const sid = crypto.randomUUID()
    const r = records({ sid, cwd: h.cwd, t0: Date.parse('2026-11-20T10:00:00Z') })
    const cmd = { ...r.prompt(60, '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'), uuid: 'cmd-1' }
    const file = h.write(sid, [
      r.prompt(0, PROMPT),
      r.reply(5, [r.text('Done: the badge is green.')]),
      cmd,
      r.system(61, 'local_command', '<local-command-stdout>Kept model as Opus</local-command-stdout>', { parentUuid: 'cmd-1' }),
    ])
    const stop = section(h.run(['handoff', file, '--kind', 'clear', '--print']), 'Where it stopped')
    assert.match(stop, /The last turn \(#1\) ran to its end/)
    assert.doesNotMatch(stop, /has no answer/)
  })

  it('embeds the handoff the session wrote, its headings two levels down', () => {
    const { sids, handoff } = planFixture(h)
    const pack = h.run(['handoff', sids.bigcold, '--kind', 'restart', '--print'])
    const own = section(pack, 'Handoff the session wrote')
    assert.ok(own, 'the section is there')
    assert.ok(own.includes(handoff.replace(/\\/g, '/')), 'it names the file')
    assert.match(own, /The session went on after writing it \(\d+ min, 1 more turn, 1 of them from the person\)/)
    assert.ok(own.includes('#### Goal') && own.includes('Finish the bigcold part of the demo.'))
  })

  it('builds from an engine export when no transcript was saved, and turns it into a transcript beside it', () => {
    const sid = crypto.randomUUID()
    const dir = path.join(h.config, 'cache-keeper', 'exports')
    fs.mkdirSync(dir, { recursive: true })
    const exp = path.join(dir, `${sid}.json`)
    fs.writeFileSync(exp, JSON.stringify({
      sessionId: sid, cwd: h.cwd, configDir: h.config, exportedAt: Date.parse('2026-11-20T12:00:00Z'),
      startedAt: Date.parse('2026-11-20T11:00:00Z'), lastTurnAt: Date.parse('2026-11-20T11:30:00Z'),
      model: 'claude-opus-5-5', title: 'demo export', why: 'CLAUDE_CODE_CHILD_SESSION is set',
      messages: [
        { role: 'user', content: PROMPT },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: QUESTIONS } }] },
      ],
    }))
    const out = JSON.parse(h.run(['handoff', exp, '--kind', 'clear', '--json']))
    const jsonl = path.join(dir, `${sid}.jsonl`)
    assert.ok(fs.existsSync(jsonl), 'the transcript form is written beside the export')
    assert.ok(!fs.existsSync(exp), 'the export is removed')
    const pack = fs.readFileSync(out.pack, 'utf8')
    assert.match(pack, /Claude Code saved no transcript/)
    assert.match(section(pack, 'Where it stopped'), /waiting on the person's answer to a question/)
    assert.ok(path.resolve(out.pack).startsWith(path.join(h.config, 'handoffs', 'demo', 'acct') + path.sep), 'the pack goes to <config>/handoffs/<project>/acct/')
  })

  it('names the handoff command from ACCT_SYNC_HANDOFF_COMMAND in handoff --ask', () => {
    const { sid } = packOf('F')
    assert.match(h.run(['handoff', sid, '--ask']), /^ {2}\/hub-handoff$/m)
    assert.match(h.run(['handoff', sid, '--ask'], { extraEnv: { ACCT_SYNC_HANDOFF_COMMAND: '/session-handoff' } }), /^ {2}\/session-handoff$/m)
  })
})
