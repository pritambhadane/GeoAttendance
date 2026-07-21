import { useState, useEffect } from 'react';
import {
  LayoutDashboard, MapPin, Calendar, Share2,
  Menu, X, Radio, Sun, Moon, BarChart3, Crosshair, Clock,
  BatteryWarning,
} from 'lucide-react';
import { ThemeProvider, useTheme } from './hooks/useTheme';
import { useAutomation } from './hooks/useAutomation';
import Dashboard from './components/Dashboard';
import ProfilesManager from './components/ProfilesManager';
import AttendanceHistory from './components/AttendanceHistory';
import ExportSuite from './components/ExportSuite';
import MonthlySummary from './components/MonthlySummary';
import PermissionOnboarding from './components/PermissionOnboarding';
import { AttendanceServicePlugin, isNativeServiceAvailable } from './services/nativePlugin';
import { getProfiles, getLogs, isOnboardingComplete } from './utils/storage';
import { App as CapacitorApp } from '@capacitor/app';

type Tab = 'dashboard' | 'profiles' | 'history' | 'monthly' | 'export';

const TABS: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'profiles', label: 'Profiles', icon: MapPin },
  { id: 'history', label: 'History', icon: Calendar },
  { id: 'monthly', label: 'Monthly', icon: BarChart3 },
  { id: 'export', label: 'Export', icon: Share2 },
];

