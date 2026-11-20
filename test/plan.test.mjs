// plan and wake on a small synthetic projects folder (test/synth.mjs, planFixture): what each session's next turn
// costs, and what to do first.
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeHome, planFixture } from './synth.mjs'

let h, sids
before(() => {
  h = makeHome()
  ;({ sids } = planFixture(h))
  for (const n of ['small', 'bigcold', 'compacted', 'other']) h.run(['share', sids[n]])
})
after(() => h.cleanup())

describe('plan', () => {
  it('lists the running and shared sessions, each with what to do before a switch', () => {
    const rows = JSON.parse(h.run(['plan', '--json']))
    const act = Object.fromEntries(rows.map(r => [r.sid, r.advice.act]))
    assert.equal(rows.length, 5)
    assert.equal(act[sids.small], 'resume', 'small: about what a compaction would leave, nothing to save')
    assert.equal(act[sids.bigcold], 'pack', 'big and cold: a pack')
    assert.equal(act[sids.warm], 'warm', 'warm on its own login: /compact, then switch')
    assert.equal(act[sids.compacted], 'resume', 'compacted, nothing sent since: as it is')
    assert.equal(act[sids.other], 'pack', 'its requests ran on another login: a pack')
    assert.match(rows.find(r => r.sid === sids.other).advice.why, /another login/)
    assert.equal(rows.find(r => r.sid === sids.warm).live?.status, 'idle', 'the running session is seen as running')
  })

  it('prints the table and what one more turn in each costs', () => {
    const out = h.run(['plan'])
    assert.match(out, /^id +name +login +model +ctx +cache +next turn, as it is +\/compact first +via pack +do before the switch$/m)
    assert.match(out, new RegExp(`^${sids.warm.slice(0, 8)} .*/compact \\(by itself in \\d+m\\)$`, 'm'))
    assert.match(out, new RegExp(`^${sids.small.slice(0, 8)}\\* .* nothing$`, 'm'))
    assert.match(out, /One more turn in each: {2}where they are now \$[\d.]+ {2}· {2}after a login change, as they are \$[\d.]+/)
  })

  it('takes one session path by path, with the reason for the choice', () => {
    const out = h.run(['plan', sids.bigcold.slice(0, 8)])
    assert.match(out, /^resume the whole conversation +/m)
    assert.match(out, /^fresh session from a pack +/m)
    assert.match(out, /in its own words: the handoff it wrote at .*, 1 turn before the end/)
    assert.match(out, /^Do: pack \+ fresh session\. Why: its cache is already cold/m)
  })
})

describe('wake', () => {
  it('says which closed sessions to resume whole and which to start fresh from a pack', () => {
    const out = JSON.parse(h.run(['wake', '--json']))
    const by = Object.fromEntries(out.sessions.map(s => [s.sid, s]))
    assert.equal(out.mode, 'auto')
    assert.equal(by[sids.warm], undefined, 'a running session is not offered')
    assert.equal(by[sids.bigcold].route, 'handoff', 'large, cold, with a recent handoff of its own')
    assert.equal(by[sids.bigcold].pack.kind, 'restart', 'on the login it ran on: a restart pack')
    assert.ok(by[sids.bigcold].sends.handoff < by[sids.bigcold].sends.resume)
    assert.equal(by[sids.small].route, 'resume', 'little to save')
    assert.equal(by[sids.compacted].route, 'resume', 'compacted already')
    assert.equal(by[sids.other].route, 'resume', 'nothing in its own words: a pack would be thin')
    assert.equal(by[sids.other].thin, true)
    assert.equal(by[sids.other].pack.kind, 'switch', 'it last ran on another login: a switch pack')
  })
})
