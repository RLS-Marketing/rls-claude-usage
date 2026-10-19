import path from 'node:path';
import { tagOf } from './ledger.mjs';

export const UNTAGGED = '(untagged)';

const pad2 = (n) => String(n).padStart(2, '0');
/** Local date of an ISO timestamp, YYYY-MM-DD. */
export const localDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const localDateTime = (iso) => {
  const d = new Date(iso);
  return `${localDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const projectName = (rec) => (rec.project ? path.basename(rec.project.replace(/[\\/]+$/, '')) : '');

/** Ledger entries matching the command-line filters, newest first. */
export function filterSessions(ledger, f) {
  const tags = f.tag?.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const search = f.search?.toLowerCase();
  return Object.values(ledger.sessions)
    .filter((r) => {
      const tag = tagOf(r);
      const day = localDate(r.first);
      if (tags && !tags.includes((tag ?? UNTAGGED).toLowerCase()) && !(tag == null && tags.includes('untagged'))) return false;
      if (search && ![r.title, r.project, r.id].some((s) => s?.toLowerCase().includes(search))) return false;
      if (f.project && !r.project.toLowerCase().includes(f.project.toLowerCase())) return false;
      if (f.session && !r.id.startsWith(f.session)) return false;
      if (f.since && day < f.since) return false;
      if (f.until && day > f.until) return false;
      if (f.month && !day.startsWith(f.month)) return false;
      return true;
    })
    .sort((a, b) => (a.first < b.first ? 1 : -1));
}

const GROUP_KEYS = {
  tag: (r) => tagOf(r) ?? UNTAGGED,
  project: (r) => projectName(r) || '(unknown)',
  month: (r) => localDate(r.first).slice(0, 7),
  day: (r) => localDate(r.first),
};
export const GROUPS = Object.keys(GROUP_KEYS);

/**
 * Totals per group, most expensive first (chronological for month/day).
 * Keys are case-insensitive ("webshop" and "Webshop" are one tag), labelled as the newest session spells them.
 */
export function groupSessions(sessions, by) {
  const groups = new Map();
  for (const r of [...sessions].sort((a, b) => (a.first < b.first ? 1 : -1))) {
    const label = GROUP_KEYS[by](r);
    const k = label.toLowerCase();
    const g = groups.get(k) ?? { [by]: label, sessions: 0, usd: 0, first: r.first, last: r.last ?? r.first };
    g.sessions++;
    g.usd += r.usd;
    if (r.first < g.first) g.first = r.first;
    if ((r.last ?? r.first) > g.last) g.last = r.last ?? r.first;
    groups.set(k, g);
  }
  const out = [...groups.values()];
  return by === 'month' || by === 'day'
    ? out.sort((a, b) => (a[by] < b[by] ? -1 : 1))
    : out.sort((a, b) => b.usd - a.usd);
}

const usd = (n) => n.toFixed(2);
const table = (rows, align) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (align[i] === 'r' ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i])))
    .join('  ').trimEnd()).join('\n');
};

export function formatGroups(groups, by) {
  const total = groups.reduce((s, g) => s + g.usd, 0);
  const n = groups.reduce((s, g) => s + g.sessions, 0);
  const rows = [[by, 'sessions', 'USD', 'first', 'last']];
  for (const g of groups) rows.push([g[by], g.sessions, usd(g.usd), localDate(g.first), localDate(g.last)]);
  rows.push(['total', n, usd(total), '', '']);
  return table(rows, ['l', 'r', 'r', 'l', 'l']);
}

export function formatSessions(sessions) {
  const rows = [['started', 'session', 'USD', 'project', 'title']];
  for (const r of sessions) {
    const flags = (r.source === 'computed' ? '*' : ' ') + (r.unpricedModels?.length ? '!' : ' ');
    rows.push([localDateTime(r.first), r.id.slice(0, 8), usd(r.usd) + flags, projectName(r), r.title || '—']);
  }
  const notes = [];
  if (sessions.some((r) => r.source === 'computed')) {
    notes.push('* computed from token usage at list price — no cost record from Claude Code: not yet (an open session; the next sync picks it up) or never (older Claude Code versions)');
  }
  const unpriced = [...new Set(sessions.flatMap((r) => r.unpricedModels ?? []))];
  if (unpriced.length) notes.push(`! counts no cost for unpriced models: ${unpriced.join(', ')} — add them to lib/prices.mjs`);
  return table(rows, ['l', 'l', 'r', 'l', 'l']) + (notes.length ? '\n\n' + notes.join('\n') : '');
}

const CSV_COLUMNS = ['id', 'started', 'last', 'tag', 'title', 'project', 'usd', 'source', 'computed_usd',
  'subagent_usd', 'subagents', 'calls', 'tokens', 'models', 'transcript'];

export function toCsv(sessions) {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of sessions) {
    lines.push([r.id, r.first, r.last ?? '', tagOf(r) ?? '', r.title, r.project, r.usd.toFixed(4), r.source,
      r.computedUsd.toFixed(4), r.subagentUsd.toFixed(4), r.subagents, r.calls, r.tokens, r.models.join(' '),
      r.transcript].map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}

export function toJson(sessions) {
  return JSON.stringify(sessions.map(({ fingerprint, ...r }) => ({ ...r, tag: tagOf(r) })), null, 2) + '\n';
}
