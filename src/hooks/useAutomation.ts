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
  notifyCheckOut,
  notifyAbsent,
  notifyGeofenceExit,
} from '../services/capacitor';

// Track which profiles have open sessions and which we've already processed this minute
interface ProcessedCheckIn {
  profileId: string;
  date: string;
  timeKey: string; // HH:mm or special key
}

const PROCESSED_KEY = 'geo_attendance_processed';
const ABSENT_PROCESSED_KEY = 'geo_attendance_absent_processed';

function loadProcessedFromStorage(key: string, currentDateStr: string): ProcessedCheckIn[] {
  try {
    const data = localStorage.getItem(key);
    if (!data) return [];
    const parsed: ProcessedCheckIn[] = JSON.parse(data);
    // Only keep entries for today
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

export function useAutomation() {
  const [profiles, setProfiles] = useState<LocationProfile[]>(getProfiles);
  const [logs, setLogs] = useState<AttendanceLog[]>(getLogs);
  const [simulation, setSimulation] = useState<SimulationState>(getSimulation);
  const [currentPosition, setCurrentPosition] = useState<PositionData | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);

  // Use refs for processed state — persisted to localStorage across restarts
  const processedRef = useRef<ProcessedCheckIn[]>([]);
  const absentProcessedRef = useRef<ProcessedCheckIn[]>([]);
  // Keep logs in a ref so the tick effect doesn't need logs in its deps (fix #9)
  const logsRef = useRef<AttendanceLog[]>(logs);

  // Keep logsRef in sync with logs state
  useEffect(() => {
    logsRef.current = logs;
  }, [logs]);

  // ── Request permissions on mount ──────────────────────────────────────────
  useEffect(() => {
    requestLocationPermission().catch(console.warn);
    requestNotificationPermission().catch(console.warn);
  }, []);

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

  // Derive tracking state from logs
  // Fix B6: exclude absent logs from open session detection
  const getOpenSessions = useCallback(() => {
    return logsRef.current.filter(l => l.checkOut === null && l.status !== 'absent');
  }, []);

  const getTrackingStatus = useCallback((): TrackingStatus => {
    // Fix B6: absent logs must not count as 'checked-in'
    const open = logsRef.current.filter(l => l.checkOut === null && l.status !== 'absent');
    if (open.length > 0) return 'checked-in';
    if (logsRef.current.length > 0) {
      // Find latest non-absent log for status
      const nonAbsent = logsRef.current.filter(l => l.status !== 'absent');
      if (nonAbsent.length > 0) {
        const latest = nonAbsent[nonAbsent.length - 1];
        if (latest.checkOut) return 'checked-out';
      }
    }
    return 'idle';
  }, []);

  // ── Core automation tick ──────────────────────────────────────────────────
  // profiles and simulation in deps — but NOT logs (use logsRef instead, fix #9)
  useEffect(() => {
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

      // Load processed state from localStorage on first tick (restores across app restarts — fix #3)
      if (processedRef.current.length === 0) {
        processedRef.current = loadProcessedFromStorage(PROCESSED_KEY, currentDateStr);
      }
      if (absentProcessedRef.current.length === 0) {
        absentProcessedRef.current = loadProcessedFromStorage(ABSENT_PROCESSED_KEY, currentDateStr);
      }

      // Pruning: keep exit: keys all day (deduplicate geofence exit per session).
      // entry: keys are per-minute — prune after 2 min so re-entry next hour gets a fresh key.
      processedRef.current = processedRef.current.filter(p => {
        if (p.date !== currentDateStr) return false;
        // exit: keys kept all day — scoped to session id, never expire
        if (p.timeKey.startsWith('exit:')) return true;
        // entry: keys are HH:MM — keep only if within 2 min of current time
        if (p.timeKey.startsWith('entry:')) {
          const entryMins = timeToMinutes(p.timeKey.slice(6)); // strip 'entry:'
          return Math.abs(timeToMinutes(currentTimeStr) - entryMins) < 2;
        }
        return false;
      });
      absentProcessedRef.current = absentProcessedRef.current.filter(
        p => p.date === currentDateStr
      );

      for (const profile of activeProfiles) {
        // Skip if not a working day
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(currentDay)) continue;

        const dist = calculateDistance(coords.latitude, coords.longitude, profile.latitude, profile.longitude);
        const isWithinRadius = dist <= profile.radius;

        // Fix B1+B2: exclude absent logs from hasOpenSession.
        // absent logs have checkOut=null but are NOT real open sessions.
        // Without this guard: auto checkout modifies absent log, manual check-in is blocked.
        const hasOpenSession = updatedLogs.some(
          l => l.profileId === profile.id && l.checkOut === null
            && l.date === currentDateStr && l.status !== 'absent'
        );

        // ── AUTO CHECK-IN ────────────────────────────────────────────────────
        // Trigger: user enters geofence AND current time is within check-in window.
        // Check-in window: checkInTime → checkInTime + markAbsentAfter
        // This applies to both first check-in and re-entry after geofence exit.
        // If absent already marked: no auto check-in (manual punch required).
        if (!hasOpenSession && isWithinRadius) {
          const checkInMins = timeToMinutes(profile.checkInTime);
          const currentMins = timeToMinutes(currentTimeStr);

          // Check-in window: from checkInTime to checkInTime + markAbsentAfter (inclusive)
          // For catch-up on mount: same window applies
          const withinCheckInWindow =
            currentMins >= checkInMins &&
            currentMins <= checkInMins + profile.markAbsentAfter;

          // Absent already marked today — no auto check-in, require manual punch
          const absentMarked = updatedLogs.some(
            l => l.profileId === profile.id && l.date === currentDateStr && l.status === 'absent'
          );

          // Deduplicate: use a key per entry-minute so rapid ticks don't create duplicates.
          // Key is scoped to the minute the user entered — prevents multiple logs per entry.
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
            processedRef.current.push({
              profileId: profile.id,
              date: currentDateStr,
              timeKey: entryKey,
            });
            saveProcessedToStorage(PROCESSED_KEY, processedRef.current);
            notifyCheckIn(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          }
        }

        // ── AUTO CHECK-OUT: geofence exit ONLY ──────────────────────────────
        // Check-out is triggered ONLY by geofence exit or manual punch.
        // checkOutTime in profile is used only for: absent logic, smart scanning window,
        // stale session cleanup on mount — NOT for auto checkout during live tick.
        if (hasOpenSession) {
          // ── AUTO CHECK-OUT on geofence exit ──────────────────────────────
          if (!isWithinRadius && hasOpenSession) {
            const openLog = updatedLogs.find(
              l => l.profileId === profile.id && l.checkOut === null && l.date === currentDateStr
            );
            if (openLog) {
              const timeSinceCheckIn = (now.getTime() - new Date(openLog.checkIn).getTime()) / 60000;
              if (timeSinceCheckIn > 5) {
                // Fix #10: key on session id, not date — allows second exit same day after re-check-in
                const exitKey = `exit:${openLog.id}`;
                const alreadyProcessedExit = processedRef.current.some(
                  p => p.profileId === profile.id && p.date === currentDateStr && p.timeKey === exitKey
                );
                if (!alreadyProcessedExit) {
                  const duration = Math.round((now.getTime() - new Date(openLog.checkIn).getTime()) / 60000);
                  const expectedMinutes = profile.expectedHoursPerDay * 60;
                  const attended = duration >= expectedMinutes * 0.5;
                  updatedLogs = updatedLogs.map(l => {
                    if (l.id === openLog.id) {
                      return { ...l, checkOut: now.toISOString(), duration, attended, status: 'auto' as const };
                    }
                    return l;
                  });
                  logsChanged = true;
                  processedRef.current.push({
                    profileId: profile.id,
                    date: currentDateStr,
                    timeKey: exitKey,
                  });
                  saveProcessedToStorage(PROCESSED_KEY, processedRef.current);
                  notifyGeofenceExit(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
                }
              }
            }
          }
        }

        // ── MARK ABSENT ──────────────────────────────────────────────────────
        const checkInMinutes = timeToMinutes(profile.checkInTime);
        const currentMinutes = timeToMinutes(currentTimeStr);
        // Fix B5: never mark absent if user is physically within the geofence radius.
        // Previously, a user arriving at 09:31 (1 min past catch-up window) would get
        // marked absent even though they were standing at the location.
        if (currentMinutes > checkInMinutes + profile.markAbsentAfter && !hasOpenSession && !isWithinRadius) {
          const existingLog = updatedLogs.find(
            l => l.profileId === profile.id && l.date === currentDateStr
          );
          const alreadyMarkedAbsent = absentProcessedRef.current.some(
            p => p.profileId === profile.id && p.date === currentDateStr
          );
          if (!existingLog && !alreadyMarkedAbsent) {
            // Fix #2: absent log uses scheduled times, null checkOut, status:'absent'
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
            absentProcessedRef.current.push({
              profileId: profile.id,
              date: currentDateStr,
              timeKey: 'absent',
            });
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

    // Run catch-up scan on mount (fix #4)
    tick(true);

    // Fix B4+B8: close any open (non-absent) sessions that missed their checkout window.
    // Covers both: app killed at checkout time today (B4), and sessions from previous
    // days that were never closed (B8 — e.g. app killed before midnight).
    const closeStaleOpenSessions = () => {
      const now = getCurrentTime();
      const currentDateStr = dateToStr(now);
      const currentMins = timeToMinutes(timeToStr(now));
      let updated = [...logsRef.current];
      let changed = false;

      // Find ALL open non-absent sessions across all dates
      const openLogs = updated.filter(l => l.checkOut === null && l.status !== 'absent');

      for (const openLog of openLogs) {
        const profile = profiles.find(p => p.id === openLog.profileId);
        if (!profile) continue;

        const checkOutMins = timeToMinutes(profile.checkOutTime);
        const isToday = openLog.date === currentDateStr;

        if (isToday) {
          // Today: do NOT auto-close — checkout is geofence exit or manual only.
          // Session stays open until user leaves the geofence or manually punches out.
          // Exception: if it is now past midnight (next day), close at checkOutTime.
          // This is handled by the 'previous day' branch on next app open.
        } else {
          // Previous day: close at that day's scheduled checkout time
          // B8: session from a previous day was never closed (app was killed)
          const logDate = openLog.date; // YYYY-MM-DD
          const checkOutMoment = new Date(`${logDate}T${profile.checkOutTime}:00`);
          // Only close if the scheduled checkout has already passed
          if (checkOutMoment < now) {
            const duration = Math.max(0, Math.round((checkOutMoment.getTime() - new Date(openLog.checkIn).getTime()) / 60000));
            const attended = duration >= profile.expectedHoursPerDay * 60 * 0.5;
            updated = updated.map(l =>
              l.id === openLog.id
                ? { ...l, checkOut: checkOutMoment.toISOString(), duration, attended }
                : l
            );
            changed = true;
          }
        }
      }

      if (changed) {
        setLogs(updated);
        logsRef.current = updated;
        saveLogs(updated);
      }
    };
    closeStaleOpenSessions();

    // Fix B11: night shift absent scan — profiles whose checkInTime is late (e.g. 23:00)
    // may have missed the absent marking if the app opens after midnight on the next day.
    // Run a one-time scan for the previous calendar day.
    const markPreviousDayAbsent = () => {
      const now = getCurrentTime();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = dateToStr(yesterday);

      let updated = [...logsRef.current];
      let changed = false;

      for (const profile of profiles.filter(p => p.active)) {
        const checkInMins = timeToMinutes(profile.checkInTime);
        // Only applies to late-night profiles (checkIn after 20:00)
        if (checkInMins < 20 * 60) continue;

        const alreadyHasLog = updated.some(l => l.profileId === profile.id && l.date === yesterdayStr);
        if (alreadyHasLog) continue;

        // Mark absent for yesterday if no log exists
        updated = [...updated, {
          id: generateId(),
          profileId: profile.id,
          profileName: profile.name,
          date: yesterdayStr,
          checkIn: `${yesterdayStr}T${profile.checkInTime}:00`,
          checkOut: null,
          duration: null,
          status: 'absent' as const,
          profileColor: profile.color,
          attended: false,
        }];
        changed = true;
      }

      if (changed) {
        setLogs(updated);
        logsRef.current = updated;
        saveLogs(updated);
      }
    };
    markPreviousDayAbsent();

    // ── Smart scanning scheduler (Point 4) ─────────────────────────────────
    // Instead of scanning every 5s 24/7, compute whether ANY active profile
    // needs scanning right now. If yes, tick every checkEvery seconds (per profile min).
    // If no profile needs scanning, sleep until the next window opens.
    // Windows per profile:
    //   1. Pre-check-in: checkInTime - 15min  →  checkInTime + markAbsentAfter
    //   2. Live session: always scan (uses profile.checkEvery interval)
    //   3. Post-checkout buffer: checkOutTime - 15min  →  checkOutTime + 15min (for geofence exit near checkout)

    let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

    const getActiveScanInterval = (): number => {
      // Returns scan interval in ms if any profile needs scanning now, or -1 if sleeping
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

        const inPreCheckIn  = currentMins >= (ci - 15) && currentMins <= (ci + profile.markAbsentAfter);
        const inCheckOut    = currentMins >= (co - 15) && currentMins <= (co + 15);

        if (hasLiveSession) {
          // During live session use profile's checkEvery (in minutes), minimum 1 min
          const intervalMs = Math.max(1, profile.checkEvery ?? 5) * 60 * 1000;
          minInterval = Math.min(minInterval, intervalMs);
        } else if (inPreCheckIn || inCheckOut) {
          // Near check-in or checkout time: scan every 30s for responsiveness
          minInterval = Math.min(minInterval, 30 * 1000);
        }
      }

      return minInterval === Infinity ? -1 : minInterval;
    };

    const getMsUntilNextWindow = (): number => {
      // Returns ms until the earliest upcoming scan window across all profiles
      const now = getCurrentTime();
      const currentMins = timeToMinutes(timeToStr(now));
      const currentDay = now.getDay();

      let minWait = 24 * 60 * 60 * 1000; // default: check again tomorrow

      for (const profile of profiles.filter(p => p.active)) {
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(currentDay)) continue;

        const ci = timeToMinutes(profile.checkInTime);
        const co = timeToMinutes(profile.checkOutTime);

        // Next window starts at ci-15 or co-15, whichever is sooner and still in the future
        const ciWindowStart = ci - 15;
        const coWindowStart = co - 15;

        for (const windowStart of [ciWindowStart, coWindowStart]) {
          if (windowStart > currentMins) {
            const waitMs = (windowStart - currentMins) * 60 * 1000;
            minWait = Math.min(minWait, waitMs);
          }
        }
      }
      return minWait;
    };

    const scheduleNext = () => {
      if (schedulerTimer) clearTimeout(schedulerTimer);

      const interval = getActiveScanInterval();

      if (interval > 0) {
        // Inside a scan window — tick now and schedule next tick
        tick(false);
        schedulerTimer = setTimeout(scheduleNext, interval);
      } else {
        // Outside all scan windows — sleep until next window
        const waitMs = getMsUntilNextWindow();
        schedulerTimer = setTimeout(scheduleNext, waitMs);
      }
    };

    // Start the smart scheduler
    scheduleNext();

    return () => {
      if (schedulerTimer) clearTimeout(schedulerTimer);
    };
  // logs intentionally NOT in deps — use logsRef.current inside tick (fix #9)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, simulation, currentPosition, getCurrentTime, getCurrentCoords]);

  // Profile CRUD
  const addProfile = useCallback((profile: Omit<LocationProfile, 'id' | 'color'>) => {
    const newProfile: LocationProfile = {
      ...profile,
      id: generateId(),
      color: ['#10b981', '#f59e0b', '#6366f1', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'][profiles.length % 7],
    };
    const updated = [...profiles, newProfile];
    setProfiles(updated);
    saveProfiles(updated);
  }, [profiles]);

  const updateProfile = useCallback((id: string, data: Partial<LocationProfile>) => {
    const updated = profiles.map(p => p.id === id ? { ...p, ...data } : p);
    setProfiles(updated);
    saveProfiles(updated);
  }, [profiles]);

  const deleteProfile = useCallback((id: string) => {
    const updated = profiles.filter(p => p.id !== id);
    setProfiles(updated);
    saveProfiles(updated);
  }, [profiles]);

  const toggleProfile = useCallback((id: string) => {
    const updated = profiles.map(p => p.id === id ? { ...p, active: !p.active } : p);
    setProfiles(updated);
    saveProfiles(updated);
  }, [profiles]);

  // Manual check-in
  const manualCheckIn = useCallback((profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    const now = getCurrentTime();
    const currentDateStr = dateToStr(now);
    // Fix B2: exclude absent logs — absent.checkOut=null must not block manual check-in
    const alreadyOpen = logsRef.current.some(
      l => l.profileId === profileId && l.checkOut === null
        && l.date === currentDateStr && l.status !== 'absent'
    );
    if (alreadyOpen) return;

    const newLog: AttendanceLog = {
      id: generateId(),
      profileId,
      profileName: profile.name,
      date: currentDateStr,
      checkIn: now.toISOString(),
      checkOut: null,
      duration: null,
      status: 'manual',
      profileColor: profile.color,
      attended: true,
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
          const attended = duration >= expectedMinutes * 0.5;
          return { ...l, checkOut: now.toISOString(), duration: Math.round(duration), attended };
        }
        return l;
      });
    } else {
      updated = updated.map(l => {
        if (l.checkOut === null) {
          const duration = (now.getTime() - new Date(l.checkIn).getTime()) / 60000;
          const profile = profiles.find(p => p.id === l.profileId);
          const expectedMinutes = (profile?.expectedHoursPerDay ?? 8) * 60;
          const attended = duration >= expectedMinutes * 0.5;
          return { ...l, checkOut: now.toISOString(), duration: Math.round(duration), attended };
        }
        return l;
      });
    }
    setLogs(updated);
    logsRef.current = updated;
    saveLogs(updated);
  }, [profiles, getCurrentTime]);

  // Simulation
  const updateSimulation = useCallback((sim: Partial<SimulationState>) => {
    const updated = { ...simulation, ...sim };
    setSimulation(updated);
    saveSimulation(updated);
  }, [simulation]);

  // Weekly hours
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

  // Today's status
  const getTodayStatus = useCallback(() => {
    const now = getCurrentTime();
    const todayStr = dateToStr(now);
    const todayLogs = logsRef.current.filter(l => l.date === todayStr);
    const openSessions = todayLogs.filter(l => l.checkOut === null && l.status !== 'absent');
    const totalMinutes = todayLogs
      .filter(l => l.status !== 'absent')
      .reduce((sum, l) => sum + (l.duration || 0), 0);
    return {
      checkedIn: openSessions.length > 0,
      totalMinutes,
      logCount: todayLogs.length,
      openSessions,
    };
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

function isTimeWithinWindow(currentTime: string, targetTime: string, windowMinutes: number): boolean {
  const current = timeToMinutes(currentTime);
  const target = timeToMinutes(targetTime);
  return Math.abs(current - target) <= windowMinutes;
}
