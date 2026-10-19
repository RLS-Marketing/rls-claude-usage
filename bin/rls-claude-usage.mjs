#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultLedgerPath, loadLedger, saveLedger, syncLedger } from '../lib/ledger.mjs';
import { installHook, uninstallHook, hookStatus, settingsPath } from '../lib/hook.mjs';
import { projectsDir } from '../lib/transcripts.mjs';
import { filterSessions, formatGroups, formatSessions, groupSessions, GROUPS, toCsv, toJson } from '../lib/report.mjs';

const HELP = `rls-claude-usage — a permanent ledger of what your Claude Code sessions cost

Usage: rls-claude-usage [command] [options]

Commands
  report            (default) totals per tag, then the sessions
  summary           totals only
  list              sessions only
  sync              update the ledger from the transcripts, print nothing else
  retag <id> <tag>  set a session's tag by hand ("" to go back to the title's tag)
  install-hook      add a SessionEnd hook to Claude Code that runs "sync"
  uninstall-hook    remove it
  where             print the ledger, transcript and settings paths

Filters (report, summary, list)
  --tag <a,b>       sessions with this tag — the title before the first "|"
                    ("Webshop | Checkout" has tag "Webshop"); "untagged" for none
  --search <text>   title, project path or session id contains the text
  --project <text>  project path contains the text
  --session <id>    session id starts with this
  --since <date>    started on or after YYYY-MM-DD (local time)
  --until <date>    started on or before YYYY-MM-DD
  --month <YYYY-MM> started in this month

Output
  --by <key>        group totals by ${GROUPS.join(' | ')} (default tag)
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
      tag: { type: 'string' }, search: { type: 'string' }, project: { type: 'string' },
      session: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
      month: { type: 'string' }, by: { type: 'string', default: 'tag' },
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

for (const [k, re] of [['since', /^\d{4}-\d{2}-\d{2}$/], ['until', /^\d{4}-\d{2}-\d{2}$/], ['month', /^\d{4}-\d{2}$/]]) {
  if (o[k] && !re.test(o[k])) fail(`--${k} ${o[k]}: expected ${k === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'}`);
}
if (!GROUPS.includes(o.by)) fail(`--by ${o.by}: expected one of ${GROUPS.join(', ')}`);
if (o.csv && o.json) fail('--csv and --json: pick one');

switch (command) {
  case 'report':
  case 'summary':
  case 'list': {
    const { ledger, stats } = openLedger();
    const sessions = filterSessions(ledger, o);
    if (command === 'summary') {
      const groups = groupSessions(sessions, o.by);
      if (o.json) emit(JSON.stringify(groups, null, 2));
      else if (o.csv) emit([`${o.by},sessions,usd,first,last`, ...groups.map((g) => [g[o.by], g.sessions, g.usd.toFixed(4), g.first, g.last]
        .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))].join('\n'));
      else emit(formatGroups(groups, o.by));
    } else if (o.json) emit(toJson(sessions));
    else if (o.csv) emit(toCsv(sessions));
    else if (command === 'list') emit(formatSessions(sessions));
    else {
      const header = `Ledger ${ledgerFile} — ${syncNote(stats)}`;
      emit(sessions.length
        ? `${header}\n\n${formatGroups(groupSessions(sessions, o.by), o.by)}\n\n${formatSessions(sessions)}`
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
