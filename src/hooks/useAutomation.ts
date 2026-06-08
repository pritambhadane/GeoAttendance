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
  const getOpenSessions = useCallback(() => {
    return logsRef.current.filter(l => l.checkOut === null);
  }, []);

  const getTrackingStatus = useCallback((): TrackingStatus => {
    const open = logsRef.current.filter(l => l.checkOut === null);
    if (open.length > 0) return 'checked-in';
    if (logsRef.current.length > 0) {
      const latest = logsRef.current[logsRef.current.length - 1];
      if (latest.checkOut) return 'checked-out';
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

      // Clean old processed entries
      processedRef.current = processedRef.current.filter(
        p => p.date === currentDateStr && Math.abs(timeToMinutes(currentTimeStr) - timeToMinutes(p.timeKey.replace(/^(out:|exit:)/, ''))) < 2
      );
      // Keep exit and out keys for the full day — only time-based check-in keys need pruning
      processedRef.current = processedRef.current.filter(
        p => p.date === currentDateStr
      );
      absentProcessedRef.current = absentProcessedRef.current.filter(
        p => p.date === currentDateStr
      );

      for (const profile of activeProfiles) {
        // Skip if not a working day
        if (profile.workingDays.length > 0 && !profile.workingDays.includes(currentDay)) continue;

        const dist = calculateDistance(coords.latitude, coords.longitude, profile.latitude, profile.longitude);
        const isWithinRadius = dist <= profile.radius;

        const hasOpenSession = updatedLogs.some(
          l => l.profileId === profile.id && l.checkOut === null && l.date === currentDateStr
        );

        // ── AUTO CHECK-IN ────────────────────────────────────────────────────
        if (!hasOpenSession && isWithinRadius) {
          const checkInMinutesProfile = timeToMinutes(profile.checkInTime);
          const currentMinutesNow = timeToMinutes(currentTimeStr);

          // Normal ±1 min window for live tick; catch-up window = markAbsentAfter (fix #4)
          const windowMinutes = isCatchUp ? profile.markAbsentAfter : 1;
          const withinCheckInWindow = isCatchUp
            ? (currentMinutesNow >= checkInMinutesProfile && currentMinutesNow <= checkInMinutesProfile + windowMinutes)
            : Math.abs(currentMinutesNow - checkInMinutesProfile) <= windowMinutes;

          const alreadyProcessed = processedRef.current.some(
            p => p.profileId === profile.id && p.date === currentDateStr && p.timeKey === profile.checkInTime
          );

          if (withinCheckInWindow && !alreadyProcessed) {
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
              timeKey: profile.checkInTime,
            });
            saveProcessedToStorage(PROCESSED_KEY, processedRef.current);
            notifyCheckIn(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          }
        }

        // ── AUTO CHECK-OUT at scheduled time ─────────────────────────────────
        if (hasOpenSession) {
          const withinCheckOutWindow = isTimeWithinWindow(currentTimeStr, profile.checkOutTime, 1);
          const alreadyProcessedOut = processedRef.current.some(
            p => p.profileId === profile.id && p.date === currentDateStr && p.timeKey === `out:${profile.checkOutTime}`
          );

          if (withinCheckOutWindow && !alreadyProcessedOut) {
            updatedLogs = updatedLogs.map(l => {
              if (l.profileId === profile.id && l.checkOut === null && l.date === currentDateStr) {
                const duration = (now.getTime() - new Date(l.checkIn).getTime()) / 60000;
                const expectedMinutes = profile.expectedHoursPerDay * 60;
                const attended = duration >= expectedMinutes * 0.5;
                return { ...l, checkOut: now.toISOString(), duration: Math.round(duration), attended };
              }
              return l;
            });
            logsChanged = true;
            processedRef.current.push({
              profileId: profile.id,
              date: currentDateStr,
              timeKey: `out:${profile.checkOutTime}`,
            });
            saveProcessedToStorage(PROCESSED_KEY, processedRef.current);
            const openLog = logsRef.current.find(l => l.profileId === profile.id && l.checkOut === null && l.date === currentDateStr);
            if (openLog) {
              const dur = Math.round((now.getTime() - new Date(openLog.checkIn).getTime()) / 60000);
              notifyCheckOut(profile.name, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), dur);
            }
          }

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
        if (currentMinutes > checkInMinutes + profile.markAbsentAfter && !hasOpenSession) {
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
    // Then run normal ticks
    const id = setInterval(() => tick(false), 5000);
    return () => clearInterval(id);
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
    const alreadyOpen = logsRef.current.some(l => l.profileId === profileId && l.checkOut === null && l.date === currentDateStr);
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
