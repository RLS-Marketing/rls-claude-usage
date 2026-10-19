/**
 * Reading Claude Code's local transcripts.
 *
 * Claude Code writes one JSONL transcript per session under
 * <config dir>/projects/<cwd with separators turned into dashes>/<session>.jsonl,
 * and every subagent it spawned under <session>/subagents/*.jsonl. The config
 * dir is ~/.claude unless CLAUDE_CONFIG_DIR says otherwise. Transcripts are
 * deleted after `cleanupPeriodDays` (default 30) — which is why the ledger exists.
 *
 * Two cost figures per session:
 *   claude-code  the last `cost-state` record Claude Code writes into the
 *                transcript (`totalCostUSD`, what its own cost display shows).
 *                It also covers calls the transcript does not (side queries,
 *                compaction), so it is the one reported. A session that is still
 *                open may not have one yet.
 *   computed     summed from each assistant message's `message.usage` at list
 *                price (prices.mjs), subagents included. A message streamed as
 *                several records repeats its usage under one `message.id`,
 *                growing as it streams, so the last record per id counts. Used
 *                only until a `cost-state` exists; it runs a little under.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageCost, usageTokens } from './prices.mjs';

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function projectsDir() {
  return path.join(configDir(), 'projects');
}

/** Every session transcript under `root`: { id, projectDir, file, subagentFiles }. */
export function findSessions(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(root, dir.name);
    for (const f of fs.readdirSync(projectDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      const subDir = path.join(projectDir, id, 'subagents');
      const subagentFiles = fs.existsSync(subDir)
        ? fs.readdirSync(subDir).filter((s) => s.endsWith('.jsonl')).map((s) => path.join(subDir, s))
        : [];
      out.push({ id, projectDir, file: path.join(projectDir, f), subagentFiles });
    }
  }
  return out;
}

/** Changes whenever any of the session's files changes; lets a sync skip unchanged sessions. */
export function fingerprint(session) {
  return [session.file, ...session.subagentFiles]
    .map((f) => { const s = fs.statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; })
    .join(',');
}

function readFile(file, acc) {
  const last = new Map(); // message id -> { model, usage, ts }; the final streamed record wins
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.includes('"type":"cost-state"')) {
      try {
        const c = JSON.parse(line);
        if (typeof c.totalCostUSD === 'number') acc.costState = c;
      } catch {}
      continue;
    }
    if (line.includes('"type":"custom-title"')) {
      try { acc.title = JSON.parse(line).customTitle ?? acc.title; } catch {}
      continue;
    }
    if (!acc.cwd && line.includes('"cwd"')) {
      try { acc.cwd = JSON.parse(line).cwd ?? null; } catch {}
    }
    if (!line.includes('"usage"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.message;
    if (d.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') continue;
    last.set(m.id ?? d.requestId ?? d.uuid, { model: m.model, u: m.usage, ts: d.timestamp });
  }
  let usd = 0;
  for (const { model, u, ts } of last.values()) {
    const c = usageCost(model, u);
    if (c == null) acc.unpriced.add(model);
    else usd += c;
    acc.calls++;
    acc.tokens += usageTokens(u);
    acc.models.add(model);
    if (ts) {
      if (!acc.first || ts < acc.first) acc.first = ts;
      if (!acc.last || ts > acc.last) acc.last = ts;
    }
  }
  return usd;
}

/**
 * Cost and metadata of one session, or null when it made no API calls.
 * Never returns transcript content — only the title, the working directory and numbers.
 */
export function readSession(session) {
  const acc = { title: null, cwd: null, costState: null, calls: 0, tokens: 0,
    models: new Set(), unpriced: new Set(), first: null, last: null };
  const mainUsd = readFile(session.file, acc);
  let subagentUsd = 0;
  for (const f of session.subagentFiles) {
    const mainState = acc.costState;
    subagentUsd += readFile(f, acc);
    acc.costState = mainState; // only the main transcript's cost-state is the session total
  }
  if (!acc.first) return null;
  let title = acc.title;
  if (!title) {
    try {
      title = JSON.parse(fs.readFileSync(path.join(session.projectDir, session.id, 'custom-title.json'), 'utf8')).customTitle;
    } catch {}
  }
  const computedUsd = mainUsd + subagentUsd;
  const cs = acc.costState;
  return {
    id: session.id,
    title: title ?? '',
    project: acc.cwd ?? '',
    first: acc.first,
    last: acc.last,
    usd: round(cs ? cs.totalCostUSD : computedUsd),
    source: cs ? 'claude-code' : 'computed',
    computedUsd: round(computedUsd),
    subagentUsd: round(subagentUsd),
    subagents: session.subagentFiles.length,
    calls: acc.calls,
    tokens: acc.tokens,
    models: [...acc.models].sort(),
    // Claude Code prices every model it ran, so unpriced models only matter for a computed figure.
    unpricedModels: cs ? [] : [...acc.unpriced].sort(),
    file: session.file,
  };
}

const round = (usd) => Math.round(usd * 1e6) / 1e6;
