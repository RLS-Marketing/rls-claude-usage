import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/rls-claude-usage.mjs', import.meta.url));
let tmp, projects, ledger, env;

const line = (o) => JSON.stringify(o) + '\n';
const assistant = (id, ts, usage, model = 'claude-opus-5-5') =>
  line({ type: 'assistant', timestamp: ts, cwd: '/work/demo-repo', message: { id, model, usage } });
const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0 };
// opus-5-5: 1000 × $4/M + 1000 × $20/M = $0.024

function writeSession(id, records, project = 'demo') {
  const dir = path.join(projects, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.join(''));
}

function run(...args) {
  return execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
}
const json = (...args) => JSON.parse(run('list', '--json', ...args));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rls-claude-usage-'));
  projects = path.join(tmp, 'claude', 'projects');
  ledger = path.join(tmp, 'ledger', 'ledger.json');
  env = { ...process.env, TZ: 'UTC', RLS_CLAUDE_USAGE_TODAY: '2026-10-20', CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), RLS_CLAUDE_USAGE_LEDGER: ledger };
  writeSession('aaaa1111-0000', [
    line({ type: 'custom-title', customTitle: 'Old name' }),
    // streamed twice under one message id: only the last record counts
    assistant('m1', '2026-10-12T08:00:00Z', { ...usage, output_tokens: 10 }),
    assistant('m1', '2026-10-12T08:00:01Z', usage),
    line({ type: 'custom-title', customTitle: 'Webshop | Checkout' }),
  ]);
  writeSession('bbbb2222-0000', [
    assistant('m1', '2026-09-01T08:00:00Z', usage),
    line({ type: 'cost-state', totalCostUSD: 1.5 }),
    line({ type: 'custom-title', customTitle: 'Sentry issues' }),
  ]);
  writeSession('cccc3333-0000', [
    assistant('m1', '2026-10-13T08:00:00Z', usage, 'claude-future-9'),
    line({ type: 'custom-title', customTitle: 'webshop | unpriced model' }),
  ]);
});

test('computes cost from the last streamed usage record, prefers Claude Code\'s own figure', () => {
  const byId = Object.fromEntries(json('--all').map((s) => [s.id.slice(0, 4), s]));
  assert.equal(byId.aaaa.usd, 0.024);
  assert.equal(byId.aaaa.source, 'computed');
  assert.equal(byId.bbbb.usd, 1.5);
  assert.equal(byId.bbbb.source, 'claude-code');
  assert.deepEqual(byId.cccc.unpricedModels, ['claude-future-9']);
  assert.equal(byId.cccc.usd, 0);
});

test('tag is the title before "|", latest rename wins, matched case-insensitively', () => {
  const s = json('--all', '--tag', 'WEBSHOP');
  assert.deepEqual(s.map((x) => x.id.slice(0, 4)), ['cccc', 'aaaa']);
  assert.equal(s[1].title, 'Webshop | Checkout');
  assert.deepEqual(json('--all', '--tag', 'untagged').map((x) => x.tag), [null]);
});

test('summary groups by tag (case-insensitively, newest spelling) and by month', () => {
  const byTag = JSON.parse(run('summary', '--all', '--json'));
  assert.deepEqual(byTag.map((g) => [g.tag, g.sessions]), [['(untagged)', 1], ['webshop', 2]]);
  const byMonth = JSON.parse(run('summary', '--all', '--by', 'month', '--json'));
  assert.deepEqual(byMonth.map((g) => [g.month, g.sessions]), [['2026-09', 1], ['2026-10', 2]]);
});

test('filters: search, since/until, month, session prefix', () => {
  assert.deepEqual(json('--all', '--search', 'sentry').map((s) => s.id.slice(0, 4)), ['bbbb']);
  assert.deepEqual(json('--all', '--title', 'SENTRY').map((s) => s.id.slice(0, 4)), ['bbbb']);
  assert.deepEqual(json('--all', '--title', 'demo'), [], '--title ignores the project path');
  assert.deepEqual(json('--all', '--title', 'aaaa'), [], '--title ignores the session id');
  assert.deepEqual(json('--since', '2026-10-13').map((s) => s.id.slice(0, 4)), ['cccc']);
  assert.deepEqual(json('--until', '2026-09-30').map((s) => s.id.slice(0, 4)), ['bbbb']);
  assert.deepEqual(json('--month', '2026-09').map((s) => s.id.slice(0, 4)), ['bbbb']);
  assert.deepEqual(json('--session', 'aaaa').map((s) => s.id.slice(0, 4)), ['aaaa']);
});

