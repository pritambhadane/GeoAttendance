import { LocationProfile, AttendanceLog, SimulationState } from '../types';

const PROFILES_KEY = 'geo_attendance_profiles';
const LOGS_KEY = 'geo_attendance_logs';
const SIM_KEY = 'geo_attendance_simulation';

export function getProfiles(): LocationProfile[] {
  const data = localStorage.getItem(PROFILES_KEY);
  if (!data) return [];
  const parsed: LocationProfile[] = JSON.parse(data);
  // Migrate old profiles missing new fields
  return parsed.map(p => ({
    ...p,
    expectedHoursPerDay: p.expectedHoursPerDay ?? 8,
    checkFrequency: p.checkFrequency ?? 5,
    markAbsentAfter: p.markAbsentAfter ?? 30,
    workingDays: p.workingDays ?? [1, 2, 3, 4, 5],
  }));
}

export function saveProfiles(profiles: LocationProfile[]): void {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export function getLogs(): AttendanceLog[] {
  const data = localStorage.getItem(LOGS_KEY);
  if (!data) return [];
  const parsed: AttendanceLog[] = JSON.parse(data);
  // Migrate old logs missing attended field
  return parsed.map(l => ({
    ...l,
    attended: l.attended ?? (l.duration !== null && l.duration > 0),
  }));
}

export function saveLogs(logs: AttendanceLog[]): void {
  localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
}

export function getSimulation(): SimulationState {
  const data = localStorage.getItem(SIM_KEY);
  return data ? JSON.parse(data) : { enabled: false, latitude: 0, longitude: 0, timeOffset: 0 };
}

export function saveSimulation(sim: SimulationState): void {
  localStorage.setItem(SIM_KEY, JSON.stringify(sim));
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

const PROFILE_COLORS = [
  '#10b981', '#f59e0b', '#6366f1', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
];

export function getProfileColor(index: number): string {
  return PROFILE_COLORS[index % PROFILE_COLORS.length];
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null) return '--';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

export function calculateDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export interface PositionData {
  latitude: number;
  longitude: number;
  accuracy: number; // meters
  timestamp: number; // ms since epoch
}

export function getCurrentPosition(): Promise<PositionData> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

export function timeToStr(date: Date): string {
  return date.toTimeString().slice(0, 5);
}

export function dateToStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function getDayName(day: number): string {
  return DAY_NAMES[day] || '';
}
