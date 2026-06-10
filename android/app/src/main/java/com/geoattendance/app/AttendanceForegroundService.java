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
 * The React/Capacitor UI layer reads state from SharedPreferences ("AttendanceState")
 * and logs from ("AttendanceLogs") via AttendancePlugin.
 *
 * Key design decisions that mirror the TypeScript logic:
 *  - hasOpenSession() explicitly filters out status=="absent" records (fixes B1/B2/B6)
 *  - Absent is only written once per profile per day (absentProcessed flag)
 *  - Geofence exit key is scoped to session id, not date (fixes B7 / re-entry)
 *  - Previous-day open sessions are closed on service start (fixes B8)
 *  - START_STICKY so Android restarts us if killed (fixes B4/B9/B10)
 *  - BootReceiver restarts us after reboot
 */
public class AttendanceForegroundService extends Service {

    private static final String TAG = "AttendSvc";

    // ── Notification channel ─────────────────────────────────────────────────
    public static final String CHANNEL_ID    = "attendance_tracking";
    public static final String CHANNEL_NOTIF = "attendance_events";
    public static final int    NOTIF_ID      = 1001;  // persistent foreground notif
    private int eventNotifId = 2000;                  // incrementing event notifs

    // ── SharedPreferences keys ───────────────────────────────────────────────
    /** Bridge to React UI — current tracking snapshot */
    public static final String PREFS_STATE = "AttendanceState";
    /** Attendance log records (JSON array) */
    public static final String PREFS_LOGS  = "AttendanceLogs";
    /** Per-day processed markers (dedup keys) */
    public static final String PREFS_PROC  = "AttendanceProcessed";

    // ── GPS ──────────────────────────────────────────────────────────────────
    private LocationManager locationManager;
    private LocationListener locationListener;   // kept as field so stopGPS() can removeUpdates()
    private Location lastLocation;
    private static final long   GPS_MIN_TIME_MS   = 30_000;  // 30 s
    private static final float  GPS_MIN_DISTANCE_M = 10f;    // 10 m

    // ── Periodic tick ────────────────────────────────────────────────────────
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable tickRunnable;
    private static final long TICK_INTERVAL_MS = 30_000; // 30 s

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
        Log.i(TAG, "onStartCommand action=" + (intent != null ? intent.getAction() : "null"));

        startForeground(NOTIF_ID, buildPersistentNotification("GeoAttend active — tracking location"));

        // Close any previous-day open sessions on service start (fix B8)
        closeStaleSessions();

        // Start GPS
        startGPS();

        // Start periodic logic ticks
        startTicks();

        // Run an immediate catch-up scan (mirrors isCatchUp=true in TypeScript)
        handler.postDelayed(this::runCatchUpScan, 2000);

