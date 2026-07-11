package com.geoattendance.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

/**
 * AttendanceForegroundService
 *
 * Runs as an Android ForegroundService (exempt from Doze/battery optimisation).
 * Handles all GPS polling, geofence evaluation, session logic, and notifications.
 *
 * Attendance rules:
 *  - Present/Absent is determined ONLY by geofence (inside radius = present).
 *  - Check-in fires any time the user enters the geofence within the active window.
 *  - Active window: [checkInTime - markAbsentAfter] to [checkOutTime + 30 min].
 *  - GPS starts 30 min before the earliest check-in window and stops 30 min after
 *    all sessions end (geofence left) or checkOutTime passes — whichever is later.
 *  - Absent is marked if the user never entered the geofence by checkInTime + markAbsentAfter.
 *  - No manual check-in or check-out.
 */
public class AttendanceForegroundService extends Service {

    private static final String TAG = "AttendSvc";

    // ── Notification channels ─────────────────────────────────────────────────
    public static final String CHANNEL_ID    = "attendance_tracking";
    public static final String CHANNEL_NOTIF = "attendance_events";
    public static final int    NOTIF_ID      = 1001;

    // ── Intent extras ─────────────────────────────────────────────────────────
    public static final String EXTRA_IS_BOOT = "is_boot_start";

    // ── SharedPreferences keys ────────────────────────────────────────────────
    public static final String PREFS_STATE = "AttendanceState";
    public static final String PREFS_LOGS  = "AttendanceLogs";
    public static final String PREFS_PROC  = "AttendanceProcessed";

    // ── GPS ───────────────────────────────────────────────────────────────────
    private LocationManager  locationManager;
    private LocationListener locationListener;
    private Location         lastLocation;
    private boolean          gpsActive = false;

    // GPS update params while actively scanning
    private static final long  GPS_MIN_TIME_MS    = 30_000; // 30 s between updates
    private static final float GPS_MIN_DISTANCE_M = 10f;    // 10 m minimum movement

    // ── Scheduler ─────────────────────────────────────────────────────────────
    private final Handler  handler      = new Handler(Looper.getMainLooper());
    private       Runnable tickRunnable = null;

    // ── Geofence-exit lingering ───────────────────────────────────────────────
    // Track when each open session last left the fence, so we can keep GPS on
    // for 30 min after exit before powering down.
    // Key: profileId, Value: epoch ms when exit was first detected
    private final java.util.HashMap<String, Long> exitDetectedAt = new java.util.HashMap<>();

    // ── IST timezone ─────────────────────────────────────────────────────────
    private static final TimeZone IST = TimeZone.getTimeZone("Asia/Kolkata");

    // ─────────────────────────────────────────────────────────────────────────
    // Service lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        Log.i(TAG, "Service created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean isBootStart = intent != null && intent.getBooleanExtra(EXTRA_IS_BOOT, false);
        Log.i(TAG, "onStartCommand isBootStart=" + isBootStart);

        // Android 14+ throws SecurityException when starting a `location`-type
        // foreground service without location permission (e.g. after reboot if
        // the user revoked "Allow all the time"). Fail gracefully, not crash.
        boolean hasLocation = androidx.core.content.ContextCompat.checkSelfPermission(
                this, android.Manifest.permission.ACCESS_FINE_LOCATION)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
        try {
            if (!hasLocation) throw new SecurityException("Location permission not granted");
            startForeground(NOTIF_ID, buildPersistentNotification("GeoAttend active — monitoring schedule"));
        } catch (Exception e) {
            Log.e(TAG, "Cannot start foreground service: " + e.getMessage());
            try {
                sendEventNotification("⚠️ GeoAttend — action required",
                        "Location permission missing. Open the app and grant \"Allow all the time\".");
            } catch (Exception ignored) { /* POST_NOTIFICATIONS may also be missing */ }
            stopSelf();
            return START_NOT_STICKY;
        }

        // Close truly-abandoned sessions (live overnight sessions are kept open)
        closeStaleSessions();

        // Keep the dedup store from growing forever
        pruneOldProcessedKeys();

        // Start the smart scheduler — it will decide when to start/stop GPS
        scheduleNext(true);

