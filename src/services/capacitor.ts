/**
 * Capacitor native bridge service
 * Provides geolocation via @capacitor-community/background-geolocation (native)
 * which keeps GPS running even when the screen is locked / app is in background.
 * Falls back gracefully to the browser APIs when running in a web browser.
 */

import { PositionData } from '../utils/storage';
import { log } from '../utils/logger';

// ─── Type declarations ────────────────────────────────────────────────────────

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

type BGLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  time?: number;
};

type BackgroundGeolocationPlugin = {
  addWatcher: (
    opts: {
      backgroundMessage: string;
      backgroundTitle: string;
      requestPermissions: boolean;
      stale: boolean;
      distanceFilter?: number;
    },
    callback: (location: BGLocation | undefined, error: unknown) => void
  ) => Promise<string>;
  removeWatcher: (opts: { id: string }) => Promise<void>;
};

// ─── Runtime detection ────────────────────────────────────────────────────────

function getGeoPlugin(): CapacitorGeolocation | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).CapacitorCustomPlatform?.plugins?.Geolocation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ?? (window as any).Capacitor?.Plugins?.Geolocation
        ?? null;
    }
  } catch { /* noop */ }
  return null;
}

function getBGGeoPlugin(): BackgroundGeolocationPlugin | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugin = (window as any).Capacitor?.Plugins?.BackgroundGeolocation ?? null;
      log('info', 'BGPLUGIN', plugin ? 'BackgroundGeolocation plugin found' : 'BackgroundGeolocation plugin NOT found');
      return plugin;
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

// ─── Geolocation ─────────────────────────────────────────────────────────────

export async function requestLocationPermission(): Promise<boolean> {
  const plugin = getGeoPlugin();
  if (plugin) {
    try {
      const result = await plugin.requestPermissions();
      log('info', 'PERM', `Location permission: ${result.location}`);
      return result.location === 'granted';
    } catch (e) {
      log('error', 'PERM', `Location permission error: ${e}`);
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
        log('gps', 'GPS', `Got position: ${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)} acc=${Math.round(pos.coords.accuracy)}m`);
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
      log('warn', 'GPS', `Position attempt ${attempt} failed: ${e}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  throw lastError;
}

let bgWatcherId: string | null = null;
let webWatchId: number | null = null;

export async function startLocationWatch(
  callback: (pos: PositionData) => void,
  onError?: (err: unknown) => void
): Promise<void> {
  const bgPlugin = getBGGeoPlugin();

  if (bgPlugin) {
    try {
      log('info', 'BGWATCH', 'Starting BackgroundGeolocation watcher...');
      bgWatcherId = await bgPlugin.addWatcher(
        {
          backgroundMessage: 'GeoAttend is tracking your location for attendance',
          backgroundTitle: 'GeoAttend Active',
          requestPermissions: true,
          stale: false,
        },
        (location, error) => {
          if (error || !location) {
            log('error', 'BGWATCH', `Watcher error: ${error}`);
            onError?.(error);
            return;
          }
          log('gps', 'BGWATCH', `BG position: ${location.latitude.toFixed(5)},${location.longitude.toFixed(5)} acc=${Math.round(location.accuracy)}m`);
          callback({
            latitude: location.latitude,
            longitude: location.longitude,
            accuracy: location.accuracy,
            timestamp: location.time ?? Date.now(),
          });
        }
      );
      log('info', 'BGWATCH', `Watcher started, id=${bgWatcherId}`);
      return;
    } catch (e) {
      log('error', 'BGWATCH', `addWatcher failed, falling back: ${e}`);
    }
  }

  // Native fallback
  const geoPlugin = getGeoPlugin();
  if (geoPlugin) {
    log('warn', 'BGWATCH', 'Using standard watchPosition (no background support)');
    const id = await geoPlugin.watchPosition({ enableHighAccuracy: true, timeout: 15000 }, (pos, err) => {
      if (err || !pos) { onError?.(err); return; }
      log('gps', 'WATCH', `watchPosition: ${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`);
      callback({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      });
    });
    bgWatcherId = id;
    return;
  }

  // Web fallback
  log('warn', 'BGWATCH', 'Using web navigator.geolocation (no background support)');
  webWatchId = navigator.geolocation.watchPosition(
    (p) => callback({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, timestamp: p.timestamp }),
    onError,
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

export async function stopLocationWatch(): Promise<void> {
  log('info', 'BGWATCH', 'Stopping location watch');
  const bgPlugin = getBGGeoPlugin();
  if (bgWatcherId !== null) {
    if (bgPlugin) {
      try { await bgPlugin.removeWatcher({ id: bgWatcherId }); } catch { /* noop */ }
    } else {
      const geoPlugin = getGeoPlugin();
      if (geoPlugin) {
        try { await geoPlugin.clearWatch({ id: bgWatcherId }); } catch { /* noop */ }
      }
    }
    bgWatcherId = null;
  }
  if (webWatchId !== null) {
    navigator.geolocation.clearWatch(webWatchId);
    webWatchId = null;
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────

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
      log('info', 'PERM', `Notification permission: ${result.display}`);
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
          smallIcon: 'ic_stat_notify',
          iconColor: '#10b981',
        }],
      });
      log('info', 'NOTIF', `Sent: ${title}`);
      return;
    } catch (e) {
      log('warn', 'NOTIF', `Native notification failed: ${e}`);
    }
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/icon.png' });
    return;
  }
  console.info(`[Notification] ${title}: ${body}`);
}

export async function notifyCheckIn(profileName: string, time: string): Promise<void> {
  log('geo', 'CHECKIN', `Auto check-in: ${profileName} at ${time}`);
  await sendLocalNotification('✅ Checked In – ' + profileName, `Auto check-in recorded at ${time}`);
}

export async function notifyCheckOut(profileName: string, time: string, durationMinutes: number): Promise<void> {
  const h = Math.floor(durationMinutes / 60);
  const m = Math.round(durationMinutes % 60);
  const dur = h > 0 ? `${h}h ${m}m` : `${m}m`;
  log('geo', 'CHECKOUT', `Auto check-out: ${profileName} at ${time}, duration=${dur}`);
  await sendLocalNotification('🚪 Checked Out – ' + profileName, `Auto check-out at ${time} · Duration: ${dur}`);
}

export async function notifyAbsent(profileName: string): Promise<void> {
  log('geo', 'ABSENT', `Marked absent: ${profileName}`);
  await sendLocalNotification('⚠️ Marked Absent – ' + profileName, `You were marked absent for ${profileName} today`);
}

export async function notifyGeofenceExit(profileName: string, time: string): Promise<void> {
  log('geo', 'EXIT', `Geofence exit: ${profileName} at ${time}`);
  await sendLocalNotification('📍 Left Geofence – ' + profileName, `Check-out triggered on geofence exit at ${time}`);
}
