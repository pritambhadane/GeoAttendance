import {
  MapPin, Clock, CheckCircle2, LogOut, Timer, Activity,
  TrendingUp, CalendarDays, Radio, Users, Crosshair,
} from 'lucide-react';
import { AttendanceLog, LocationProfile, TrackingStatus } from '../types';
import { formatDuration } from '../utils/storage';

interface DashboardProps {
  trackingStatus: TrackingStatus;
  weeklyMinutes: number;
  todayStatus: {
    checkedIn: boolean;
    totalMinutes: number;
    logCount: number;
    openSessions: AttendanceLog[];
  };
  profiles: LocationProfile[];
  onManualCheckIn: (profileId: string) => void;
  onManualCheckOut: (profileId?: string) => void;
  positionError: string | null;
  currentCoords: { latitude: number; longitude: number; accuracy: number; timestamp: number } | null;
}

export default function Dashboard({
  trackingStatus, weeklyMinutes, todayStatus, profiles,
  onManualCheckIn, onManualCheckOut, positionError, currentCoords,
}: DashboardProps) {
  const activeProfiles = profiles.filter(p => p.active);
  const { openSessions } = todayStatus;

  // Determine which profiles are currently checked in
  const checkedInProfileIds = new Set(openSessions.map(s => s.profileId));
  const profilesToCheckIn = activeProfiles.filter(p => !checkedInProfileIds.has(p.id));

  return (
    <div className="space-y-6">
      {/* Hero Status Card */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 p-6 text-white shadow-lg shadow-emerald-500/20">
        <div className="absolute -right-8 -top-8 h-40 w-40 rounded-full bg-white/10" />
        <div className="absolute -right-4 bottom-0 h-24 w-24 rounded-full bg-white/5" />
        <div className="relative z-10">
          <div className="flex items-center gap-2 text-emerald-100 text-sm font-medium mb-2">
            <Radio className="h-4 w-4 animate-pulse" />
            <span>Live Tracking</span>
          </div>
          <h2 className="text-2xl font-bold mb-1">
            {todayStatus.checkedIn
              ? `${openSessions.length} Session${openSessions.length > 1 ? 's' : ''} Active`
              : trackingStatus === 'checked-out' ? 'Checked Out' : 'Not Active'}
          </h2>
          {openSessions.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {openSessions.map(s => (
                <span key={s.id} className="flex items-center gap-1 text-emerald-100 text-sm">
                  <MapPin className="h-3.5 w-3.5" />
                  {s.profileName}
                </span>
              ))}
            </div>
          )}
          <div className="mt-4 flex gap-6">
            <div>
              <p className="text-emerald-200 text-xs uppercase tracking-wide">Today</p>
              <p className="text-xl font-bold">{formatDuration(todayStatus.totalMinutes)}</p>
            </div>
            <div>
              <p className="text-emerald-200 text-xs uppercase tracking-wide">This Week</p>
              <p className="text-xl font-bold">{formatDuration(weeklyMinutes)}</p>
            </div>
            <div>
              <p className="text-emerald-200 text-xs uppercase tracking-wide">Logs</p>
              <p className="text-xl font-bold">{todayStatus.logCount}</p>
            </div>
          </div>
          {currentCoords && (
            <div className="mt-3 flex items-center gap-1.5 text-emerald-200 text-xs">
              <Clock className="h-3 w-3" />
              Last location check: {new Date(currentCoords.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
          )}
        </div>
      </div>

      {/* Active Sessions Card - shows when multiple profiles are tracked */}
      {openSessions.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Users className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            <h3 className="font-semibold text-heading">Active Sessions</h3>
          </div>
          <div className="space-y-2">
            {openSessions.map(s => {
              const elapsed = (Date.now() - new Date(s.checkIn).getTime()) / 60000;
              return (
                <div key={s.id} className="flex items-center justify-between rounded-xl bg-emerald-50 border border-emerald-200 p-3 dark:bg-emerald-950 dark:border-emerald-800">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full animate-pulse" style={{ backgroundColor: s.profileColor }} />
                    <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">{s.profileName}</span>
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">
                      Since {new Date(s.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{formatDuration(elapsed)}</span>
                    <button
                      onClick={() => onManualCheckOut(s.profileId)}
                      className="rounded-lg bg-rose-100 text-rose-600 px-2 py-1 text-xs font-medium hover:bg-rose-200 transition flex items-center gap-1 dark:bg-rose-950 dark:text-rose-300 dark:hover:bg-rose-900"
                    >
                      <LogOut className="h-3 w-3" /> Out
                    </button>
                  </div>
                </div>
              );
            })}
            {openSessions.length > 1 && (
              <button
                onClick={() => onManualCheckOut()}
                className="w-full rounded-xl bg-gradient-to-r from-red-500 to-rose-600 text-white font-semibold py-2.5 px-4 flex items-center justify-center gap-2 hover:from-red-600 hover:to-rose-700 transition-all shadow-sm active:scale-[0.98] text-sm"
              >
                <LogOut className="h-4 w-4" />
                Check Out All
              </button>
            )}
          </div>
        </div>
      )}

      {/* Map Indicator Card */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="h-5 w-5 text-teal-600 dark:text-teal-400" />
          <h3 className="font-semibold text-heading">Current Location</h3>
        </div>
        {positionError && !currentCoords && (
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-amber-700 text-sm dark:bg-amber-950 dark:border-amber-800 dark:text-amber-300">
            {positionError} — Enable location services or use simulation mode.
          </div>
        )}
        {currentCoords && (
          <div className="card-inner p-3 space-y-1">
            <div className="font-mono text-sm text-slate-600 dark:text-slate-300">
              <p>Lat: {currentCoords.latitude.toFixed(6)}</p>
              <p>Lng: {currentCoords.longitude.toFixed(6)}</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <Crosshair className="h-3 w-3" />
              Accuracy: {currentCoords.accuracy < 1000
                ? `~${Math.round(currentCoords.accuracy)}m`
                : `~${(currentCoords.accuracy / 1000).toFixed(1)}km`}
            </div>
          </div>
        )}
        {!currentCoords && !positionError && (
          <div className="card-inner p-3 text-sm text-sub">
            Acquiring GPS position...
          </div>
        )}

        {/* Geofence visual - shows ALL active profiles */}
        {activeProfiles.length > 0 && currentCoords && (
          <div className="mt-3 space-y-2">
            {activeProfiles.map(p => {
              const dist = Math.sqrt(
                Math.pow((currentCoords.latitude - p.latitude) * 111000, 2) +
                Math.pow((currentCoords.longitude - p.longitude) * 111000 * Math.cos(currentCoords.latitude * Math.PI / 180), 2)
              );
              const within = dist <= p.radius;
              const isCheckedIn = checkedInProfileIds.has(p.id);
              return (
                <div key={p.id} className={`rounded-xl p-3 text-sm flex items-center gap-2 ${
                  isCheckedIn
                    ? 'bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-300'
                    : within
                      ? 'bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-300'
                      : 'card-inner text-slate-600 dark:text-slate-400'
                }`}>
                  <div className="h-3 w-3 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-auto text-xs">
                    {isCheckedIn ? 'Checked In' : within ? 'In Range' : `~${Math.round(dist)}m away`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Quick Actions - Check in to profiles not yet checked in */}
      {profilesToCheckIn.length > 0 && openSessions.length === 0 ? (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <h3 className="font-semibold text-heading">Quick Actions</h3>
          </div>
          <div className="space-y-2">
            {profilesToCheckIn.map(p => (
              <button
                key={p.id}
                onClick={() => onManualCheckIn(p.id)}
                className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-semibold py-3 px-4 flex items-center justify-center gap-2 hover:from-emerald-600 hover:to-teal-700 transition-all shadow-sm active:scale-[0.98]"
              >
                <CheckCircle2 className="h-5 w-5" />
                Check In — {p.name}
              </button>
            ))}
            {activeProfiles.length === 0 && (
              <p className="text-sub text-sm text-center py-3">No active profiles. Enable a profile or create one.</p>
            )}
          </div>
        </div>
      ) : profilesToCheckIn.length > 0 ? (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <h3 className="font-semibold text-heading">Check Into More Profiles</h3>
          </div>
          <div className="space-y-2">
            {profilesToCheckIn.map(p => (
              <button
                key={p.id}
                onClick={() => onManualCheckIn(p.id)}
                className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-semibold py-2.5 px-4 flex items-center justify-center gap-2 hover:from-emerald-600 hover:to-teal-700 transition-all shadow-sm active:scale-[0.98] text-sm"
              >
                <CheckCircle2 className="h-4 w-4" />
                Check In — {p.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 mb-2">
            <Clock className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Weekly Hours</span>
          </div>
          <p className="text-2xl font-bold text-heading">{formatDuration(weeklyMinutes)}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 mb-2">
            <TrendingUp className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Active Profiles</span>
          </div>
          <p className="text-2xl font-bold text-heading">{activeProfiles.length}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 text-teal-600 dark:text-teal-400 mb-2">
            <Timer className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Today</span>
          </div>
          <p className="text-2xl font-bold text-heading">{formatDuration(todayStatus.totalMinutes)}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 mb-2">
            <CalendarDays className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Total Logs</span>
          </div>
          <p className="text-2xl font-bold text-heading">{todayStatus.logCount}</p>
        </div>
      </div>
    </div>
  );
}
