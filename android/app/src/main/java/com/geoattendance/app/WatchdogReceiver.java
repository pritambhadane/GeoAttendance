package com.geoattendance.app;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * WatchdogReceiver — alarm-driven safety net that revives
 * AttendanceForegroundService if HyperOS/MIUI (or Android itself) killed it.
 *
 * How it works:
 *   1. The service arms a watchdog alarm (~15 min out) every time it starts.
 *   2. When the alarm fires, this receiver re-arms the next alarm (so the
 *      chain never breaks) and calls startForegroundService().
 *   3. If the service is already running, onStartCommand() is idempotent —
 *      it just re-checks the schedule. If it was killed, this brings it back.
 *
 * setAndAllowWhileIdle() is used so the alarm still fires while the phone
 * is in Doze (screen locked, idle). On Android 12+ a foreground service may
 * only be started from the background when the app is exempt from battery
 * optimisation — which the app requests on first launch. If the start is
 * rejected we post a notification asking the user to open the app.
 */
public class WatchdogReceiver extends BroadcastReceiver {

    private static final String TAG = "AttendanceWatchdog";
    public  static final String ACTION_WATCHDOG = "com.geoattendance.app.WATCHDOG";
    private static final int    REQUEST_CODE    = 4242;
    private static final long   INTERVAL_MS     = 15 * 60_000L; // 15 minutes
    private static final String ALERT_CHANNEL   = "watchdog_alerts";
    private static final int    ALERT_NOTIF_ID  = 9902;

    @Override
    public void onReceive(Context context, Intent intent) {
        Log.i(TAG, "Watchdog fired — ensuring attendance service is alive");
        schedule(context); // keep the chain going no matter what happens below
        try {
            Intent svc = new Intent(context, AttendanceForegroundService.class);
            svc.setAction("START");
            ContextCompat.startForegroundService(context, svc);
        } catch (Exception e) {
            // Android 12+: background FGS start denied (battery exemption missing)
            Log.e(TAG, "Watchdog could not start service: " + e.getMessage());
            notifyUser(context);
        }
    }

    /** (Re)arm the watchdog ~15 min out. Safe to call repeatedly (self-replacing). */
    public static void schedule(Context context) {
        scheduleAt(context, INTERVAL_MS);
    }

    /** Fast revive (e.g. 3 s after the app is swiped away from recents). */
    public static void scheduleSoon(Context context, long delayMs) {
        scheduleAt(context, delayMs);
    }

    /** Stop the watchdog chain (used when the user intentionally stops tracking). */
    public static void cancel(Context context) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            am.cancel(buildPendingIntent(context));
            Log.i(TAG, "Watchdog cancelled");
        } catch (Exception e) {
            Log.e(TAG, "Failed to cancel watchdog: " + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────

    private static void scheduleAt(Context context, long delayMs) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            PendingIntent pi = buildPendingIntent(context);
            long triggerAt = System.currentTimeMillis() + delayMs;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                // Fires even in Doze (rate-limited by the OS to ~once per 15 min)
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            }
            Log.i(TAG, "Watchdog armed for +" + (delayMs / 1000) + " s");
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule watchdog: " + e.getMessage());
        }
    }

    private static PendingIntent buildPendingIntent(Context context) {
        Intent i = new Intent(context, WatchdogReceiver.class);
        i.setAction(ACTION_WATCHDOG);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(context, REQUEST_CODE, i, flags);
    }

    /** Shown only when Android refuses to let us restart the service silently. */
    private void notifyUser(Context context) {
        try {
            NotificationManager nm =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel ch = new NotificationChannel(
                        ALERT_CHANNEL, "Tracking watchdog alerts",
                        NotificationManager.IMPORTANCE_HIGH);
                nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(context, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent contentPi = PendingIntent.getActivity(context, 9903, open, piFlags);

            NotificationCompat.Builder b = new NotificationCompat.Builder(context, ALERT_CHANNEL)
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setContentTitle("⚠️ GeoAttend tracking stopped")
                    .setContentText("Android blocked the automatic restart. Tap to open the app and resume tracking.")
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(
                            "Android blocked the automatic restart. Tap to open the app and resume tracking. " +
                            "To prevent this, allow \"No restrictions\" in Battery saver settings."))
                    .setContentIntent(contentPi)
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH);
            nm.notify(ALERT_NOTIF_ID, b.build());
        } catch (Exception e) {
            Log.e(TAG, "Failed to post watchdog alert: " + e.getMessage());
        }
    }
}
