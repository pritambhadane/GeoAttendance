import { useState } from 'react';
import {
  Calendar, Filter, ArrowUpDown,
  CheckCircle2, UserCheck, ThumbsUp, ThumbsDown,
} from 'lucide-react';
import { AttendanceLog } from '../types';
import { formatDuration } from '../utils/storage';

interface AttendanceHistoryProps {
  logs: AttendanceLog[];
  onClear: () => void;
}

type SortKey = 'date' | 'profileName' | 'duration' | 'status' | 'attended';
type SortDir = 'asc' | 'desc';

export default function AttendanceHistory({ logs, onClear }: AttendanceHistoryProps) {
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filterStatus, setFilterStatus] = useState<'all' | 'auto' | 'manual'>('all');

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
        {logs.length > 0 && (
          <button
            onClick={onClear}
            className="rounded-xl bg-rose-50 text-rose-600 border border-rose-200 px-3 py-1.5 text-sm font-medium hover:bg-rose-100 transition dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-900"
          >
            Clear All
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="h-4 w-4 text-slate-400 dark:text-slate-500" />
        {(['all', 'auto', 'manual'] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              filterStatus === s
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            {s === 'all' ? 'All' : s === 'auto' ? 'Auto' : 'Manual'}
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
            const isOpen = log.checkOut === null;

            return (
              <div key={log.id} className={`card p-4 transition-all ${isOpen ? 'border-emerald-200 ring-1 ring-emerald-100 dark:border-emerald-800 dark:ring-emerald-900' : ''}`}>
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
                    {isOpen ? (
                      <span className="rounded-lg bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-semibold flex items-center gap-1 animate-pulse dark:bg-emerald-950 dark:text-emerald-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Active
                      </span>
                    ) : null}
                    <span className={`rounded-lg px-2 py-0.5 text-xs font-semibold ${log.status === 'auto' ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'}`}>
                      {log.status === 'auto' ? (
                        <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Auto</span>
                      ) : (
                        <span className="flex items-center gap-1"><UserCheck className="h-3 w-3" /> Manual</span>
                      )}
                    </span>
                  </div>
                </div>
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