        return START_STICKY; // restart if killed by system (fix B4/B9/B10)
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "Service destroyed — stopping GPS and ticks");
        stopGPS();
        if (tickRunnable != null) handler.removeCallbacks(tickRunnable);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null; // not a bound service
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GPS
    // ─────────────────────────────────────────────────────────────────────────

    private void startGPS() {
        // Guard against double-registration on START_STICKY restarts.
        // removeUpdates is a no-op if listener was never registered.
        if (locationListener != null && locationManager != null) {
            locationManager.removeUpdates(locationListener);
            Log.d(TAG, "GPS: removed stale listener before re-registering");
        }

        try {
            locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);

            // Assign to field so stopGPS() can call removeUpdates() correctly.
            locationListener = new LocationListener() {
                @Override
                public void onLocationChanged(@NonNull Location location) {
                    lastLocation = location;
                    Log.d(TAG, String.format("GPS update: %.5f,%.5f acc=%.0fm",
                            location.getLatitude(), location.getLongitude(), location.getAccuracy()));
                    runTick(false);
                }
                // Required for API < 29
                @Override public void onProviderEnabled(@NonNull String p) {}
                @Override public void onProviderDisabled(@NonNull String p) {
                    Log.w(TAG, "GPS provider disabled: " + p);
                }
            };

            //noinspection MissingPermission — permissions are declared in manifest
            locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    GPS_MIN_TIME_MS,
                    GPS_MIN_DISTANCE_M,
                    locationListener,
                    Looper.getMainLooper()
            );

            // Seed with last known location so first tick isn't blind
            //noinspection MissingPermission
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last != null) lastLocation = last;

            Log.i(TAG, "GPS started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start GPS: " + e.getMessage());
        }
    }

    private void stopGPS() {
        if (locationManager != null && locationListener != null) {
            locationManager.removeUpdates(locationListener);
            Log.i(TAG, "GPS stopped — listener unregistered");
        } else {
            Log.i(TAG, "GPS stopGPS called but nothing to remove");
        }
        locationListener = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tick scheduler
    // ─────────────────────────────────────────────────────────────────────────

    private void startTicks() {
        tickRunnable = new Runnable() {
            @Override public void run() {
                runTick(false);
                handler.postDelayed(this, TICK_INTERVAL_MS);
            }
        };
        handler.postDelayed(tickRunnable, TICK_INTERVAL_MS);
    }

    private void runCatchUpScan() {
        Log.i(TAG, "Running catch-up scan");
        runTick(true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core tick — mirrors useAutomation.ts tick()
    // ─────────────────────────────────────────────────────────────────────────

    private synchronized void runTick(boolean isCatchUp) {
        if (lastLocation == null) {
            Log.d(TAG, "Tick skipped — no GPS fix yet");
            return;
        }

        Calendar now = Calendar.getInstance(IST);
        String currentDateStr = formatDate(now);
        String currentTimeStr = formatTime(now);
        int currentMinutes = toMinutes(currentTimeStr);
        int currentDay = now.get(Calendar.DAY_OF_WEEK) - 1; // 0=Sun … 6=Sat

        JSONArray profiles = getProfiles();
        JSONArray logs = getLogs();
        boolean logsChanged = false;

        for (int i = 0; i < profiles.length(); i++) {
            try {
                JSONObject profile = profiles.getJSONObject(i);
                if (!profile.optBoolean("active", false)) continue;

                // Skip non-working days
                JSONArray workingDays = profile.optJSONArray("workingDays");
                if (workingDays != null && workingDays.length() > 0 && !arrayContains(workingDays, currentDay)) continue;

                String profileId   = profile.getString("id");
                String profileName = profile.getString("name");
                double lat         = profile.getDouble("latitude");
                double lon         = profile.getDouble("longitude");
                double radius      = profile.getDouble("radius");
                String checkInTime = profile.getString("checkInTime");
                String checkOutTime= profile.getString("checkOutTime");
                int markAbsentAfter= profile.optInt("markAbsentAfter", 30);
                double expectedHrs = profile.optDouble("expectedHoursPerDay", 8.0);
                String color       = profile.optString("color", "#10b981");

                double dist = haversine(lastLocation.getLatitude(), lastLocation.getLongitude(), lat, lon);
                boolean isWithin = dist <= radius;

                // Fix B1/B2/B6: absent logs (checkOut==null, status==absent) must NOT count as open sessions
                boolean hasOpenSession = hasOpenSession(logs, profileId, currentDateStr);

                // ── AUTO CHECK-IN ─────────────────────────────────────────────
                if (!hasOpenSession && isWithin) {
                    int checkInMins  = toMinutes(checkInTime);
                    int windowMins   = isCatchUp ? markAbsentAfter : 1;
                    boolean inWindow;
                    if (isCatchUp) {
                        inWindow = currentMinutes >= checkInMins && currentMinutes <= checkInMins + windowMins;
                    } else {
                        inWindow = Math.abs(currentMinutes - checkInMins) <= windowMins;
                    }

                    boolean hadRealSessionToday = hadRealSession(logs, profileId, currentDateStr);

                    String reEntryKey = "reentry:" + currentTimeStr.substring(0, 5);
                    boolean alreadyReEntry = isProcessed(profileId, currentDateStr, reEntryKey);
                    boolean alreadyFirst   = isProcessed(profileId, currentDateStr, checkInTime);

                    boolean shouldCheckIn = hadRealSessionToday
                            ? !alreadyReEntry
                            : inWindow && !alreadyFirst;

                    if (shouldCheckIn) {
                        JSONObject newLog = buildCheckInLog(profileId, profileName, currentDateStr, now, color);
                        logs = appendLog(logs, newLog);
                        logsChanged = true;
                        markProcessed(profileId, currentDateStr, hadRealSessionToday ? reEntryKey : checkInTime);
                        sendEventNotification("✅ Checked In – " + profileName,
                                "Auto check-in at " + currentTimeStr);
                        Log.i(TAG, "CHECK-IN: " + profileName + " at " + currentTimeStr);
                    }
                }

                // Re-evaluate hasOpenSession after possible check-in above
                hasOpenSession = hasOpenSession(logs, profileId, currentDateStr);

                // ── AUTO CHECK-OUT at scheduled time ──────────────────────────
                if (hasOpenSession) {
                    boolean inOutWindow = Math.abs(currentMinutes - toMinutes(checkOutTime)) <= 1;
                    boolean alreadyOut  = isProcessed(profileId, currentDateStr, "out:" + checkOutTime);

                    if (inOutWindow && !alreadyOut) {
                        logs = closeOpenSession(logs, profileId, currentDateStr, now, expectedHrs);
                        logsChanged = true;
                        markProcessed(profileId, currentDateStr, "out:" + checkOutTime);
                        sendEventNotification("🚪 Checked Out – " + profileName,
                                "Auto check-out at " + currentTimeStr);
                        Log.i(TAG, "CHECKOUT (scheduled): " + profileName + " at " + currentTimeStr);
                        hasOpenSession = false;
                    }
                }

                // ── AUTO CHECK-OUT on geofence exit ───────────────────────────
                if (hasOpenSession && !isWithin) {
                    JSONObject openLog = findOpenLog(logs, profileId, currentDateStr);
                    if (openLog != null) {
                        long checkInEpoch = isoToEpoch(openLog.getString("checkIn"));
                        long minutesSinceIn = (now.getTimeInMillis() - checkInEpoch) / 60000;
                        if (minutesSinceIn > 5) {
                            String exitKey = "exit:" + openLog.getString("id");
                            if (!isProcessed(profileId, currentDateStr, exitKey)) {
                                logs = closeOpenSession(logs, profileId, currentDateStr, now, expectedHrs);
                                logsChanged = true;
                                markProcessed(profileId, currentDateStr, exitKey);
                                sendEventNotification("📍 Left Geofence – " + profileName,
                                        "Check-out at " + currentTimeStr);
                                Log.i(TAG, "CHECKOUT (exit): " + profileName + " at " + currentTimeStr);
                            }
                        }
                    }
                }

                // ── MARK ABSENT ───────────────────────────────────────────────
                // Fix B5: never mark absent if physically within geofence
                int checkInMins = toMinutes(checkInTime);
                if (!hasOpenSession && !isWithin
                        && currentMinutes > checkInMins + markAbsentAfter) {
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
                Log.e(TAG, "Tick error for profile " + i + ": " + e.getMessage());
            }
        }

        if (logsChanged) {
            saveLogs(logs);
            // Update the state snapshot that React reads
            updateStateSnapshot(logs);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Close stale sessions from previous day on service start (fix B8)
    // ─────────────────────────────────────────────────────────────────────────

    private void closeStaleSessions() {
        Calendar now = Calendar.getInstance(IST);
        String todayStr = formatDate(now);
        JSONArray logs = getLogs();
        boolean changed = false;

        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject log = logs.getJSONObject(i);
                if (!log.isNull("checkOut")) continue;
                if ("absent".equals(log.optString("status"))) continue;
                String logDate = log.optString("date", "");
                if (logDate.equals(todayStr)) continue; // today's open sessions handled by normal tick

                // Previous day open session — close it at checkout time or midnight
                JSONArray profiles = getProfiles();
                String profileId = log.getString("profileId");
                String checkOutTime = "17:00"; // fallback
                for (int j = 0; j < profiles.length(); j++) {
                    JSONObject p = profiles.getJSONObject(j);
                    if (profileId.equals(p.getString("id"))) {
                        checkOutTime = p.getString("checkOutTime");
                        break;
                    }
                }
                // Set checkout to the profile's checkout time on the log's date
                String closedAt = logDate + "T" + checkOutTime + ":00+05:30";
                long checkInMs = isoToEpoch(log.getString("checkIn"));
                long checkOutMs = isoToEpoch(closedAt);
                long duration = Math.max(0, (checkOutMs - checkInMs) / 60000);
                log.put("checkOut", closedAt);
                log.put("duration", duration);
                log.put("attended", duration >= 240); // ≥4h counts as attended
                logs.put(i, log);
                changed = true;
                Log.i(TAG, "Closed stale session for profile " + profileId + " from " + logDate);
            }
        } catch (JSONException e) {
            Log.e(TAG, "closeStaleSessions error: " + e.getMessage());
        }

        if (changed) {
            saveLogs(logs);
            updateStateSnapshot(logs);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Session logic helpers — exact Java equivalents of TypeScript functions
    // ─────────────────────────────────────────────────────────────────────────

    /** Fix B1/B2/B6: absent records (status=absent, checkOut=null) are NOT open sessions */
    private boolean hasOpenSession(JSONArray logs, String profileId, String date) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && date.equals(l.optString("date"))
                        && l.isNull("checkOut")
                        && !"absent".equals(l.optString("status"))) {
                    return true;
                }
            }
        } catch (JSONException e) { Log.e(TAG, e.getMessage()); }
        return false;
    }

    /** True if any non-absent log exists for this profile today */
    private boolean hadRealSession(JSONArray logs, String profileId, String date) {
        try {
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && date.equals(l.optString("date"))
                        && !"absent".equals(l.optString("status"))) {
                    return true;
                }
            }
        } catch (JSONException e) { Log.e(TAG, e.getMessage()); }
        return false;
    }

    /** True if any log (absent or real) exists for this profile today */
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
                        && !"absent".equals(l.optString("status"))) {
                    return l;
                }
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
                    long checkInMs = isoToEpoch(l.getString("checkIn"));
                    long duration = Math.round((now.getTimeInMillis() - checkInMs) / 60000.0);
                    long expectedMins = Math.round(expectedHrs * 60);
                    l.put("checkOut", toISO(now));
                    l.put("duration", duration);
                    l.put("attended", duration >= expectedMins * 0.5);
                    logs.put(i, l);
                    break;
                }
            }
        } catch (JSONException e) { Log.e(TAG, "closeOpenSession error: " + e.getMessage()); }
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
    // Processed-key deduplication (mirrors processedRef in TypeScript)
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
        String prefKey = profileId + ":" + date;
        String existing = prefs.getString(prefKey, "");
        String updated = existing.isEmpty() ? key : existing + "," + key;
        prefs.edit().putString(prefKey, updated).apply();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SharedPreferences I/O
    // ─────────────────────────────────────────────────────────────────────────

    private JSONArray getProfiles() {
        // Profiles are written by React/JS to localStorage, which Capacitor bridges
        // to the WebView's localStorage. We read them via a separate SharedPreferences
        // key that AttendancePlugin.syncProfiles() keeps updated.
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
    }

    /** Writes a compact state snapshot that the React UI polls via AttendancePlugin.getState() */
    private void updateStateSnapshot(JSONArray logs) {
        Calendar now = Calendar.getInstance(IST);
        String today = formatDate(now);
        boolean checkedIn = false;
        int totalMinutes = 0;
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
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Notifications
    // ─────────────────────────────────────────────────────────────────────────

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);

            NotificationChannel tracking = new NotificationChannel(
                    CHANNEL_ID, "Attendance Tracking",
                    NotificationManager.IMPORTANCE_LOW);
            tracking.setDescription("Persistent notification while tracking is active");
            nm.createNotificationChannel(tracking);

            NotificationChannel events = new NotificationChannel(
                    CHANNEL_NOTIF, "Attendance Events",
                    NotificationManager.IMPORTANCE_DEFAULT);
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

    /** Haversine distance in metres — exact port of calculateDistance() from storage.ts */
    private static double haversine(double lat1, double lon1, double lat2, double lon2) {
        final double R = 6_371_000;
        double phi1 = Math.toRadians(lat1);
        double phi2 = Math.toRadians(lat2);
        double dPhi = Math.toRadians(lat2 - lat1);
        double dLam = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2)
                + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) * Math.sin(dLam / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static int toMinutes(String hhmm) {
        if (hhmm == null || !hhmm.contains(":")) return 0;
        String[] parts = hhmm.split(":");
        return Integer.parseInt(parts[0]) * 60 + Integer.parseInt(parts[1]);
    }

    private static String formatDate(Calendar c) {
        return String.format(Locale.US, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    private static String formatTime(Calendar c) {
        return String.format(Locale.US, "%02d:%02d",
                c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE));
    }

    /** ISO 8601 with IST offset (+05:30) */
    private static String toISO(Calendar c) {
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'+05:30'", Locale.US);
        sdf.setTimeZone(IST);
        return sdf.format(c.getTime());
    }

    private static long isoToEpoch(String iso) {
        try {
            // Handle +05:30 or Z suffix
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            sdf.setTimeZone(IST);
            String trimmed = iso.replaceAll("(\\+[0-9:]+|Z)$", "");
            return sdf.parse(trimmed).getTime();
        } catch (Exception e) {
            Log.e(TAG, "isoToEpoch failed for: " + iso);
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
