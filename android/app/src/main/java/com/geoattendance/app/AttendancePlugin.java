package com.geoattendance.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * AttendancePlugin — Capacitor bridge between the native Java service and React UI.
 *
 * Methods:
 *   startService()              — start ForegroundService
 *   stopService()               — stop ForegroundService
 *   syncProfiles(data)          — push profiles from React localStorage → SharedPreferences
 *   syncLogs(data)              — push existing logs from React localStorage → SharedPreferences
 *   getState()                  — read current snapshot (checkedIn, todayStatus, totalMinutesToday)
 *   getLogs()                   — read full log array from SharedPreferences
 *   manualCheckIn(id)           — force a check-in for a profile
 *   manualCheckOut(id)          — force a check-out for a profile
 *   isBatteryExempted()         — check if app is exempt from battery optimisation
 *   requestBatteryExemption()   — open system dialog to request exemption
 */
@CapacitorPlugin(name = "AttendanceService")
public class AttendancePlugin extends Plugin {

    private static final String TAG = "AttendPlugin";

    // ── Start / stop ─────────────────────────────────────────────────────────

    @PluginMethod
    public void startService(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), AttendanceForegroundService.class);
            intent.setAction("START");
            ContextCompat.startForegroundService(getContext(), intent);
            Log.i(TAG, "startService called from JS");
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to start service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        try {
            // User intentionally stopped tracking — stop the watchdog too,
            // otherwise it would silently restart the service in 15 minutes.
            WatchdogReceiver.cancel(getContext());
            Intent intent = new Intent(getContext(), AttendanceForegroundService.class);
            getContext().stopService(intent);
            Log.i(TAG, "stopService called from JS");
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to stop service: " + e.getMessage());
        }
    }

    // ── Profile / log sync from React → Java ─────────────────────────────────

    @PluginMethod
    public void syncProfiles(PluginCall call) {
        String profilesJson = call.getString("profiles", "[]");
        getContext()
                .getSharedPreferences(AttendanceForegroundService.PREFS_STATE, Context.MODE_PRIVATE)
                .edit()
                .putString("profiles", profilesJson)
                .apply();
        Log.i(TAG, "Profiles synced to SharedPreferences");
        call.resolve();
    }

    @PluginMethod
    public void syncLogs(PluginCall call) {
        String logsJson = call.getString("logs", "[]");
        // `replace=true` means the caller is authoritative (user cleared logs,
        // restored a backup, or edited records) and the native store must be
        // overwritten. Default is FALSE: merge, never destroy native entries.
        boolean replace = Boolean.TRUE.equals(call.getBoolean("replace", false));

        SharedPreferences prefs = getContext()
                .getSharedPreferences(AttendanceForegroundService.PREFS_LOGS, Context.MODE_PRIVATE);

        if (replace) {
            prefs.edit().putString("logs", logsJson).apply();
            Log.i(TAG, "Logs REPLACED in SharedPreferences from React (authoritative)");
            call.resolve();
            return;
        }

        try {
            JSONArray incoming = new JSONArray(logsJson);
            JSONArray existing = new JSONArray(prefs.getString("logs", "[]"));

            // Index the incoming (React) entries by id.
            java.util.LinkedHashMap<String, JSONObject> byId = new java.util.LinkedHashMap<>();
            for (int i = 0; i < incoming.length(); i++) {
                JSONObject l = incoming.getJSONObject(i);
                String id = l.optString("id", "");
                if (!id.isEmpty()) byId.put(id, l);
            }

            // Fold in the native entries. Native wins whenever it holds a more
            // complete record (a closed session beats an still-open duplicate),
            // and native-only entries are always preserved.
            for (int i = 0; i < existing.length(); i++) {
                JSONObject nat = existing.getJSONObject(i);
                String id = nat.optString("id", "");
                if (id.isEmpty()) continue;
                JSONObject react = byId.get(id);
                if (react == null) {
                    byId.put(id, nat);                       // native-only → keep
                } else if (react.isNull("checkOut") && !nat.isNull("checkOut")) {
                    byId.put(id, nat);                       // native closed it → keep native
                }
            }

            JSONArray merged = new JSONArray();
            for (JSONObject l : byId.values()) merged.put(l);

            prefs.edit().putString("logs", merged.toString()).apply();
            Log.i(TAG, "Logs MERGED: react=" + incoming.length()
                    + " native=" + existing.length() + " result=" + merged.length());
            call.resolve();
        } catch (JSONException e) {
            // Never destroy native data because of a parse problem.
            Log.e(TAG, "syncLogs merge failed, native store left untouched", e);
            call.resolve();
        }
    }

    // ── Read state / logs ─────────────────────────────────────────────────────

    @PluginMethod
    public void getState(PluginCall call) {
        SharedPreferences prefs = getContext()
                .getSharedPreferences(AttendanceForegroundService.PREFS_STATE, Context.MODE_PRIVATE);

        JSObject ret = new JSObject();
        ret.put("checkedIn",         prefs.getBoolean("checkedIn", false));
        ret.put("todayStatus",       prefs.getString("todayStatus", "idle"));
        ret.put("totalMinutesToday", prefs.getInt("totalMinutesToday", 0));
        ret.put("lastUpdated",       prefs.getLong("lastUpdated", 0));
        call.resolve(ret);
    }

    @PluginMethod
    public void getLogs(PluginCall call) {
        SharedPreferences prefs = getContext()
                .getSharedPreferences(AttendanceForegroundService.PREFS_LOGS, Context.MODE_PRIVATE);
        String logsJson = prefs.getString("logs", "[]");

        JSObject ret = new JSObject();
        ret.put("logs", logsJson);
        call.resolve(ret);
    }

    // ── Manual overrides ──────────────────────────────────────────────────────

    @PluginMethod
    public void manualCheckIn(PluginCall call) {
        String profileId = call.getString("profileId");
        if (profileId == null || profileId.isEmpty()) {
            call.reject("profileId required");
            return;
        }

        try {
            SharedPreferences statePrefs = getContext()
                    .getSharedPreferences(AttendanceForegroundService.PREFS_STATE, Context.MODE_PRIVATE);
            SharedPreferences logsPrefs = getContext()
                    .getSharedPreferences(AttendanceForegroundService.PREFS_LOGS, Context.MODE_PRIVATE);

            String profilesJson = statePrefs.getString("profiles", "[]");
            JSONArray profiles = new JSONArray(profilesJson);
            JSONObject profile = null;
            for (int i = 0; i < profiles.length(); i++) {
                JSONObject p = profiles.getJSONObject(i);
                if (profileId.equals(p.getString("id"))) { profile = p; break; }
            }
            if (profile == null) { call.reject("Profile not found"); return; }

            String logsJson = logsPrefs.getString("logs", "[]");
            JSONArray logs = new JSONArray(logsJson);

            java.util.Calendar now = java.util.Calendar.getInstance(
                    java.util.TimeZone.getTimeZone("Asia/Kolkata"));
            String dateStr = String.format(java.util.Locale.US, "%04d-%02d-%02d",
                    now.get(java.util.Calendar.YEAR),
                    now.get(java.util.Calendar.MONTH) + 1,
                    now.get(java.util.Calendar.DAY_OF_MONTH));

            // Check if already checked in (exclude absent records).
            // Date-agnostic: an open overnight session from yesterday also blocks.
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (profileId.equals(l.optString("profileId"))
                        && l.isNull("checkOut")
                        && isSessionStatus(l.optString("status"))) {
                    call.reject("Already checked in");
                    return;
                }
            }

            java.text.SimpleDateFormat sdf =
                    new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'+05:30'", java.util.Locale.US);
            sdf.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Kolkata"));

            JSONObject newLog = new JSONObject();
            newLog.put("id", Long.toString(System.currentTimeMillis(), 36)
                    + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 9));
            newLog.put("profileId", profileId);
            newLog.put("profileName", profile.getString("name"));
            newLog.put("date", dateStr);
            newLog.put("checkIn", sdf.format(now.getTime()));
            newLog.put("checkOut", JSONObject.NULL);
            newLog.put("duration", JSONObject.NULL);
            newLog.put("status", "manual");
            newLog.put("profileColor", profile.optString("color", "#10b981"));
            newLog.put("attended", true);

            JSONArray updated = new JSONArray();
            for (int i = 0; i < logs.length(); i++) updated.put(logs.getJSONObject(i));
            updated.put(newLog);

            logsPrefs.edit().putString("logs", updated.toString()).apply();
            AttendanceWidgetProvider.refreshAll(getContext());

            Log.i(TAG, "Manual check-in: " + profile.getString("name"));
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);

        } catch (JSONException e) {
            call.reject("manualCheckIn error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void manualCheckOut(PluginCall call) {
        String profileId = call.getString("profileId"); // nullable = close all

        try {
            SharedPreferences statePrefs = getContext()
                    .getSharedPreferences(AttendanceForegroundService.PREFS_STATE, Context.MODE_PRIVATE);
            SharedPreferences logsPrefs = getContext()
                    .getSharedPreferences(AttendanceForegroundService.PREFS_LOGS, Context.MODE_PRIVATE);

            String profilesJson = statePrefs.getString("profiles", "[]");
            JSONArray profiles = new JSONArray(profilesJson);

            String logsJson = logsPrefs.getString("logs", "[]");
            JSONArray logs = new JSONArray(logsJson);

            java.util.Calendar now = java.util.Calendar.getInstance(
                    java.util.TimeZone.getTimeZone("Asia/Kolkata"));
            String dateStr = String.format(java.util.Locale.US, "%04d-%02d-%02d",
                    now.get(java.util.Calendar.YEAR),
                    now.get(java.util.Calendar.MONTH) + 1,
                    now.get(java.util.Calendar.DAY_OF_MONTH));
            java.text.SimpleDateFormat sdf =
                    new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'+05:30'", java.util.Locale.US);
            sdf.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Kolkata"));

            boolean changed = false;
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (!l.isNull("checkOut")) continue;
                if (!isSessionStatus(l.optString("status"))) continue;
                // No date filter: an overnight session opened yesterday must
                // still be closable after midnight.
                if (profileId != null && !profileId.equals(l.optString("profileId"))) continue;

                long checkInMs;
                try {
                    java.text.SimpleDateFormat p = new java.text.SimpleDateFormat(
                            "yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
                    p.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Kolkata"));
                    String trimmed = l.getString("checkIn").replaceAll("(\\+[0-9:]+|Z)$", "");
                    checkInMs = p.parse(trimmed).getTime();
                } catch (Exception ex) {
                    checkInMs = now.getTimeInMillis() - 3_600_000;
                }

                long duration = Math.round((now.getTimeInMillis() - checkInMs) / 60000.0);

                double expectedHrs = 8.0;
                for (int j = 0; j < profiles.length(); j++) {
                    JSONObject p = profiles.getJSONObject(j);
                    if (l.optString("profileId").equals(p.getString("id"))) {
                        expectedHrs = p.optDouble("expectedHoursPerDay", 8.0);
                        break;
                    }
                }
                long expectedMins = Math.round(expectedHrs * 60);

                l.put("checkOut", sdf.format(now.getTime()));
                l.put("duration", duration);
                l.put("attended", duration >= expectedMins * 0.5);
                logs.put(i, l);
                changed = true;
            }

            if (changed) {
                logsPrefs.edit().putString("logs", logs.toString()).apply();
                AttendanceWidgetProvider.refreshAll(getContext());
            }

            JSObject ret = new JSObject();
            ret.put("success", changed);
            call.resolve(ret);

        } catch (JSONException e) {
            call.reject("manualCheckOut error: " + e.getMessage());
        }
    }

    /** True for real attendance sessions; absent and leave markers are not sessions. */
    private static boolean isSessionStatus(String status) {
        return !"absent".equals(status) && !"leave".equals(status);
    }

    // ── Battery optimisation exemption ────────────────────────────────────────

    /**
     * Check if this app is already exempt from battery optimisation.
     * Returns: { exempted: boolean }
     */
    @PluginMethod
    public void isBatteryExempted(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            boolean exempted = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            ret.put("exempted", exempted);
        } else {
            ret.put("exempted", true); // not applicable below API 23
        }
        call.resolve(ret);
    }

    /**
     * Open the system dialog to exempt this app from battery optimisation.
     * Only call after showing a rationale to the user.
     * Returns: { alreadyExempted: boolean }
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
                JSObject ret = new JSObject();
                ret.put("alreadyExempted", true);
                call.resolve(ret);
                return;
            }
            try {
                Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                Log.i(TAG, "Battery optimisation exemption dialog launched");
                JSObject ret = new JSObject();
                ret.put("alreadyExempted", false);
                call.resolve(ret);
            } catch (Exception e) {
                Log.e(TAG, "requestBatteryExemption failed: " + e.getMessage());
                call.reject("Could not open battery settings: " + e.getMessage());
            }
        } else {
            JSObject ret = new JSObject();
            ret.put("alreadyExempted", true); // not applicable below API 23
            call.resolve(ret);
        }
    }

    /**
     * Open the OEM "Autostart" management screen (Xiaomi/HyperOS/MIUI).
     * On HyperOS a foreground service will NOT survive screen-lock kills
     * unless the user enables Autostart for this app — there is no API to
     * check or request it, so the best we can do is deep-link the screen.
     * Falls back to the standard App Info page on non-Xiaomi devices.
     * Returns: { opened: boolean, fallback?: boolean }
     */
    @PluginMethod
    public void openAutostartSettings(PluginCall call) {
        // Known Xiaomi/HyperOS autostart management activities
        String[][] targets = {
            {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
            {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartDetailManagementActivity"},
        };
        for (String[] t : targets) {
            try {
                Intent intent = new Intent();
                intent.setClassName(t[0], t[1]);
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                Log.i(TAG, "Opened autostart screen: " + t[1]);
                JSObject ret = new JSObject();
                ret.put("opened", true);
                call.resolve(ret);
                return;
            } catch (Exception ignored) { /* try next target */ }
        }
        // Fallback: standard App Info page (Autostart toggle lives there too on HyperOS)
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            Log.i(TAG, "Opened app-info fallback for autostart");
            JSObject ret = new JSObject();
            ret.put("opened", true);
            ret.put("fallback", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not open settings: " + e.getMessage());
        }
    }
}
