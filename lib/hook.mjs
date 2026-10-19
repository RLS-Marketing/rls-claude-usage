/**
 * The SessionEnd hook in Claude Code's user settings, so every session lands in
 * the ledger when it ends — even in a month the tool is never run by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './transcripts.mjs';

const MARK = 'rls-claude-usage';

export function settingsPath() {
  return path.join(configDir(), 'settings.json');
}

function hookCommand(script) {
  // Forward slashes work for node in both cmd and Git Bash, which Claude Code uses on Windows.
  return `node "${fs.realpathSync(script).replace(/\\/g, '/')}" sync --quiet`;
}

const ours = (h) => typeof h.command === 'string' && h.command.includes(MARK);

function load(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function save(file, settings) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

/** Drops our hook entries; returns how many there were. */
function strip(settings) {
  let removed = 0;
  const groups = settings.hooks?.SessionEnd ?? [];
  for (const g of groups) {
    const before = g.hooks?.length ?? 0;
    g.hooks = (g.hooks ?? []).filter((h) => !ours(h));
    removed += before - g.hooks.length;
  }
  if (settings.hooks?.SessionEnd) {
    settings.hooks.SessionEnd = groups.filter((g) => g.hooks.length);
    if (!settings.hooks.SessionEnd.length) delete settings.hooks.SessionEnd;
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  }
  return removed;
}

/** Installs (or re-points) the hook at `script`; returns the command. */
export function installHook(script) {
  const file = settingsPath();
  const settings = load(file);
  strip(settings);
  const command = hookCommand(script);
  settings.hooks ??= {};
  settings.hooks.SessionEnd ??= [];
  settings.hooks.SessionEnd.push({ hooks: [{ type: 'command', command }] });
  save(file, settings);
  return command;
}

export function uninstallHook() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return 0;
  const settings = load(file);
  const removed = strip(settings);
  if (removed) save(file, settings);
  return removed;
}

export function hookStatus() {
  const settings = load(settingsPath());
  return (settings.hooks?.SessionEnd ?? []).flatMap((g) => g.hooks ?? []).filter(ours).map((h) => h.command);
}
