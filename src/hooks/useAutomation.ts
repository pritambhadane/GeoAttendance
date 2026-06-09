/**
 * useAutomation.ts — Option B thin version
 *
 * The native Java ForegroundService now owns all GPS polling, geofence logic,
 * session state, and notifications.  This hook becomes a thin bridge that:
 *   1. Syncs profiles and existing logs to the Java service on mount.
 *   2. Polls getState() every 10s for the UI snapshot.
 *   3. Exposes the same API surface as before so no other files change.
 *
 * Falls back to a no-op simulation when running in a browser (dev mode).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { LocationProfile, AttendanceLog, SimulationState, TrackingStatus } from '../types';
import {
  getProfiles, saveProfiles, getLogs, saveLogs,
  getSimulation, saveSimulation, generateId,
  calculateDistance, timeToStr, dateToStr,
  PositionData,
} from '../utils/storage';
import { AttendanceServicePlugin, isNativeServiceAvailable } from '../services/nativePlugin';
import { log } from '../utils/logger';

const POLL_INTERVAL_MS = 10_000; // 10 s

export function useAutomation() {
  const [profiles, setProfiles] = useState<LocationProfile[]>(getProfiles);
  const [logs, setLogs] = useState<AttendanceLog[]>(getLogs);
  const [simulation, setSimulation] = useState<SimulationState>(getSimulation);
  const [currentPosition, setCurrentPosition] = useState<PositionData | null>(null);
  const [positionError] = useState<string | null>(null);

  const logsRef = useRef<AttendanceLog[]>(logs);
  const seededRef = useRef(false);

  // Keep logsRef in sync
  useEffect(() => { logsRef.current = logs; }, [logs]);

  // ── Bootstrap native service on mount ─────────────────────────────────────
  useEffect(() => {
    if (!isNativeServiceAvailable()) {
      log('warn', 'NATIVE', 'AttendanceService plugin not available — running in browser mode');
      return;
    }

    const bootstrap = async () => {
      try {
        // Push profiles to Java SharedPreferences
        await AttendanceServicePlugin.syncProfiles({
          profiles: JSON.stringify(getProfiles()),
        });

        // Seed logs once (migration from old localStorage-only data)
        if (!seededRef.current) {
          await AttendanceServicePlugin.syncLogs({
            logs: JSON.stringify(getLogs()),
          });
          seededRef.current = true;
        }

        // Start the service (safe to call multiple times — service checks if already running)
        await AttendanceServicePlugin.startService();
        log('info', 'NATIVE', 'ForegroundService started');
      } catch (e) {
        log('error', 'NATIVE', `Bootstrap failed: ${e}`);
      }
    };

    bootstrap();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync profiles to Java whenever they change
  useEffect(() => {
    if (!isNativeServiceAvailable()) return;
    AttendanceServicePlugin.syncProfiles({
      profiles: JSON.stringify(profiles),
    }).catch(e => log('error', 'NATIVE', `syncProfiles failed: ${e}`));
  }, [profiles]);

  // ── Poll native service state every 10s ────────────────────────────────────
  useEffect(() => {
    if (!isNativeServiceAvailable()) return;

    const poll = async () => {
      try {
        // Refresh log array from Java (source of truth)
        const result = await AttendanceServicePlugin.getLogs();
        const nativeLogs: AttendanceLog[] = JSON.parse(result.logs);

        // Only update React state if logs actually changed (avoid unnecessary re-renders)
        const currentJson = JSON.stringify(logsRef.current);
        const nativeJson  = JSON.stringify(nativeLogs);
        if (currentJson !== nativeJson) {
          setLogs(nativeLogs);
          logsRef.current = nativeLogs;
          // Keep React's localStorage in sync so export/history components work offline
          saveLogs(nativeLogs);
          log('tick', 'POLL', `Logs updated (${nativeLogs.length} records)`);
        }
      } catch (e) {
        log('error', 'POLL', `Poll failed: ${e}`);
      }
    };

    poll(); // immediate first poll
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Helpers (same signatures as before) ───────────────────────────────────

  const getCurrentTime = useCallback(() => {
    const now = new Date();
    if (simulation.enabled && simulation.timeOffset !== 0) {
      return new Date(now.getTime() + simulation.timeOffset * 60000);
    }
    return now;
  }, [simulation]);

  const getCurrentCoords = useCallback(() => {
    if (simulation.enabled) {
      return {
        latitude: simulation.latitude,
        longitude: simulation.longitude,
        accuracy: 0,
        timestamp: Date.now(),
      };
    }
    return currentPosition;
  }, [simulation, currentPosition]);

  const getTrackingStatus = useCallback((): TrackingStatus => {
    const open = logsRef.current.filter(l => l.checkOut === null && l.status !== 'absent');
    if (open.length > 0) return 'checked-in';
    const nonAbsent = logsRef.current.filter(l => l.status !== 'absent');
    if (nonAbsent.length > 0) {
      const latest = nonAbsent[nonAbsent.length - 1];
      if (latest.checkOut) return 'checked-out';
    }
    return 'idle';
  }, []);

  const getOpenSessions = useCallback(() => {
    return logsRef.current.filter(l => l.checkOut === null && l.status !== 'absent');
  }, []);

  // ── Profile CRUD (unchanged — profiles live in React localStorage) ─────────

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

  // ── Manual check-in / check-out — delegate to native service ──────────────

  const manualCheckIn = useCallback(async (profileId: string) => {
    if (isNativeServiceAvailable()) {
      try {
        await AttendanceServicePlugin.manualCheckIn({ profileId });
        // Logs will be refreshed on next poll
      } catch (e) {
        log('error', 'NATIVE', `manualCheckIn failed: ${e}`);
      }
      return;
    }
    // Browser fallback (dev mode)
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
    setLogs(updated); logsRef.current = updated; saveLogs(updated);
  }, [profiles, getCurrentTime]);

  const manualCheckOut = useCallback(async (profileId?: string) => {
    if (isNativeServiceAvailable()) {
      try {
        await AttendanceServicePlugin.manualCheckOut({ profileId });
      } catch (e) {
        log('error', 'NATIVE', `manualCheckOut failed: ${e}`);
      }
      return;
    }
    // Browser fallback
    const now = getCurrentTime();
    const currentDateStr = dateToStr(now);
    const updated = logsRef.current.map(l => {
      if (l.checkOut !== null) return l;
      if (profileId && l.profileId !== profileId) return l;
      if (l.date !== currentDateStr) return l;
      const duration = (now.getTime() - new Date(l.checkIn).getTime()) / 60000;
      const profile = profiles.find(p => p.id === l.profileId);
      const expectedMinutes = (profile?.expectedHoursPerDay ?? 8) * 60;
      return { ...l, checkOut: now.toISOString(), duration: Math.round(duration), attended: duration >= expectedMinutes * 0.5 };
    });
    setLogs(updated); logsRef.current = updated; saveLogs(updated);
  }, [profiles, getCurrentTime]);

  // ── Simulation ─────────────────────────────────────────────────────────────

  const updateSimulation = useCallback((sim: Partial<SimulationState>) => {
    const updated = { ...simulation, ...sim };
    setSimulation(updated);
    saveSimulation(updated);
  }, [simulation]);

  // ── Derived aggregates (unchanged) ────────────────────────────────────────

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
    const totalMinutes = todayLogs
      .filter(l => l.status !== 'absent')
      .reduce((sum, l) => sum + (l.duration || 0), 0);
    return { checkedIn: openSessions.length > 0, totalMinutes, logCount: todayLogs.length, openSessions };
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