function AppContent() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [nowClock, setNowClock] = useState(() => new Date());
  const [showBatteryBanner, setShowBatteryBanner] = useState(false);
  const [showAutostartBanner, setShowAutostartBanner] = useState(false);
  const [healthIssue, setHealthIssue] = useState<string | null>(null);
  const [onboardingDone, setOnboardingDone] = useState(() => isOnboardingComplete());
  const { theme, toggleTheme } = useTheme();
  const automation = useAutomation();

  // ── Android hardware/gesture BACK button ─────────────────────────────────
  // Without this listener, Capacitor's default behavior backgrounds the app
  // on ANY back press — even from a sub-tab — which feels broken.
  // Behavior: close the nav drawer if open → return to Dashboard if on
  // another tab → minimize the app only when already on Dashboard.
  useEffect(() => {
    const sub = CapacitorApp.addListener('backButton', () => {
      if (mobileNavOpen) { setMobileNavOpen(false); return; }
      if (activeTab !== 'dashboard') { setActiveTab('dashboard'); return; }
      CapacitorApp.minimizeApp().catch(() => { /* web: no-op */ });
    });
    return () => { sub.then(s => s.remove()).catch(() => { /* web: no-op */ }); };
  }, [mobileNavOpen, activeTab]);

  // ── CRITICAL: ALL hooks must be declared before any conditional return.
  // The original code placed useEffect hooks after an early `return` when
  // onboardingDone=false. On first render React never registered those hooks;
  // when onComplete() set onboardingDone=true React detected a hook count
  // mismatch and threw, leaving a blank screen. All hooks are now declared
  // unconditionally; onboardingDone is checked inside each effect.

  // ── Start native ForegroundService on app launch ─────────────────────────
  useEffect(() => {
    if (!onboardingDone) return;
    if (!isNativeServiceAvailable()) return;

    const bootstrap = async () => {
      try {
        await AttendanceServicePlugin.syncProfiles({ profiles: JSON.stringify(getProfiles()) });
        // MERGE (no `replace`) — React's copy is stale on launch because the
        // background service records sessions while the app is closed. A blind
        // overwrite here previously destroyed those entries.
        await AttendanceServicePlugin.syncLogs({ logs: JSON.stringify(getLogs()) });
        await AttendanceServicePlugin.startService();
        console.log('[GeoAttend] Native ForegroundService started');
      } catch (e) {
        console.error('[GeoAttend] Failed to start native service:', e);
      }
    };

    bootstrap();
  }, [onboardingDone]);

  // ── Battery optimisation exemption check ─────────────────────────────────
  useEffect(() => {
    if (!onboardingDone) return;
    if (!isNativeServiceAvailable()) return;

    const checkBattery = async () => {
      try {
        const result = await AttendanceServicePlugin.isBatteryExempted();
        if (!result.exempted) {
          setShowBatteryBanner(true);
        }
      } catch (e) {
        console.warn('[GeoAttend] Battery exemption check failed:', e);
      }
    };

    const t = setTimeout(checkBattery, 3000);
    return () => clearTimeout(t);
  }, [onboardingDone]);

  // ── Autostart prompt (Xiaomi/HyperOS) — shown once, dismissible ──────────
  // HyperOS kills background services when the screen locks unless Autostart
  // is enabled for the app. Android has no API to detect that setting, so we
  // guide the user there once and remember that we asked.
  useEffect(() => {
    if (!onboardingDone) return;
    if (!isNativeServiceAvailable()) return;
    if (localStorage.getItem('geoattend_autostart_prompted') === 'yes') return;
    const t = setTimeout(() => setShowAutostartBanner(true), 5000);
    return () => clearTimeout(t);
  }, [onboardingDone]);

  // ── Clock tick ───────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNowClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Tracking health: warn when something silently breaks tracking ────────
  useEffect(() => {
    if (!onboardingDone) return;
    let cancelled = false;
    const check = async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const geo = (window as any).Capacitor?.Plugins?.Geolocation;
        if (geo) {
          const perm = await geo.checkPermissions();
          if (cancelled) return;
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
            setHealthIssue('Location permission is missing — automatic check-in cannot work. Open Settings → Apps → GeoAttendance → Permissions → Location → "Allow all the time".');
            return;
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const notif = (window as any).Capacitor?.Plugins?.LocalNotifications;
        if (notif) {
          const np = await notif.checkPermissions();
          if (cancelled) return;
          if (np.display === 'denied') {
            setHealthIssue('Notifications are blocked — you will not see check-in/check-out alerts. Enable them in Settings → Apps → GeoAttendance → Notifications.');
            return;
          }
        }
        setHealthIssue(null);
      } catch { /* health check is best-effort */ }
    };
    check();
    const iv = setInterval(check, 60_000); // re-check every minute
    return () => { cancelled = true; clearInterval(iv); };
  }, [onboardingDone]);

  // ── Conditional render (after all hooks) ─────────────────────────────────
  if (!onboardingDone) {
    return <PermissionOnboarding onComplete={() => setOnboardingDone(true)} />;
  }

  const weeklyMinutes = automation.getWeeklyHours();
  const todayStatus = automation.getTodayStatus();
  const currentCoords = automation.getCurrentCoords();
  const trackingStatus = automation.getTrackingStatus();

  const renderTab = () => {
    switch (activeTab) {
      case 'dashboard':
        return (
          <Dashboard
            trackingStatus={trackingStatus}
            weeklyMinutes={weeklyMinutes}
            todayStatus={todayStatus}
            profiles={automation.profiles}
            positionError={automation.positionError}
            currentCoords={currentCoords}
          />
        );
      case 'profiles':
        return (
          <ProfilesManager
            profiles={automation.profiles}
            onAdd={automation.addProfile}
            onUpdate={automation.updateProfile}
            onDelete={automation.deleteProfile}
            onToggle={automation.toggleProfile}
          />
        );
      case 'history':
        return (
          <AttendanceHistory
            logs={automation.logs}
            profiles={automation.profiles}
            onClear={automation.clearLogs}
            onAddManual={automation.addManualRecord}
            onUpdateRecord={automation.updateRecord}
            onDeleteRecord={automation.deleteRecord}
            onMarkLeave={automation.markLeave}
          />
        );
      case 'export':
        return (
          <ExportSuite
            logs={automation.logs}
            weeklyMinutes={weeklyMinutes}
            profiles={automation.profiles}
            onRestore={automation.restoreBackup}
          />
        );
      case 'monthly':
        return (
          <MonthlySummary
            logs={automation.logs}
          />
        );
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">

      {/* Battery optimisation banner — shown once if not whitelisted */}
      {healthIssue && (
        <div className="bg-rose-50 border-b border-rose-200 dark:bg-rose-950/60 dark:border-rose-800 px-4 py-2.5 flex items-center gap-3">
          <BatteryWarning className="h-5 w-5 text-rose-600 dark:text-rose-400 shrink-0" />
          <p className="text-xs text-rose-800 dark:text-rose-300 flex-1 leading-snug">
            <strong>Tracking problem:</strong> {healthIssue}
          </p>
        </div>
      )}
      {showAutostartBanner && (
        <div className="bg-sky-50 border-b border-sky-200 dark:bg-sky-950/60 dark:border-sky-800 px-4 py-2.5 flex items-center gap-3">
          <BatteryWarning className="h-5 w-5 text-sky-600 dark:text-sky-400 shrink-0" />
          <p className="text-xs text-sky-800 dark:text-sky-300 flex-1 leading-snug">
            <strong>Enable Autostart</strong> so tracking survives screen lock on this phone. On the next screen, find GeoAttendance and switch Autostart ON.
          </p>
          <button
            onClick={async () => {
              localStorage.setItem('geoattend_autostart_prompted', 'yes');
              setShowAutostartBanner(false);
              try { await AttendanceServicePlugin.openAutostartSettings(); } catch { /* best-effort */ }
            }}
            className="text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-100 dark:bg-sky-900 px-3 py-1 rounded-lg shrink-0 hover:bg-sky-200 dark:hover:bg-sky-800 transition"
          >
            Open settings
          </button>
          <button
            onClick={() => {
              localStorage.setItem('geoattend_autostart_prompted', 'yes');
              setShowAutostartBanner(false);
            }}
            className="p-1 text-sky-500 hover:text-sky-700 dark:hover:text-sky-300"
            title="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {showBatteryBanner && (
        <div className="bg-amber-50 border-b border-amber-200 dark:bg-amber-950/60 dark:border-amber-800 px-4 py-2.5 flex items-center gap-3">
          <BatteryWarning className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
          <p className="text-xs text-amber-800 dark:text-amber-300 flex-1 leading-snug">
            <strong>Battery optimisation is ON.</strong> Android may stop background tracking within an hour. Tap to disable it for this app.
          </p>
          <button
            onClick={async () => {
              await AttendanceServicePlugin.requestBatteryExemption();
              setShowBatteryBanner(false);
            }}
            className="text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900 px-3 py-1 rounded-lg shrink-0 hover:bg-amber-200 dark:hover:bg-amber-800 transition"
          >
            Fix now
          </button>
          <button
            onClick={() => setShowBatteryBanner(false)}
            className="p-1 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
            title="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Top Header */}
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-xl border-b border-slate-200 dark:bg-slate-900/80 dark:border-slate-800">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-sm">
                <Radio className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-800 dark:text-slate-100 leading-tight">GeoAttendance</h1>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-tight">Smart Location Tracker</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {trackingStatus === 'checked-in' && (
                <span className="rounded-lg bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-semibold flex items-center gap-1 animate-pulse dark:bg-emerald-950 dark:text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  LIVE
                </span>
              )}
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition dark:text-slate-300 dark:hover:bg-slate-800"
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </button>
              <button
                className="lg:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                onClick={() => setMobileNavOpen(!mobileNavOpen)}
              >
                {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
              <span>{nowClock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            </div>
            {currentCoords && (
              <>
                <div className="flex items-center gap-1.5">
                  <Crosshair className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span>
                    GPS scan: {new Date(currentCoords.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    {' · '}~{currentCoords.accuracy < 1000
                      ? `${Math.round(currentCoords.accuracy)}m`
                      : `${(currentCoords.accuracy / 1000).toFixed(1)}km`}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Desktop Navigation */}
      <nav className="hidden lg:block sticky top-[57px] z-30 bg-white/60 backdrop-blur-xl border-b border-slate-100 dark:bg-slate-900/60 dark:border-slate-800">
        <div className="max-w-2xl mx-auto px-4">
          <div className="flex gap-1">
            {TABS.map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium transition relative ${
                    activeTab === tab.id
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                  {activeTab === tab.id && (
                    <div className="absolute bottom-0 left-4 right-4 h-0.5 bg-emerald-600 dark:bg-emerald-400 rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Mobile Nav Dropdown */}
      {mobileNavOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/20 dark:bg-black/40" onClick={() => setMobileNavOpen(false)} />
          <div className="absolute right-4 top-16 bg-white rounded-2xl shadow-xl border border-slate-200 p-2 min-w-[200px] dark:bg-slate-900 dark:border-slate-700">
            {TABS.map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); setMobileNavOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition ${
                    activeTab === tab.id
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                      : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-2xl mx-auto px-4 py-6">
        {renderTab()}
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/90 backdrop-blur-xl border-t border-slate-200 safe-bottom dark:bg-slate-900/90 dark:border-slate-800">
        <div className="flex justify-around">
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex flex-col items-center py-2 px-3 text-xs font-medium transition ${
                  activeTab === tab.id
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-400 dark:text-slate-500'
                }`}
              >
                <Icon className={`h-5 w-5 ${activeTab === tab.id ? 'text-emerald-600 dark:text-emerald-400' : ''}`} />
                <span className="mt-0.5">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Bottom spacer for mobile nav */}
      <div className="lg:hidden h-16" />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}
