# rls-claude-usage

What did the Claude Code work on a project cost? This tool reads Claude Code's
local session transcripts, writes each session's cost into a **ledger file that
outlives the transcripts**, and reports the totals grouped by project tag,
project folder, month or day.

```text
$ rls-claude-usage
Ledger C:\Users\you\.rls-claude-usage\ledger.json — 2 new, 1 updated
Period 2026-10 (this month)

started           session      USD  tag      project  title
2026-10-02 09:12  3a9c55e0   4.22   Docs     docs     Docs | IT setup
...
2026-10-15 12:37  b41e9d07   2.06   Webshop  website  Webshop | Checkout - first attempt
2026-10-19 11:07  7f3c2a91  11.47*  Webshop  website  Webshop | Checkout - second attempt

tag         sessions    USD  first       last
Webshop            3  15.05  2026-10-12  2026-10-19
(untagged)         4   9.61  2026-10-08  2026-10-19
Docs               1   4.22  2026-10-02  2026-10-02
total              8  28.88
```

No dependencies — Node.js 18.18 or newer is all it needs. Works on Windows,
macOS and Linux, from any folder.

## Install

```bash
npm install -g github:RLS-Marketing/rls-claude-usage
rls-claude-usage install-hook
```

Or from a clone, if you want to change it:

```bash
git clone https://github.com/RLS-Marketing/rls-claude-usage.git
cd rls-claude-usage
npm link
rls-claude-usage install-hook
```