test('period: this month by default; last month, a month, years, last 12 months, all', () => {
  writeSession('dddd4444-0000', [assistant('m1', '2025-12-31T09:00:00Z', usage)]);
  const ids = (...args) => json(...args).map((s) => s.id.slice(0, 4)).sort();
  assert.deepEqual(ids(), ['aaaa', 'cccc'], 'default: this month (2026-10)');
  assert.deepEqual(ids('--this-month'), ['aaaa', 'cccc']);
  assert.deepEqual(ids('--last-month'), ['bbbb']);
  assert.deepEqual(ids('--month', '2025-12'), ['dddd']);
  assert.deepEqual(ids('--this-year'), ['aaaa', 'bbbb', 'cccc']);
  assert.deepEqual(ids('--last-year'), ['dddd']);
  assert.deepEqual(ids('--year', '2025'), ['dddd']);
  assert.deepEqual(ids('--last-12-months'), ['aaaa', 'bbbb', 'cccc', 'dddd']);
  assert.deepEqual(ids('--all'), ['aaaa', 'bbbb', 'cccc', 'dddd']);
  assert.deepEqual(ids('--session', 'dddd'), ['dddd'], 'an id lookup searches all history');
  assert.match(run('report'), /Period 2026-10 \(this month\)/);
  assert.throws(() => run('--all', '--this-year'), /pick one period/);
  assert.throws(() => run('--all', '--since', '2026-01-01'), /pick one/);
});

test('--monthly: totals per tag and month for a year-long period', () => {
  const rows = JSON.parse(run('summary', '--this-year', '--monthly', '--json'));
  assert.deepEqual(rows.map((r) => [r.tag, r.months]), [['(untagged)', { '2026-09': 1.5 }], ['webshop', { '2026-10': 0.024 }]]);
  const out = run('--this-year', '--monthly');
  assert.match(out, /^tag\s+2026-01\s+.*2026-10\s+total$/m, 'every month of the period, January to now');
  assert.doesNotMatch(out, /2026-11/);
  assert.match(out, /^webshop\s+(·\s+){9}0\.02\s+0\.02$/m);
  assert.match(run('summary', '--last-12-months', '--monthly', '--csv', '--by', 'project').split('\n')[0], /^project,2025-11,.*,2026-10,total$/);
  assert.throws(() => run('--last-month', '--monthly'), /needs a year-long period/);
  assert.throws(() => run('--all', '--monthly', '--by', 'day'), /expected tag or project/);
});

test('list: a separator line between sessions started on different days', () => {
  writeSession('dddd4444-0000', [assistant('m1', '2026-10-13T09:00:00Z', usage)]);
  const lines = run('list', '--all').split('\n').filter((l) => /^(\d{4}-|-+$)/.test(l));
  assert.deepEqual(lines.map((l) => (l.startsWith('-') ? '---' : l.slice(0, 10))),
    ['2026-09-01', '---', '2026-10-12', '---', '2026-10-13', '2026-10-13']);
});

test('the ledger keeps a session after Claude Code deletes its transcript', () => {
  run('sync');
  fs.rmSync(path.join(projects, 'demo', 'bbbb2222-0000.jsonl'));
  const out = run('report');
  assert.match(out, /1 transcripts deleted by Claude Code/);
  const kept = json('--session', 'bbbb');
  assert.equal(kept[0].usd, 1.5);
  assert.equal(kept[0].transcript, 'gone');
});

test('a changed transcript is re-read; an unchanged one is not', () => {
  run('sync');
  assert.match(run('sync'), /0 new, 0 updated/);
  fs.appendFileSync(path.join(projects, 'demo', 'aaaa1111-0000.jsonl'), line({ type: 'cost-state', totalCostUSD: 2 }));
  assert.match(run('sync'), /0 new, 1 updated/);
  assert.equal(json('--session', 'aaaa')[0].source, 'claude-code');
});

test('retag overrides the title\'s tag and survives later syncs', () => {
  run('retag', 'bbbb', 'Website');
  fs.appendFileSync(path.join(projects, 'demo', 'bbbb2222-0000.jsonl'), line({ type: 'cost-state', totalCostUSD: 2 }));
  assert.equal(json('--all', '--tag', 'website')[0].usd, 2);
  run('retag', 'bbbb', '');
  assert.equal(json('--session', 'bbbb')[0].tag, null);
});

test('subagent transcripts add to the session that spawned them', () => {
  const sub = path.join(projects, 'demo', 'aaaa1111-0000', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), assistant('s1', '2026-10-12T08:05:00Z', usage));
  const [s] = json('--session', 'aaaa');
  assert.equal(s.usd, 0.048);
  assert.equal(s.subagentUsd, 0.024);
});

test('csv export: one row per session, with the tag column', () => {
  const csv = run('list', '--csv', '--session', 'aaaa');
  assert.match(csv.split('\n')[1], /,Webshop,Webshop \| Checkout,/);
  assert.match(run('list', '--csv', '--session', 'bbbb'), /,,Sentry issues,/);
  const rows = run('list', '--all', '--csv').trim().split('\n');
  assert.equal(rows.length, 4);
});

test('install-hook and uninstall-hook keep other settings', () => {
  const settings = path.join(tmp, 'claude', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'other' }] }] } }));
  run('install-hook');
  run('install-hook'); // idempotent
  let s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  const cmds = s.hooks.SessionEnd.flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0], 'other');
  assert.match(cmds[1], /^node ".*rls-claude-usage\.mjs" sync --quiet$/);
  assert.equal(s.model, 'opus');
  run('uninstall-hook');
  s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(s.hooks.SessionEnd.flatMap((g) => g.hooks.map((h) => h.command)), ['other']);
});

test('sync --quiet never fails, even on a broken ledger', () => {
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, 'not json');
  assert.equal(run('sync', '--quiet'), '');
});
