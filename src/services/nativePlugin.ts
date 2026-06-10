/**
 * nativePlugin.ts
 *
 * Typed TypeScript wrapper for AttendancePlugin (Java Capacitor bridge).
 * Drop this into src/services/nativePlugin.ts
 *
 * Usage:
 *   import { AttendanceServicePlugin, isNativeServiceAvailable } from './nativePlugin';
 *
 *   // On app launch:
 *   await AttendanceServicePlugin.syncProfiles({ profiles: JSON.stringify(getProfiles()) });
 *   await AttendanceServicePlugin.syncLogs({ logs: JSON.stringify(getLogs()) });
 *   await AttendanceServicePlugin.startService();
 *
 *   // Poll every 10s to update UI:
 *   const state = await AttendanceServicePlugin.getState();
 *
 *   // Manual overrides:
 *   await AttendanceServicePlugin.manualCheckIn({ profileId: "abc123" });
 *   await AttendanceServicePlugin.manualCheckOut({ profileId: "abc123" });
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NativeState {
  checkedIn: boolean;
  todayStatus: 'idle' | 'checked-in' | 'checked-out';
  totalMinutesToday: number;
  lastUpdated: number; // epoch ms
}

export interface NativeLogsResult {
  logs: string; // JSON string — parse with JSON.parse()
}

export interface BatteryExemptionResult {
  exempted?: boolean;
  alreadyExempted?: boolean;
}

// ── Plugin accessor ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPlugin(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).Capacitor?.Plugins?.AttendanceService ?? null;
    }
  } catch { /* noop */ }
  return null;
}

export function isNativeServiceAvailable(): boolean {
  return getPlugin() !== null;
}

// ── Plugin API ────────────────────────────────────────────────────────────────

export const AttendanceServicePlugin = {

  /** Start the native ForegroundService. Call once on app launch. */
  startService(): Promise<void> {
    const p = getPlugin();
    if (!p) return Promise.resolve();
    return p.startService();
  },

  /** Stop the native ForegroundService. */
  stopService(): Promise<void> {
    const p = getPlugin();
    if (!p) return Promise.resolve();
    return p.stopService();
  },

  /**
   * Push current profiles from React localStorage → SharedPreferences.
   * Call after app launch and after any profile create/update/delete.
   */
  syncProfiles(opts: { profiles: string }): Promise<void> {
    const p = getPlugin();
    if (!p) return Promise.resolve();
    return p.syncProfiles(opts);
  },

  /**
   * Seed Java's log store from React's localStorage.
   * Call ONCE on first launch to migrate existing data.
   * After this, Java is the authoritative writer.
   */
  syncLogs(opts: { logs: string }): Promise<void> {
    const p = getPlugin();
    if (!p) return Promise.resolve();
    return p.syncLogs(opts);
  },

  /**
   * Read the compact state snapshot updated by the service on every tick.
   * Poll this every ~10s to refresh the React UI.
   */
  async getState(): Promise<NativeState> {
    const p = getPlugin();
    if (!p) {
      return { checkedIn: false, todayStatus: 'idle', totalMinutesToday: 0, lastUpdated: 0 };
    }
    return p.getState();
  },

  /**
   * Read the full log array stored by the service.
   * Parse with JSON.parse(result.logs).
   */
  async getLogs(): Promise<NativeLogsResult> {
    const p = getPlugin();
    if (!p) return { logs: '[]' };
    return p.getLogs();
  },

  /** Force a manual check-in for the given profileId. */
  manualCheckIn(opts: { profileId: string }): Promise<{ success: boolean }> {
    const p = getPlugin();
    if (!p) return Promise.resolve({ success: false });
    return p.manualCheckIn(opts);
  },

  /**
   * Force a manual check-out.
   * Pass profileId to close one session, or omit to close all open sessions.
   */
  manualCheckOut(opts: { profileId?: string }): Promise<{ success: boolean }> {
    const p = getPlugin();
    if (!p) return Promise.resolve({ success: false });
    return p.manualCheckOut(opts);
  },

  /**
   * Returns whether the app is already exempt from battery optimisation.
   * Call on launch — if false, show a rationale then call requestBatteryExemption().
   */
  async isBatteryExempted(): Promise<BatteryExemptionResult> {
    const p = getPlugin();
    if (!p) return { exempted: true };
    return p.isBatteryExempted();
  },

  /**
   * Opens the system dialog to exempt this app from battery optimisation.
   * Only call this after showing the user a rationale dialog.
   * No-op on iOS or web.
   */
  async requestBatteryExemption(): Promise<BatteryExemptionResult> {
    const p = getPlugin();
    if (!p) return { alreadyExempted: true };
    return p.requestBatteryExemption();
  },
};
