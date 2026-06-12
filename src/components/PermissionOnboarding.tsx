import { useState } from 'react';
import { MapPin, Bell, BatteryCharging, Radio, ShieldCheck, ArrowRight } from 'lucide-react';
import {
  requestLocationPermission,
  requestNotificationPermission,
} from '../services/capacitor';
import { AttendanceServicePlugin, isNativeServiceAvailable } from '../services/nativePlugin';
import { setOnboardingComplete } from '../utils/storage';

interface PermissionOnboardingProps {
  onComplete: () => void;
}

export default function PermissionOnboarding({ onComplete }: PermissionOnboardingProps) {
  const [requesting, setRequesting] = useState(false);

  const handleGrantAll = async () => {
    setRequesting(true);
    try {
      // Location (foreground + background, if declared in manifest)
      await requestLocationPermission().catch(() => false);

      // Notifications (needed for check-in/out alerts and the foreground service)
      await requestNotificationPermission().catch(() => false);

      // Battery optimisation exemption — required for reliable background
      // tracking when the screen is locked.
      if (isNativeServiceAvailable()) {
        try {
          const status = await AttendanceServicePlugin.isBatteryExempted();
          if (!status.exempted) {
            await AttendanceServicePlugin.requestBatteryExemption();
          }
        } catch {
          /* noop — non-fatal, banner will prompt again later */
        }
      }
    } finally {
      setOnboardingComplete();
      setRequesting(false);
      onComplete();
    }
  };

  const handleSkip = () => {
    setOnboardingComplete();
    onComplete();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 px-4">
      <div className="max-w-sm w-full">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-sm mb-4">
            <Radio className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">Welcome to GeoAttendance</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            To track attendance automatically — even when the app is closed or your
            screen is locked — please grant the following permissions.
          </p>
        </div>

        <div className="space-y-3 mb-6">
          <div className="card p-4 flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center shrink-0 dark:bg-indigo-950 dark:text-indigo-400">
              <MapPin className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-heading text-sm">Location (Always Allow)</h3>
              <p className="text-xs text-sub mt-0.5">
                Required to detect when you enter or leave a geofenced location, including
                in the background.
              </p>
            </div>
          </div>

          <div className="card p-4 flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center shrink-0 dark:bg-amber-950 dark:text-amber-400">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-heading text-sm">Notifications</h3>
              <p className="text-xs text-sub mt-0.5">
                Lets the app alert you on check-in, check-out, and absence events.
              </p>
            </div>
          </div>

          <div className="card p-4 flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0 dark:bg-emerald-950 dark:text-emerald-400">
              <BatteryCharging className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-heading text-sm">Unrestricted Battery Usage</h3>
              <p className="text-xs text-sub mt-0.5">
                Prevents Android from stopping the background tracking service to
                save power.
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={handleGrantAll}
          disabled={requesting}
          className="w-full flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3 text-sm transition disabled:opacity-60"
        >
          <ShieldCheck className="h-4 w-4" />
          {requesting ? 'Requesting permissions…' : 'Grant Permissions'}
          {!requesting && <ArrowRight className="h-4 w-4" />}
        </button>

        <button
          onClick={handleSkip}
          disabled={requesting}
          className="w-full mt-2 text-center text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 py-2"
        >
          Skip for now (you can grant these later in Settings)
        </button>
      </div>
    </div>
  );
}
