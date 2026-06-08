import { useState } from 'react';
import {
  LayoutDashboard, MapPin, Sliders, Calendar, Share2,
  Menu, X, Radio, Sun, Moon, BarChart3, Crosshair, Clock,
} from 'lucide-react';
import { ThemeProvider, useTheme } from './hooks/useTheme';
import { useAutomation } from './hooks/useAutomation';
import Dashboard from './components/Dashboard';
import ProfilesManager from './components/ProfilesManager';
import SimulationPanel from './components/SimulationPanel';
import AttendanceHistory from './components/AttendanceHistory';
import ExportSuite from './components/ExportSuite';
import MonthlySummary from './components/MonthlySummary';

type Tab = 'dashboard' | 'profiles' | 'simulation' | 'history' | 'monthly' | 'export';

const TABS: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'profiles', label: 'Profiles', icon: MapPin },
  { id: 'simulation', label: 'Simulate', icon: Sliders },
  { id: 'history', label: 'History', icon: Calendar },
  { id: 'monthly', label: 'Monthly', icon: BarChart3 },
  { id: 'export', label: 'Export', icon: Share2 },
];

function AppContent() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const automation = useAutomation();

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
            onManualCheckIn={automation.manualCheckIn}
            onManualCheckOut={automation.manualCheckOut}
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
      case 'simulation':
        return (
          <SimulationPanel
            simulation={automation.simulation}
            onUpdate={automation.updateSimulation}
          />
        );
      case 'history':
        return (
          <AttendanceHistory
            logs={automation.logs}
            onClear={automation.clearLogs}
          />
        );
      case 'export':
        return (
          <ExportSuite
            logs={automation.logs}
            weeklyMinutes={weeklyMinutes}
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
              {automation.simulation.enabled && (
                <span className="rounded-lg bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-semibold flex items-center gap-1 dark:bg-amber-950 dark:text-amber-300">
                  <Sliders className="h-3 w-3" />
                  SIM
                </span>
              )}
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
          {currentCoords && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                <span>Last check: {new Date(currentCoords.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Crosshair className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                <span>Accuracy: ~{currentCoords.accuracy < 1000
                  ? `${Math.round(currentCoords.accuracy)}m`
                  : `${(currentCoords.accuracy / 1000).toFixed(1)}km`}</span>
              </div>
            </div>
          )}
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
