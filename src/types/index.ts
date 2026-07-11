export interface LocationProfile {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius: number; // meters
  checkInTime: string; // HH:mm
  checkOutTime: string; // HH:mm
  color: string;
  active: boolean;
  expectedHoursPerDay: number; // hours
  checkEvery: number; // minutes between location checks (runtime key — must match Java optInt("checkEvery"))
  markAbsentAfter: number; // minutes after check-in time to mark absent
  workingDays: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
  notificationsEnabled: boolean; // per-profile event notifications
}

export interface AttendanceLog {
  id: string;
  profileId: string;
  profileName: string;
  date: string; // YYYY-MM-DD
  checkIn: string; // ISO timestamp
  checkOut: string | null; // ISO timestamp
  duration: number | null; // minutes
  status: 'auto' | 'manual' | 'absent' | 'leave';
  profileColor: string;
  attended: boolean;
}

export interface SimulationState {
  enabled: boolean;
  latitude: number;
  longitude: number;
  timeOffset: number; // minutes offset from real time
}

// idle       = no GPS session, nothing today
// tracking   = GPS active, inside working hours, waiting for geofence entry
// checked-in = open session exists right now
// checked-out = all today's sessions are closed
export type TrackingStatus = 'idle' | 'tracking' | 'checked-in' | 'checked-out';

export type ThemeMode = 'light' | 'dark';
