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

interface ProcessedCheckIn {
  profileId: string;
  date: string;
  timeKey: string;
}

const PROCESSED_KEY = 'geo_attendance_processed';
const ABSENT_PROCESSED_KEY = 'geo_attendance_absent_processed';

function loadProcessedFromStorage(key: string, currentDateStr: string): ProcessedCheckIn[] {
  try {
    const data = localStorage.getItem(key);
    if (!data) return [];
    const parsed: ProcessedCheckIn[] = JSON.parse(data);
    return parsed.filter(p => p.date === currentDateStr);
  } catch {
    return [];
  }
}

function saveProcessedToStorage(key: string, entries: ProcessedCheckIn[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(entries));
  } catch { /* noop */ }
}

// ── FIX 2: helper — push profiles to Java SharedPreferences ─────────────────
// Called after every profile add/update/delete/toggle so the background
// ForegroundService always has the latest office locations and schedules.
async function syncProfilesToNative(profiles: LocationProfile[]) {
  if (!isNativeServiceAvailable()) return;
  try {
    await AttendanceServicePlugin.syncProfiles({ profiles: JSON.stringify(profiles) });
  } catch (e) {
    console.warn('[GeoAttend] syncProfiles failed:', e);
  }
}

// ── FIX 5: merge logs written by Java back into React state ─────────────────
// Java writes check-ins to SharedPreferences; React reads from localStorage.
// These are separate stores. We poll getLogs() from the native service and
// merge any new entries the service added while the screen was locked.
async function mergeNativeLogs(currentLogs: AttendanceLog[]): Promise<AttendanceLog[] | null> {
  if (!isNativeServiceAvailable()) return null;
  try {
    const result = await AttendanceServicePlugin.getLogs();
    const nativeLogs: AttendanceLog[] = JSON.parse(result.logs);
    if (!nativeLogs.length) return null;

    // Build a set of existing IDs for fast lookup
    const existingIds = new Set(currentLogs.map(l => l.id));
    const newEntries = nativeLogs.filter(l => !existingIds.has(l.id));

    // Also update any logs the service modified (e.g. added checkOut)
    const nativeById = new Map(nativeLogs.map(l => [l.id, l]));
    let changed = newEntries.length > 0;
    const merged = currentLogs.map(l => {
      const native = nativeById.get(l.id);
      if (native && native.checkOut !== l.checkOut) {
        changed = true;
        return native; // service filled in checkOut
      }
      return l;
    });

    if (!changed) return null;
    return [...merged, ...newEntries];
  } catch (e) {
    console.warn('[GeoAttend] mergeNativeLogs failed:', e);
    return null;
  }
}

