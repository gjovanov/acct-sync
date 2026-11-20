# acct-sync

A command-line tool for Claude Code sessions. Before an account switch it tells you what each session's next turn
will cost on the other account and what to do first. After a restart it tells you which closed sessions to resume whole
and which to start fresh from a pack. A pack is a Markdown handoff that acct-sync builds from a session's transcript,
with no model call.

```sh
node ~/.claude/tools/account-sync/acct-sync.mjs <command>
```

One Node file, no dependencies. It reads transcripts and never changes one. It never reads or copies credentials. It
writes packs under `<config dir>/handoffs/<project>/acct/` and its own `state.json` beside the script. Only when you ask
for it, it also copies sessions between two config directories, and turns an engine export into a transcript beside it
([A session with no transcript](#a-session-with-no-transcript)).

## What it is for

| When | What it costs | What acct-sync does |
|---|---|---|
| You switch to another account (`/login`), or a usage limit makes you | The prompt cache belongs to one organization and one model. The first turn of each session you wake on the other account writes its whole context again, at the cache-write price. | `plan` lists every running session with that cost, and what to do on the old account first: `/compact`, a pack, or nothing. |
| The machine restarts (an update, a crash, a reboot) | Resuming a closed session sends its whole conversation again, uncached. | `wake` says which sessions to resume whole and which to start fresh from a pack, and writes those packs. [crestore](https://github.com/gjovanov/crestore) reopens them, one terminal tab each. |
| A running session's cache has gone cold | Its next turn rewrites everything. | `handoff --kind clear` builds a pack for the conversation `/clear` starts in the same process. [Cache Keeper](https://github.com/gjovanov/cache-keeper)'s Pack & Clear does that in one press. |

## Install

```sh
git clone https://github.com/gjovanov/acct-sync ~/.claude/tools/account-sync
node ~/.claude/tools/account-sync/acct-sync.mjs help
```

On Windows, in PowerShell:

```powershell
git clone https://github.com/gjovanov/acct-sync "$env:USERPROFILE\.claude\tools\account-sync"
```

That folder is where Cache Keeper looks for it (`<config dir>/tools/account-sync/acct-sync.mjs`). Any other folder works
for the commands themselves. `git pull` in the folder updates it; `state.json` is ignored by git and stays.

## Requirements

- **Node.js 18 or newer** (`node:test` for the tests; the script itself needs 16.6). Built and tested on Node 24.
- **Claude Code.** Written against the transcript format of Claude Code 2.1.322. That format is not a public interface:
  the script skips records it does not recognise, and a later release may change what it reads.
- **A terminal.** It prints tables and Markdown, and takes no input.

## Commands

A session is an id, a unique id prefix, a session name, a transcript's path, or `.` inside a running session (it reads
`CLAUDE_CODE_SESSION_ID`). Most commands take `--json`.

| Command | What it does |
|---|---|
| `plan` | Every running session, and every one on the share list: what its next turn costs as it is, after `/compact`, and through a pack, and what to do before a switch. `--to <label>` counts sessions still warm on that login as warm. `--turns <n>` (10) is the horizon for the comparison. |
| `plan <session>` | One session, path by path, with the reason for the choice. |
| `handoff <session>` | Write the pack (see [The pack](#the-pack)). `--kind switch\|restart\|clear\|auto` picks its wording (`switch`). `--print` writes it to stdout, `--out <file>` elsewhere, `--budget <tokens>` sets its size (14000). `--ask` prints how to get the session's own handoff first. `<session>` may be an engine export (`.json`, see [A session with no transcript](#a-session-with-no-transcript)). |
| `wake [<session>...]` | Sessions whose process is gone: which to resume whole and which to start fresh from a pack. `--mode auto\|handoff\|resume` (`auto`). `--write` writes those packs and prints the command that starts each one. With no names: the closed sessions of the last 3 days (`--since`, `--limit`, `--project`). |
| `sync [<session>...]` | Packs for the named sessions, or for the share list. With `--to <label>` for a login that has its own config directory, it copies the transcripts there too (see [Two config directories](#two-config-directories)). |
| `share` / `unshare` / `shared` | Keep a list of the sessions that matter on both accounts. `plan` and `sync` read it. |
| `ls` | Recent sessions of this project: login, model, context, cache state, what a cold resume and a pack would cost. `--all-projects`, `--live`, `--owner <label>`, `--since 7d`, `--limit <n>`. |
| `show <session>` | A small slice of a transcript: `--grep <regex>`, `--turn <n>`, `--turns <a>-<b>`, `--last <n>`, `--prompts`, `--files`, `--tools`, `--full`. A question the session put to the person prints whole. |
| `render <session> --out <file>` | Prompts, the session's messages and one line per tool call, for a cheaper reader. `--results` adds tool output. |
| `accounts` | The logins that sessions here have run on, and the one in use. |
| `label <name> --current` | Name the login in use. `--owner <fingerprint>` names another one, `--config-dir <dir>` one with its own directory. |

One example each:

```sh
acct-sync plan                                # before a switch: every running and shared session
acct-sync plan 5f3a                           # one session, by id prefix
acct-sync handoff 5f3a                        # write its pack: an account-switch pack by default
acct-sync handoff . --kind clear --json       # inside a session: a pack for the conversation /clear starts
acct-sync wake --write                        # after a restart: the plan for the closed sessions, and their packs
acct-sync sync --to work                      # packs (and copies) for the shared sessions, for the login labelled work
acct-sync share 5f3a 9c1e                     # put two sessions on the share list
acct-sync ls --since 7d                       # this project's sessions of the last week
acct-sync show 5f3a --grep "badge color"      # look a detail up without loading the conversation
acct-sync render 5f3a --out notes.md          # the conversation without tool output, for a subagent to read
acct-sync accounts                            # which logins sessions ran on
acct-sync label work --current                # name the login in use
```

Here `acct-sync` stands for `node ~/.claude/tools/account-sync/acct-sync.mjs`.

First use, once per login:

```sh
acct-sync label work --current                # while logged in to it
acct-sync accounts                            # the other logins, by fingerprint
acct-sync label personal --owner 3e7b         # the first characters of its fingerprint
```

A login is shown as its label or as eight hex characters: a hash of its organization id. The tool never prints an
address or an id.

## Before an account switch: `plan`

Another account starts with none of the prompt cache. So the first turn of every session you wake there writes the
whole context again, at 2x the input price on the one-hour cache (1.25x on the five-minute cache). A warm turn reads the
same tokens at 0.025x to 0.1x. That one cold write is nearly the whole cost of a switch. Measured on the author's
machine at one login change, the first turn of four sessions after it:

| Session | Context before | Written on the first turn after |
|---|---|---|
| 1 | 862k | 692k |
| 2 | 732k | 703k |
| 3 | 244k | 245k |
| 4 | 251k | 199k |

So the plan is about one thing: make what gets written small before it is written, and do not write for sessions you
are not going to use. Run `plan` before you change login. Its last column follows these rules:

| The session is | Do | It costs | What is kept |
|---|---|---|---|
| small enough that a compaction would save under 15% over the next ten turns | nothing: resume it as it is | 2x its context, once | everything |
| on its own login, cache warm | `/compact` as the last thing on that login, then switch and carry on in the same session | a cache read there, then about 2x the compacted size on arrival | the model's summary of the whole conversation; the session's name, tasks, schedules and background work |
| on its own login, but its account is at its limit or its cache is cold | `handoff` (no model call), then a fresh session that reads the pack, or `/clear` in the session | 2x a fresh session plus the pack | the person's prompts word for word, the last handoff or compaction summary the session wrote, where it stopped, what it left running |
| as above, but the pack would be thin (the session wrote nothing about itself for more than 12 turns) and the session is very large | resume, and run `/compact` before any prompt | at most 1.25x its context, once | a summary of the whole conversation |
| as above, but smaller | resume it as it is | 2x its context, once | everything |
| compacted, and not run since | nothing | 2x its compacted size, on any login | everything it had |
| last run on the destination, still inside its cache lifetime (`plan --to <label>`) | nothing | a cache read | everything |

A compaction is advised only where it saves at least 15% over the next ten turns. It trades detail for tokens, and below
that share the saving is inside the spread of what a compaction leaves behind.

`/compact` first, and not a pack, for a live session with a warm cache: the compaction reads the context at the
cache-read price, and the model writes the summary with all of it in view. That summary is better than anything a
script can assemble, and the session stays the same session. Do it as the last thing on the old login: a turn sent after
it writes the compacted context there, and then again on the new login. A pack is for when the old account cannot answer
(its limit is reached) or its cache is already cold, where a summary request would rewrite everything too.

Then, on the new login:

1. Wake one session and wait for its first words before waking the rest. About 34k tokens (system prompt and tools) are
   the same for every session of a project: the first session writes them, the others read them once that first
   answer has begun.
2. Leave asleep what you do not need. A closed session costs nothing until it is opened.
3. When a pack lacks a detail, look it up with `show` instead of resuming the old session: a slice is a few thousand
   tokens. For a broad question, `render` the conversation to a file and give that to a subagent on a cheaper model.
4. Going back to the first account inside its cache lifetime is cheap for a session that was not touched in between.
5. Keep the model and the speed the session ran on. Each model and each speed has its own cache.

On the author's machine, for 28 running sessions taking one more turn each: $44 where they were, $102 after a login
change as they were, $50 with the last column done first. Dollars are API prices throughout. On a subscription nothing is
billed per token, and how cache reads and writes count toward a plan's limits is not documented; the tool assumes the
same proportions.

Claude Code compacts an idle session by itself 54 minutes after its last request (90% of the one-hour cache lifetime)
when it holds 200k tokens or more, and `plan` shows the minutes left. Do not count on it before a switch: it is
skipped while the account is near its limit, which is the state an account is in shortly before a limit forces a
switch. `idleCompaction: false`, `autoCompactEnabled: false` and `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` in a session's
settings change it, and `plan` reads them.

## After a restart: `wake`

`wake` is for sessions whose process is gone: a restart, a crash, a closed terminal. It reads which login is in use and
plans each session for it. `--mode auto` decides per session:

| The session | Comes back as | Why |
|---|---|---|
| has its cache still warm on the login in use | resume | the conversation is read at the read price |
| was compacted and has not run since | resume | its next turn sends the summary, which is small already |
| holds under 70k of its own above what a fresh session starts with | resume | little to save, and everything is kept |
| would be no smaller as a fresh session with its pack | resume | nothing to save |
| wrote nothing about itself in its last 12 turns | resume, with `/compact` before the first prompt where that pays | a pack would rest on prompts and one-line results |
| is large, cold, and has a recent handoff, brief or compaction summary of its own | a fresh session from its pack | the pack is a fraction of the conversation |

On the author's machine, eight closed sessions of one project, first turn of each: $15.56 resumed, $6.70 with `auto`.
Four came back from a pack, and the largest of those went from 459k tokens ($3.67) to 78k ($0.62).

`wake --write` writes the packs and prints, for each, the command that starts a fresh session from it:
`claude -n "<name>" --append-system-prompt "<line>"`. The line tells the new session to read the pack when the first
message arrives, and not before, so a session you never use costs nothing. The line holds only for the conversation the
process started with: after a `/clear` it is spent. A second `wake --write` for a session that has not changed returns
the same pack.

A session started from a pack is a new session with an id of its own. The old conversation is untouched and can be
resumed at any time with `claude --resume <id>`.

## The pack

`handoff` builds it from the transcript without a model call. In order:

1. What the reader needs to know about its own position: the cache and the reasoning did not come along, the
   conversation is on disk, and how to look a detail up (`show`, `render`).
2. State: folder, branch, model, size, the logins the session ran on, and the pack it was itself started from.
3. Every prompt the person typed, word for word, including those typed while Claude worked. Claude Code records such a
   prompt inside the running turn as an attachment, not as a user record, and the pack reads it there. A command that
   Claude Code or a hook answered itself (`/clear`, `/model`, Cache Keeper's `/pack-and-clear`) asked the model nothing
   and is no turn.
4. The newest thing the session wrote about itself: a handoff document it wrote, a brief a plugin took from a fork of
   it, or failing those Claude Code's last compaction summary. The pack says how many turns came after it. See
   [What counts as a handoff](#what-counts-as-a-handoff).
5. Where it stopped: the last messages, tool calls with no result, a usage-limit stop, whether the process was still
   running, and whether the machine restarted after the session's last record.
6. A timeline, the files it edited, pull requests and commands that changed something outside, background work that
   never reported back, and its open task list.
7. What does not cross to the other account, listed only where the session used it.

A pack has one of three wordings:

| `--kind` | For | Title |
|---|---|---|
| `switch` (the default) | a session on another account | Account-switch handoff |
| `restart` | a fresh session on the same login, after the old process ended | Restart handoff |
| `clear` | the conversation `/clear` starts in the same process, once the old one's cache went cold (Cache Keeper's Pack & Clear) | Handoff after /clear |

`--kind auto` (what `wake` uses) picks `switch` when the session last ran on another login than the one in use, and
`restart` otherwise.

Packs go to `<config dir>/handoffs/<project>/acct/`, where `<project>` is the name of the session's folder. That is a
folder of their own, so anything that reads "the newest handoff" of a project never picks a pack up, and it is outside
every repository. `--out` puts one elsewhere. A pack that does not fit `--budget` is trimmed in up to three steps, and
`handoff` says so.

If the session's own account still answers and its cache is warm, get its own handoff first (`handoff --ask` prints
the two ways: your handoff command, or a prompt to send) and then run `handoff`: the pack is built around that file.

### A question the session was waiting on

When the session's last word was a question to the person (`AskUserQuestion`) that never got an answer, "Where it
stopped" opens with it, whole: each question with its header, whether several options may be picked, and every option
with its description, "(Recommended)" kept. The reader is told to take the answer from the person's message or to ask
again with the same options, and the top of the pack points at it. An option's preview is cut at 1500 characters, and
the pack then names the `show --turn` that prints it whole.

The question also counts as waiting when Cache Keeper held the answer: it ended the turn under the open dialog because
the cache was cold, so the answer never reached the model. The pack then says the person sends that answer as their next
message (Pack & Clear puts it in the fresh session's prompt). These signs are read only where they belong, on the
question's own result or a system line: the same words in another tool's output change nothing.

A question the conversation went past is not shown whole. One with a result counts as answered. One with no result (a
rewind can leave one) is listed with the other tool calls that have no result.

### A session with no transcript

Claude Code (2.1.322) writes no transcript for a process started with `CLAUDE_CODE_CHILD_SESSION` in its environment,
unless `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` is set too. A Claude Code session sets that variable for every command
it runs, so a `claude` started from inside one saves nothing, and `handoff`, `wake` and `/resume` cannot find it.

For such a session a plugin can hand over what the engine holds instead: `handoff <export>.json`. The export is

```
{ sessionId, cwd, configDir, exportedAt, startedAt, lastTurnAt, model, title, why, usage, handoffs, trimmed, messages }
```

with the messages as `$.session.messages({ as: 'api' })` returns them in a Claude Code hooks module. acct-sync writes
them out beside the export as `<sessionId>.jsonl` in transcript form, removes the export, and builds the pack from that
file, which `show` and `render` then take by its path. What it lacks: times (only the first and last record have one),
anything before the last compaction, the logins, and Claude Code's recaps. Cache Keeper's Pack & Clear does this when it
finds no transcript.

## With Cache Keeper, handoff-guard and crestore

Each of these works without the others.

- **[Cache Keeper](https://github.com/gjovanov/cache-keeper)** shows when a session's prompt cache goes cold. Once it is
  cold, its **Pack & Clear** button runs `acct-sync.mjs handoff <session> --kind clear --json` from
  `<config dir>/tools/account-sync/`, clears the session and puts a pointer to the pack in the prompt. Where Claude
  Code saved no transcript, it hands acct-sync an engine export instead. acct-sync reads Cache Keeper's snapshot of each
  session (`cache-keeper/live/<session>.json`) for the cache clock and the account's limits, and counts a brief saved in
  `cache-keeper/handoffs/` as the session's own handoff. Its Use Latest Handoff uses the same rule as acct-sync for
  what counts as a handoff.
- **[handoff-guard](https://github.com/gjovanov/handoff-guard)** keeps each session's handoff current: before `/exit`,
  `/clear` and `/resume`, near a usage limit, and when a restart tool asks. A pack is built around the newest handoff a
  session wrote, so with handoff-guard there is a current one to build on. handoff-guard leaves the `acct/` folders out,
  so a pack never makes a session's handoff current.
- **[crestore](https://github.com/gjovanov/crestore)** reopens the sessions a restart closed, one terminal tab each. With
  `-From auto` or `-From handoff` it runs `wake --json` for the plan and `wake --mode handoff --write --json` for the
  packs, and starts each pack's session with the line `wake` prints. Before a planned restart it can ask every open
  session for a fresh handoff through handoff-guard first.

## What does not cross to another account

| | After the switch |
|---|---|
| Prompt cache | none: it is per organization and per model |
| Reasoning | not usable. Claude Code says the earlier thinking was written under another organization and can be used again only there |
| Published pages | owned by the old account: an update is refused as if the page were deleted. Publish a new one from the same file |
| Remote Control, files sent to your devices | disconnected by a login change until turned on again |
| Chrome extension | paired with a claude.ai login: reconnect it with `/mcp` |
| claude.ai connectors, `/schedule` routines | tied to the claude.ai login, so the new account's |
| Usage windows | the other account's. Percentages and "wait until" notes in an old handoff do not apply |
| Schedules, background shells | live in the session's process. They survive a login change and a `/clear`, and fire on whatever login is current |

A pack lists the ones the session used.

Claude Code records two things about whose session it is. `session-owner` names the login that started the session, and
is not rewritten when another login continues it. A `credential_org` attachment names the organization whose credential
the requests use, and a new one is written when that changes, so the last one says where the session's cache is.
`ls` shows `a→b` when the two differ.

## Two config directories

The documented way to stay signed in to two accounts at once is one config directory each (Claude Code docs,
Authentication, "Log in with multiple accounts"):

```sh
alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'
```

Then a `/login` no longer moves every session on the machine. The price is that settings, skills, plugins, hooks, memory
and MCP sign-ins live under the directory and have to exist in both.

Label each login with its directory (`label work --current --config-dir ~/.claude-work`), and `sync --to <label>`
copies each session's transcript and its side folder into the other directory's `projects/<project>/`, and with
`--with-memory` the project's memory folder. The copy:

- stops at the last complete line, so a session that is being written can be copied;
- only ever extends the other copy. If the other copy is ahead, it is left alone; if both were continued, the two are
  reported as diverged and nothing is written. `--force` overwrites after keeping a `.bak-<time>` file;
- is skipped when the session is running in the target directory;
- compares the two ends of the files, and all of them with `--verify`. `--dry-run` writes nothing.

With one shared directory there is nothing to copy, and `sync` writes the packs. `wake` works inside one config
directory: copy the sessions first.

## Settings

All from the environment, with no file to edit.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config directory, the one acct-sync reads. The home folder is Node's `os.homedir()`: `USERPROFILE` on Windows, `HOME` elsewhere. |
| `ACCT_SYNC_STATE` | `state.json` beside the script | Where acct-sync keeps its state. |
| `ACCT_SYNC_HANDOFF_COMMAND` | `hub-handoff` | The slash command, without the slash, that has a session write its own handoff. `plan <session>` and `handoff --ask` name it. The default is the author's own skill and is not published: set yours, the same one as handoff-guard's `command` setting. |

Prices are a table at the top of the script, from Anthropic's published API prices as of 2026-11-03. A `prices.json`
beside the script overrides or extends them: `[["regex on the model id", {"in": 4, "read": 0.05}]]`, in dollars per
million input tokens.

### What counts as a handoff

These folder names are fixed. They are the ones Cache Keeper and handoff-guard use.

| Where | What counts |
|---|---|
| `<config dir>/handoffs/`, any subfolder | A Markdown file the session wrote, named for when it was written (`2026-01-31-0930-<slug>.md`), or with "handoff" in its name, or opening on a `# Handoff` heading. Not in an `acct/` folder: those hold packs. |
| `<config dir>/hub/`, any subfolder | A Markdown file the session wrote with "handoff" in its name. The author's orchestrator keeps its handoffs there; it is not published. |
| `<config dir>/cache-keeper/handoffs/`, `<config dir>/autohandoff/briefs/` | A brief a plugin took from a fork of the session: `<name>-<first 8 characters of the session id>.md`. The second folder belongs to a plugin of the author's that is not published. |

For the first two rows, the file's path must have a folder in it whose name starts with `.claude` (`.claude`, or
`.claude-work`): that is where Claude Code keeps its config unless `CLAUDE_CONFIG_DIR` names another folder. Most files
sessions write in those folders are side notes (PR bodies, step logs, drafts): only a handoff stands in for the
conversation.

## Files

| Path | What it holds |
|---|---|
| `acct-sync.mjs` | The tool. |
| `state.json` | Login labels with their account and organization ids, the share list, the measured size of a fresh session per project, which pack `wake` wrote for which session, and an index of which login each session ran on. No credentials. Not in git. |
| `prices.json` | Optional price overrides. |

It reads, under the config directory: transcripts (`projects/<project>/<session>.jsonl`) and their side folders, the
registry of running sessions (`sessions/`), the idle-compaction keys in `settings.json` (and in the project's
`.claude/settings.json` and `settings.local.json`), the session's task list (`tasks/<session>/`), Cache Keeper's
snapshots, and the handoffs above. It reads the login from Claude Code's `.claude.json` (inside the config directory, or
beside it in the home folder): the account and organization ids only. Nothing leaves the machine.

## The numbers and where they come from

The cost model's constants were measured on the author's machine (Claude Code 2.1.322, November 2026). Yours will
differ; `plan` measures the fresh-session size per project itself.

| Number | Value | Source |
|---|---|---|
| A fresh session's first turn | median 80.5k tokens | 39 recent sessions of one project. `plan` measures it per project and caches it for a week; with no measurement it assumes 60k |
| Shared by every session of a project | about 34k | the cache read on those first turns |
| Context after a compaction | median 142k, 62k above that session's fresh size | 116 compactions, at a median of 369k before |
| Cache write | 2x input (one hour), 1.25x (five minutes) | Anthropic's price list |
| Cache read | 0.025x (Fable 5.1, 5.2), 0.05x (Opus 5.5, Sonnet 5.5), 0.1x (others) | the same, as of 2026-11-03 |
| A compaction's own request | a cache read while the cache is warm; on a cold cache 1x to 1.25x | Claude Code docs, "How Claude Code uses prompt caching" |
| Cache scope | one organization, and inside it one model, one speed and one exact prefix | the same page |
| Compaction summary, session handoff | 6k and 3k output tokens | estimates |
| When a compaction is advised | it must save 15% over ten turns | the middle half of compactions leaves 115k to 163k: 24k either side of the median, about 13% of the next turn for a 190k session |

## Limits

- **Built and used on Windows 11**, from PowerShell and Git Bash. It has not been run on macOS or Linux. Nothing in it is
  Windows-only (paths go through Node's `path`, the home folder through `os.homedir()`, the boot time through
  `os.uptime()`), but nothing is proven there either. The tests have run on Windows only.
- **The transcript format is not a public interface.** The script was written against Claude Code 2.1.322.
- **A resume under a second login was not run for this tool.** The costs come from what transcripts recorded at earlier
  login changes. The copy between config directories was tested between two scratch directories with stand-in logins.
- **The restart note in a pack** is written only when the machine's uptime shows a boot after the session's last record.
  With Windows Fast Startup on, a shutdown and a power-on do not reset that clock, so such a pack reads as for a closed
  session.
- **Whether the idle-compaction timer of a running session notices a login change** is not established. Compacting or
  clearing the big sessions before the change removes the question.
- **A config directory whose name does not start with `.claude`**: the handoff documents sessions write there are not
  recognised ([What counts as a handoff](#what-counts-as-a-handoff)), so their packs rest on a brief or a compaction
  summary instead.

## Tests

```sh
node --test
```

runs 22 tests on synthetic transcripts, in a throwaway config directory per test file: nothing reads or writes your
real one. `test/synth.mjs` builds the transcripts; `node --test` lists it as a file of its own, with no tests in it.

- **Where it stopped**, for eleven shapes of a question to the person: open; answered; held by Cache Keeper, in its three
  record shapes; held, then answered, in two; the engine's turn-ended result with no line from Cache Keeper; and the same
  words on a Bash call, as its error or in its output, where they mean nothing.
- **The pack**: its three wordings, the person's prompts word for word (one typed mid-turn among them), a command
  Claude Code answered itself, an embedded handoff, a pack from an engine export, and `ACCT_SYNC_HANDOFF_COMMAND`.
- **plan** on a small projects folder (a small session, a large cold one with a handoff, a warm running one, a
  compacted one, one on another login) and **wake** on the same folder.

## License

MIT. See [LICENSE](LICENSE).
