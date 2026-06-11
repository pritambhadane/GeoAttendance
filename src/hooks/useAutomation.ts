import { useState, useEffect, useCallback, useRef } from 'react';
import { LocationProfile, AttendanceLog, SimulationState, TrackingStatus } from '../types';
import {
  getProfiles, saveProfiles, getLogs, saveLogs,
  getSimulation, saveSimulation, generateId,
  calculateDistance, timeToStr, dateToStr,
  PositionData,
} from '../utils/storage';
import {
  requestLocationPermission,
  requestNotificationPermission,
  getNativePosition,
  startLocationWatch,
  stopLocationWatch,
  notifyCheckIn,
  notifyGeofenceExit,
  notifyAbsent,
} from '../services/capacitor';
import { AttendanceServicePlugin, isNativeServiceAvailable } from '../services/nativePlugin';

// ── Dedup key store ──────────────────────────────────────────────────────────
// Keys are per-profile per-date strings stored in localStorage.
// Format:  "checkin:{profileId}:{date}"          — first check-in of the day
//          "reentry:{profileId}:{date}:{n}"       — nth re-entry (n = session count)
//          "exit:{logId}"                         — geofence-exit checkout
//          "out:{profileId}:{date}"               — scheduled-time checkout
//          "absent:{profileId}:{date}"            — absent mark
// Cleared at midnight via date-filter on load.

const PROCESSED_KEY = 'geo_attendance_processed_v2';

interface DedupEntry { key: string; date: string; }

function loadDedup(currentDate: string): Set<string> {
  try {
    const raw = localStorage.getItem(PROCESSED_KEY);
    if (!raw) return new Set();
    const entries: DedupEntry[] = JSON.parse(raw);
    return new Set(entries.filter(e => e.date === currentDate).map(e => e.key));
  } catch { return new Set(); }
}

function saveDedup(keys: Set<string>, currentDate: string): void {
  try {
    const entries: DedupEntry[] = Array.from(keys).map(k => ({ key: k, date: currentDate }));
    localStorage.setItem(PROCESSED_KEY, JSON.stringify(entries));
  } catch { /* noop */ }
}

// ── Native sync helpers ──────────────────────────────────────────────────────

async function syncProfilesToNative(profiles: LocationProfile[]) {
  if (!isNativeServiceAvailable()) return;
  try {
    await AttendanceServicePlugin.syncProfiles({ profiles: JSON.stringify(profiles) });
  } catch (e) {
    console.warn('[GeoAttend] syncProfiles failed:', e);
  }
}

