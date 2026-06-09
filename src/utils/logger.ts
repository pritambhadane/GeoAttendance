/**
 * In-app logger — writes timestamped entries to localStorage.
 * Access the log viewer by tapping the app version 5 times in the Dashboard.
 */

const LOG_KEY = 'geo_app_logs';
const MAX_ENTRIES = 500;

export type LogLevel = 'info' | 'warn' | 'error' | 'gps' | 'geo' | 'tick';

export interface LogEntry {
  ts: string;       // ISO timestamp
  level: LogLevel;
  tag: string;      // e.g. 'GPS', 'TICK', 'CHECKIN'
  msg: string;
}

function now(): string {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
    + ' IST';
}

function load(): LogEntry[] {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
  } catch {
    return [];
  }
}

function save(entries: LogEntry[]): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch { /* noop */ }
}

export function log(level: LogLevel, tag: string, msg: string): void {
  const entry: LogEntry = { ts: now(), level, tag, msg };
  const entries = load();
  entries.push(entry);
  save(entries);
  // Also print to console for ADB logcat
  const line = `[${tag}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function getLogs(): LogEntry[] {
  return load();
}

export function clearLogs(): void {
  localStorage.removeItem(LOG_KEY);
}

export function exportLogs(): string {
  return load()
    .map(e => `${e.ts} [${e.level.toUpperCase()}] [${e.tag}] ${e.msg}`)
    .join('\n');
}
