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

async function syncLogsToNative(logs: AttendanceLog[]) {
  if (!isNativeServiceAvailable()) return;
  try {
    await AttendanceServicePlugin.syncLogs({ logs: JSON.stringify(logs) });
  } catch (e) {
    console.warn('[GeoAttend] syncLogs failed:', e);
  }
}

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

/** Normalize minutes into [0, 1439] so windows can wrap across midnight. */
function wrapMins(mins: number): number {
  return ((mins % 1440) + 1440) % 1440;
}

/** True if `now` is inside [start, end]; window may wrap across midnight. */
function inWrappedWindow(now: number, start: number, end: number): boolean {
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

/** Shift date string: post-midnight portion of an overnight shift belongs to yesterday. */
function shiftDateFor(now: Date, postMidnight: boolean): string {
  if (!postMidnight) return dateToStr(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  return dateToStr(y);
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

  const logsRef  = useRef<AttendanceLog[]>(logs);
  const dedupRef = useRef<Set<string>>(new Set());

  useEffect(() => { logsRef.current = logs; }, [logs]);

  // ── Permissions ─────────────────────────────────────────────────────────
  useEffect(() => {
    requestLocationPermission().catch(console.warn);
    requestNotificationPermission().catch(console.warn);
  }, []);

  // ── Native log poll (15 s) ───────────────────────────────────────────────
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

  // ── GPS watch (web/simulation fallback) ──────────────────────────────────
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
    logsRef.current.filter(l => l.checkOut === null && l.status !== 'absent' && l.status !== 'leave'), []);

  const getTrackingStatus = useCallback((): TrackingStatus => {
    const now      = getCurrentTime();
    const todayStr = dateToStr(now);
    const nowMins  = timeToMinutes(timeToStr(now));
    const nowDay   = now.getDay();

    // Open sessions are date-agnostic — overnight sessions stay visible after midnight
    const open = logsRef.current.filter(l => l.checkOut === null && l.status !== 'absent' && l.status !== 'leave');
    if (open.length > 0) return 'checked-in';

    const todayLogs = logsRef.current.filter(l => l.date === todayStr);
    const nonAbsent = todayLogs.filter(l => l.status !== 'absent' && l.status !== 'leave');
    if (nonAbsent.length > 0 && nonAbsent[nonAbsent.length - 1].checkOut) return 'checked-out';

    // 'tracking' = inside active scan window (GPS should be on) but not yet checked in
    // Scan window: [checkInTime - 30] to [checkOutTime + 30], wrap-safe for overnight
    const inWindow = profiles.some(p => {
      if (!p.active) return false;
      const scanStart = wrapMins(timeToMinutes(p.checkInTime) - 30);
      const scanEnd   = wrapMins(timeToMinutes(p.checkOutTime) + 30);
      const overnight = scanEnd < scanStart;
      const postMidnight = overnight && nowMins <= scanEnd;
      const anchorDay = postMidnight ? (nowDay + 6) % 7 : nowDay;
      if (p.workingDays.length > 0 && !p.workingDays.includes(anchorDay)) return false;
      return inWrappedWindow(nowMins, scanStart, scanEnd);
    });
    if (inWindow && (currentPosition !== null || simulation.enabled)) return 'tracking';

    return 'idle';
  }, [getCurrentTime, profiles, currentPosition, simulation.enabled]);

  // ── Core automation tick (web/browser only) ──────────────────────────────
  useEffect(() => {
    if (isNativeServiceAvailable()) return; // Java service owns all tick logic on Android

    // Close stale open sessions from previous days
    const closeStale = () => {
      // Only close sessions that are open LONGER than the shift length + 2 h
      // grace. This keeps legitimately-running overnight sessions (dated
      // yesterday) alive so the geofence exit can close them properly.
      const now = getCurrentTime();
      let updated = [...logsRef.current];
      let changed = false;
      for (const log of updated.filter(l => l.checkOut === null && l.status !== 'absent' && l.status !== 'leave')) {
        const profile = profiles.find(p => p.id === log.profileId);
        if (!profile) continue;
        const shiftLen = wrapMins(timeToMinutes(profile.checkOutTime) - timeToMinutes(profile.checkInTime)) || 480;
        const openMins = safeDuration(now.getTime() - new Date(log.checkIn).getTime());
        if (openMins <= shiftLen + 120) continue; // plausibly still live
        const closeAt = new Date(new Date(log.checkIn).getTime() + shiftLen * 60000);
        const expectedMins = profile.expectedHoursPerDay * 60;
        updated = updated.map(l => l.id === log.id
          ? { ...l, checkOut: closeAt.toISOString(), duration: shiftLen, attended: shiftLen >= expectedMins * 0.5 } : l);
        changed = true;
      }
      if (changed) { setLogs(updated); logsRef.current = updated; saveLogs(updated); }
    };
    closeStale();

    // Mark previous day(s) absent
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

    // ── Tick ──────────────────────────────────────────────────────────────
    const tick = () => {
      const now     = getCurrentTime();
      const coords  = getCurrentCoords();
      if (!coords) return;
      // Never make attendance decisions on a garbage fix (simulation has accuracy 0)
      if (coords.accuracy > 200) return;

      const nowStr  = dateToStr(now);
      const nowMins = timeToMinutes(timeToStr(now));
      const nowDay  = now.getDay();

      if (dedupRef.current.size === 0) {
        dedupRef.current = loadDedup(nowStr);
      }

      let updatedLogs = [...logsRef.current];
      let changed     = false;

      for (const profile of profiles.filter(p => p.active)) {
        const pOvernight = wrapMins(timeToMinutes(profile.checkOutTime) + 30) < wrapMins(timeToMinutes(profile.checkInTime) - 30);
        const pPostMid   = pOvernight && nowMins <= wrapMins(timeToMinutes(profile.checkOutTime) + 30);
        const pAnchorDay = pPostMid ? (nowDay + 6) % 7 : nowDay;
        const pHasOpen   = logsRef.current.some(l => l.profileId === profile.id && l.checkOut === null && l.status !== 'absent' && l.status !== 'leave');
        if (!pHasOpen && profile.workingDays.length > 0 && !profile.workingDays.includes(pAnchorDay)) continue;

        const dist    = calculateDistance(coords.latitude, coords.longitude, profile.latitude, profile.longitude);
        const inFence = dist <= profile.radius;
        const ciMins  = timeToMinutes(profile.checkInTime);
        const coMins  = timeToMinutes(profile.checkOutTime);
        const markAfter = profile.markAbsentAfter;
        const expMins   = profile.expectedHoursPerDay * 60;

        // Shift-date attribution: post-midnight part of an overnight shift → yesterday
        const scanEnd      = wrapMins(coMins + 30);
        const overnight    = scanEnd < wrapMins(ciMins - 30);
        const postMidnight = overnight && nowMins <= scanEnd;
        const shiftStr     = shiftDateFor(now, postMidnight);

        // First check-in window: checkInTime ± markAbsentAfter (requirement).
        // Re-entries after an earlier session are allowed until checkOutTime.
        const windowStart = wrapMins(ciMins - markAfter);
        const windowEnd   = wrapMins(ciMins + markAfter);
        const inFirstWindow   = inWrappedWindow(nowMins, windowStart, windowEnd);
        const inReEntryWindow = inWrappedWindow(nowMins, windowStart, wrapMins(coMins));

        // ── Shift-day rollover: previous shift's session still open when
        // the new shift's window arrives → cap it at its own shift end so
        // today starts a fresh session (prevents giant multi-day records
        // and bogus absent marks). Late work on the same shift is untouched.
        const prevOpen = updatedLogs.find(l =>
          l.profileId === profile.id && l.checkOut === null && l.status !== 'absent' && l.status !== 'leave');
        if (prevOpen && prevOpen.date !== shiftStr
            && inWrappedWindow(nowMins, wrapMins(ciMins - 30), scanEnd)) {
          const shiftLen = wrapMins(coMins - ciMins) || 480;
          const elapsed = safeDuration(now.getTime() - new Date(prevOpen.checkIn).getTime());
          if (elapsed > shiftLen) {
            const capAt = new Date(Math.min(now.getTime(),
              new Date(prevOpen.checkIn).getTime() + shiftLen * 60000));
            updatedLogs = updatedLogs.map(l => l.id === prevOpen.id
              ? { ...l, checkOut: capAt.toISOString(), duration: shiftLen, attended: shiftLen >= expMins * 0.5 }
              : l);
            changed = true;
          }
        }

        // Open sessions are date-agnostic — overnight sessions survive midnight
        const hasOpen = updatedLogs.some(l =>
          l.profileId === profile.id && l.checkOut === null && l.status !== 'absent' && l.status !== 'leave');
        const sessionCount = updatedLogs.filter(l =>
          l.profileId === profile.id && l.date === shiftStr && l.status !== 'absent' && l.status !== 'leave').length;
        const inCheckInWindow = sessionCount > 0 ? inReEntryWindow : inFirstWindow;

        // ── AUTO CHECK-IN: geofence entry within window ─────────────────
        // No time-gate — geofence alone determines presence.
        if (!hasOpen && inFence && inCheckInWindow) {
          const absentMarked = updatedLogs.some(
            l => l.profileId === profile.id && l.date === shiftStr && l.status === 'absent');
          const ciKey = sessionCount === 0
            ? `checkin:${profile.id}:${shiftStr}`
            : `reentry:${profile.id}:${shiftStr}:${sessionCount}`;

          if (!absentMarked && !dedupRef.current.has(ciKey)) {
            const newLog: AttendanceLog = {
              id: generateId(), profileId: profile.id, profileName: profile.name,
              date: shiftStr, checkIn: now.toISOString(),
              checkOut: null, duration: null, status: 'auto', profileColor: profile.color, attended: true,
            };
            updatedLogs = [...updatedLogs, newLog];
            dedupRef.current.add(ciKey);
            saveDedup(dedupRef.current, nowStr);
            changed = true;
            if (profile.notificationsEnabled) notifyCheckIn(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          }
        }

        const openLog = updatedLogs.find(
          l => l.profileId === profile.id && l.checkOut === null && l.status !== 'absent' && l.status !== 'leave');

        // NOTE: time-based scheduled checkout REMOVED — check-out is
        // triggered exclusively by geofence exit, per requirements.

        // ── AUTO CHECK-OUT: geofence exit (2 consecutive out-of-fence ticks) ──
        if (openLog && !inFence) {
          const pendingKey = `exitpending:${openLog.id}`;
          const exitKey    = `exit:${openLog.id}`;
          const sessionMins = safeDuration(now.getTime() - new Date(openLog.checkIn).getTime());
          if (sessionMins >= 5 && !dedupRef.current.has(exitKey)) {
            if (dedupRef.current.has(pendingKey)) {
              const duration = safeDuration(now.getTime() - new Date(openLog.checkIn).getTime());
              updatedLogs = updatedLogs.map(l => l.id === openLog.id
                ? { ...l, checkOut: now.toISOString(), duration, attended: duration >= expMins * 0.5, status: 'auto' as const }
                : l);
              dedupRef.current.add(exitKey);
              dedupRef.current.delete(pendingKey);
              saveDedup(dedupRef.current, nowStr);
              changed = true;
              if (profile.notificationsEnabled) notifyGeofenceExit(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            } else {
              dedupRef.current.add(pendingKey);
              saveDedup(dedupRef.current, nowStr);
            }
          }
        } else if (openLog && inFence) {
          dedupRef.current.delete(`exitpending:${openLog.id}`);
        }

        // ── MARK ABSENT ──────────────────────────────────────────────────
        // Past the check-in window but before scan end — wrap-safe for overnight
        const pastWindow = inWrappedWindow(nowMins, wrapMins(ciMins + markAfter + 1), scanEnd);
        if (!openLog && !inFence && pastWindow) {
          const absentKey = `absent:${profile.id}:${shiftStr}`;
          const hasAnyLog = updatedLogs.some(l => l.profileId === profile.id && l.date === shiftStr);
          if (!hasAnyLog && !dedupRef.current.has(absentKey)) {
            updatedLogs = [...updatedLogs, {
              id: generateId(), profileId: profile.id, profileName: profile.name,
              date: shiftStr,
              checkIn: `${shiftStr}T${profile.checkInTime}:00+05:30`,
              checkOut: null, duration: null, status: 'absent' as const,
              profileColor: profile.color, attended: false,
            }];
            dedupRef.current.add(absentKey);
            saveDedup(dedupRef.current, nowStr);
            changed = true;
            if (profile.notificationsEnabled) notifyAbsent(profile.name);
          }
        }
      }

      if (changed) { setLogs(updatedLogs); logsRef.current = updatedLogs; saveLogs(updatedLogs); }
    };

    // ── Smart scheduler (mirrors Java scheduleNext) ───────────────────────
    let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (schedulerTimer) clearTimeout(schedulerTimer);
      const now     = getCurrentTime();
      const nowMins = timeToMinutes(timeToStr(now));
      const nowDay  = now.getDay();

      let inScanWindow = false;
      let hasOpen      = false;
      let msToNext     = Infinity;

      for (const profile of profiles.filter(p => p.active)) {
        const ciMins    = timeToMinutes(profile.checkInTime);
        const coMins    = timeToMinutes(profile.checkOutTime);
        // Requirement: scanning starts exactly 30 min before check-in time
        const scanStart = wrapMins(ciMins - 30);
        const scanEnd   = wrapMins(coMins + 30);

        // Open sessions always keep the scheduler active (date-agnostic,
        // checked before the working-day filter — overnight-safe)
        if (logsRef.current.some(l =>
          l.profileId === profile.id && l.checkOut === null && l.status !== 'absent' && l.status !== 'leave')) {
          hasOpen = true;
          inScanWindow = true;
        }

        const overnight    = scanEnd < scanStart;
        const postMidnight = overnight && nowMins <= scanEnd;
        const anchorDay    = postMidnight ? (nowDay + 6) % 7 : nowDay;
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(anchorDay)) continue;

        if (inWrappedWindow(nowMins, scanStart, scanEnd)) {
          inScanWindow = true;
        } else {
          const ms = wrapMins(scanStart - nowMins) * 60_000;
          if (ms < msToNext) msToNext = ms;
        }
      }

      if (inScanWindow || hasOpen) {
        tick();
        schedulerTimer = setTimeout(scheduleNext, 30_000);
      } else {
        // Sleep until 1 min before next scan window
        const sleepMs = msToNext === Infinity
          ? 60 * 60_000
          : Math.max(60_000, msToNext - 60_000);
        schedulerTimer = setTimeout(scheduleNext, sleepMs);
      }
    };

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
      .filter(l => new Date(l.checkIn) >= startOfWeek && l.status !== 'absent' && l.status !== 'leave')
      .reduce((sum, l) => {
        if (l.duration !== null) return sum + l.duration;
        if (l.checkOut === null) return sum + Math.max(0, (now.getTime() - new Date(l.checkIn).getTime()) / 60000);
        return sum;
      }, 0);
  }, [getCurrentTime]);

  const getTodayStatus = useCallback(() => {
    const now = getCurrentTime();
    const todayStr = dateToStr(now);
    const todayLogs = logsRef.current.filter(l => l.date === todayStr);
    const open = todayLogs.filter(l => l.checkOut === null && l.status !== 'absent' && l.status !== 'leave');
    const totalMinutes = todayLogs
      .filter(l => l.status !== 'absent' && l.status !== 'leave')
      .reduce((s, l) => {
        if (l.duration !== null) return s + l.duration;
        if (l.checkOut === null) return s + Math.max(0, (now.getTime() - new Date(l.checkIn).getTime()) / 60000);
        return s;
      }, 0);
    return { checkedIn: open.length > 0, totalMinutes, logCount: todayLogs.length, openSessions: open };
  }, [getCurrentTime]);

  const clearLogs = useCallback(() => {
    setLogs([]); logsRef.current = []; saveLogs([]); syncLogsToNative([]);
  }, []);

  // ── Manual record corrections ─────────────────────────────────────────────
  const applyLogs = useCallback((updated: AttendanceLog[]) => {
    setLogs(updated); logsRef.current = updated; saveLogs(updated); syncLogsToNative(updated);
  }, []);

  /** Add a manual attendance record (GPS missed a check-in, dead battery, etc.) */
  const addManualRecord = useCallback((profileId: string, date: string, checkIn: string, checkOut: string | null) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    const inISO  = `${date}T${checkIn}:00+05:30`;
    const outISO = checkOut ? `${date}T${checkOut}:00+05:30` : null;
    let duration: number | null = null;
    if (outISO) {
      duration = Math.max(0, Math.round((new Date(outISO).getTime() - new Date(inISO).getTime()) / 60000));
      if (duration === 0) duration = null;
    }
    const expMins = profile.expectedHoursPerDay * 60;
    const newLog: AttendanceLog = {
      id: generateId(), profileId, profileName: profile.name, date,
      checkIn: inISO, checkOut: outISO, duration,
      status: 'manual', profileColor: profile.color,
      attended: duration !== null ? duration >= expMins * 0.5 : true,
    };
    applyLogs([...logsRef.current, newLog]);
  }, [profiles, applyLogs]);

  /** Edit an existing record's times (marked as manual correction). */
  const updateRecord = useCallback((logId: string, checkIn: string, checkOut: string | null) => {
    const log = logsRef.current.find(l => l.id === logId);
    if (!log) return;
    const profile = profiles.find(p => p.id === log.profileId);
    const inISO  = `${log.date}T${checkIn}:00+05:30`;
    const outISO = checkOut ? `${log.date}T${checkOut}:00+05:30` : null;
    let duration: number | null = null;
    if (outISO) duration = Math.max(0, Math.round((new Date(outISO).getTime() - new Date(inISO).getTime()) / 60000));
    const expMins = (profile?.expectedHoursPerDay ?? 8) * 60;
    applyLogs(logsRef.current.map(l => l.id === logId
      ? { ...l, checkIn: inISO, checkOut: outISO, duration,
          status: 'manual' as const,
          attended: duration !== null ? duration >= expMins * 0.5 : true }
      : l));
  }, [profiles, applyLogs]);

  const deleteRecord = useCallback((logId: string) => {
    applyLogs(logsRef.current.filter(l => l.id !== logId));
  }, [applyLogs]);

  /** Restore a full backup (profiles + logs), replacing current data. */
  const restoreBackup = useCallback((newProfiles: LocationProfile[], newLogs: AttendanceLog[]) => {
    setProfiles(newProfiles); saveProfiles(newProfiles); syncProfilesToNative(newProfiles);
    applyLogs(newLogs);
  }, [applyLogs]);

  /** Mark a date as leave/holiday for a profile (or all profiles when profileId is null).
   *  Leave blocks absent-marking on that date and doesn't break the streak. */
  const markLeave = useCallback((date: string, profileId: string | null) => {
    const targets = profileId ? profiles.filter(p => p.id === profileId) : profiles;
    let updated = [...logsRef.current];
    for (const p of targets) {
      // Skip if any record already exists for this profile+date
      if (updated.some(l => l.profileId === p.id && l.date === date)) continue;
      updated = [...updated, {
        id: generateId(), profileId: p.id, profileName: p.name, date,
        checkIn: `${date}T${p.checkInTime}:00+05:30`,
        checkOut: null, duration: null,
        status: 'leave' as const, profileColor: p.color, attended: false,
      }];
    }
    applyLogs(updated);
  }, [profiles, applyLogs]);

  return {
    profiles, logs, simulation, currentPosition, positionError,
    getCurrentTime, getCurrentCoords,
    getTrackingStatus, getOpenSessions,
    addProfile, updateProfile, deleteProfile, toggleProfile,
    updateSimulation,
    getWeeklyHours, getTodayStatus, clearLogs,
    addManualRecord, updateRecord, deleteRecord, markLeave, restoreBackup,
  };
}