        if (isBootStart) {
            JSONArray profiles = getProfiles();
            if (profiles.length() == 0) {
                sendEventNotification("⚠️ GeoAttend — action required",
                        "Open the app to restore attendance tracking after reboot");
            }
            // Delay first catch-up scan by 90 s on boot (GPS cold-fix time)
            handler.postDelayed(this::runCatchUpScan, 90_000);
        } else {
            handler.postDelayed(this::runCatchUpScan, 2_000);
        }

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "Service destroyed");
        stopGPS();
        if (tickRunnable != null) handler.removeCallbacks(tickRunnable);
        super.onDestroy();
    }

    @Nullable @Override
    public IBinder onBind(Intent intent) { return null; }

    // ─────────────────────────────────────────────────────────────────────────
    // GPS — smart start / stop
    // ─────────────────────────────────────────────────────────────────────────

    private void startGPS() {
        if (gpsActive) return; // already running
        try {
            locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);

            locationListener = new LocationListener() {
                @Override
                public void onLocationChanged(@NonNull Location location) {
                    lastLocation = location;
                    Log.d(TAG, String.format("GPS: %.5f,%.5f acc=%.0fm",
                            location.getLatitude(), location.getLongitude(), location.getAccuracy()));
                    saveLastLocation(location);
                    runTick(false);
                }
                @Override public void onProviderEnabled(@NonNull String p) {}
                @Override public void onProviderDisabled(@NonNull String p) {
                    Log.w(TAG, "GPS provider disabled: " + p);
                }
            };

            //noinspection MissingPermission
            locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    GPS_MIN_TIME_MS,
                    GPS_MIN_DISTANCE_M,
                    locationListener,
                    Looper.getMainLooper());

            // Network provider fallback — GPS often fails indoors, which is
            // exactly where people are when they check in. Cell/Wi-Fi fixes
            // keep the geofence evaluation alive.
            try {
                if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    //noinspection MissingPermission
                    locationManager.requestLocationUpdates(
                            LocationManager.NETWORK_PROVIDER,
                            GPS_MIN_TIME_MS,
                            GPS_MIN_DISTANCE_M,
                            locationListener,
                            Looper.getMainLooper());
                }
            } catch (Exception e) {
                Log.w(TAG, "Network provider unavailable: " + e.getMessage());
            }

            //noinspection MissingPermission
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last == null) {
                //noinspection MissingPermission
                last = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            }
            if (last != null) lastLocation = last;

            gpsActive = true;
            Log.i(TAG, "GPS started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start GPS: " + e.getMessage());
        }
    }

    private void stopGPS() {
        if (!gpsActive) return;
        if (locationManager != null && locationListener != null) {
            locationManager.removeUpdates(locationListener);
        }
        locationListener = null;
        gpsActive = false;
        Log.i(TAG, "GPS stopped (outside active window)");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Smart scheduler
    //
    // Logic:
    //   scanStart = checkInTime - markAbsentAfter - 30 min
    //   scanEnd   = checkOutTime + 30 min   (or 30 min after last geofence exit,
    //               whichever is later)
    //
    // Between scanStart and scanEnd  → GPS on, tick every 30 s
    // Outside that window            → GPS off, sleep until next scanStart
    // ─────────────────────────────────────────────────────────────────────────

    private void scheduleNext(boolean immediate) {
        if (tickRunnable != null) handler.removeCallbacks(tickRunnable);

        tickRunnable = new Runnable() {
            @Override public void run() {
                Calendar now     = Calendar.getInstance(IST);
                int nowMins      = toMinutes(formatTime(now));
                int nowDay       = now.get(Calendar.DAY_OF_WEEK) - 1;
                JSONArray profs  = getProfiles();
                JSONArray logs   = getLogs();

                boolean anyActive    = false; // any open session right now
                boolean inScanWindow = false; // inside at least one scan window
                long    msToNextScan = Long.MAX_VALUE; // ms until next scan window opens

                for (int i = 0; i < profs.length(); i++) {
                    try {
                        JSONObject p = profs.getJSONObject(i);
                        if (!p.optBoolean("active", false)) continue;

                        String profileId    = p.getString("id");
                        int ciMins          = toMinutes(p.getString("checkInTime"));
                        int coMins          = toMinutes(p.getString("checkOutTime"));

                        // An open session ALWAYS keeps GPS on — checked before the
                        // working-day filter and with no date filter, so overnight
                        // sessions that cross midnight are never abandoned.
                        if (hasOpenSession(logs, profileId)) {
                            anyActive = true;
                            inScanWindow = true;
                        }

                        // Requirement: scanning starts exactly 30 min before check-in.
                        int scanStartMins = wrapMins(ciMins - 30);
                        int scanEndMins   = wrapMins(coMins + 30);
                        boolean overnight = wrapMins(coMins + 30) < wrapMins(ciMins - 30);

                        // Working-day check must use the SHIFT's anchor day: in the
                        // post-midnight portion of an overnight shift, the shift
                        // belongs to yesterday.
                        boolean postMidnightPortion = overnight && nowMins <= scanEndMins;
                        int anchorDay = postMidnightPortion ? (nowDay + 6) % 7 : nowDay;
                        JSONArray wd = p.optJSONArray("workingDays");
                        if (wd != null && wd.length() > 0 && !arrayContains(wd, anchorDay)) continue;

                        // Keep GPS on for 30 min after a geofence exit
                        if (exitDetectedAt.containsKey(profileId)) {
                            long exitMs    = exitDetectedAt.get(profileId);
                            long lingerEnd = exitMs + 30L * 60_000;
                            if (lingerEnd > now.getTimeInMillis()) {
                                inScanWindow = true;
                            } else {
                                exitDetectedAt.remove(profileId); // linger expired
                            }
                        }

                        if (inWrappedWindow(nowMins, scanStartMins, scanEndMins)) {
                            inScanWindow = true;
                        } else {
                            long ms = (long) minutesUntil(nowMins, scanStartMins) * 60_000;
                            if (ms < msToNextScan) msToNextScan = ms;
                        }

                    } catch (JSONException e) {
                        Log.e(TAG, "scheduleNext profile error: " + e.getMessage());
                    }
                }

                if (inScanWindow || anyActive) {
                    startGPS();
                    runTick(false);
                    // Re-schedule in 30 s
                    handler.postDelayed(this, 30_000);
                } else {
                    stopGPS();
                    // Sleep until 1 min before next scan window (min 1 min, max 60 min)
                    long sleepMs = (msToNextScan == Long.MAX_VALUE)
                            ? 60L * 60_000
                            : Math.max(60_000, msToNextScan - 60_000);
                    Log.i(TAG, "Outside scan window — sleeping " + (sleepMs / 60_000) + " min");
                    handler.postDelayed(this, sleepMs);
                }
            }
        };

        handler.postDelayed(tickRunnable, immediate ? 0 : 30_000);
    }

    private void runCatchUpScan() {
        Log.i(TAG, "Running catch-up scan");
        runTick(true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core tick
    //
    // Attendance rules:
    //  1. CHECK-IN  : user enters geofence at any time while inside active window.
    //                 Window = [checkInTime - markAbsentAfter .. checkOutTime]
    //                 No time-gate — presence alone triggers check-in.
    //  2. CHECK-OUT : scheduled (at checkOutTime) OR geofence exit after 5 min.
    //  3. ABSENT    : currentTime > checkInTime + markAbsentAfter
    //                 AND user never entered the geofence today.
    // ─────────────────────────────────────────────────────────────────────────

    private synchronized void runTick(boolean isCatchUp) {
        if (lastLocation == null) {
            Log.d(TAG, "Tick skipped — no GPS fix yet");
            return;
        }

        // Never make attendance decisions on a stale fix (e.g. a cached
        // getLastKnownLocation from hours ago after boot/restart).
        long fixAgeMs = System.currentTimeMillis() - lastLocation.getTime();
        if (fixAgeMs > 5 * 60_000) {
            Log.d(TAG, "Tick skipped — GPS fix is " + (fixAgeMs / 60_000) + " min old");
            return;
        }

        Calendar now          = Calendar.getInstance(IST);
        String currentDateStr = formatDate(now);
        String currentTimeStr = formatTime(now);
        int    currentMinutes = toMinutes(currentTimeStr);
        int    currentDay     = now.get(Calendar.DAY_OF_WEEK) - 1;

        JSONArray profiles   = getProfiles();
        JSONArray logs       = getLogs();
        boolean  logsChanged = false;

        for (int i = 0; i < profiles.length(); i++) {
            try {
                JSONObject profile = profiles.getJSONObject(i);
                if (!profile.optBoolean("active", false)) continue;

                String profileId    = profile.getString("id");
                String profileName  = profile.getString("name");
                double lat          = profile.getDouble("latitude");
                double lon          = profile.getDouble("longitude");
                double radius       = profile.getDouble("radius");
                String checkInTime  = profile.getString("checkInTime");
                String checkOutTime = profile.getString("checkOutTime");
                int markAbsentAfter = profile.optInt("markAbsentAfter", 30);
                double expectedHrs  = profile.optDouble("expectedHoursPerDay", 8.0);
                String color        = profile.optString("color", "#10b981");

                int ciMins = toMinutes(checkInTime);
                int coMins = toMinutes(checkOutTime);

                // Shift-date attribution: in the post-midnight portion of an
                // overnight shift, everything belongs to YESTERDAY's shift date.
                int scanEndMins       = wrapMins(coMins + 30);
                boolean overnight     = scanEndMins < wrapMins(ciMins - 30);
                boolean postMidnight  = overnight && currentMinutes <= scanEndMins;
                String  shiftDateStr  = postMidnight ? yesterdayOf(now) : currentDateStr;
                int     anchorDay     = postMidnight ? (currentDay + 6) % 7 : currentDay;

                boolean hasOpenSession = hasOpenSession(logs, profileId);

                // Working-day filter uses the shift's anchor day, and NEVER
                // skips a profile that has an open session (so an overnight
                // session can still be checked out after midnight).
                JSONArray workingDays = profile.optJSONArray("workingDays");
                if (!hasOpenSession && workingDays != null && workingDays.length() > 0
                        && !arrayContains(workingDays, anchorDay)) continue;

                double  dist    = haversine(lastLocation.getLatitude(), lastLocation.getLongitude(), lat, lon);
                boolean isWithin = dist <= radius;

                // ── AUTO CHECK-IN ────────────────────────────────────────────
                // Geofence presence is the ONLY trigger.
                // First check-in window: checkInTime ± markAbsentAfter.
                // Re-entries (after an earlier real session this shift) are
                // allowed until checkOutTime.
                if (!hasOpenSession && isWithin) {
                    int windowStart = wrapMins(ciMins - markAbsentAfter);
                    int windowEnd   = wrapMins(ciMins + markAbsentAfter);

                    boolean hadRealSessionToday = hadRealSession(logs, profileId, shiftDateStr);
                    boolean inFirstWindow   = inWrappedWindow(currentMinutes, windowStart, windowEnd);
                    boolean inReEntryWindow = inWrappedWindow(currentMinutes, windowStart, wrapMins(coMins));

                    boolean shouldCheckIn = hadRealSessionToday ? inReEntryWindow : inFirstWindow;

                    if (shouldCheckIn) {
                        String reEntryKey  = "reentry:" + currentTimeStr.substring(0, 5);
                        boolean alreadyRe  = isProcessed(profileId, shiftDateStr, reEntryKey);
                        boolean alreadyFirst = isProcessed(profileId, shiftDateStr, checkInTime);

                        boolean doCheckIn = hadRealSessionToday ? !alreadyRe : !alreadyFirst;

                        if (doCheckIn) {
                            JSONObject newLog = buildCheckInLog(profileId, profileName, shiftDateStr, now, color);
                            logs = appendLog(logs, newLog);
                            logsChanged = true;
                            markProcessed(profileId, shiftDateStr, hadRealSessionToday ? reEntryKey : checkInTime);
                            exitDetectedAt.remove(profileId); // clear any lingering exit timer on re-entry
                            sendEventNotification("✅ Checked In – " + profileName,
                                    "Auto check-in at " + currentTimeStr);
                            Log.i(TAG, "CHECK-IN: " + profileName + " at " + currentTimeStr);
                        }
                    }
                }

                // Re-evaluate after possible check-in
                hasOpenSession = hasOpenSession(logs, profileId);

                // NOTE: Scheduled checkout by time has been intentionally removed.
                // Auto check-out fires ONLY on geofence exit (see block below).

                // ── AUTO CHECK-OUT: geofence exit (the ONLY checkout trigger) ─
                // Date-agnostic: closes overnight sessions after midnight too.
                if (hasOpenSession && !isWithin) {
                    JSONObject openLog = findOpenLog(logs, profileId);
                    if (openLog != null) {
                        long checkInEpoch   = isoToEpoch(openLog.getString("checkIn"));
                        long minutesSinceIn = (now.getTimeInMillis() - checkInEpoch) / 60000;
                        if (minutesSinceIn > 5) {
                            String exitKey = "exit:" + openLog.getString("id");
                            String logShiftDate = openLog.optString("date", shiftDateStr);
                            if (!isProcessed(profileId, logShiftDate, exitKey)) {
                                logs = closeOpenSession(logs, profileId, now, expectedHrs);
                                logsChanged = true;
                                markProcessed(profileId, logShiftDate, exitKey);
                                // Record exit time so scheduler keeps GPS on for 30 min
                                exitDetectedAt.put(profileId, now.getTimeInMillis());
                                sendEventNotification("📍 Left Geofence – " + profileName,
                                        "Check-out at " + currentTimeStr);
                                Log.i(TAG, "CHECKOUT (exit): " + profileName + " at " + currentTimeStr);
                            }
                        }
                    }
                }

                // Clear exit linger if user re-entered the fence
                if (isWithin && exitDetectedAt.containsKey(profileId)) {
                    exitDetectedAt.remove(profileId);
                }

                // ── MARK ABSENT ──────────────────────────────────────────────
                // Only if: no session for this shift AND outside geofence AND we
                // are past the check-in window (checkInTime + markAbsentAfter),
                // but still before the shift's scan end. Wrap-safe for overnight.
                boolean pastWindow = inWrappedWindow(currentMinutes,
                        wrapMins(ciMins + markAbsentAfter + 1), scanEndMins);
                if (!hasOpenSession && !isWithin && pastWindow) {
                    boolean existsToday = hasAnyLogToday(logs, profileId, shiftDateStr);
                    boolean absentDone  = isProcessed(profileId, shiftDateStr, "absent");
                    if (!existsToday && !absentDone) {
                        JSONObject absentLog = buildAbsentLog(profileId, profileName, shiftDateStr, checkInTime, color);
                        logs = appendLog(logs, absentLog);
                        logsChanged = true;
                        markProcessed(profileId, shiftDateStr, "absent");
                        sendEventNotification("⚠️ Marked Absent – " + profileName,
                                "No check-in recorded for " + shiftDateStr);
                        Log.i(TAG, "ABSENT: " + profileName + " on " + shiftDateStr);
                    }
                }

            } catch (JSONException e) {
                Log.e(TAG, "Tick error profile " + i + ": " + e.getMessage());
            }
        }

        if (logsChanged) {
            saveLogs(logs);
            updateStateSnapshot(logs);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Close stale sessions from previous days on service start
    // ─────────────────────────────────────────────────────────────────────────

    private void closeStaleSessions() {
        // A session is only "stale" if the time since check-in exceeds the
        // profile's shift length plus a 2-hour grace period. This protects
        // legitimately-running OVERNIGHT sessions (which have yesterday's
        // date) from being killed when the service restarts after midnight.
        Calendar now    = Calendar.getInstance(IST);
        JSONArray logs  = getLogs();
        boolean changed = false;

        try {
            JSONArray profiles = getProfiles();
            for (int i = 0; i < logs.length(); i++) {
                JSONObject log = logs.getJSONObject(i);
                if (!log.isNull("checkOut")) continue;
                if ("absent".equals(log.optString("status"))) continue;

                String profileId = log.getString("profileId");
                int shiftLenMins = 480; // fallback: 8 h
                double expectedHrs = 8.0;
                for (int j = 0; j < profiles.length(); j++) {
                    JSONObject p = profiles.getJSONObject(j);
                    if (profileId.equals(p.getString("id"))) {
                        int ci = toMinutes(p.getString("checkInTime"));
                        int co = toMinutes(p.getString("checkOutTime"));
                        shiftLenMins = wrapMins(co - ci);          // overnight-safe length
                        if (shiftLenMins == 0) shiftLenMins = 480;
                        expectedHrs = p.optDouble("expectedHoursPerDay", 8.0);
                        break;
                    }
                }

                long checkInMs      = isoToEpoch(log.getString("checkIn"));
                long minutesSinceIn = (now.getTimeInMillis() - checkInMs) / 60_000;

                // Still plausibly a live session (incl. overnight)? Leave it open —
                // the geofence-exit logic will close it with the REAL exit time.
                if (minutesSinceIn <= shiftLenMins + 120) continue;

                // Truly abandoned (service was dead past the whole shift).
                // Best available estimate: close at check-in + shift length.
                long checkOutMs = checkInMs + shiftLenMins * 60_000L;
                Calendar closeAt = Calendar.getInstance(IST);
                closeAt.setTimeInMillis(checkOutMs);
                long duration = shiftLenMins;
                log.put("checkOut", toISO(closeAt));
                log.put("duration", duration);
                log.put("attended", duration >= Math.round(expectedHrs * 60) * 0.5);
                logs.put(i, log);
                changed = true;
                Log.i(TAG, "Closed stale session for " + profileId
                        + " (open " + minutesSinceIn + " min, shift " + shiftLenMins + " min)");
            }
        } catch (JSONException e) {
            Log.e(TAG, "closeStaleSessions error: " + e.getMessage());
        }

        if (changed) { saveLogs(logs); updateStateSnapshot(logs); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Session helpers
    // ─────────────────────────────────────────────────────────────────────────

    /** Date-agnostic: any open, non-absent session for this profile counts —
     *  crucial for overnight shifts that cross a calendar-day boundary. */
    private boolean hasOpenSession(JSONArray logs, String profileId) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && l.isNull("checkOut")
                        && !"absent".equals(l.optString("status")))
                    return true;
            }
        } catch (JSONException e) { Log.e(TAG, e.getMessage()); }
        return false;
    }

    private boolean hadRealSession(JSONArray logs, String profileId, String date) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && date.equals(l.optString("date"))
                        && !"absent".equals(l.optString("status")))
                    return true;
            }
        } catch (JSONException e) { Log.e(TAG, e.getMessage()); }
        return false;
    }

    private boolean hasAnyLogToday(JSONArray logs, String profileId, String date) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId")) && date.equals(l.optString("date")))
                    return true;
            }
        } catch (JSONException e) { Log.e(TAG, e.getMessage()); }
        return false;
    }

    private JSONObject findOpenLog(JSONArray logs, String profileId) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && l.isNull("checkOut")
                        && !"absent".equals(l.optString("status")))
                    return l;
            }
        } catch (JSONException e) { Log.e(TAG, e.getMessage()); }
        return null;
    }

    private JSONArray closeOpenSession(JSONArray logs, String profileId,
                                       Calendar now, double expectedHrs) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && l.isNull("checkOut")
                        && !"absent".equals(l.optString("status"))) {
                    long checkInMs   = isoToEpoch(l.getString("checkIn"));
                    long duration    = Math.round((now.getTimeInMillis() - checkInMs) / 60000.0);
                    long expectedMin = Math.round(expectedHrs * 60);
                    l.put("checkOut", toISO(now));
                    l.put("duration", duration);
                    l.put("attended", duration >= expectedMin * 0.5);
                    logs.put(i, l);
                    break;
                }
            }
        } catch (JSONException e) { Log.e(TAG, "closeOpenSession: " + e.getMessage()); }
        return logs;
    }

    private JSONObject buildCheckInLog(String profileId, String profileName, String date,
                                       Calendar now, String color) throws JSONException {
        JSONObject l = new JSONObject();
        l.put("id", generateId());
        l.put("profileId", profileId);
        l.put("profileName", profileName);
        l.put("date", date);
        l.put("checkIn", toISO(now));
        l.put("checkOut", JSONObject.NULL);
        l.put("duration", JSONObject.NULL);
        l.put("status", "auto");
        l.put("profileColor", color);
        l.put("attended", true);
        return l;
    }

    private JSONObject buildAbsentLog(String profileId, String profileName, String date,
                                      String checkInTime, String color) throws JSONException {
        JSONObject l = new JSONObject();
        l.put("id", generateId());
        l.put("profileId", profileId);
        l.put("profileName", profileName);
        l.put("date", date);
        l.put("checkIn", date + "T" + checkInTime + ":00+05:30");
        l.put("checkOut", JSONObject.NULL);
        l.put("duration", JSONObject.NULL);
        l.put("status", "absent");
        l.put("profileColor", color);
        l.put("attended", false);
        return l;
    }

    private JSONArray appendLog(JSONArray logs, JSONObject newLog) throws JSONException {
        JSONArray updated = new JSONArray();
        for (int i = 0; i < logs.length(); i++) updated.put(logs.getJSONObject(i));
        updated.put(newLog);
        return updated;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dedup helpers
    // ─────────────────────────────────────────────────────────────────────────

    private boolean isProcessed(String profileId, String date, String key) {
        SharedPreferences prefs = getSharedPreferences(PREFS_PROC, MODE_PRIVATE);
        String stored = prefs.getString(profileId + ":" + date, "");
        for (String k : stored.split(",")) {
            if (key.equals(k.trim())) return true;
        }
        return false;
    }

    private void markProcessed(String profileId, String date, String key) {
        SharedPreferences prefs = getSharedPreferences(PREFS_PROC, MODE_PRIVATE);
        String prefKey  = profileId + ":" + date;
        String existing = prefs.getString(prefKey, "");
        String updated  = existing.isEmpty() ? key : existing + "," + key;
        prefs.edit().putString(prefKey, updated).apply();
    }

    /**
     * Removes dedup entries older than 7 days so PREFS_PROC does not grow
     * forever. Keys are "profileId:yyyy-MM-dd" — dates compare lexicographically.
     */
    private void pruneOldProcessedKeys() {
        try {
            Calendar cutoff = Calendar.getInstance(IST);
            cutoff.add(Calendar.DAY_OF_MONTH, -7);
            String cutoffDate = formatDate(cutoff);

            SharedPreferences prefs = getSharedPreferences(PREFS_PROC, MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();
            boolean changed = false;
            for (String prefKey : prefs.getAll().keySet()) {
                int idx = prefKey.lastIndexOf(':');
                if (idx < 0) continue;
                String date = prefKey.substring(idx + 1);
                if (date.length() == 10 && date.compareTo(cutoffDate) < 0) {
                    editor.remove(prefKey);
                    changed = true;
                }
            }
            if (changed) editor.apply();
        } catch (Exception e) {
            Log.e(TAG, "pruneOldProcessedKeys: " + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SharedPreferences I/O
    // ─────────────────────────────────────────────────────────────────────────

    private JSONArray getProfiles() {
        SharedPreferences prefs = getSharedPreferences(PREFS_STATE, MODE_PRIVATE);
        String raw = prefs.getString("profiles", "[]");
        try { return new JSONArray(raw); } catch (JSONException e) { return new JSONArray(); }
    }

    private JSONArray getLogs() {
        SharedPreferences prefs = getSharedPreferences(PREFS_LOGS, MODE_PRIVATE);
        String raw = prefs.getString("logs", "[]");
        try { return new JSONArray(raw); } catch (JSONException e) { return new JSONArray(); }
    }

    private void saveLogs(JSONArray logs) {
        getSharedPreferences(PREFS_LOGS, MODE_PRIVATE)
                .edit().putString("logs", logs.toString()).apply();
        AttendanceWidgetProvider.refreshAll(this);
    }

    /**
     * Persists the most recent GPS fix (lat/lng/accuracy/timestamp) so the
     * activity/UI is not running.
     */
    private void saveLastLocation(Location location) {
        getSharedPreferences(PREFS_STATE, MODE_PRIVATE).edit()
                .putFloat("lastLocLat", (float) location.getLatitude())
                .putFloat("lastLocLng", (float) location.getLongitude())
                .putFloat("lastLocAccuracy", location.getAccuracy())
                .putLong("lastLocTimestamp", System.currentTimeMillis())
                .apply();
        AttendanceWidgetProvider.refreshAll(this);
    }

    private void updateStateSnapshot(JSONArray logs) {
        Calendar now  = Calendar.getInstance(IST);
        String today  = formatDate(now);
        boolean checkedIn  = false;
        int totalMinutes   = 0;
        String todayStatus = "idle";

        // Per-profile summary for widget: track each profile independently
        int profilesPresent = 0;
        int profilesAbsent  = 0;
        int profilesActive  = 0; // open session right now
        String firstCheckIn  = "";
        String firstCheckOut = "";

        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                String status = l.optString("status", "auto");

                // OPEN sessions count regardless of date — an overnight session
                // that started yesterday is still "active" after midnight.
                if (!"absent".equals(status) && l.isNull("checkOut")) {
                    checkedIn = true;
                    todayStatus = "checked-in";
                    profilesActive++;
                    if (firstCheckIn.isEmpty()) firstCheckIn = l.optString("checkIn", "");
                    continue;
                }

                // Closed / absent records: today only
                if (!today.equals(l.optString("date"))) continue;

                if ("absent".equals(status)) {
                    profilesAbsent++;
                    continue;
                }

                if (!l.isNull("duration")) totalMinutes += l.optInt("duration", 0);
                profilesPresent++;
                if (firstCheckIn.isEmpty())  firstCheckIn  = l.optString("checkIn", "");
                if (firstCheckOut.isEmpty()) firstCheckOut = l.optString("checkOut", "");
            }
            if (!checkedIn && totalMinutes > 0) todayStatus = "checked-out";
            // If ALL active profiles today are absent and nothing else, mark absent
            if (!checkedIn && totalMinutes == 0 && profilesAbsent > 0 && profilesPresent == 0) {
                todayStatus = "absent";
            }
        } catch (JSONException e) { Log.e(TAG, "updateStateSnapshot: " + e.getMessage()); }

        getSharedPreferences(PREFS_STATE, MODE_PRIVATE).edit()
                .putBoolean("checkedIn", checkedIn)
                .putInt("totalMinutesToday", totalMinutes)
                .putString("todayStatus", todayStatus)
                .putInt("profilesPresent", profilesPresent)
                .putInt("profilesAbsent",  profilesAbsent)
                .putInt("profilesActive",  profilesActive)
                .putString("firstCheckIn",  firstCheckIn)
                .putString("firstCheckOut", firstCheckOut)
                .putLong("lastUpdated", System.currentTimeMillis())
                .apply();
        AttendanceWidgetProvider.refreshAll(this);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Notifications
    // ─────────────────────────────────────────────────────────────────────────

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel tracking = new NotificationChannel(
                    CHANNEL_ID, "Attendance Tracking", NotificationManager.IMPORTANCE_LOW);
            tracking.setDescription("Persistent notification while tracking is active");
            nm.createNotificationChannel(tracking);
            NotificationChannel events = new NotificationChannel(
                    CHANNEL_NOTIF, "Attendance Events", NotificationManager.IMPORTANCE_DEFAULT);
            events.setDescription("Check-in, check-out, and absent alerts");
            nm.createNotificationChannel(events);
        }
    }

    private Notification buildPersistentNotification(String text) {
        Intent tapIntent = new Intent(this, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("GeoAttend")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    private void sendEventNotification(String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_NOTIF)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setAutoCancel(true)
                .build();
        // Timestamp-based ID: unique even across service restarts
        nm.notify((int) (System.currentTimeMillis() & 0x7FFFFFFF), n);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utility
    // ─────────────────────────────────────────────────────────────────────────

    private static double haversine(double lat1, double lon1, double lat2, double lon2) {
        final double R = 6_371_000;
        double phi1 = Math.toRadians(lat1), phi2 = Math.toRadians(lat2);
        double dPhi = Math.toRadians(lat2 - lat1), dLam = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2)
                + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) * Math.sin(dLam / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static int toMinutes(String hhmm) {
        if (hhmm == null || !hhmm.contains(":")) return 0;
        String[] p = hhmm.split(":");
        return Integer.parseInt(p[0]) * 60 + Integer.parseInt(p[1]);
    }

    /** Normalize minutes into [0, 1439] so windows can wrap across midnight. */
    private static int wrapMins(int mins) {
        return ((mins % 1440) + 1440) % 1440;
    }

    /**
     * True if `now` lies inside [start, end], where the window may wrap
     * across midnight (start > end means e.g. 22:00 → 06:00).
     */
    private static boolean inWrappedWindow(int now, int start, int end) {
        if (start <= end) return now >= start && now <= end;
        return now >= start || now <= end;
    }

    /** Minutes from `now` forward to `target`, wrapping across midnight. */
    private static int minutesUntil(int now, int target) {
        return wrapMins(target - now);
    }

    /** Yesterday's date string for shift-date attribution of overnight shifts. */
    private static String yesterdayOf(Calendar now) {
        Calendar y = (Calendar) now.clone();
        y.add(Calendar.DAY_OF_MONTH, -1);
        return formatDate(y);
    }

    private static String formatDate(Calendar c) {
        return String.format(Locale.US, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    private static String formatTime(Calendar c) {
        return String.format(Locale.US, "%02d:%02d",
                c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE));
    }

    private static String toISO(Calendar c) {
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'+05:30'", Locale.US);
        sdf.setTimeZone(IST);
        return sdf.format(c.getTime());
    }

    private static long isoToEpoch(String iso) {
        try {
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            sdf.setTimeZone(IST);
            return sdf.parse(iso.replaceAll("(\\+[0-9:]+|Z)$", "")).getTime();
        } catch (Exception e) {
            Log.e(TAG, "isoToEpoch failed: " + iso);
            return System.currentTimeMillis();
        }
    }

    private static String generateId() {
        return Long.toString(System.currentTimeMillis(), 36)
                + UUID.randomUUID().toString().replace("-", "").substring(0, 9);
    }

    private static boolean arrayContains(JSONArray arr, int value) {
        for (int i = 0; i < arr.length(); i++) {
            if (arr.optInt(i, -1) == value) return true;
        }
        return false;
    }
}

