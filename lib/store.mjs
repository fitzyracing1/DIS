// Tiny JSON state file. Atomic writes (tmp + rename) so a crash never leaves half a file.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const HISTORY_MAX = 1440; // one day at the default 60s interval

export function emptyTargetState() {
  return { light: 'pending', since: null, consecutiveFail: 0, consecutiveOk: 0, checks: 0, okChecks: 0, lastCheck: null, lastChange: null, lastReportedAt: null, history: [] };
}

export class Store {
  constructor(path) {
    this.path = path ? resolve(path) : null; // null = in-memory only
    this.data = { version: 1, targets: {}, lightReportTokens: {} };
    if (this.path) {
      try {
        const d = JSON.parse(readFileSync(this.path, 'utf8'));
        if (d && typeof d === 'object') this.data = { ...this.data, ...d, targets: d.targets || {}, lightReportTokens: d.lightReportTokens || {} };
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[dis] could not read state ${this.path} (${e.message}); starting fresh`);
      }
    }
  }

  target(name) {
    if (!this.data.targets[name]) this.data.targets[name] = emptyTargetState();
    const s = this.data.targets[name];
    if (!Array.isArray(s.history)) s.history = [];
    return s;
  }

  /** Drop state for targets no longer in the config. */
  prune(names) {
    for (const k of Object.keys(this.data.targets)) if (!names.includes(k)) delete this.data.targets[k];
  }

  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
