import { useState } from 'react';
import {
  Plus, MapPin, Clock, Trash2, Power, PowerOff,
  Edit3, X, Check, Navigation, Calendar,
} from 'lucide-react';
import { LocationProfile } from '../types';
import { getCurrentPosition, getDayName } from '../utils/storage';

interface ProfilesManagerProps {
  profiles: LocationProfile[];
  onAdd: (profile: Omit<LocationProfile, 'id' | 'color'>) => void;
  onUpdate: (id: string, data: Partial<LocationProfile>) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}

const RADIUS_OPTIONS = [25, 50, 100, 200, 500];
const FREQUENCY_OPTIONS = [1, 2, 5, 10, 15, 30];
const ABSENT_OPTIONS = [5, 10, 15, 30, 60];
const HOURS_PRESETS = [4, 6, 7, 8, 9, 10, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export default function ProfilesManager({ profiles, onAdd, onUpdate, onDelete, onToggle }: ProfilesManagerProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [radius, setRadius] = useState(100);
  const [customRadius, setCustomRadius] = useState('');
  const [checkInTime, setCheckInTime] = useState('09:00');
  const [checkOutTime, setCheckOutTime] = useState('17:00');
  const [expectedHoursPerDay, setExpectedHoursPerDay] = useState(8);
  const [customHours, setCustomHours] = useState('');
  const [checkFrequency, setCheckFrequency] = useState(5);
  const [markAbsentAfter, setMarkAbsentAfter] = useState(30);
  const [customAbsent, setCustomAbsent] = useState('');
  const [workingDays, setWorkingDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [capturing, setCapturing] = useState(false);

  const resetForm = () => {
    setName(''); setLatitude(''); setLongitude(''); setRadius(100);
    setCustomRadius('');
    setCheckInTime('09:00'); setCheckOutTime('17:00');
    setExpectedHoursPerDay(8); setCustomHours('');
    setCheckFrequency(5); setMarkAbsentAfter(30); setCustomAbsent('');
    setWorkingDays([1, 2, 3, 4, 5]);
    setEditingId(null);
  };

  const handleCapture = async () => {
    setCapturing(true);
    try {
      const pos = await getCurrentPosition();
      setLatitude(pos.latitude.toString());
      setLongitude(pos.longitude.toString());
    } catch {
      // Silently fail, user can enter manually
    } finally {
      setCapturing(false);
    }
  };

  const handleSubmit = () => {
    if (!name || !latitude || !longitude) return;
    const effectiveRadius = customRadius ? parseInt(customRadius) : radius;
    const effectiveHours = customHours ? parseFloat(customHours) : expectedHoursPerDay;
    const effectiveAbsent = customAbsent ? parseInt(customAbsent) : markAbsentAfter;
    const data = {
      name,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      radius: effectiveRadius,
      checkInTime,
      checkOutTime,
      active: true,
      expectedHoursPerDay: effectiveHours,
      checkFrequency,
      markAbsentAfter: effectiveAbsent,
      workingDays,
    };
    if (editingId) {
      onUpdate(editingId, data);
    } else {
      onAdd(data);
    }
    resetForm();
    setShowForm(false);
  };

  const startEdit = (p: LocationProfile) => {
    setEditingId(p.id);
    setName(p.name);
    setLatitude(p.latitude.toString());
    setLongitude(p.longitude.toString());
    const isPresetRadius = RADIUS_OPTIONS.includes(p.radius);
    setRadius(isPresetRadius ? p.radius : RADIUS_OPTIONS[0]);
    setCustomRadius(isPresetRadius ? '' : p.radius.toString());
    setCheckInTime(p.checkInTime);
    setCheckOutTime(p.checkOutTime);
    const isPresetHours = HOURS_PRESETS.includes(p.expectedHoursPerDay);
    setExpectedHoursPerDay(isPresetHours ? p.expectedHoursPerDay : HOURS_PRESETS[0]);
    setCustomHours(isPresetHours ? '' : p.expectedHoursPerDay.toString());
    setCheckFrequency(p.checkFrequency);
    const isPresetAbsent = ABSENT_OPTIONS.includes(p.markAbsentAfter);
    setMarkAbsentAfter(isPresetAbsent ? p.markAbsentAfter : ABSENT_OPTIONS[0]);
    setCustomAbsent(isPresetAbsent ? '' : p.markAbsentAfter.toString());
    setWorkingDays([...p.workingDays]);
    setShowForm(true);
  };

  const toggleDay = (day: number) => {
    setWorkingDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort()
    );
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-heading">Location Profiles</h2>
          <p className="text-sm text-sub">Manage your work locations and shift times</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true); }}
          className="rounded-xl bg-gradient-to-r from-indigo-500 to-blue-600 text-white px-4 py-2.5 font-semibold text-sm flex items-center gap-1.5 hover:from-indigo-600 hover:to-blue-700 transition-all shadow-sm active:scale-[0.97]"
        >
          <Plus className="h-4 w-4" />
          Add Profile
        </button>
      </div>

      {/* Profile Form */}
      {showForm && (
        <div className="card p-5 space-y-4 animate-in">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-heading">{editingId ? 'Edit Profile' : 'New Profile'}</h3>
            <button onClick={() => { setShowForm(false); resetForm(); }} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div>
            <label className="text-label mb-1 block">Profile Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Main Office"
              className="input-field"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-label mb-1 block">Latitude</label>
              <input
                type="number"
                step="any"
                value={latitude}
                onChange={e => setLatitude(e.target.value)}
                placeholder="e.g. 40.7128"
                className="input-field"
              />
            </div>
            <div>
              <label className="text-label mb-1 block">Longitude</label>
              <input
                type="number"
                step="any"
                value={longitude}
                onChange={e => setLongitude(e.target.value)}
                placeholder="e.g. -74.0060"
                className="input-field"
              />
            </div>
          </div>

          <button
            onClick={handleCapture}
            disabled={capturing}
            className="w-full rounded-xl bg-teal-50 border border-teal-200 text-teal-700 font-medium text-sm py-2.5 flex items-center justify-center gap-2 hover:bg-teal-100 transition disabled:opacity-50 dark:bg-teal-950 dark:border-teal-800 dark:text-teal-300 dark:hover:bg-teal-900"
          >
            <Navigation className="h-4 w-4" />
            {capturing ? 'Capturing GPS...' : 'Capture Current Location'}
          </button>

          <div>
            <label className="text-label mb-1 block">Geofence Radius</label>
            <div className="flex flex-wrap gap-2">
              {RADIUS_OPTIONS.map(r => (
                <button
                  key={r}
                  onClick={() => { setRadius(r); setCustomRadius(''); }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    radius === r && !customRadius
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                  }`}
                >
                  {r}m
                </button>
              ))}
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min="10"
                  max="5000"
                  value={customRadius}
                  onChange={e => setCustomRadius(e.target.value)}
                  placeholder="Custom"
                  className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent dark:bg-slate-800 dark:border-slate-600 dark:text-slate-200"
                />
                <span className="text-xs text-slate-500 dark:text-slate-400">m</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-label mb-1 block flex items-center gap-1">
                <Clock className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> Check-In
              </label>
              <input
                type="time"
                value={checkInTime}
                onChange={e => setCheckInTime(e.target.value)}
                className="input-field"
              />
            </div>
            <div>
              <label className="text-label mb-1 block flex items-center gap-1">
                <Clock className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" /> Check-Out
              </label>
              <input
                type="time"
                value={checkOutTime}
                onChange={e => setCheckOutTime(e.target.value)}
                className="input-field"
              />
            </div>
          </div>

          {/* New Fields Section */}
          <div className="border-t border-slate-200 dark:border-slate-700 pt-4 space-y-4">
            <h4 className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wide">Attendance Rules</h4>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-label mb-1 block">Expected Hrs/Day</label>
                <div className="flex flex-wrap gap-1.5">
                  {HOURS_PRESETS.map(h => (
                    <button
                      key={h}
                      onClick={() => { setExpectedHoursPerDay(h); setCustomHours(''); }}
                      className={`rounded-lg px-2 py-1 text-xs font-medium transition ${
                        expectedHoursPerDay === h && !customHours
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                      }`}
                    >
                      {h}h
                    </button>
                  ))}
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min="1"
                      max="24"
                      step="0.5"
                      value={customHours}
                      onChange={e => setCustomHours(e.target.value)}
                      placeholder="Custom"
                      className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent dark:bg-slate-800 dark:border-slate-600 dark:text-slate-200"
                    />
                    <span className="text-xs text-slate-500 dark:text-slate-400">h</span>
                  </div>
                </div>
              </div>
              <div>
                <label className="text-label mb-1 block">Check Frequency (min)</label>
                <div className="flex flex-wrap gap-1.5">
                  {FREQUENCY_OPTIONS.map(f => (
                    <button
                      key={f}
                      onClick={() => setCheckFrequency(f)}
                      className={`rounded-lg px-2 py-1 text-xs font-medium transition ${
                        checkFrequency === f
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                      }`}
                    >
                      {f}m
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label className="text-label mb-1 block">Mark Absent After (min past check-in)</label>
              <div className="flex flex-wrap gap-2">
                {ABSENT_OPTIONS.map(a => (
                  <button
                    key={a}
                    onClick={() => { setMarkAbsentAfter(a); setCustomAbsent(''); }}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      markAbsentAfter === a && !customAbsent
                        ? 'bg-rose-600 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                    }`}
                  >
                    {a}m
                  </button>
                ))}
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="1"
                    max="480"
                    value={customAbsent}
                    onChange={e => setCustomAbsent(e.target.value)}
                    placeholder="Custom"
                    className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent dark:bg-slate-800 dark:border-slate-600 dark:text-slate-200"
                  />
                  <span className="text-xs text-slate-500 dark:text-slate-400">min</span>
                </div>
              </div>
            </div>

            <div>
              <label className="text-label mb-1 block flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" /> Working Days
              </label>
              <div className="flex flex-wrap gap-2">
                {ALL_DAYS.map(d => (
                  <button
                    key={d}
                    onClick={() => toggleDay(d)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      workingDays.includes(d)
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-400 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:hover:bg-slate-700'
                    }`}
                  >
                    {getDayName(d)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={!name || !latitude || !longitude}
            className="w-full rounded-xl bg-gradient-to-r from-indigo-500 to-blue-600 text-white font-semibold py-3 flex items-center justify-center gap-2 hover:from-indigo-600 hover:to-blue-700 transition-all shadow-sm disabled:opacity-40 active:scale-[0.98]"
          >
            <Check className="h-5 w-5" />
            {editingId ? 'Update Profile' : 'Create Profile'}
          </button>
        </div>
      )}

      {/* Profiles List */}
      {profiles.length === 0 ? (
        <div className="card p-8 text-center">
          <MapPin className="h-12 w-12 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
          <h3 className="font-semibold text-heading mb-1">No Profiles Yet</h3>
          <p className="text-sm text-sub">Create your first location profile to get started</p>
        </div>
      ) : (
        <div className="space-y-3">
          {profiles.map(p => (
            <div key={p.id} className={`card p-4 transition-all ${p.active ? 'border-emerald-200 ring-1 ring-emerald-100 dark:border-emerald-800 dark:ring-emerald-900' : 'opacity-70'}`}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl flex items-center justify-center text-white text-sm font-bold" style={{ backgroundColor: p.color }}>
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-semibold text-heading">{p.name}</h3>
                    <p className="text-xs text-sub font-mono">
                      {p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onToggle(p.id)}
                    className={`p-1.5 rounded-lg transition ${p.active ? 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-950 dark:hover:bg-emerald-900' : 'text-slate-400 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700'}`}
                    title={p.active ? 'Disable' : 'Enable'}
                  >
                    {p.active ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
                  </button>
                  <button onClick={() => startEdit(p)} className="p-1.5 rounded-lg text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition dark:text-indigo-400 dark:bg-indigo-950 dark:hover:bg-indigo-900">
                    <Edit3 className="h-4 w-4" />
                  </button>
                  <button onClick={() => onDelete(p.id)} className="p-1.5 rounded-lg text-rose-600 bg-rose-50 hover:bg-rose-100 transition dark:text-rose-400 dark:bg-rose-950 dark:hover:bg-rose-900">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="rounded-lg bg-slate-100 text-slate-600 px-2.5 py-1 flex items-center gap-1 dark:bg-slate-800 dark:text-slate-300">
                  <MapPin className="h-3 w-3" /> {p.radius}m fence
                </span>
                <span className="rounded-lg bg-emerald-50 text-emerald-700 px-2.5 py-1 flex items-center gap-1 dark:bg-emerald-950 dark:text-emerald-300">
                  <Clock className="h-3 w-3" /> In: {p.checkInTime}
                </span>
                <span className="rounded-lg bg-rose-50 text-rose-700 px-2.5 py-1 flex items-center gap-1 dark:bg-rose-950 dark:text-rose-300">
                  <Clock className="h-3 w-3" /> Out: {p.checkOutTime}
                </span>
                <span className="rounded-lg bg-indigo-50 text-indigo-700 px-2.5 py-1 dark:bg-indigo-950 dark:text-indigo-300">
                  {p.expectedHoursPerDay}h/day
                </span>
                <span className="rounded-lg bg-amber-50 text-amber-700 px-2.5 py-1 dark:bg-amber-950 dark:text-amber-300">
                  Check every {p.checkFrequency}m
                </span>
                <span className="rounded-lg bg-rose-50 text-rose-700 px-2.5 py-1 dark:bg-rose-950 dark:text-rose-300">
                  Absent after {p.markAbsentAfter}m
                </span>
                <span className="rounded-lg bg-blue-50 text-blue-700 px-2.5 py-1 dark:bg-blue-950 dark:text-blue-300">
                  {p.workingDays.map(d => getDayName(d)).join(', ')}
                </span>
                {p.active && (
                  <span className="rounded-lg bg-emerald-100 text-emerald-700 px-2.5 py-1 font-medium dark:bg-emerald-950 dark:text-emerald-300">
                    Active
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
