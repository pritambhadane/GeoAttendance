import { useState } from 'react';
import {
  Calendar, Filter, ArrowUpDown,
  CheckCircle2, UserCheck, ThumbsUp, ThumbsDown, UserX,
  Plus, Plane, Edit3, Trash2, X, Check,
} from 'lucide-react';
import { AttendanceLog, LocationProfile } from '../types';
import { formatDuration } from '../utils/storage';

interface AttendanceHistoryProps {
  logs: AttendanceLog[];
  profiles: LocationProfile[];
  onClear: () => void;
  onAddManual: (profileId: string, date: string, checkIn: string, checkOut: string | null) => void;
  onUpdateRecord: (logId: string, checkIn: string, checkOut: string | null) => void;
  onDeleteRecord: (logId: string) => void;
  onMarkLeave: (date: string, profileId: string | null) => void;
  onMarkAbsent: (date: string, profileId: string | null) => void;
}

type SortKey = 'date' | 'profileName' | 'duration' | 'status' | 'attended';
type SortDir = 'asc' | 'desc';
type FilterStatus = 'all' | 'auto' | 'manual' | 'absent' | 'leave';

function isoToHHMM(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return '09:00'; }
}

export default function AttendanceHistory({
  logs, profiles, onClear, onAddManual, onUpdateRecord, onDeleteRecord, onMarkLeave, onMarkAbsent,
}: AttendanceHistoryProps) {
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  // Add-record / mark-leave form
  const [formMode, setFormMode] = useState<'add' | 'leave' | 'absent' | null>(null);
  const [fProfile, setFProfile] = useState('');
  const [fDate, setFDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fIn, setFIn] = useState('09:00');
  const [fOut, setFOut] = useState('17:00');
  // Inline row editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eIn, setEIn] = useState('09:00');
  const [eOut, setEOut] = useState('');

  const submitForm = () => {
    if (formMode === 'add') {
      if (!fProfile || !fDate || !fIn) return;
      onAddManual(fProfile, fDate, fIn, fOut || null);
    } else if (formMode === 'leave') {
      if (!fDate) return;
      onMarkLeave(fDate, fProfile || null);
    } else if (formMode === 'absent') {
      if (!fDate) return;
      onMarkAbsent(fDate, fProfile || null);
    }
    setFormMode(null);
  };

  const startEdit = (log: AttendanceLog) => {
    setEditingId(log.id);
    setEIn(isoToHHMM(log.checkIn));
    setEOut(log.checkOut ? isoToHHMM(log.checkOut) : '');
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const filtered = logs
    .filter(l => filterStatus === 'all' || l.status === filterStatus)
    .sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      switch (sortKey) {
        case 'date': return dir * a.date.localeCompare(b.date);
        case 'profileName': return dir * a.profileName.localeCompare(b.profileName);
        case 'duration': return dir * ((a.duration || 0) - (b.duration || 0));
        case 'status': return dir * a.status.localeCompare(b.status);
        case 'attended': return dir * (a.attended === b.attended ? 0 : a.attended ? 1 : -1);
        default: return 0;
      }
    });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-heading">Attendance History</h2>
          <p className="text-sm text-sub">{logs.length} log entries</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setFormMode(formMode === 'add' ? null : 'add'); setFProfile(profiles[0]?.id ?? ''); }}
            className="rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-200 px-3 py-1.5 text-sm font-medium hover:bg-indigo-100 transition flex items-center gap-1 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800 dark:hover:bg-indigo-900"
          >
            <Plus className="h-3.5 w-3.5" /> Add Record
          </button>
          <button
            onClick={() => { setFormMode(formMode === 'leave' ? null : 'leave'); setFProfile(''); }}
            className="rounded-xl bg-sky-50 text-sky-600 border border-sky-200 px-3 py-1.5 text-sm font-medium hover:bg-sky-100 transition flex items-center gap-1 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800 dark:hover:bg-sky-900"
          >
            <Plane className="h-3.5 w-3.5" /> Mark Leave
          </button>
          <button
            onClick={() => { setFormMode(formMode === 'absent' ? null : 'absent'); setFProfile(''); }}
            className="rounded-xl bg-rose-50 text-rose-600 border border-rose-200 px-3 py-1.5 text-sm font-medium hover:bg-rose-100 transition flex items-center gap-1 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-900"
          >
            <UserX className="h-3.5 w-3.5" /> Mark Absent
          </button>
        {logs.length > 0 && (
          <button
            onClick={onClear}
            className="rounded-xl bg-rose-50 text-rose-600 border border-rose-200 px-3 py-1.5 text-sm font-medium hover:bg-rose-100 transition dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-900"
          >
            Clear All
          </button>
        )}
        </div>
      </div>

      {/* Add-record / Mark-leave form */}
      {formMode && (
        <div className="card p-4 space-y-3">
          <h3 className="font-semibold text-heading text-sm">
            {formMode === 'add' ? 'Add manual record'
              : formMode === 'leave' ? 'Mark leave / holiday'
              : 'Mark absent'}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={fProfile}
              onChange={e => setFProfile(e.target.value)}
              className="input-field"
            >
              {formMode !== 'add' && <option value="">All profiles</option>}
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="date" value={fDate} onChange={e => setFDate(e.target.value)} className="input-field" />
            {formMode === 'add' && (
              <>
                <div>
                  <label className="text-label mb-1 block">Check-in</label>
                  <input type="time" value={fIn} onChange={e => setFIn(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="text-label mb-1 block">Check-out (optional)</label>
                  <input type="time" value={fOut} onChange={e => setFOut(e.target.value)} className="input-field" />
                </div>
              </>
            )}
          </div>
          {formMode === 'leave' && (
            <p className="text-xs text-sub">Leave days are never marked absent and don't break your streak.</p>
          )}
          {formMode === 'absent' && (
            <p className="text-xs text-sub">Marks the day absent. Profiles that already have a record for this date are left untouched.</p>
          )}
          <div className="flex gap-2">
            <button onClick={submitForm} className="rounded-xl bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-700 transition">Save</button>
            <button onClick={() => setFormMode(null)} className="rounded-xl bg-slate-100 text-slate-600 px-4 py-2 text-sm font-medium hover:bg-slate-200 transition dark:bg-slate-800 dark:text-slate-300">Cancel</button>
          </div>
        </div>
      )}

      {/* Filters — now includes Absent (fix #11) */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="h-4 w-4 text-slate-400 dark:text-slate-500" />
        {(['all', 'auto', 'manual', 'absent', 'leave'] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              filterStatus === s
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            {s === 'all' ? 'All' : s === 'auto' ? 'Auto' : s === 'manual' ? 'Manual' : s === 'absent' ? 'Absent' : 'Leave'}
          </button>
        ))}
        <div className="border-l border-slate-200 dark:border-slate-700 pl-2 ml-1 flex items-center gap-1">
          <ArrowUpDown className="h-4 w-4 text-slate-400 dark:text-slate-500" />
          {(['date', 'duration', 'status', 'attended'] as SortKey[]).map(k => (
            <button
              key={k}
              onClick={() => toggleSort(k)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                sortKey === k
                  ? 'bg-slate-800 text-white shadow-sm dark:bg-slate-200 dark:text-slate-900'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              {k === 'date' ? 'Date' : k === 'duration' ? 'Duration' : k === 'status' ? 'Status' : 'Attended'}
              {sortKey === k && (sortDir === 'asc' ? ' ^' : ' v')}
            </button>
          ))}
        </div>
      </div>

      {/* Log List */}
      {filtered.length === 0 ? (
        <div className="card p-8 text-center">
          <Calendar className="h-12 w-12 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
          <h3 className="font-semibold text-heading mb-1">No Records Yet</h3>
          <p className="text-sm text-sub">Attendance logs will appear here as you check in and out</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(log => {
            const checkInTime = new Date(log.checkIn);
            const checkOutTime = log.checkOut ? new Date(log.checkOut) : null;
            const isOpen = log.checkOut === null && log.status !== 'absent' && log.status !== 'leave';
            const isAbsent = log.status === 'absent';
            const isLeave = log.status === 'leave';
            const isEditing = editingId === log.id;

            return (
              <div key={log.id} className={`card p-4 transition-all ${
                isOpen ? 'border-emerald-200 ring-1 ring-emerald-100 dark:border-emerald-800 dark:ring-emerald-900' : ''
              } ${isAbsent ? 'border-rose-200 dark:border-rose-900' : ''} ${isLeave ? 'border-sky-200 dark:border-sky-900' : ''}`}>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl flex items-center justify-center text-white text-sm font-bold" style={{ backgroundColor: log.profileColor }}>
                      {log.profileName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <h3 className="font-semibold text-heading text-sm">{log.profileName}</h3>
                      <p className="text-xs text-sub">{log.date}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isOpen && (
                      <span className="rounded-lg bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-semibold flex items-center gap-1 animate-pulse dark:bg-emerald-950 dark:text-emerald-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Active
                      </span>
                    )}
                    {/* Status badge: Leave / Absent / Auto / Manual */}
                    {isLeave ? (
                      <span className="rounded-lg px-2 py-0.5 text-xs font-semibold bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                        <span className="flex items-center gap-1"><Plane className="h-3 w-3" /> Leave</span>
                      </span>
                    ) : isAbsent ? (
                      <span className="rounded-lg px-2 py-0.5 text-xs font-semibold bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                        <span className="flex items-center gap-1"><UserX className="h-3 w-3" /> Absent</span>
                      </span>
                    ) : (
                      <span className={`rounded-lg px-2 py-0.5 text-xs font-semibold ${log.status === 'auto' ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'}`}>
                        {log.status === 'auto' ? (
                          <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Auto</span>
                        ) : (
                          <span className="flex items-center gap-1"><UserCheck className="h-3 w-3" /> Manual</span>
                        )}
                      </span>
                    )}
                    {!isAbsent && !isLeave && !isOpen && (
                      <button onClick={() => startEdit(log)} className="rounded-lg p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition dark:hover:bg-indigo-950" title="Edit times">
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => { if (confirm(`Delete this ${log.status} record for ${log.profileName} on ${log.date}?`)) onDeleteRecord(log.id); }}
                      className="rounded-lg p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition dark:hover:bg-rose-950" title="Delete record">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Inline edit form */}
                {isEditing && (
                  <div className="mt-3 rounded-xl bg-indigo-50 border border-indigo-100 p-3 dark:bg-indigo-950 dark:border-indigo-900 flex items-end gap-2 flex-wrap">
                    <div>
                      <label className="text-label mb-1 block">Check-in</label>
                      <input type="time" value={eIn} onChange={e => setEIn(e.target.value)} className="input-field" />
                    </div>
                    <div>
                      <label className="text-label mb-1 block">Check-out</label>
                      <input type="time" value={eOut} onChange={e => setEOut(e.target.value)} className="input-field" />
                    </div>
                    <button onClick={() => { onUpdateRecord(log.id, eIn, eOut || null); setEditingId(null); }}
                      className="rounded-xl bg-indigo-600 text-white p-2 hover:bg-indigo-700 transition"><Check className="h-4 w-4" /></button>
                    <button onClick={() => setEditingId(null)}
                      className="rounded-xl bg-slate-200 text-slate-600 p-2 hover:bg-slate-300 transition dark:bg-slate-700 dark:text-slate-300"><X className="h-4 w-4" /></button>
                  </div>
                )}

                {/* Leave notice */}
                {isLeave && (
                  <div className="mt-3 rounded-xl bg-sky-50 border border-sky-100 p-3 dark:bg-sky-950 dark:border-sky-900">
                    <p className="text-sm text-sky-700 dark:text-sky-300 font-medium flex items-center gap-2">
                      <Plane className="h-4 w-4 flex-shrink-0" />
                      Leave / holiday — not counted as absent, streak preserved
                    </p>
                  </div>
                )}

                {/* Absent records show a simple absent notice instead of fake time cells */}
                {isLeave ? null : isAbsent ? (
                  <div className="mt-3 rounded-xl bg-rose-50 border border-rose-100 p-3 dark:bg-rose-950 dark:border-rose-900">
                    <p className="text-sm text-rose-700 dark:text-rose-300 font-medium flex items-center gap-2">
                      <UserX className="h-4 w-4 flex-shrink-0" />
                      Absent — did not check in for this profile
                    </p>
                    <p className="text-xs text-rose-500 dark:text-rose-400 mt-0.5">
                      Scheduled check-in: {checkInTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                ) : (
                  <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                    <div className="rounded-lg bg-emerald-50 p-2 dark:bg-emerald-950">
                      <p className="text-emerald-600 dark:text-emerald-400 font-medium mb-0.5">Check-In</p>
                      <p className="text-emerald-800 dark:text-emerald-200 font-semibold">
                        {checkInTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <div className="rounded-lg bg-rose-50 p-2 dark:bg-rose-950">
                      <p className="text-rose-600 dark:text-rose-400 font-medium mb-0.5">Check-Out</p>
                      <p className="text-rose-800 dark:text-rose-200 font-semibold">
                        {checkOutTime ? checkOutTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'}
                      </p>
                    </div>
                    <div className="rounded-lg bg-indigo-50 p-2 dark:bg-indigo-950">
                      <p className="text-indigo-600 dark:text-indigo-400 font-medium mb-0.5">Duration</p>
                      <p className="text-indigo-800 dark:text-indigo-200 font-semibold">{formatDuration(log.duration)}</p>
                    </div>
                    <div className={`rounded-lg p-2 flex flex-col items-center justify-center ${
                      log.attended
                        ? 'bg-green-400 dark:bg-green-500'
                        : 'bg-red-500 dark:bg-red-600'
                    }`}>
                      <p className={`font-medium mb-0.5 ${log.attended ? 'text-green-950 dark:text-green-50' : 'text-red-50'}`}>
                        {log.attended ? <ThumbsUp className="h-3.5 w-3.5 inline" /> : <ThumbsDown className="h-3.5 w-3.5 inline" />}
                      </p>
                      <p className={`font-bold ${log.attended ? 'text-green-950 dark:text-green-50' : 'text-red-50'}`}>
                        {log.attended ? 'Yes' : 'No'}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
