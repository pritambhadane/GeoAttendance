import { Sliders, MapPin, Clock, Zap, Info } from 'lucide-react';
import { SimulationState } from '../types';

interface SimulationPanelProps {
  simulation: SimulationState;
  onUpdate: (sim: Partial<SimulationState>) => void;
}

export default function SimulationPanel({ simulation, onUpdate }: SimulationPanelProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-heading">Simulation Panel</h2>
        <p className="text-sm text-sub">Test auto-logging without moving or waiting</p>
      </div>

      <div className="rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 p-5 space-y-4 dark:from-amber-950 dark:to-orange-950 dark:border-amber-800">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
          <Info className="h-5 w-5" />
          <p className="text-sm font-medium">Simulation mode overrides real GPS and clock for testing purposes.</p>
        </div>

        {/* Toggle */}
        <div className="flex items-center justify-between rounded-xl bg-white p-4 border border-amber-100 dark:bg-slate-900 dark:border-amber-900">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            <span className="font-semibold text-heading">Enable Simulation</span>
          </div>
          <button
            onClick={() => onUpdate({ enabled: !simulation.enabled })}
            className={`relative w-12 h-7 rounded-full transition-colors ${simulation.enabled ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600'}`}
          >
            <div className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${simulation.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {simulation.enabled && (
          <>
            {/* Simulated Location */}
            <div className="rounded-xl bg-white p-4 border border-amber-100 space-y-3 dark:bg-slate-900 dark:border-amber-900">
              <div className="flex items-center gap-2 text-teal-700 dark:text-teal-400">
                <MapPin className="h-4 w-4" />
                <span className="font-semibold text-sm">Simulated Location</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">Latitude</label>
                  <input
                    type="number"
                    step="any"
                    value={simulation.latitude}
                    onChange={e => onUpdate({ latitude: parseFloat(e.target.value) || 0 })}
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">Longitude</label>
                  <input
                    type="number"
                    step="any"
                    value={simulation.longitude}
                    onChange={e => onUpdate({ longitude: parseFloat(e.target.value) || 0 })}
                    className="input-field"
                  />
                </div>
              </div>
              <p className="text-xs text-sub">Set these to match a profile's coordinates to test geofencing.</p>
            </div>

            {/* Time Offset */}
            <div className="rounded-xl bg-white p-4 border border-amber-100 space-y-3 dark:bg-slate-900 dark:border-amber-900">
              <div className="flex items-center gap-2 text-indigo-700 dark:text-indigo-400">
                <Clock className="h-4 w-4" />
                <span className="font-semibold text-sm">Time Offset</span>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
                  Offset (minutes): {simulation.timeOffset > 0 ? '+' : ''}{simulation.timeOffset}
                </label>
                <input
                  type="range"
                  min="-720"
                  max="720"
                  value={simulation.timeOffset}
                  onChange={e => onUpdate({ timeOffset: parseInt(e.target.value) })}
                  className="w-full accent-indigo-600"
                />
                <div className="flex justify-between text-xs text-slate-400 dark:text-slate-500 mt-1">
                  <span>-12h</span>
                  <span>Now</span>
                  <span>+12h</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'Reset', value: 0 },
                  { label: '9:00 AM', value: 9 * 60 - new Date().getHours() * 60 - new Date().getMinutes() },
                  { label: '5:00 PM', value: 17 * 60 - new Date().getHours() * 60 - new Date().getMinutes() },
                  { label: '+1h', value: simulation.timeOffset + 60 },
                  { label: '-1h', value: simulation.timeOffset - 60 },
                ].map(btn => (
                  <button
                    key={btn.label}
                    onClick={() => onUpdate({ timeOffset: btn.value })}
                    className="rounded-lg bg-indigo-50 text-indigo-700 px-3 py-1.5 text-xs font-medium hover:bg-indigo-100 transition dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900"
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Quick Scenario Buttons */}
            <div className="rounded-xl bg-white p-4 border border-amber-100 space-y-3 dark:bg-slate-900 dark:border-amber-900">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <Sliders className="h-4 w-4" />
                <span className="font-semibold text-sm">Quick Scenarios</span>
              </div>
              <p className="text-xs text-sub">Set simulation to common test states:</p>
              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={() => onUpdate({ enabled: true, timeOffset: 0 })}
                  className="rounded-lg bg-emerald-50 text-emerald-700 px-3 py-2.5 text-sm font-medium hover:bg-emerald-100 transition text-left flex items-center gap-2 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900"
                >
                  <MapPin className="h-4 w-4" />
                  Current Time + Real GPS (override only GPS)
                </button>
                <button
                  onClick={() => onUpdate({ timeOffset: 9 * 60 - new Date().getHours() * 60 - new Date().getMinutes() })}
                  className="rounded-lg bg-blue-50 text-blue-700 px-3 py-2.5 text-sm font-medium hover:bg-blue-100 transition text-left flex items-center gap-2 dark:bg-blue-950 dark:text-blue-300 dark:hover:bg-blue-900"
                >
                  <Clock className="h-4 w-4" />
                  Jump to 9:00 AM (simulate check-in time)
                </button>
                <button
                  onClick={() => onUpdate({ timeOffset: 17 * 60 - new Date().getHours() * 60 - new Date().getMinutes() })}
                  className="rounded-lg bg-rose-50 text-rose-700 px-3 py-2.5 text-sm font-medium hover:bg-rose-100 transition text-left flex items-center gap-2 dark:bg-rose-950 dark:text-rose-300 dark:hover:bg-rose-900"
                >
                  <Clock className="h-4 w-4" />
                  Jump to 5:00 PM (simulate check-out time)
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
