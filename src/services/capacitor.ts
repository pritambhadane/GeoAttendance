/**
 * Capacitor native bridge service
 *
 * On Android, background GPS is handled entirely by AttendanceForegroundService.java.
 * This file provides:
 *   - Location permission request
 *   - One-shot getCurrentPosition (used for initial UI display only)
 *   - watchPosition via @capacitor/geolocation (foreground only — Java service
 *     handles background; this is a UI convenience only)
 *   - Notification helpers (JS-side; Java service sends its own native notifications)
 *
 * FIX 3: Removed all references to @capacitor-community/background-geolocation
 * (BackgroundGeolocation plugin). That package is NOT installed in this project
 * (absent from package.json and capacitor.plugins.json). Referencing it caused
 * getBGGeoPlugin() to always return null, then silently fall through to standard
 * watchPosition which Android suspends on screen lock. The code now uses
 * @capacitor/geolocation directly for the foreground watch, which is correct
 * since the Java ForegroundService owns all background GPS tracking.
 */

import { PositionData } from '../utils/storage';

type CapacitorGeolocation = {
  requestPermissions: () => Promise<{ location: string }>;
  getCurrentPosition: (opts: {
    enableHighAccuracy: boolean;
    timeout: number;
  }) => Promise<{ coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }>;
  watchPosition: (
    opts: { enableHighAccuracy: boolean; timeout: number },
    cb: (pos: { coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number } | null, err?: unknown) => void
  ) => Promise<string>;
  clearWatch: (opts: { id: string }) => Promise<void>;
};

type CapacitorLocalNotifications = {
  requestPermissions: () => Promise<{ display: string }>;
  schedule: (opts: {
    notifications: Array<{
      id: number;
      title: string;
      body: string;
      smallIcon?: string;
      iconColor?: string;
      schedule?: { at: Date };
    }>;
  }) => Promise<void>;
  checkPermissions: () => Promise<{ display: string }>;
};

function getGeoPlugin(): CapacitorGeolocation | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).Capacitor?.Plugins?.Geolocation ?? null;
    }
  } catch { /* noop */ }
  return null;
}

function getNotifPlugin(): CapacitorLocalNotifications | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).Capacitor?.Plugins?.LocalNotifications ?? null;
    }
  } catch { /* noop */ }
  return null;
}

export function isNative(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return !!(window as any).Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

// ── Geolocation ───────────────────────────────────────────────────────────────

export async function requestLocationPermission(): Promise<boolean> {
  const plugin = getGeoPlugin();
  if (plugin) {
    try {
      const result = await plugin.requestPermissions();
      return result.location === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

export async function getNativePosition(retries = 3): Promise<PositionData> {
  const plugin = getGeoPlugin();
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (plugin) {
        const pos = await plugin.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
        return {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        };
      }
      return await new Promise<PositionData>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, timestamp: p.timestamp }),
          reject,
          { enableHighAccuracy: true, timeout: 10000 }
        );
      });
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  throw lastError;
}

let watchId: string | null = null;
let webWatchId: number | null = null;

export async function startLocationWatch(
  callback: (pos: PositionData) => void,
  onError?: (err: unknown) => void
): Promise<void> {
  // FIX 3: Use @capacitor/geolocation watchPosition directly.
  // Background tracking is owned by AttendanceForegroundService (Java).
  // This watch is foreground-only and feeds the React UI with live coordinates.
  const geoPlugin = getGeoPlugin();
  if (geoPlugin) {
    try {
      const id = await geoPlugin.watchPosition({ enableHighAccuracy: true, timeout: 15000 }, (pos, err) => {
        if (err || !pos) { onError?.(err); return; }
        callback({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        });
      });
      watchId = id;
      return;
    } catch (e) {
      console.warn('watchPosition failed:', e);
    }
  }

  // Web fallback
  webWatchId = navigator.geolocation.watchPosition(
    (p) => callback({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, timestamp: p.timestamp }),
    onError,
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

export async function stopLocationWatch(): Promise<void> {
  const geoPlugin = getGeoPlugin();
  if (watchId !== null) {
    if (geoPlugin) {
      try { await geoPlugin.clearWatch({ id: watchId }); } catch { /* noop */ }
    }
    watchId = null;
  }
  if (webWatchId !== null) {
    navigator.geolocation.clearWatch(webWatchId);
    webWatchId = null;
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────
// These are used by the JS-side tick (foreground). The Java service sends
// its own native notifications independently when the screen is locked.

let notifPermissionGranted = false;
let notifIdCounter = Math.floor(Math.random() * 10000);

export async function requestNotificationPermission(): Promise<boolean> {
  const plugin = getNotifPlugin();
  if (plugin) {
    try {
      const check = await plugin.checkPermissions();
      if (check.display === 'granted') { notifPermissionGranted = true; return true; }
      const result = await plugin.requestPermissions();
      notifPermissionGranted = result.display === 'granted';
      return notifPermissionGranted;
    } catch {
      return false;
    }
  }
  if ('Notification' in window) {
    const perm = await Notification.requestPermission();
    notifPermissionGranted = perm === 'granted';
    return notifPermissionGranted;
  }
  return false;
}

export async function sendLocalNotification(title: string, body: string): Promise<void> {
  const plugin = getNotifPlugin();
  if (plugin) {
    try {
      await plugin.schedule({
        notifications: [{
          id: ++notifIdCounter,
          title,
          body,
          smallIcon: 'ic_stat_notify', // FIX 4: this drawable now exists
          iconColor: '#10b981',
        }],
      });
      return;
    } catch (e) {
      console.warn('Native notification failed:', e);
    }
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/icon.png' });
    return;
  }
  console.info(`[Notification] ${title}: ${body}`);
}

export async function notifyCheckIn(profileName: string, time: string): Promise<void> {
  await sendLocalNotification('✅ Checked In – ' + profileName, `Auto check-in recorded at ${time}`);
}

export async function notifyCheckOut(profileName: string, time: string, durationMinutes: number): Promise<void> {
  const h = Math.floor(durationMinutes / 60);
  const m = Math.round(durationMinutes % 60);
  const dur = h > 0 ? `${h}h ${m}m` : `${m}m`;
  await sendLocalNotification('🚪 Checked Out – ' + profileName, `Auto check-out at ${time} · Duration: ${dur}`);
}

export async function notifyAbsent(profileName: string): Promise<void> {
  await sendLocalNotification('⚠️ Marked Absent – ' + profileName, `You were marked absent for ${profileName} today`);
}

export async function notifyGeofenceExit(profileName: string, time: string): Promise<void> {
  await sendLocalNotification('📍 Left Geofence – ' + profileName, `Check-out triggered on geofence exit at ${time}`);
}