`install-hook` adds a `SessionEnd` hook to your Claude Code user settings
(`~/.claude/settings.json`; a backup is written next to it as
`settings.json.bak`). From then on every Claude Code session is written to the
ledger when it ends. Without the hook, the ledger is only updated when you run
the tool — which is fine as long as you run it at least once every few weeks
(see [Why a ledger](#why-a-ledger)).

Check what is where:

```bash
rls-claude-usage where
```

Update: run the same `npm install -g …` again (or `git pull` in the clone). If
you moved the clone, run `install-hook` again so the hook points at the new
location. Remove: `rls-claude-usage uninstall-hook`, then
`npm uninstall -g rls-claude-usage`. The ledger stays in
`~/.rls-claude-usage/` until you delete it.

## Tag your sessions

The project a session belongs to is the **tag at the start of its title** —
the name in the Claude app's sidebar (or set with `/rename` in the CLI) — up to
the first `|`:

| Title                                  | Tag          |
|----------------------------------------|--------------|
| `Webshop \| Checkout - second attempt` | `Webshop`    |
| `Docs \| IT setup`                     | `Docs`       |
| `Sentry issues`                        | (untagged)   |

Rules of thumb:

- **One project per session.** A session that mixed two projects can't be split
  afterwards. Start a new session when you switch, or rename the session after
  the project it mostly served.
- Tags are case-insensitive: `webshop` and `Webshop` are one tag.
- Renaming a session re-tags it at the next sync, as long as Claude Code still
  has its transcript. For an older session, set the tag by hand:
  `rls-claude-usage retag 7f3c2a91 "Webshop"` (`""` returns to the title's tag).

Don't want tags? `--title` matches any part of the title (and nothing else);
`--search` matches any part of the title, the project path or the session id.

## Use

```bash
rls-claude-usage                          # this month: every session, then totals per tag
rls-claude-usage --tag Webshop            # one project
rls-claude-usage --tag "Webshop,Docs"     # several
rls-claude-usage --tag untagged           # sessions still to be tagged
rls-claude-usage --title checkout         # title (only) contains "checkout"
rls-claude-usage --search checkout        # title / project path / id contains "checkout"
rls-claude-usage --project website        # sessions run in a folder whose path contains "website"

rls-claude-usage summary --this-year --by month   # totals only: by tag | project | month | day
rls-claude-usage summary --all --by month --tag Webshop
rls-claude-usage list --tag Webshop       # sessions only

rls-claude-usage list --csv --out october.csv --month 2026-10   # for Excel / sharing
rls-claude-usage summary --json                                 # for scripts
```

### Period

Without a period option, `report`, `summary` and `list` cover **the current
month**. Pick one of (local time):

| Option                | Period                                            |
|-----------------------|---------------------------------------------------|
| `--this-month`        | the current calendar month (the default)          |
| `--last-month`        | the previous calendar month                       |
| `--month 2026-07`     | any month                                         |
| `--this-year`         | the current calendar year, 1 January to today     |
| `--last-year`         | the previous calendar year                        |
| `--year 2025`         | any calendar year                                 |
| `--last-12-months`    | the current month and the 11 before it            |
| `--all`               | all history                                       |
| `--since` / `--until` | any range, `YYYY-MM-DD` (either end may be open)  |

`--session <id>` looks in all history unless a period is given.

With a year-long period (the year options, `--last-12-months`, `--all`,
`--since/--until`), **`--monthly`** replaces the session list with one row per
tag and one column per month (`--by project` for project folders; `--csv` and
`--json` work too):

```bash
rls-claude-usage --this-year --monthly
rls-claude-usage --last-12-months --monthly --by project
rls-claude-usage --year 2025 --monthly --csv --out 2025.csv
```

```text
tag        2026-01  ...  2026-09  2026-10  2026-11   total
Webshop          ·  ...        ·    51.37    83.68  135.05
Docs             ·  ...     4.22    10.35        ·   14.56
total            ·  ...     4.22    61.72    83.68  149.61
```

Every command first syncs the ledger with the transcripts (fast: only sessions
whose files changed are re-read). Add `--no-sync` to read the ledger as it is.
`rls-claude-usage --help` lists every option.

### Several people

The ledger is per user and per computer — each person runs the tool on their own
machine. For a team total, everyone exports a CSV for the period
(`list --csv --month 2026-10 --tag Webshop --out webshop-2026-10-<name>.csv`)
and the files are added up in a spreadsheet.

## Where the numbers come from

For each session the ledger stores two figures; `usd` is the one reported.

- **`claude-code`** — the cost Claude Code itself records in the transcript (the
  same figure as its cost display). It includes calls that do not show up as
  messages (compaction, side queries), so it is the more complete one. Claude
  Code writes it while a session runs and when it ends.
- **`computed`** — summed from the token usage of every model call in the
  session and its subagents, at the list prices in [`lib/prices.mjs`](lib/prices.mjs):
  input, output, cache reads, cache writes (1.25× input for a 5-minute TTL, 2×
  for 1-hour), and web searches ($10 per 1,000). Used only when there is no
  Claude Code figure — a session that is still open, or one from an older Claude
  Code version that did not record one. Marked `*` in the list. It tends to run
  slightly under the Claude Code figure.

A model missing from `lib/prices.mjs` is never counted as zero silently: the
session is marked `!` and the model named. Add its prices from the
[pricing page](https://platform.claude.com/docs/en/about-claude/pricing).

**These are list prices.** Included usage of a subscription or Enterprise seat,
and any discount, are not modelled — read the totals as an upper bound on what
extra usage costs, and reconcile against the billing in the Claude admin
console, which is per user, not per project.

## Why a ledger

Claude Code keeps transcripts only for `cleanupPeriodDays` (30 days by default)
and then deletes them — and with them the only record of what a session cost.
The ledger keeps one entry per session forever: entries are added and updated,
never removed. When a transcript disappears, its entry is kept and marked
`"transcript": "gone"`.

The ledger is `~/.rls-claude-usage/ledger.json` (move it with `--ledger <file>`
or the `RLS_CLAUDE_USAGE_LEDGER` environment variable). It holds, per session:
id, title, working directory, start and end time, both cost figures, number of
calls, tokens, models and subagents. **It holds no conversation content.** Back
it up like any other file you'd hate to lose.

Transcripts are read from `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`).

## Development

```bash
npm test
```

The tests build throwaway transcripts in a temp folder; they never touch your
real `~/.claude` or ledger.
