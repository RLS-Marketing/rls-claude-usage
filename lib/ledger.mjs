/**
 * The ledger: one JSON file that keeps every session's cost after Claude Code
 * has deleted the transcript. Entries are added and updated, never removed.
 *
 *   ~/.rls-claude-usage/ledger.json   (RLS_CLAUDE_USAGE_LEDGER or --ledger to move it)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSessions, fingerprint, readSession } from './transcripts.mjs';

export function defaultLedgerPath() {
  return process.env.RLS_CLAUDE_USAGE_LEDGER ||
    path.join(os.homedir(), '.rls-claude-usage', 'ledger.json');
}

export function loadLedger(file) {
  if (!fs.existsSync(file)) return { version: 1, sessions: {} };
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (ledger.version !== 1 || typeof ledger.sessions !== 'object') {
    throw new Error(`${file} is not a rls-claude-usage ledger (version 1)`);
  }
  return ledger;
}

/** Writes through a temporary file, so a crash or a concurrent hook never leaves half a ledger. */
export function saveLedger(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ledger.updated = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Brings the ledger up to date with the transcripts under `root`.
 * Re-reads only sessions whose files changed; marks entries whose transcript is gone.
 */
export function syncLedger(ledger, root) {
  const stats = { added: 0, updated: 0, unchanged: 0, gone: 0 };
  const now = new Date().toISOString();
  for (const s of findSessions(root)) {
    const prev = ledger.sessions[s.id];
    let fp;
    try { fp = fingerprint(s); } catch { continue; } // deleted while we looked
    if (prev && prev.fingerprint === fp && prev.transcript === 'present') { stats.unchanged++; continue; }
    let rec;
    try { rec = readSession(s); } catch { continue; }
    if (!rec) continue; // no API calls yet
    ledger.sessions[s.id] = {
      ...rec,
      ...(prev?.tagOverride ? { tagOverride: prev.tagOverride } : {}),
      transcript: 'present',
      fingerprint: fp,
      syncedAt: now,
    };
    stats[prev ? 'updated' : 'added']++;
  }
  for (const rec of Object.values(ledger.sessions)) {
    if (rec.transcript === 'present' && !fs.existsSync(rec.file)) {
      rec.transcript = 'gone';
      rec.goneSince = now;
      stats.gone++;
    }
  }
  return stats;
}

/** The project tag: the part of the title before the first "|" ("Webshop | Checkout" → "Webshop"). */
export function tagOf(rec) {
  if (rec.tagOverride) return rec.tagOverride;
  const i = rec.title.indexOf('|');
  const tag = i > 0 ? rec.title.slice(0, i).trim() : '';
  return tag || null;
}
