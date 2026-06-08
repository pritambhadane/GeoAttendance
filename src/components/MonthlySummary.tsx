import { useState, useMemo } from 'react';
import {
  BarChart3, TrendingUp, TrendingDown, Clock, CheckCircle2,
  XCircle, Calendar, ChevronLeft, ChevronRight, AlertTriangle,
  Award, Target, Flame, Zap,
} from 'lucide-react';
import { AttendanceLog } from '../types';
import { formatDuration, getDayName } from '../utils/storage';

interface MonthlySummaryProps {
  logs: AttendanceLog[];
}

interface DayData {
  date: string;
  dayName: string;
  dayNum: number;
  totalMinutes: number;
  sessions: number;
  attended: boolean;
  absent: boolean;
  profiles: string[];
}

interface ProfileBreakdown {
  name: string;
  color: string;
  totalMinutes: number;
  sessions: number;
  attendedDays: number;
  absentDays: number;
  avgMinutes: number;
}

function getMonthName(m: number): string {
  return ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'][m];
}

export default function MonthlySummary({ logs }: MonthlySummaryProps) {
  const now = new Date();
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [viewYear, setViewYear] = useState(now.getFullYear());

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  };
  const goToday = () => { setViewMonth(now.getMonth()); setViewYear(now.getFullYear()); };

  // Compute all analytics for the selected month
  const analytics = useMemo(() => {
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const monthStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}`;
    const monthLogs = logs.filter(l => l.date.startsWith(monthStr));

    // Build per-day data
    const dayMap = new Map<string, DayData>();
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${monthStr}-${String(d).padStart(2, '0')}`;
      const dayDate = new Date(viewYear, viewMonth, d);
      dayMap.set(dateStr, {
        date: dateStr,
        dayName: getDayName(dayDate.getDay()),
        dayNum: d,
        totalMinutes: 0,
        sessions: 0,
        attended: false,
        absent: false,
        profiles: [],
      });
    }

    for (const log of monthLogs) {
      const day = dayMap.get(log.date);
      if (!day) continue;
      day.totalMinutes += log.duration || 0;
      day.sessions += 1;
      if (log.attended) { day.attended = true; day.profiles.push(log.profileName); }
      else { day.absent = true; }
    }

    const days = Array.from(dayMap.values());
    const workingDays = days.filter(d => d.sessions > 0 || d.attended || d.absent);
    const attendedDays = days.filter(d => d.attended && !d.absent);
    const absentDays = days.filter(d => d.absent && !d.attended);
    const totalMinutes = monthLogs.reduce((s, l) => s + (l.duration || 0), 0);
    const avgDailyMinutes = workingDays.length > 0 ? totalMinutes / workingDays.length : 0;

    // Profile breakdown
    const profileMap = new Map<string, ProfileBreakdown>();
    for (const log of monthLogs) {
      if (!profileMap.has(log.profileId)) {
        profileMap.set(log.profileId, {
          name: log.profileName,
          color: log.profileColor,
          totalMinutes: 0,
          sessions: 0,
          attendedDays: 0,
          absentDays: 0,
          avgMinutes: 0,
        });
      }
      const pb = profileMap.get(log.profileId)!;
      pb.totalMinutes += log.duration || 0;
      pb.sessions += 1;
      if (log.attended) pb.attendedDays += 1;
      else pb.absentDays += 1;
    }
    const profileBreakdown = Array.from(profileMap.values());
    for (const pb of profileBreakdown) {
      pb.avgMinutes = pb.attendedDays > 0 ? pb.totalMinutes / pb.attendedDays : 0;
    }

    // Week-over-week trend (compare last 2 full weeks in the month)
    const weekBuckets: number[][] = [[], [], [], [], []];
    for (const d of days) {
      const weekIdx = Math.min(Math.floor((d.dayNum - 1) / 7), 4);
      weekBuckets[weekIdx].push(d.totalMinutes);
    }
    const weeklyTotals = weekBuckets
      .filter(w => w.length > 0)
      .map(w => w.reduce((s, m) => s + m, 0));

    let weeklyTrend: 'up' | 'down' | 'stable' | 'none' = 'none';
    let weeklyTrendPct = 0;
    if (weeklyTotals.length >= 2) {
      const prev = weeklyTotals[weeklyTotals.length - 2];
      const curr = weeklyTotals[weeklyTotals.length - 1];
      if (prev > 0) {
        weeklyTrendPct = Math.round(((curr - prev) / prev) * 100);
        weeklyTrend = weeklyTrendPct > 5 ? 'up' : weeklyTrendPct < -5 ? 'down' : 'stable';
      }
    }

    // Streak: longest consecutive attended days
    let longestStreak = 0;
    let currentStreak = 0;
    for (const d of days) {
      if (d.attended) { currentStreak++; longestStreak = Math.max(longestStreak, currentStreak); }
      else { currentStreak = 0; }
    }

    // Current streak from today going backward
    let activeStreak = 0;
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i];
      if (d.date > todayStr) continue;
      if (d.attended) activeStreak++;
      else break;
    }

    // Best day
    const bestDay = days.reduce((best, d) => d.totalMinutes > best.totalMinutes ? d : best, days[0]);

    // Average check-in time
    const checkInTimes = monthLogs
      .filter(l => l.attended)
      .map(l => new Date(l.checkIn))
      .map(d => d.getHours() * 60 + d.getMinutes());
    const avgCheckInMin = checkInTimes.length > 0
      ? Math.round(checkInTimes.reduce((s, t) => s + t, 0) / checkInTimes.length)
      : -1;
    const avgCheckInStr = avgCheckInMin >= 0
      ? `${String(Math.floor(avgCheckInMin / 60)).padStart(2, '0')}:${String(avgCheckInMin % 60).padStart(2, '0')}`
      : '--';

    // Attendance rate
    const totalTrackedDays = attendedDays.length + absentDays.length;
    const attendanceRate = totalTrackedDays > 0
      ? Math.round((attendedDays.length / totalTrackedDays) * 100)
      : 0;

    // Day-of-week breakdown
    const dowMinutes = [0, 0, 0, 0, 0, 0, 0];
    const dowCounts = [0, 0, 0, 0, 0, 0, 0];
    for (const log of monthLogs) {
      const day = new Date(log.date).getDay();
      dowMinutes[day] += log.duration || 0;
      dowCounts[day] += 1;
    }

    return {
      days, workingDays: workingDays.length,
      attendedDays: attendedDays.length, absentDays: absentDays.length,
      totalMinutes, avgDailyMinutes,
      profileBreakdown, weeklyTrend, weeklyTrendPct,
      longestStreak, activeStreak, bestDay, avgCheckInStr,
      attendanceRate, dowMinutes, dowCounts,
    };
  }, [logs, viewMonth, viewYear]);

  const {
    days, workingDays, attendedDays, absentDays,
    totalMinutes, avgDailyMinutes, profileBreakdown,
    weeklyTrend, weeklyTrendPct, longestStreak, activeStreak,
    bestDay, avgCheckInStr, attendanceRate, dowMinutes, dowCounts,
  } = analytics;

  // Heatmap: max minutes for color scaling
  const maxDayMinutes = Math.max(...days.map(d => d.totalMinutes), 1);

  // Bar chart: daily hours for the last 14 days of the month
  const barDays = days.slice(-14);

  const isCurrentMonth = viewMonth === now.getMonth() && viewYear === now.getFullYear();

  // Insight messages
  const insights = useMemo(() => {
    const items: { icon: typeof TrendingUp; text: string; color: string; bg: string }[] = [];

    if (attendanceRate >= 95) {
      items.push({ icon: Award, text: `Outstanding ${attendanceRate}% attendance rate this month!`, color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950 dark:border-emerald-800' });
    } else if (attendanceRate >= 80) {
      items.push({ icon: CheckCircle2, text: `${attendanceRate}% attendance rate — solid performance.`, color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950 dark:border-emerald-800' });
    } else if (attendanceRate > 0) {
      items.push({ icon: AlertTriangle, text: `${attendanceRate}% attendance rate — room for improvement.`, color: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-50 border-amber-200 dark:bg-amber-950 dark:border-amber-800' });
    }

    if (weeklyTrend === 'up') {
      items.push({ icon: TrendingUp, text: `Hours trending up (+${weeklyTrendPct}%) vs previous week.`, color: 'text-teal-700 dark:text-teal-300', bg: 'bg-teal-50 border-teal-200 dark:bg-teal-950 dark:border-teal-800' });
    } else if (weeklyTrend === 'down') {
      items.push({ icon: TrendingDown, text: `Hours trending down (${weeklyTrendPct}%) vs previous week.`, color: 'text-rose-700 dark:text-rose-300', bg: 'bg-rose-50 border-rose-200 dark:bg-rose-950 dark:border-rose-800' });
    }

    if (activeStreak >= 5) {
      items.push({ icon: Flame, text: `You're on a ${activeStreak}-day active streak!`, color: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-50 border-orange-200 dark:bg-orange-950 dark:border-orange-800' });
    } else if (longestStreak >= 7) {
      items.push({ icon: Flame, text: `Longest streak this month: ${longestStreak} consecutive days.`, color: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-50 border-orange-200 dark:bg-orange-950 dark:border-orange-800' });
    }

    if (bestDay && bestDay.totalMinutes > 0) {
      items.push({ icon: Zap, text: `Most productive day: ${bestDay.dayName} ${bestDay.dayNum} (${formatDuration(bestDay.totalMinutes)}).`, color: 'text-indigo-700 dark:text-indigo-300', bg: 'bg-indigo-50 border-indigo-200 dark:bg-indigo-950 dark:border-indigo-800' });
    }

    if (avgDailyMinutes > 0 && avgDailyMinutes < 360) {
      items.push({ icon: Target, text: `Average ${formatDuration(avgDailyMinutes)}/day — below typical 6h threshold.`, color: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-50 border-amber-200 dark:bg-amber-950 dark:border-amber-800' });
    } else if (avgDailyMinutes >= 480) {
      items.push({ icon: Target, text: `Average ${formatDuration(avgDailyMinutes)}/day — exceeding 8h target!`, color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950 dark:border-emerald-800' });
    }

    return items;
  }, [attendanceRate, weeklyTrend, weeklyTrendPct, activeStreak, longestStreak, bestDay, avgDailyMinutes]);

  return (
    <div className="space-y-6">
      {/* Header with month navigation */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-heading">Monthly Summary</h2>
          <p className="text-sm text-sub">Key trends and attendance insights</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 transition dark:bg-slate-800 dark:hover:bg-slate-700">
            <ChevronLeft className="h-4 w-4 text-slate-600 dark:text-slate-300" />
          </button>
          <button onClick={goToday} className="rounded-lg bg-emerald-100 text-emerald-700 px-3 py-1.5 text-sm font-semibold hover:bg-emerald-200 transition dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900">
            {getMonthName(viewMonth)} {viewYear}
          </button>
          <button onClick={nextMonth} disabled={isCurrentMonth} className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 transition disabled:opacity-30 dark:bg-slate-800 dark:hover:bg-slate-700">
            <ChevronRight className="h-4 w-4 text-slate-600 dark:text-slate-300" />
          </button>
        </div>
      </div>

      {totalMinutes === 0 && absentDays === 0 ? (
        <div className="card p-8 text-center">
          <BarChart3 className="h-12 w-12 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
          <h3 className="font-semibold text-heading mb-1">No Data for {getMonthName(viewMonth)}</h3>
          <p className="text-sm text-sub">Check in to a location profile to start building your monthly report.</p>
        </div>
      ) : (
        <>
          {/* Key Metrics Hero */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="card p-4">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 mb-2">
                <Clock className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Total Hours</span>
              </div>
              <p className="text-2xl font-bold text-heading">{formatDuration(totalMinutes)}</p>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2 text-teal-600 dark:text-teal-400 mb-2">
                <CheckCircle2 className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Attended</span>
              </div>
              <p className="text-2xl font-bold text-heading">{attendedDays}<span className="text-sm text-sub font-normal">/{workingDays} days</span></p>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 mb-2">
                <XCircle className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Absent</span>
              </div>
              <p className="text-2xl font-bold text-heading">{absentDays}<span className="text-sm text-sub font-normal"> days</span></p>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 mb-2">
                <Target className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Avg/Day</span>
              </div>
              <p className="text-2xl font-bold text-heading">{formatDuration(avgDailyMinutes)}</p>
            </div>
          </div>

          {/* Attendance Rate + Streak */}
          <div className="grid grid-cols-2 gap-4">
            <div className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-heading">Attendance Rate</span>
                <span className={`text-lg font-bold ${attendanceRate >= 80 ? 'text-emerald-600 dark:text-emerald-400' : attendanceRate >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {attendanceRate}%
                </span>
              </div>
              <div className="h-3 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${attendanceRate >= 80 ? 'bg-emerald-500' : attendanceRate >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`}
                  style={{ width: `${Math.min(attendanceRate, 100)}%` }}
                />
              </div>
              <div className="mt-2 flex items-center gap-1 text-xs text-sub">
                <Flame className="h-3 w-3 text-orange-500" />
                <span>Current streak: <strong className="text-heading">{activeStreak}</strong> days</span>
              </div>
            </div>
            <div className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-heading">Avg Check-In</span>
                <span className="text-lg font-bold text-heading">{avgCheckInStr}</span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-sub">
                <Calendar className="h-3 w-3 text-indigo-500" />
                <span>Best streak: <strong className="text-heading">{longestStreak}</strong> days</span>
              </div>
              {bestDay.totalMinutes > 0 && (
                <div className="mt-2 flex items-center gap-1 text-xs text-sub">
                  <Zap className="h-3 w-3 text-amber-500" />
                  <span>Top day: <strong className="text-heading">{bestDay.dayName} {bestDay.dayNum}</strong> ({formatDuration(bestDay.totalMinutes)})</span>
                </div>
              )}
            </div>
          </div>

          {/* Insights */}
          {insights.length > 0 && (
            <div className="card p-5">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                <h3 className="font-semibold text-heading">Key Insights</h3>
              </div>
              <div className="space-y-2">
                {insights.map((ins, i) => {
                  const Icon = ins.icon;
                  return (
                    <div key={i} className={`flex items-start gap-2 rounded-xl border p-3 ${ins.bg}`}>
                      <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${ins.color}`} />
                      <span className={`text-sm ${ins.color}`}>{ins.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Daily Hours Bar Chart */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <h3 className="font-semibold text-heading">Daily Hours</h3>
            </div>
            <div className="flex items-end gap-1 h-32">
              {barDays.map(d => {
                const pct = maxDayMinutes > 0 ? (d.totalMinutes / maxDayMinutes) * 100 : 0;
                const isToday = d.date === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                return (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                    <span className="text-[10px] text-sub truncate w-full text-center">
                      {d.totalMinutes > 0 ? `${Math.round(d.totalMinutes / 60 * 10) / 10}h` : ''}
                    </span>
                    <div className="w-full relative" style={{ height: '80px' }}>
                      <div
                        className={`absolute bottom-0 w-full rounded-t-md transition-all duration-500 ${
                          isToday ? 'bg-teal-500' : d.attended ? 'bg-emerald-400 dark:bg-emerald-600' : d.absent ? 'bg-rose-400 dark:bg-rose-600' : 'bg-slate-200 dark:bg-slate-700'
                        }`}
                        style={{ height: `${Math.max(pct, d.absent ? 10 : 2)}%` }}
                      />
                    </div>
                    <span className={`text-[10px] ${isToday ? 'font-bold text-teal-600 dark:text-teal-400' : 'text-sub'}`}>
                      {d.dayNum}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Attendance Heatmap Calendar */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-4">
              <Calendar className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              <h3 className="font-semibold text-heading">Attendance Heatmap</h3>
            </div>
            {/* Day-of-week headers */}
            <div className="grid grid-cols-7 gap-1.5 mb-1.5">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <div key={i} className="text-center text-[10px] font-medium text-sub">{d}</div>
              ))}
            </div>
            {/* Calendar grid */}
            <div className="grid grid-cols-7 gap-1.5">
              {/* Leading empty cells */}
              {Array.from({ length: new Date(viewYear, viewMonth, 1).getDay() }, (_, i) => (
                <div key={`empty-${i}`} />
              ))}
              {days.map(d => {
                const intensity = d.totalMinutes / maxDayMinutes;
                const isToday = d.date === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                let bg = 'bg-slate-100 dark:bg-slate-800';
                if (d.absent && !d.attended) bg = 'bg-rose-400 dark:bg-rose-600';
                else if (intensity >= 0.8) bg = 'bg-emerald-500';
                else if (intensity >= 0.5) bg = 'bg-emerald-400';
                else if (intensity >= 0.2) bg = 'bg-emerald-300 dark:bg-emerald-700';
                else if (d.attended) bg = 'bg-emerald-200 dark:bg-emerald-800';

                return (
                  <div
                    key={d.date}
                    className={`aspect-square rounded-lg ${bg} flex items-center justify-center text-xs font-medium relative ${
                      isToday ? 'ring-2 ring-teal-500 ring-offset-1 dark:ring-offset-slate-900' : ''
                    } ${d.attended || d.absent ? 'text-white' : 'text-slate-500 dark:text-slate-400'}`}
                    title={`${d.date}: ${d.attended ? 'Present' : d.absent ? 'Absent' : 'No data'}${d.totalMinutes > 0 ? ` - ${formatDuration(d.totalMinutes)}` : ''}`}
                  >
                    {d.dayNum}
                  </div>
                );
              })}
            </div>
            {/* Legend */}
            <div className="flex items-center gap-3 mt-3 text-xs text-sub">
              <div className="flex items-center gap-1">
                <div className="h-3 w-3 rounded bg-rose-400" /> Absent
              </div>
              <div className="flex items-center gap-1">
                <div className="h-3 w-3 rounded bg-emerald-200 dark:bg-emerald-800" /> Low
              </div>
              <div className="flex items-center gap-1">
                <div className="h-3 w-3 rounded bg-emerald-400" /> Mid
              </div>
              <div className="flex items-center gap-1">
                <div className="h-3 w-3 rounded bg-emerald-500" /> High
              </div>
            </div>
          </div>

          {/* Day-of-Week Breakdown */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-4">
              <Calendar className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              <h3 className="font-semibold text-heading">Day-of-Week Breakdown</h3>
            </div>
            <div className="space-y-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, i) => {
                const mins = dowMinutes[i];
                const count = dowCounts[i];
                const maxDow = Math.max(...dowMinutes, 1);
                const pct = (mins / maxDow) * 100;
                return (
                  <div key={name} className="flex items-center gap-3">
                    <span className="w-8 text-xs font-medium text-sub">{name}</span>
                    <div className="flex-1 h-6 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-lg bg-amber-400 dark:bg-amber-600 transition-all duration-500 flex items-center px-2"
                        style={{ width: `${Math.max(pct, count > 0 ? 8 : 0)}%` }}
                      >
                        {mins > 0 && (
                          <span className="text-[10px] font-semibold text-amber-900 dark:text-amber-100 whitespace-nowrap">
                            {formatDuration(mins)}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-sub w-12 text-right">{count} session{count !== 1 ? 's' : ''}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Profile Breakdown */}
          {profileBreakdown.length > 1 && (
            <div className="card p-5">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                <h3 className="font-semibold text-heading">Profile Breakdown</h3>
              </div>
              <div className="space-y-3">
                {profileBreakdown.map(pb => {
                  const maxProfileMinutes = Math.max(...profileBreakdown.map(p => p.totalMinutes), 1);
                  const pct = (pb.totalMinutes / maxProfileMinutes) * 100;
                  return (
                    <div key={pb.name} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="h-3 w-3 rounded-full" style={{ backgroundColor: pb.color }} />
                          <span className="text-sm font-medium text-heading">{pb.name}</span>
                        </div>
                        <span className="text-sm text-sub">{formatDuration(pb.totalMinutes)}</span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, backgroundColor: pb.color }}
                        />
                      </div>
                      <div className="flex items-center gap-4 text-xs text-sub">
                        <span>{pb.attendedDays} present</span>
                        {pb.absentDays > 0 && <span className="text-rose-600 dark:text-rose-400">{pb.absentDays} absent</span>}
                        <span>Avg {formatDuration(pb.avgMinutes)}/day</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