export function useAutomation() {
  const [profiles, setProfiles] = useState<LocationProfile[]>(getProfiles);
  const [logs, setLogs] = useState<AttendanceLog[]>(getLogs);
  const [simulation, setSimulation] = useState<SimulationState>(getSimulation);
  const [currentPosition, setCurrentPosition] = useState<PositionData | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);

  const processedRef = useRef<ProcessedCheckIn[]>([]);
  const absentProcessedRef = useRef<ProcessedCheckIn[]>([]);
  const logsRef = useRef<AttendanceLog[]>(logs);

  useEffect(() => {
    logsRef.current = logs;
  }, [logs]);

  // ── Request permissions on mount ──────────────────────────────────────────
  useEffect(() => {
    requestLocationPermission().catch(console.warn);
    requestNotificationPermission().catch(console.warn);
  }, []);

  // ── FIX 5: Poll native logs every 15s to sync background check-ins to UI ──
  // When the screen is locked, the Java service records events into
  // SharedPreferences. React's localStorage never gets updated. We poll
  // the native bridge and merge any new/updated logs into React state.
  useEffect(() => {
    if (!isNativeServiceAvailable()) return;

    const poll = async () => {
      const merged = await mergeNativeLogs(logsRef.current);
      if (merged) {
        setLogs(merged);
        logsRef.current = merged;
        saveLogs(merged); // keep localStorage in sync for next cold start
      }
    };

    // Initial poll shortly after mount (service may already have data)
    const initialTimer = setTimeout(poll, 3000);
    // Then poll every 15s
    const interval = setInterval(poll, 15000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, []); // run once — logsRef.current always has latest value

  const getCurrentTime = useCallback(() => {
    const now = new Date();
    if (simulation.enabled && simulation.timeOffset !== 0) {
      return new Date(now.getTime() + simulation.timeOffset * 60000);
    }
    return now;
  }, [simulation.enabled, simulation.timeOffset]);

  const getCurrentCoords = useCallback(() => {
    if (simulation.enabled) {
      return { latitude: simulation.latitude, longitude: simulation.longitude, accuracy: 0, timestamp: Date.now() };
    }
    return currentPosition;
  }, [simulation, currentPosition]);

  // ── Native location watch ─────────────────────────────────────────────────
  useEffect(() => {
    if (simulation.enabled) return;

    let active = true;

    const start = async () => {
      try {
        const pos = await getNativePosition();
        if (active) { setCurrentPosition(pos); setPositionError(null); }
      } catch (e) {
        if (active) setPositionError('Unable to get location');
      }

      await startLocationWatch(
        (pos) => { if (active) { setCurrentPosition(pos); setPositionError(null); } },
        () => { if (active) setPositionError('Location watch failed'); }
      );
    };

    start();
    return () => {
      active = false;
      stopLocationWatch();
    };
  }, [simulation.enabled]);

  const getOpenSessions = useCallback(() => {
    return logsRef.current.filter(l => l.checkOut === null && l.status !== 'absent');
  }, []);

  const getTrackingStatus = useCallback((): TrackingStatus => {
    const open = logsRef.current.filter(l => l.checkOut === null && l.status !== 'absent');
    if (open.length > 0) return 'checked-in';
    if (logsRef.current.length > 0) {
      const nonAbsent = logsRef.current.filter(l => l.status !== 'absent');
      if (nonAbsent.length > 0) {
        const latest = nonAbsent[nonAbsent.length - 1];
        if (latest.checkOut) return 'checked-out';
      }
    }
    return 'idle';
  }, []);

  // ── Core automation tick ──────────────────────────────────────────────────
  // When running as a native Android APK, AttendanceForegroundService.java owns
  // ALL tick logic (GPS poll, geofence check, check-in/out/absent writes).
  // Running the JS tick simultaneously causes duplicate records and race conditions.
  // We skip the entire JS tick and rely solely on the native service + the
  // mergeNativeLogs() poll above to keep the UI in sync.
  useEffect(() => {
    if (isNativeServiceAvailable()) {
      // Java service is running — JS tick is intentionally disabled.
      // The mergeNativeLogs() interval (above) keeps React state up-to-date.
      return;
    }

    // ── Web / browser fallback tick (no native service available) ────────────
    const tick = (isCatchUp = false) => {
      const now = getCurrentTime();
      const currentTimeStr = timeToStr(now);
      const coords = getCurrentCoords();
      if (!coords) return;

      const activeProfiles = profiles.filter(p => p.active);
      const currentDateStr = dateToStr(now);
      const currentDay = now.getDay();

      let logsChanged = false;
      let updatedLogs = [...logsRef.current];

      if (processedRef.current.length === 0) {
        processedRef.current = loadProcessedFromStorage(PROCESSED_KEY, currentDateStr);
      }
      if (absentProcessedRef.current.length === 0) {
        absentProcessedRef.current = loadProcessedFromStorage(ABSENT_PROCESSED_KEY, currentDateStr);
      }

      processedRef.current = processedRef.current.filter(p => {
        if (p.date !== currentDateStr) return false;
        if (p.timeKey.startsWith('exit:')) return true;
        if (p.timeKey.startsWith('entry:')) {
          const entryMins = timeToMinutes(p.timeKey.slice(6));
          return Math.abs(timeToMinutes(currentTimeStr) - entryMins) < 2;
        }
        return false;
      });
      absentProcessedRef.current = absentProcessedRef.current.filter(
        p => p.date === currentDateStr
      );

      for (const profile of activeProfiles) {
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(currentDay)) continue;

        const dist = calculateDistance(coords.latitude, coords.longitude, profile.latitude, profile.longitude);
        const isWithinRadius = dist <= profile.radius;

        const hasOpenSession = updatedLogs.some(
          l => l.profileId === profile.id && l.checkOut === null
            && l.date === currentDateStr && l.status !== 'absent'
        );

        // ── AUTO CHECK-IN ──────────────────────────────────────────────────
        if (!hasOpenSession && isWithinRadius) {
          const checkInMins = timeToMinutes(profile.checkInTime);
          const currentMins = timeToMinutes(currentTimeStr);
          const withinCheckInWindow =
            currentMins >= checkInMins &&
            currentMins <= checkInMins + profile.markAbsentAfter;

          const absentMarked = updatedLogs.some(
            l => l.profileId === profile.id && l.date === currentDateStr && l.status === 'absent'
          );

          const entryKey = `entry:${currentTimeStr.slice(0, 5)}`;
          const alreadyProcessedEntry = processedRef.current.some(
            p => p.profileId === profile.id && p.date === currentDateStr && p.timeKey === entryKey
          );

          if (withinCheckInWindow && !absentMarked && !alreadyProcessedEntry) {
            const newLog: AttendanceLog = {
              id: generateId(),
              profileId: profile.id,
              profileName: profile.name,
              date: currentDateStr,
              checkIn: now.toISOString(),
              checkOut: null,
              duration: null,
              status: 'auto',
              profileColor: profile.color,
              attended: true,
            };
            updatedLogs = [...updatedLogs, newLog];
            logsChanged = true;
            processedRef.current.push({ profileId: profile.id, date: currentDateStr, timeKey: entryKey });
            saveProcessedToStorage(PROCESSED_KEY, processedRef.current);
            notifyCheckIn(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          }
        }

        // ── AUTO CHECK-OUT: geofence exit ──────────────────────────────────
        if (hasOpenSession && !isWithinRadius) {
          const openLog = updatedLogs.find(
            l => l.profileId === profile.id && l.checkOut === null && l.date === currentDateStr
          );
          if (openLog) {
            const timeSinceCheckIn = (now.getTime() - new Date(openLog.checkIn).getTime()) / 60000;
            if (timeSinceCheckIn > 5) {
              const exitKey = `exit:${openLog.id}`;
              const alreadyProcessedExit = processedRef.current.some(
                p => p.profileId === profile.id && p.date === currentDateStr && p.timeKey === exitKey
              );
              if (!alreadyProcessedExit) {
                const duration = Math.round((now.getTime() - new Date(openLog.checkIn).getTime()) / 60000);
                const expectedMinutes = profile.expectedHoursPerDay * 60;
                const attended = duration >= expectedMinutes * 0.5;
                updatedLogs = updatedLogs.map(l =>
                  l.id === openLog.id
                    ? { ...l, checkOut: now.toISOString(), duration, attended, status: 'auto' as const }
                    : l
                );
                logsChanged = true;
                processedRef.current.push({ profileId: profile.id, date: currentDateStr, timeKey: exitKey });
                saveProcessedToStorage(PROCESSED_KEY, processedRef.current);
                notifyGeofenceExit(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
              }
            }
          }
        }

        // ── MARK ABSENT ────────────────────────────────────────────────────
        const checkInMinutes = timeToMinutes(profile.checkInTime);
        const currentMinutes = timeToMinutes(currentTimeStr);
        if (currentMinutes > checkInMinutes + profile.markAbsentAfter && !hasOpenSession && !isWithinRadius) {
          const existingLog = updatedLogs.find(l => l.profileId === profile.id && l.date === currentDateStr);
          const alreadyMarkedAbsent = absentProcessedRef.current.some(
            p => p.profileId === profile.id && p.date === currentDateStr
          );
          if (!existingLog && !alreadyMarkedAbsent) {
            const absentLog: AttendanceLog = {
              id: generateId(),
              profileId: profile.id,
              profileName: profile.name,
              date: currentDateStr,
              checkIn: `${currentDateStr}T${profile.checkInTime}:00`,
              checkOut: null,
              duration: null,
              status: 'absent',
              profileColor: profile.color,
              attended: false,
            };
            updatedLogs = [...updatedLogs, absentLog];
            logsChanged = true;
            absentProcessedRef.current.push({ profileId: profile.id, date: currentDateStr, timeKey: 'absent' });
            saveProcessedToStorage(ABSENT_PROCESSED_KEY, absentProcessedRef.current);
            notifyAbsent(profile.name);
          }
        }
      }

      if (logsChanged) {
        setLogs(updatedLogs);
        logsRef.current = updatedLogs;
        saveLogs(updatedLogs);
      }
    };

    tick(true);

    const closeStaleOpenSessions = () => {
      const now = getCurrentTime();
      const currentDateStr = dateToStr(now);
      let updated = [...logsRef.current];
      let changed = false;
      const openLogs = updated.filter(l => l.checkOut === null && l.status !== 'absent');
      for (const openLog of openLogs) {
        const profile = profiles.find(p => p.id === openLog.profileId);
        if (!profile) continue;
        const isToday = openLog.date === currentDateStr;
        if (!isToday) {
          const logDate = openLog.date;
          const checkOutMoment = new Date(`${logDate}T${profile.checkOutTime}:00`);
          if (checkOutMoment < now) {
            const duration = Math.max(0, Math.round((checkOutMoment.getTime() - new Date(openLog.checkIn).getTime()) / 60000));
            const attended = duration >= profile.expectedHoursPerDay * 60 * 0.5;
            updated = updated.map(l =>
              l.id === openLog.id ? { ...l, checkOut: checkOutMoment.toISOString(), duration, attended } : l
            );
            changed = true;
          }
        }
      }
      if (changed) { setLogs(updated); logsRef.current = updated; saveLogs(updated); }
    };
    closeStaleOpenSessions();

    const markPreviousDayAbsent = () => {
      const now = getCurrentTime();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = dateToStr(yesterday);
      let updated = [...logsRef.current];
      let changed = false;
      for (const profile of profiles.filter(p => p.active)) {
        const checkInMins = timeToMinutes(profile.checkInTime);
        if (checkInMins < 20 * 60) continue;
        const alreadyHasLog = updated.some(l => l.profileId === profile.id && l.date === yesterdayStr);
        if (alreadyHasLog) continue;
        updated = [...updated, {
          id: generateId(), profileId: profile.id, profileName: profile.name,
          date: yesterdayStr, checkIn: `${yesterdayStr}T${profile.checkInTime}:00`,
          checkOut: null, duration: null, status: 'absent' as const,
          profileColor: profile.color, attended: false,
        }];
        changed = true;
      }
      if (changed) { setLogs(updated); logsRef.current = updated; saveLogs(updated); }
    };
    markPreviousDayAbsent();

    let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

    const getActiveScanInterval = (): number => {
      const now = getCurrentTime();
      const currentMins = timeToMinutes(timeToStr(now));
      const currentDateStr = dateToStr(now);
      const currentDay = now.getDay();
      let minInterval = Infinity;
      for (const profile of profiles.filter(p => p.active)) {
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(currentDay)) continue;
        const ci = timeToMinutes(profile.checkInTime);
        const co = timeToMinutes(profile.checkOutTime);
        const hasLiveSession = logsRef.current.some(
          l => l.profileId === profile.id && l.checkOut === null
            && l.date === currentDateStr && l.status !== 'absent'
        );
        const inPreCheckIn = currentMins >= (ci - 15) && currentMins <= (ci + profile.markAbsentAfter);
        const inCheckOut = currentMins >= (co - 15) && currentMins <= (co + 15);
        if (hasLiveSession) {
          const intervalMs = Math.max(1, profile.checkEvery ?? 5) * 60 * 1000;
          minInterval = Math.min(minInterval, intervalMs);
        } else if (inPreCheckIn || inCheckOut) {
          minInterval = Math.min(minInterval, 30 * 1000);
        }
      }
      return minInterval === Infinity ? -1 : minInterval;
    };

    const getMsUntilNextWindow = (): number => {
      const now = getCurrentTime();
      const currentMins = timeToMinutes(timeToStr(now));
      const currentDay = now.getDay();
      let minWait = 24 * 60 * 60 * 1000;
      for (const profile of profiles.filter(p => p.active)) {
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(currentDay)) continue;
        const ci = timeToMinutes(profile.checkInTime);
        const co = timeToMinutes(profile.checkOutTime);
        for (const windowStart of [ci - 15, co - 15]) {
          if (windowStart > currentMins) {
            minWait = Math.min(minWait, (windowStart - currentMins) * 60 * 1000);
          }
        }
      }
      return minWait;
    };

    const scheduleNext = () => {
      if (schedulerTimer) clearTimeout(schedulerTimer);
      const interval = getActiveScanInterval();
      if (interval > 0) {
        tick(false);
        schedulerTimer = setTimeout(scheduleNext, interval);
      } else {
        const waitMs = getMsUntilNextWindow();
        schedulerTimer = setTimeout(scheduleNext, waitMs);
      }
    };

    scheduleNext();
    return () => { if (schedulerTimer) clearTimeout(schedulerTimer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, simulation, currentPosition, getCurrentTime, getCurrentCoords]);

  // ── Profile CRUD — FIX 2: sync to native after every change ───────────────
  const addProfile = useCallback((profile: Omit<LocationProfile, 'id' | 'color'>) => {
    const newProfile: LocationProfile = {
      ...profile,
      id: generateId(),
      color: ['#10b981', '#f59e0b', '#6366f1', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'][profiles.length % 7],
    };
    const updated = [...profiles, newProfile];
    setProfiles(updated);
    saveProfiles(updated);
    syncProfilesToNative(updated); // FIX 2
  }, [profiles]);

  const updateProfile = useCallback((id: string, data: Partial<LocationProfile>) => {
    const updated = profiles.map(p => p.id === id ? { ...p, ...data } : p);
    setProfiles(updated);
    saveProfiles(updated);
    syncProfilesToNative(updated); // FIX 2
  }, [profiles]);

  const deleteProfile = useCallback((id: string) => {
    const updated = profiles.filter(p => p.id !== id);
    setProfiles(updated);
    saveProfiles(updated);
    syncProfilesToNative(updated); // FIX 2
  }, [profiles]);

  const toggleProfile = useCallback((id: string) => {
    const updated = profiles.map(p => p.id === id ? { ...p, active: !p.active } : p);
    setProfiles(updated);
    saveProfiles(updated);
    syncProfilesToNative(updated); // FIX 2
  }, [profiles]);

  // Manual check-in
  const manualCheckIn = useCallback((profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    const now = getCurrentTime();
    const currentDateStr = dateToStr(now);
    const alreadyOpen = logsRef.current.some(
      l => l.profileId === profileId && l.checkOut === null
        && l.date === currentDateStr && l.status !== 'absent'
    );
    if (alreadyOpen) return;
    const newLog: AttendanceLog = {
      id: generateId(), profileId, profileName: profile.name,
      date: currentDateStr, checkIn: now.toISOString(),
      checkOut: null, duration: null, status: 'manual',
      profileColor: profile.color, attended: true,
    };
    const updated = [...logsRef.current, newLog];
    setLogs(updated);
    logsRef.current = updated;
    saveLogs(updated);
  }, [profiles, getCurrentTime]);

  // Manual check-out
  const manualCheckOut = useCallback((profileId?: string) => {
    const now = getCurrentTime();
    const currentDateStr = dateToStr(now);
    let updated = [...logsRef.current];
    if (profileId) {
      updated = updated.map(l => {
        if (l.profileId === profileId && l.checkOut === null && l.date === currentDateStr) {
          const duration = (now.getTime() - new Date(l.checkIn).getTime()) / 60000;
          const profile = profiles.find(p => p.id === profileId);
          const expectedMinutes = (profile?.expectedHoursPerDay ?? 8) * 60;
          return { ...l, checkOut: now.toISOString(), duration: Math.round(duration), attended: duration >= expectedMinutes * 0.5 };
        }
        return l;
      });
    } else {
      updated = updated.map(l => {
        if (l.checkOut === null) {
          const duration = (now.getTime() - new Date(l.checkIn).getTime()) / 60000;
          const profile = profiles.find(p => p.id === l.profileId);
          const expectedMinutes = (profile?.expectedHoursPerDay ?? 8) * 60;
          return { ...l, checkOut: now.toISOString(), duration: Math.round(duration), attended: duration >= expectedMinutes * 0.5 };
        }
        return l;
      });
    }
    setLogs(updated);
    logsRef.current = updated;
    saveLogs(updated);
  }, [profiles, getCurrentTime]);

  const updateSimulation = useCallback((sim: Partial<SimulationState>) => {
    const updated = { ...simulation, ...sim };
    setSimulation(updated);
    saveSimulation(updated);
  }, [simulation]);

  const getWeeklyHours = useCallback(() => {
    const now = getCurrentTime();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const weekLogs = logsRef.current.filter(l => {
      const d = new Date(l.checkIn);
      return d >= startOfWeek && l.duration !== null && l.status !== 'absent';
    });
    return weekLogs.reduce((sum, l) => sum + (l.duration || 0), 0);
  }, [getCurrentTime]);

  const getTodayStatus = useCallback(() => {
    const now = getCurrentTime();
    const todayStr = dateToStr(now);
    const todayLogs = logsRef.current.filter(l => l.date === todayStr);
    const openSessions = todayLogs.filter(l => l.checkOut === null && l.status !== 'absent');
    const totalMinutes = todayLogs.filter(l => l.status !== 'absent').reduce((sum, l) => sum + (l.duration || 0), 0);
    return { checkedIn: openSessions.length > 0, totalMinutes, logCount: todayLogs.length, openSessions };
  }, [getCurrentTime]);

  const clearLogs = useCallback(() => {
    setLogs([]);
    logsRef.current = [];
    saveLogs([]);
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

function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + (m || 0);
}