async function mergeNativeLogs(currentLogs: AttendanceLog[]): Promise<AttendanceLog[] | null> {
  if (!isNativeServiceAvailable()) return null;
  try {
    const result = await AttendanceServicePlugin.getLogs();
    const nativeLogs: AttendanceLog[] = JSON.parse(result.logs);
    if (!nativeLogs.length) return null;
    const existingIds = new Set(currentLogs.map(l => l.id));
    const newEntries = nativeLogs.filter(l => !existingIds.has(l.id));
    const nativeById = new Map(nativeLogs.map(l => [l.id, l]));
    let changed = newEntries.length > 0;
    const merged = currentLogs.map(l => {
      const native = nativeById.get(l.id);
      if (native && native.checkOut !== l.checkOut) { changed = true; return native; }
      return l;
    });
    if (!changed) return null;
    return [...merged, ...newEntries];
  } catch (e) {
    console.warn('[GeoAttend] mergeNativeLogs failed:', e);
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

function safeDuration(ms: number): number {
  return Math.max(0, Math.round(ms / 60000));
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAutomation() {
  const [profiles, setProfiles]     = useState<LocationProfile[]>(getProfiles);
  const [logs, setLogs]             = useState<AttendanceLog[]>(getLogs);
  const [simulation, setSimulation] = useState<SimulationState>(getSimulation);
  const [currentPosition, setCurrentPosition] = useState<PositionData | null>(null);
  const [positionError, setPositionError]     = useState<string | null>(null);

  const logsRef    = useRef<AttendanceLog[]>(logs);
  const dedupRef   = useRef<Set<string>>(new Set());  // loaded lazily in tick

  useEffect(() => { logsRef.current = logs; }, [logs]);

  // ── Permissions ──────────────────────────────────────────────────────────
  useEffect(() => {
    requestLocationPermission().catch(console.warn);
    requestNotificationPermission().catch(console.warn);
  }, []);

  // ── Native log poll (15s) ────────────────────────────────────────────────
  useEffect(() => {
    if (!isNativeServiceAvailable()) return;
    const poll = async () => {
      const merged = await mergeNativeLogs(logsRef.current);
      if (merged) { setLogs(merged); logsRef.current = merged; saveLogs(merged); }
    };
    const t = setTimeout(poll, 3000);
    const iv = setInterval(poll, 15000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, []);

  // ── GPS watch (web/simulation fallback) ─────────────────────────────────
  const getCurrentTime = useCallback(() => {
    const now = new Date();
    return simulation.enabled && simulation.timeOffset !== 0
      ? new Date(now.getTime() + simulation.timeOffset * 60000) : now;
  }, [simulation.enabled, simulation.timeOffset]);

  const getCurrentCoords = useCallback(() => {
    if (simulation.enabled)
      return { latitude: simulation.latitude, longitude: simulation.longitude, accuracy: 0, timestamp: Date.now() };
    return currentPosition;
  }, [simulation, currentPosition]);

  useEffect(() => {
    if (simulation.enabled) return;
    let active = true;
    const start = async () => {
      try {
        const pos = await getNativePosition();
        if (active) { setCurrentPosition(pos); setPositionError(null); }
      } catch { if (active) setPositionError('Unable to get location'); }
      await startLocationWatch(
        pos => { if (active) { setCurrentPosition(pos); setPositionError(null); } },
        ()  => { if (active) setPositionError('Location watch failed'); }
      );
    };
    start();
    return () => { active = false; stopLocationWatch(); };
  }, [simulation.enabled]);

  // ── Session helpers ──────────────────────────────────────────────────────
  const getOpenSessions = useCallback(() =>
    logsRef.current.filter(l => l.checkOut === null && l.status !== 'absent'), []);

  const getTrackingStatus = useCallback((): TrackingStatus => {
    const now      = getCurrentTime();
    const todayStr = dateToStr(now);
    const nowMins  = timeToMinutes(timeToStr(now));
    const nowDay   = now.getDay();

    const todayLogs = logsRef.current.filter(l => l.date === todayStr);
    const open      = todayLogs.filter(l => l.checkOut === null && l.status !== 'absent');
    if (open.length > 0) return 'checked-in';

    const nonAbsent = todayLogs.filter(l => l.status !== 'absent');
    if (nonAbsent.length > 0 && nonAbsent[nonAbsent.length - 1].checkOut) return 'checked-out';

    // 'tracking' = GPS watch active, inside check-in window for at least one profile,
    // but no check-in yet (waiting for geofence entry)
    const inWindow = profiles.some(p => {
      if (!p.active) return false;
      if (p.workingDays.length > 0 && !p.workingDays.includes(nowDay)) return false;
      const ciMins = timeToMinutes(p.checkInTime);
      return nowMins >= ciMins - 15 && nowMins <= ciMins + p.markAbsentAfter;
    });
    if (inWindow && (currentPosition !== null || simulation.enabled)) return 'tracking';

    return 'idle';
  }, [getCurrentTime, profiles, currentPosition, simulation.enabled]);

  // ── Core automation tick (web/browser only — disabled when native service runs) ──
  useEffect(() => {
    if (isNativeServiceAvailable()) return; // Java service owns all tick logic on Android

    // ── Close stale open sessions from previous days ───────────────────────
    const closeStale = () => {
      const now = getCurrentTime();
      const todayStr = dateToStr(now);
      let updated = [...logsRef.current];
      let changed = false;
      for (const log of updated.filter(l => l.checkOut === null && l.status !== 'absent' && l.date !== todayStr)) {
        const profile = profiles.find(p => p.id === log.profileId);
        if (!profile) continue;
        const closeAt = new Date(`${log.date}T${profile.checkOutTime}:00`);
        if (closeAt < now) {
          const duration = safeDuration(closeAt.getTime() - new Date(log.checkIn).getTime());
          const expectedMins = profile.expectedHoursPerDay * 60;
          updated = updated.map(l => l.id === log.id
            ? { ...l, checkOut: closeAt.toISOString(), duration, attended: duration >= expectedMins * 0.5 } : l);
          changed = true;
        }
      }
      if (changed) { setLogs(updated); logsRef.current = updated; saveLogs(updated); }
    };
    closeStale();

    // ── Mark previous day(s) absent ────────────────────────────────────────
    const markPrevAbsent = () => {
      const now = getCurrentTime();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = dateToStr(yesterday);
      const yDay  = yesterday.getDay();
      let updated = [...logsRef.current];
      let changed = false;
      for (const profile of profiles.filter(p => p.active)) {
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(yDay)) continue;
        if (updated.some(l => l.profileId === profile.id && l.date === yStr)) continue;
        updated = [...updated, {
          id: generateId(), profileId: profile.id, profileName: profile.name,
          date: yStr,
          checkIn: `${yStr}T${profile.checkInTime}:00+05:30`,
          checkOut: null, duration: null, status: 'absent' as const,
          profileColor: profile.color, attended: false,
        }];
        changed = true;
      }
      if (changed) { setLogs(updated); logsRef.current = updated; saveLogs(updated); }
    };
    markPrevAbsent();

    // ── Tick ───────────────────────────────────────────────────────────────
    const tick = () => {
      const now        = getCurrentTime();
      const coords     = getCurrentCoords();
      if (!coords) return;

      const nowStr     = dateToStr(now);
      const nowMins    = timeToMinutes(timeToStr(now));
      const nowDay     = now.getDay();

      // Load dedup for today (lazy, once per day)
      if (dedupRef.current.size === 0) {
        dedupRef.current = loadDedup(nowStr);
      }

      let updatedLogs = [...logsRef.current];
      let changed     = false;

      for (const profile of profiles.filter(p => p.active)) {
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(nowDay)) continue;

        const dist      = calculateDistance(coords.latitude, coords.longitude, profile.latitude, profile.longitude);
        const inFence   = dist <= profile.radius;
        const ciMins    = timeToMinutes(profile.checkInTime);
        const coMins    = timeToMinutes(profile.checkOutTime);
        const markAfter = profile.markAbsentAfter;
        const expMins   = profile.expectedHoursPerDay * 60;

        const hasOpen   = updatedLogs.some(l =>
          l.profileId === profile.id && l.date === nowStr && l.checkOut === null && l.status !== 'absent');
        const sessionCount = updatedLogs.filter(l =>
          l.profileId === profile.id && l.date === nowStr && l.status !== 'absent').length;

        // ── AUTO CHECK-IN: geofence entry (Option A — no time window gate) ──
        if (!hasOpen && inFence) {
          const absentMarked = updatedLogs.some(
            l => l.profileId === profile.id && l.date === nowStr && l.status === 'absent');
          // First check-in key, or re-entry key keyed on session count (not time)
          const ciKey = sessionCount === 0
            ? `checkin:${profile.id}:${nowStr}`
            : `reentry:${profile.id}:${nowStr}:${sessionCount}`;

          if (!absentMarked && !dedupRef.current.has(ciKey)) {
            const newLog: AttendanceLog = {
              id: generateId(), profileId: profile.id, profileName: profile.name,
              date: nowStr, checkIn: now.toISOString(),
              checkOut: null, duration: null, status: 'auto', profileColor: profile.color, attended: true,
            };
            updatedLogs = [...updatedLogs, newLog];
            dedupRef.current.add(ciKey);
            saveDedup(dedupRef.current, nowStr);
            changed = true;
            notifyCheckIn(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          }
        }

        // Re-evaluate after possible check-in
        const openLog = updatedLogs.find(
          l => l.profileId === profile.id && l.date === nowStr && l.checkOut === null && l.status !== 'absent');

        // ── AUTO CHECK-OUT: scheduled checkout time ────────────────────────
        if (openLog && Math.abs(nowMins - coMins) <= 1) {
          const outKey = `out:${profile.id}:${nowStr}`;
          if (!dedupRef.current.has(outKey)) {
            const duration = safeDuration(now.getTime() - new Date(openLog.checkIn).getTime());
            updatedLogs = updatedLogs.map(l => l.id === openLog.id
              ? { ...l, checkOut: now.toISOString(), duration, attended: duration >= expMins * 0.5, status: 'auto' as const }
              : l);
            dedupRef.current.add(outKey);
            saveDedup(dedupRef.current, nowStr);
            changed = true;
            notifyGeofenceExit(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          }
        }

        // ── AUTO CHECK-OUT: geofence exit (Option A) ──────────────────────
        // Require 2 consecutive out-of-fence ticks (handled via exitPending key)
        // to avoid GPS jitter triggering premature checkout.
        if (openLog && !inFence) {
          const pendingKey = `exitpending:${openLog.id}`;
          const exitKey    = `exit:${openLog.id}`;
          const sessionMins = safeDuration(now.getTime() - new Date(openLog.checkIn).getTime());
          if (sessionMins >= 15 && !dedupRef.current.has(exitKey)) {
            if (dedupRef.current.has(pendingKey)) {
              // Second consecutive out-of-fence tick — fire checkout
              const duration = safeDuration(now.getTime() - new Date(openLog.checkIn).getTime());
              updatedLogs = updatedLogs.map(l => l.id === openLog.id
                ? { ...l, checkOut: now.toISOString(), duration, attended: duration >= expMins * 0.5, status: 'auto' as const }
                : l);
              dedupRef.current.add(exitKey);
              dedupRef.current.delete(pendingKey);
              saveDedup(dedupRef.current, nowStr);
              changed = true;
              notifyGeofenceExit(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            } else {
              // First out-of-fence tick — set pending, wait for next tick to confirm
              dedupRef.current.add(pendingKey);
              saveDedup(dedupRef.current, nowStr);
            }
          }
        } else if (openLog && inFence) {
          // Back inside — clear any pending exit
          dedupRef.current.delete(`exitpending:${openLog.id}`);
        }

        // ── MARK ABSENT: no entry after checkInTime + markAbsentAfter ─────
        // Only if not currently inside geofence (if inside, they're just late)
        if (!openLog && !inFence && nowMins > ciMins + markAfter) {
          const absentKey = `absent:${profile.id}:${nowStr}`;
          const hasAnyLog = updatedLogs.some(l => l.profileId === profile.id && l.date === nowStr);
          if (!hasAnyLog && !dedupRef.current.has(absentKey)) {
            updatedLogs = [...updatedLogs, {
              id: generateId(), profileId: profile.id, profileName: profile.name,
              date: nowStr,
              checkIn: `${nowStr}T${profile.checkInTime}:00+05:30`,
              checkOut: null, duration: null, status: 'absent' as const,
              profileColor: profile.color, attended: false,
            }];
            dedupRef.current.add(absentKey);
            saveDedup(dedupRef.current, nowStr);
            changed = true;
            notifyAbsent(profile.name);
          }
        }
      }

      if (changed) { setLogs(updatedLogs); logsRef.current = updatedLogs; saveLogs(updatedLogs); }
    };

    // ── Smart scheduler (mirrors Java scheduleNext) ────────────────────────
    let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (schedulerTimer) clearTimeout(schedulerTimer);
      const now      = getCurrentTime();
      const nowMins  = timeToMinutes(timeToStr(now));
      const nowStr   = dateToStr(now);
      const nowDay   = now.getDay();

      let hasOpen      = false;
      let checkEveryMs = 30_000;
      let inWindow     = false;
      let msToNext     = Infinity;

      for (const profile of profiles.filter(p => p.active)) {
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(nowDay)) continue;
        const ciMins  = timeToMinutes(profile.checkInTime);
        const coMins  = timeToMinutes(profile.checkOutTime);
        const markAfter = profile.markAbsentAfter;
        const freq    = Math.max(1, profile.checkEvery ?? 5);

        if (logsRef.current.some(l =>
          l.profileId === profile.id && l.date === nowStr && l.checkOut === null && l.status !== 'absent')) {
          hasOpen = true;
          checkEveryMs = Math.min(checkEveryMs, freq * 60_000);
        }

        const ciWindowStart = ciMins - 15;
        const ciWindowEnd   = ciMins + markAfter;
        const coWindowStart = coMins - 15;
        const coWindowEnd   = coMins + 15;

        if ((nowMins >= ciWindowStart && nowMins <= ciWindowEnd) ||
            (nowMins >= coWindowStart && nowMins <= coWindowEnd)) {
          inWindow = true;
        }

        for (const ws of [ciWindowStart, coWindowStart]) {
          const minsUntil = ws - nowMins;
          if (minsUntil > 0) msToNext = Math.min(msToNext, minsUntil * 60_000);
        }
      }

      if (hasOpen) {
        tick();
        schedulerTimer = setTimeout(scheduleNext, Math.max(30_000, checkEveryMs));
      } else if (inWindow) {
        tick();
        schedulerTimer = setTimeout(scheduleNext, 30_000);
      } else {
        // Sleep until 15 min before next window
        const sleepMs = msToNext === Infinity
          ? 60 * 60_000
          : Math.max(60_000, msToNext - 15 * 60_000);
        schedulerTimer = setTimeout(scheduleNext, sleepMs);
      }
    };

    // Initial catch-up tick then start scheduler
    tick();
    scheduleNext();
    return () => { if (schedulerTimer) clearTimeout(schedulerTimer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, simulation, currentPosition, getCurrentTime, getCurrentCoords]);

  // ── Profile CRUD ─────────────────────────────────────────────────────────
  const addProfile = useCallback((profile: Omit<LocationProfile, 'id' | 'color'>) => {
    const newProfile: LocationProfile = {
      ...profile, id: generateId(),
      color: ['#10b981','#f59e0b','#6366f1','#ef4444','#8b5cf6','#ec4899','#14b8a6'][profiles.length % 7],
    };
    const updated = [...profiles, newProfile];
    setProfiles(updated); saveProfiles(updated); syncProfilesToNative(updated);
  }, [profiles]);

  const updateProfile = useCallback((id: string, data: Partial<LocationProfile>) => {
    const updated = profiles.map(p => p.id === id ? { ...p, ...data } : p);
    setProfiles(updated); saveProfiles(updated); syncProfilesToNative(updated);
  }, [profiles]);

  const deleteProfile = useCallback((id: string) => {
    const updated = profiles.filter(p => p.id !== id);
    setProfiles(updated); saveProfiles(updated); syncProfilesToNative(updated);
  }, [profiles]);

  const toggleProfile = useCallback((id: string) => {
    const updated = profiles.map(p => p.id === id ? { ...p, active: !p.active } : p);
    setProfiles(updated); saveProfiles(updated); syncProfilesToNative(updated);
  }, [profiles]);

  // ── Manual overrides ─────────────────────────────────────────────────────
  const manualCheckIn = useCallback((profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    const now = getCurrentTime();
    const todayStr = dateToStr(now);
    const alreadyOpen = logsRef.current.some(
      l => l.profileId === profileId && l.checkOut === null && l.date === todayStr && l.status !== 'absent');
    if (alreadyOpen) return;
    const newLog: AttendanceLog = {
      id: generateId(), profileId, profileName: profile.name, date: todayStr,
      checkIn: now.toISOString(), checkOut: null, duration: null,
      status: 'manual', profileColor: profile.color, attended: true,
    };
    const updated = [...logsRef.current, newLog];
    setLogs(updated); logsRef.current = updated; saveLogs(updated);
  }, [profiles, getCurrentTime]);

  const manualCheckOut = useCallback((profileId?: string) => {
    const now = getCurrentTime();
    const todayStr = dateToStr(now);
    const updated = logsRef.current.map(l => {
      // Only close today's open sessions (fixes Bug 7 — stale cross-day close)
      if (l.checkOut !== null || l.date !== todayStr || l.status === 'absent') return l;
      if (profileId && l.profileId !== profileId) return l;
      const duration = safeDuration(now.getTime() - new Date(l.checkIn).getTime());
      const profile  = profiles.find(p => p.id === l.profileId);
      const expMins  = (profile?.expectedHoursPerDay ?? 8) * 60;
      return { ...l, checkOut: now.toISOString(), duration, attended: duration >= expMins * 0.5 };
    });
    setLogs(updated); logsRef.current = updated; saveLogs(updated);
  }, [profiles, getCurrentTime]);

  // ── Simulation ───────────────────────────────────────────────────────────
  const updateSimulation = useCallback((sim: Partial<SimulationState>) => {
    const updated = { ...simulation, ...sim };
    setSimulation(updated); saveSimulation(updated);
  }, [simulation]);

  // ── Summary helpers ──────────────────────────────────────────────────────
  const getWeeklyHours = useCallback(() => {
    const now = getCurrentTime();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    return logsRef.current
      .filter(l => new Date(l.checkIn) >= startOfWeek && l.duration !== null && l.status !== 'absent')
      .reduce((sum, l) => sum + (l.duration || 0), 0);
  }, [getCurrentTime]);

  const getTodayStatus = useCallback(() => {
    const now = getCurrentTime();
    const todayStr = dateToStr(now);
    const todayLogs = logsRef.current.filter(l => l.date === todayStr);
    const open = todayLogs.filter(l => l.checkOut === null && l.status !== 'absent');
    const totalMinutes = todayLogs
      .filter(l => l.status !== 'absent')
      .reduce((s, l) => s + (l.duration || 0), 0);
    return { checkedIn: open.length > 0, totalMinutes, logCount: todayLogs.length, openSessions: open };
  }, [getCurrentTime]);

  const clearLogs = useCallback(() => {
    setLogs([]); logsRef.current = []; saveLogs([]);
  }, []);

  return {
    profiles, logs, simulation, currentPosition, positionError,
    getCurrentTime, getCurrentCoords,
    getTrackingStatus, getOpenSessions,
    addProfile, updateProfile, deleteProfile, toggleProfile,
    manualCheckIn, manualCheckOut, updateSimulation,
    getWeeklyHours, getTodayStatus, clearLogs,
  };
}
