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
    private int eventNotifId = 2000;

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

        startForeground(NOTIF_ID, buildPersistentNotification("GeoAttend active — monitoring schedule"));

        // Close any previous-day open sessions
        closeStaleSessions();

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

            //noinspection MissingPermission
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
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
                String nowDate   = formatDate(now);
                JSONArray profs  = getProfiles();
                JSONArray logs   = getLogs();

                boolean anyActive    = false; // any open session right now
                boolean inScanWindow = false; // inside at least one scan window
                long    msToNextScan = Long.MAX_VALUE; // ms until next scan window opens

                for (int i = 0; i < profs.length(); i++) {
                    try {
                        JSONObject p = profs.getJSONObject(i);
                        if (!p.optBoolean("active", false)) continue;
                        JSONArray wd = p.optJSONArray("workingDays");
                        if (wd != null && wd.length() > 0 && !arrayContains(wd, nowDay)) continue;

                        String profileId    = p.getString("id");
                        int ciMins          = toMinutes(p.getString("checkInTime"));
                        int coMins          = toMinutes(p.getString("checkOutTime"));
                        int markAbsentAfter = p.optInt("markAbsentAfter", 30);

                        // scanStart = 30 min before the earliest point the user could arrive
                        //           = checkInTime - markAbsentAfter - 30
                        int scanStartMins = ciMins - markAbsentAfter - 30;
                        // scanEnd baseline = checkOutTime + 30
                        int scanEndMins   = coMins + 30;

                        // Extend scanEnd if we detected a geofence exit recently
                        // (keep GPS on for 30 min after leaving fence)
                        if (exitDetectedAt.containsKey(profileId)) {
                            long exitMs    = exitDetectedAt.get(profileId);
                            long lingerEnd = exitMs + 30L * 60_000;
                            long lingerMins = (lingerEnd - now.getTimeInMillis()) / 60_000;
                            if (lingerMins > 0) {
                                int lingerEndMins = nowMins + (int) lingerMins;
                                if (lingerEndMins > scanEndMins) scanEndMins = lingerEndMins;
                            } else {
                                exitDetectedAt.remove(profileId); // linger expired
                            }
                        }

                        // Check for open session → always stay active
                        if (hasOpenSession(logs, profileId, nowDate)) {
                            anyActive = true;
                            inScanWindow = true;
                        }

                        if (nowMins >= scanStartMins && nowMins <= scanEndMins) {
                            inScanWindow = true;
                        } else if (nowMins < scanStartMins) {
                            long ms = (long)(scanStartMins - nowMins) * 60_000;
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

                JSONArray workingDays = profile.optJSONArray("workingDays");
                if (workingDays != null && workingDays.length() > 0
                        && !arrayContains(workingDays, currentDay)) continue;

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

                double  dist    = haversine(lastLocation.getLatitude(), lastLocation.getLongitude(), lat, lon);
                boolean isWithin = dist <= radius;

                boolean hasOpenSession = hasOpenSession(logs, profileId, currentDateStr);

                // ── AUTO CHECK-IN ────────────────────────────────────────────
                // Fires whenever user is inside geofence within the active window.
                // Window: checkInTime - markAbsentAfter  →  checkOutTime
                // No ±1 min gate — geofence presence is the only condition.
                if (!hasOpenSession && isWithin) {
                    int windowStart = ciMins - markAbsentAfter;
                    int windowEnd   = coMins;

                    boolean inCheckInWindow = (currentMinutes >= windowStart && currentMinutes <= windowEnd);

                    // For catch-up scan: allow check-in if we're anywhere in today's window
                    // (handles the case where the app/service was just started mid-morning)
                    boolean shouldCheckIn = isCatchUp ? inCheckInWindow : inCheckInWindow;

                    if (shouldCheckIn) {
                        boolean hadRealSessionToday = hadRealSession(logs, profileId, currentDateStr);
                        String reEntryKey  = "reentry:" + currentTimeStr.substring(0, 5);
                        boolean alreadyRe  = isProcessed(profileId, currentDateStr, reEntryKey);
                        boolean alreadyFirst = isProcessed(profileId, currentDateStr, checkInTime);

                        boolean doCheckIn = hadRealSessionToday ? !alreadyRe : !alreadyFirst;

                        if (doCheckIn) {
                            JSONObject newLog = buildCheckInLog(profileId, profileName, currentDateStr, now, color);
                            logs = appendLog(logs, newLog);
                            logsChanged = true;
                            markProcessed(profileId, currentDateStr, hadRealSessionToday ? reEntryKey : checkInTime);
                            exitDetectedAt.remove(profileId); // clear any lingering exit timer on re-entry
                            sendEventNotification("✅ Checked In – " + profileName,
                                    "Auto check-in at " + currentTimeStr);
                            Log.i(TAG, "CHECK-IN: " + profileName + " at " + currentTimeStr);
                        }
                    }
                }

                // Re-evaluate after possible check-in
                hasOpenSession = hasOpenSession(logs, profileId, currentDateStr);

                // NOTE: Scheduled checkout by time has been intentionally removed.
                // Auto check-out fires ONLY on geofence exit (see block below).

                // ── AUTO CHECK-OUT: geofence exit ────────────────────────────
                if (hasOpenSession && !isWithin) {
                    JSONObject openLog = findOpenLog(logs, profileId, currentDateStr);
                    if (openLog != null) {
                        long checkInEpoch   = isoToEpoch(openLog.getString("checkIn"));
                        long minutesSinceIn = (now.getTimeInMillis() - checkInEpoch) / 60000;
                        if (minutesSinceIn > 5) {
                            String exitKey = "exit:" + openLog.getString("id");
                            if (!isProcessed(profileId, currentDateStr, exitKey)) {
                                logs = closeOpenSession(logs, profileId, currentDateStr, now, expectedHrs);
                                logsChanged = true;
                                markProcessed(profileId, currentDateStr, exitKey);
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
                // Only if: no session today AND outside geofence AND past check-in window
                if (!hasOpenSession && !isWithin && currentMinutes > ciMins + markAbsentAfter) {
                    boolean existsToday = hasAnyLogToday(logs, profileId, currentDateStr);
                    boolean absentDone  = isProcessed(profileId, currentDateStr, "absent");
                    if (!existsToday && !absentDone) {
                        JSONObject absentLog = buildAbsentLog(profileId, profileName, currentDateStr, checkInTime, color);
                        logs = appendLog(logs, absentLog);
                        logsChanged = true;
                        markProcessed(profileId, currentDateStr, "absent");
                        sendEventNotification("⚠️ Marked Absent – " + profileName,
                                "No check-in recorded for " + currentDateStr);
                        Log.i(TAG, "ABSENT: " + profileName + " on " + currentDateStr);
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
        Calendar now    = Calendar.getInstance(IST);
        String todayStr = formatDate(now);
        JSONArray logs  = getLogs();
        boolean changed = false;

        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject log = logs.getJSONObject(i);
                if (!log.isNull("checkOut")) continue;
                if ("absent".equals(log.optString("status"))) continue;
                String logDate = log.optString("date", "");
                if (logDate.equals(todayStr)) continue;

                JSONArray profiles = getProfiles();
                String profileId   = log.getString("profileId");
                String checkOutTime = "17:00";
                for (int j = 0; j < profiles.length(); j++) {
                    JSONObject p = profiles.getJSONObject(j);
                    if (profileId.equals(p.getString("id"))) {
                        checkOutTime = p.getString("checkOutTime");
                        break;
                    }
                }
                String closedAt   = logDate + "T" + checkOutTime + ":00+05:30";
                long checkInMs    = isoToEpoch(log.getString("checkIn"));
                long checkOutMs   = isoToEpoch(closedAt);
                long duration     = Math.max(0, (checkOutMs - checkInMs) / 60000);
                log.put("checkOut", closedAt);
                log.put("duration", duration);
                log.put("attended", duration >= 240);
                logs.put(i, log);
                changed = true;
                Log.i(TAG, "Closed stale session for " + profileId + " from " + logDate);
            }
        } catch (JSONException e) {
            Log.e(TAG, "closeStaleSessions error: " + e.getMessage());
        }

        if (changed) { saveLogs(logs); updateStateSnapshot(logs); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Session helpers
    // ─────────────────────────────────────────────────────────────────────────

    private boolean hasOpenSession(JSONArray logs, String profileId, String date) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && date.equals(l.optString("date"))
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

    private JSONObject findOpenLog(JSONArray logs, String profileId, String date) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && date.equals(l.optString("date"))
                        && l.isNull("checkOut")
                        && !"absent".equals(l.optString("status")))
                    return l;
            }
        } catch (JSONException e) { Log.e(TAG, e.getMessage()); }
        return null;
    }

    private JSONArray closeOpenSession(JSONArray logs, String profileId, String date,
                                       Calendar now, double expectedHrs) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && date.equals(l.optString("date"))
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
     * home-screen widget can show "last location scanned" even when the
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
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (!today.equals(l.optString("date"))) continue;
                if (l.isNull("checkOut") && !"absent".equals(l.optString("status"))) {
                    checkedIn = true;
                    todayStatus = "checked-in";
                }
                if (!l.isNull("duration") && !"absent".equals(l.optString("status"))) {
                    totalMinutes += l.optInt("duration", 0);
                }
            }
            if (!checkedIn && totalMinutes > 0) todayStatus = "checked-out";
        } catch (JSONException e) { Log.e(TAG, "updateStateSnapshot: " + e.getMessage()); }

        getSharedPreferences(PREFS_STATE, MODE_PRIVATE).edit()
                .putBoolean("checkedIn", checkedIn)
                .putInt("totalMinutesToday", totalMinutes)
                .putString("todayStatus", todayStatus)
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
        nm.notify(eventNotifId++, n);
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
