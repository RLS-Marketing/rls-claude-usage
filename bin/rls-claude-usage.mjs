#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultLedgerPath, loadLedger, saveLedger, syncLedger } from '../lib/ledger.mjs';
import { installHook, uninstallHook, hookStatus, settingsPath } from '../lib/hook.mjs';
import { projectsDir } from '../lib/transcripts.mjs';
import { filterSessions, formatGroups, formatMonthly, formatSessions, groupSessions, GROUPS, monthlyBreakdown, monthlyCsv,
  toCsv, toJson } from '../lib/report.mjs';
import { resolvePeriod } from '../lib/period.mjs';

const HELP = `rls-claude-usage — a permanent ledger of what your Claude Code sessions cost

Usage: rls-claude-usage [command] [options]

Commands
  report            (default) the sessions, then totals per tag — this month
  summary           totals only
  list              sessions only
  sync              update the ledger from the transcripts, print nothing else
  retag <id> <tag>  set a session's tag by hand ("" to go back to the title's tag)
  install-hook      add a SessionEnd hook to Claude Code that runs "sync"
  uninstall-hook    remove it
  where             print the ledger, transcript and settings paths

Period (report, summary, list) — one of; default --this-month
  --this-month      the current calendar month
  --last-month      the previous calendar month
  --month <YYYY-MM> any month
  --this-year       the current calendar year, 1 January to today
  --last-year       the previous calendar year
  --year <YYYY>     any calendar year
  --last-12-months  the current month and the 11 before it
  --all             all history
  --since <date>    started on or after YYYY-MM-DD (local time)
  --until <date>    started on or before YYYY-MM-DD
  --monthly         with a year-long period (the year options, --all, --since/--until):
                    totals per tag and month instead of the sessions

Filters (report, summary, list)
  --tag <a,b>       sessions with this tag — the title before the first "|"
                    ("Webshop | Checkout" has tag "Webshop"); "untagged" for none
  --search <text>   title, project path or session id contains the text
  --title <text>    title contains the text (the title only, anywhere in it)
  --project <text>  project path contains the text
  --session <id>    session id starts with this (searches all history unless a
                    period is given)

Output
  --by <key>        group totals by ${GROUPS.join(' | ')} (default tag;
                    with --monthly: tag | project)
  --csv, --json     machine-readable output (sessions; with "summary", the totals)
  --out <file>      write the output to a file instead of the terminal

Other
  --no-sync         read the ledger as it is, without scanning transcripts
  --ledger <file>   ledger location (default ~/.rls-claude-usage/ledger.json,
                    or RLS_CLAUDE_USAGE_LEDGER)
  --quiet           no output (for the hook)
  -h, --help        this text
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: 'string' }, search: { type: 'string' }, title: { type: 'string' }, project: { type: 'string' },
      session: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
      month: { type: 'string' }, year: { type: 'string' }, 'this-month': { type: 'boolean' },
      'last-month': { type: 'boolean' }, 'this-year': { type: 'boolean' }, 'last-year': { type: 'boolean' },
      'last-12-months': { type: 'boolean' }, all: { type: 'boolean' }, monthly: { type: 'boolean' }, by: { type: 'string', default: 'tag' },
      csv: { type: 'boolean' }, json: { type: 'boolean' }, out: { type: 'string' },
      'no-sync': { type: 'boolean' }, ledger: { type: 'string' }, quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  fail(`${e.message}\nRun "rls-claude-usage --help" for usage.`);
}
const { values: o, positionals } = parsed;
const [command = 'report', ...rest] = positionals;
const ledgerFile = o.ledger ?? defaultLedgerPath();

function fail(msg) {
  console.error(`rls-claude-usage: ${msg}`);
  process.exit(1);
}

function emit(text) {
  if (o.quiet) return;
  if (o.out) {
    fs.writeFileSync(o.out, text.endsWith('\n') ? text : text + '\n');
    console.error(`wrote ${o.out}`);
  } else {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  }
}

function openLedger({ sync = !o['no-sync'] } = {}) {
  const ledger = loadLedger(ledgerFile);
  let stats = null;
  if (sync) {
    stats = syncLedger(ledger, projectsDir());
    if (stats.added || stats.updated || stats.gone || !fs.existsSync(ledgerFile)) saveLedger(ledgerFile, ledger);
  }
  return { ledger, stats };
}

function syncNote(stats) {
  if (!stats) return 'not synced (--no-sync)';
  const parts = [`${stats.added} new`, `${stats.updated} updated`];
  if (stats.gone) parts.push(`${stats.gone} transcripts deleted by Claude Code (kept in the ledger)`);
  return parts.join(', ');
}

if (o.help || command === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}

for (const k of ['since', 'until']) {
  if (o[k] && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) fail(`--${k} ${o[k]}: expected YYYY-MM-DD`);
}
if (!GROUPS.includes(o.by)) fail(`--by ${o.by}: expected one of ${GROUPS.join(', ')}`);
if (o.csv && o.json) fail('--csv and --json: pick one');
let period;
try {
  period = resolvePeriod(o);
} catch (e) {
  fail(e.message);
}
if (o.monthly && !period.yearly) fail(`--monthly: needs a year-long period (--this-year, --last-year, --year, --last-12-months, --all, --since/--until), not ${period.label}`);
if (o.monthly && !['tag', 'project'].includes(o.by)) fail(`--monthly --by ${o.by}: expected tag or project`);

switch (command) {
  case 'report':
  case 'summary':
  case 'list': {
    const { ledger, stats } = openLedger();
    const sessions = filterSessions(ledger, { ...o, since: period.since, until: period.until });
    const header = `Ledger ${ledgerFile} — ${syncNote(stats)}\nPeriod ${period.label}`;
    if (o.monthly) {
      const b = monthlyBreakdown(sessions, o.by, period.since?.slice(0, 7), period.until?.slice(0, 7));
      if (o.json) emit(JSON.stringify(b.rows, null, 2));
      else if (o.csv) emit(monthlyCsv(b));
      else if (!sessions.length) emit(`${header}\n\nNo sessions match.`);
      else emit(command === 'report' ? `${header}\n\n${formatMonthly(b)}` : formatMonthly(b));
    } else if (command === 'summary') {
      const groups = groupSessions(sessions, o.by);
      if (o.json) emit(JSON.stringify(groups, null, 2));
      else if (o.csv) emit([`${o.by},sessions,usd,first,last`, ...groups.map((g) => [g[o.by], g.sessions, g.usd.toFixed(4), g.first, g.last]
        .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))].join('\n'));
      else emit(formatGroups(groups, o.by));
    } else if (o.json) emit(toJson(sessions));
    else if (o.csv) emit(toCsv(sessions));
    else if (command === 'list') emit(formatSessions(sessions));
    else {
      emit(sessions.length
        ? `${header}\n\n${formatSessions(sessions)}\n\n${formatGroups(groupSessions(sessions, o.by), o.by)}`
        : `${header}\n\nNo sessions match.`);
    }
    break;
  }
  case 'sync': {
    try {
      const { stats } = openLedger({ sync: true });
      if (!o.quiet) console.log(`${ledgerFile}: ${syncNote(stats)}`);
    } catch (e) {
      if (!o.quiet) throw e;
      // The hook must never disturb Claude Code; the next sync catches up.
    }
    break;
  }
  case 'retag': {
    const [prefix, tag] = rest;
    if (!prefix || tag === undefined) fail('usage: rls-claude-usage retag <session id> <tag>');
    const { ledger } = openLedger();
    const hits = Object.values(ledger.sessions).filter((r) => r.id.startsWith(prefix));
    if (hits.length !== 1) fail(hits.length ? `${prefix} matches ${hits.length} sessions — give more of the id` : `no session ${prefix} in the ledger`);
    const [rec] = hits;
    if (tag.trim()) rec.tagOverride = tag.trim();
    else delete rec.tagOverride;
    saveLedger(ledgerFile, ledger);
    console.log(`${rec.id.slice(0, 8)}  ${rec.title || '—'}  → tag ${rec.tagOverride ?? '(from the title)'}`);
    break;
  }
  case 'install-hook': {
    const cmd = installHook(fileURLToPath(import.meta.url));
    console.log(`SessionEnd hook in ${settingsPath()} (backup: settings.json.bak):\n  ${cmd}`);
    break;
  }
  case 'uninstall-hook': {
    const n = uninstallHook();
    console.log(n ? `removed ${n} hook(s) from ${settingsPath()}` : 'no rls-claude-usage hook installed');
    break;
  }
  case 'where': {
    const hooks = hookStatus();
    console.log(`ledger       ${ledgerFile}\ntranscripts  ${projectsDir()}\nsettings     ${settingsPath()}\n` +
      `hook         ${hooks.length ? hooks.join('\n             ') : 'not installed (run "rls-claude-usage install-hook")'}`);
    break;
  }
  default:
    fail(`unknown command "${command}"\nRun "rls-claude-usage --help" for usage.`);
}
