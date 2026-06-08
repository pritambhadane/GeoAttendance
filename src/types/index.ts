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
  checkFrequency: number; // minutes between location checks
  markAbsentAfter: number; // minutes after check-in time to mark absent
  workingDays: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
}

export interface AttendanceLog {
  id: string;
  profileId: string;
  profileName: string;
  date: string; // YYYY-MM-DD
  checkIn: string; // ISO timestamp
  checkOut: string | null; // ISO timestamp
  duration: number | null; // minutes
  status: 'auto' | 'manual';
  profileColor: string;
  attended: boolean;
}

export interface SimulationState {
  enabled: boolean;
  latitude: number;
  longitude: number;
  timeOffset: number; // minutes offset from real time
}

export type TrackingStatus = 'idle' | 'tracking' | 'checked-in' | 'checked-out';

export type ThemeMode = 'light' | 'dark';
