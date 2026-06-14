package com.geoattendance.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * AttendanceWidgetProvider
 *
 * Handles Small (2x2), Medium (4x2), and Large (4x4) home-screen widgets.
 * Reads data from SharedPreferences written by AttendanceForegroundService.
 * Supports Teal and Rainbow gradient themes, togglable via widget tap.
 */
public class AttendanceWidgetProvider extends AppWidgetProvider {

    // SharedPrefs keys (must match AttendanceForegroundService)
    private static final String PREFS_STATE       = "AttendanceState";
    private static final String PREFS_LOGS        = "AttendanceLogs";
    private static final String PREFS_WIDGET      = "WidgetPrefs";
    private static final String KEY_THEME         = "widget_theme";
    private static final String THEME_TEAL        = "teal";
    private static final String THEME_RAINBOW     = "rainbow";

    // Intent actions
    private static final String ACTION_TOGGLE_THEME = "com.geoattendance.app.WIDGET_TOGGLE_THEME";
    private static final String ACTION_OPEN_APP     = "com.geoattendance.app.WIDGET_OPEN_APP";

    // ─────────────────────────────────────────────────────────────────────────
    // Entry points
    // ─────────────────────────────────────────────────────────────────────────

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) updateWidget(ctx, mgr, id);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        if (ACTION_TOGGLE_THEME.equals(intent.getAction())) {
            toggleTheme(ctx);
            refreshAll(ctx);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public refresh helper (called by ForegroundService)
    // ─────────────────────────────────────────────────────────────────────────

    public static void refreshAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        // Refresh all three widget providers
        for (Class<?> cls : new Class[]{
                AttendanceWidgetSmall.class,
                AttendanceWidgetMedium.class,
                AttendanceWidgetLarge.class}) {
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, cls));
            if (ids.length > 0) {
                Intent intent = new Intent(ctx, cls);
                intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
                intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
                ctx.sendBroadcast(intent);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core update logic
    // ─────────────────────────────────────────────────────────────────────────

    static void updateWidget(Context ctx, AppWidgetManager mgr, int widgetId) {
        // Determine size class
        ComponentName comp = mgr.getAppWidgetInfo(widgetId) != null
                ? new ComponentName(ctx, mgr.getAppWidgetInfo(widgetId).provider.getClassName())
                : null;

        String sizeClass = "medium";
        if (comp != null) {
            String cn = comp.getClassName();
            if (cn.contains("Small"))  sizeClass = "small";
            else if (cn.contains("Large")) sizeClass = "large";
        }

        // Read state
        WidgetData data = readData(ctx);
        String theme    = getTheme(ctx);
        int bgDrawable  = THEME_TEAL.equals(theme)
                ? R.drawable.widget_bg_teal : R.drawable.widget_bg_rainbow;

        // Build RemoteViews
        RemoteViews views;
        switch (sizeClass) {
            case "small":  views = buildSmall(ctx, data, bgDrawable);  break;
            case "large":  views = buildLarge(ctx, data, bgDrawable);  break;
            default:       views = buildMedium(ctx, data, bgDrawable); break;
        }

        // Tap whole widget → open app
        PendingIntent openApp = PendingIntent.getActivity(ctx, 0,
                ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName()),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // Tap icon → toggle theme
        Intent toggleIntent = new Intent(ctx, AttendanceWidgetProvider.class);
        toggleIntent.setAction(ACTION_TOGGLE_THEME);
        PendingIntent togglePi = PendingIntent.getBroadcast(ctx, widgetId,
                toggleIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        int rootId = getRootId(sizeClass);
        int iconId = getIconId(sizeClass);
        views.setOnClickPendingIntent(rootId, openApp);
        views.setOnClickPendingIntent(iconId, togglePi);

        mgr.updateAppWidget(widgetId, views);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RemoteViews builders
    // ─────────────────────────────────────────────────────────────────────────

    private static RemoteViews buildSmall(Context ctx, WidgetData d, int bg) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_small);
        v.setInt(R.id.widget_small_root, "setBackgroundResource", bg);
        v.setTextViewText(R.id.widget_small_icon,   d.statusIcon);
        v.setTextViewText(R.id.widget_small_status, d.statusLabel);
        v.setTextViewText(R.id.widget_small_hours,  d.hoursToday);
        v.setTextViewText(R.id.widget_small_streak, "🔥 " + d.streak + "d");
        return v;
    }

    private static RemoteViews buildMedium(Context ctx, WidgetData d, int bg) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_medium);
        v.setInt(R.id.widget_medium_root, "setBackgroundResource", bg);
        v.setTextViewText(R.id.widget_medium_icon,     d.statusIcon);
        v.setTextViewText(R.id.widget_medium_status,   d.statusLabel);
        v.setTextViewText(R.id.widget_medium_streak,   "🔥 " + d.streak + " day streak");
        v.setTextViewText(R.id.widget_medium_hours,    d.hoursToday + " today");
        v.setTextViewText(R.id.widget_medium_checkin,  "In: " + d.checkIn);
        v.setTextViewText(R.id.widget_medium_checkout, "Out: " + d.checkOut);
        v.setTextViewText(R.id.widget_medium_gps,      "GPS: " + d.lastGps);
        return v;
    }

    private static RemoteViews buildLarge(Context ctx, WidgetData d, int bg) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_large);
        v.setInt(R.id.widget_large_root,     "setBackgroundResource", bg);
        v.setTextViewText(R.id.widget_large_icon,     d.statusIcon);
        v.setTextViewText(R.id.widget_large_status,   d.statusLabel);
        v.setTextViewText(R.id.widget_large_streak,   "🔥 " + d.streak + " day streak");
        v.setTextViewText(R.id.widget_large_hours,    d.hoursToday);
        v.setTextViewText(R.id.widget_large_checkin,  d.checkIn);
        v.setTextViewText(R.id.widget_large_checkout, d.checkOut);
        v.setTextViewText(R.id.widget_large_gps,      d.lastGps);
        v.setTextViewText(R.id.widget_large_updated,  d.updatedAt);
        return v;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Data reading
    // ─────────────────────────────────────────────────────────────────────────

    private static WidgetData readData(Context ctx) {
        WidgetData d = new WidgetData();
        SharedPreferences state = ctx.getSharedPreferences(PREFS_STATE, Context.MODE_PRIVATE);

        // Status
        String status = state.getString("todayStatus", "idle");
        boolean checkedIn = state.getBoolean("checkedIn", false);
        switch (status) {
            case "checked-in":
                d.statusLabel = "Present";
                d.statusIcon  = "✅";
                break;
            case "checked-out":
                d.statusLabel = "Done";
                d.statusIcon  = "🏁";
                break;
            case "absent":
                d.statusLabel = "Absent";
                d.statusIcon  = "❌";
                break;
            default:
                d.statusLabel = "Idle";
                d.statusIcon  = "📍";
        }

        // Hours
        int totalMins = state.getInt("totalMinutesToday", 0);
        d.hoursToday  = formatDuration(totalMins);

        // Last GPS scan
        long locTs = state.getLong("lastLocTimestamp", 0);
        d.lastGps  = locTs > 0 ? relativeTime(locTs) : "--";

        // Last updated
        long updatedTs = state.getLong("lastUpdated", 0);
        d.updatedAt    = updatedTs > 0 ? relativeTime(updatedTs) : "never";

        // Streak + check-in/out times from logs
        readLogsData(ctx, d);

        return d;
    }

    private static void readLogsData(Context ctx, WidgetData d) {
        try {
            SharedPreferences logPrefs = ctx.getSharedPreferences(PREFS_LOGS, Context.MODE_PRIVATE);
            String raw = logPrefs.getString("logs", "[]");
            JSONArray logs = new JSONArray(raw);

            // Today's date string IST
            SimpleDateFormat dateFmt = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault());
            dateFmt.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));
            String today = dateFmt.format(new Date());

            SimpleDateFormat timeFmt = new SimpleDateFormat("HH:mm", Locale.getDefault());
            timeFmt.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));

            // Streak: count consecutive attended days backwards
            java.util.Set<String> attendedDates = new java.util.TreeSet<>(java.util.Collections.reverseOrder());
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (l.optBoolean("attended", false)) attendedDates.add(l.optString("date", ""));
            }
            int streak = 0;
            java.util.Calendar cal = java.util.Calendar.getInstance(TimeZone.getTimeZone("Asia/Kolkata"));
            for (int back = 0; back < 365; back++) {
                SimpleDateFormat df2 = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault());
                df2.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));
                String checkDate = df2.format(cal.getTime());
                if (attendedDates.contains(checkDate)) {
                    streak++;
                    cal.add(java.util.Calendar.DAY_OF_YEAR, -1);
                } else {
                    break;
                }
            }
            d.streak = streak;

            // Today's check-in / check-out
            for (int i = logs.length() - 1; i >= 0; i--) {
                JSONObject l = logs.getJSONObject(i);
                if (!today.equals(l.optString("date", ""))) continue;
                if ("absent".equals(l.optString("status", ""))) continue;
                String ci = l.optString("checkIn", "");
                if (!ci.isEmpty()) {
                    try {
                        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.getDefault());
                        d.checkIn = timeFmt.format(iso.parse(ci));
                    } catch (Exception e) { d.checkIn = "--:--"; }
                }
                String co = l.isNull("checkOut") ? "" : l.optString("checkOut", "");
                if (!co.isEmpty()) {
                    try {
                        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.getDefault());
                        d.checkOut = timeFmt.format(iso.parse(co));
                    } catch (Exception e) { d.checkOut = "--:--"; }
                }
                break;
            }
        } catch (Exception e) {
            // Keep defaults
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Theme helpers
    // ─────────────────────────────────────────────────────────────────────────

    private static String getTheme(Context ctx) {
        return ctx.getSharedPreferences(PREFS_WIDGET, Context.MODE_PRIVATE)
                .getString(KEY_THEME, THEME_TEAL);
    }

    private static void toggleTheme(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_WIDGET, Context.MODE_PRIVATE);
        String current = prefs.getString(KEY_THEME, THEME_TEAL);
        prefs.edit().putString(KEY_THEME, THEME_TEAL.equals(current) ? THEME_RAINBOW : THEME_TEAL).apply();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utility
    // ─────────────────────────────────────────────────────────────────────────

    private static String formatDuration(int minutes) {
        if (minutes <= 0) return "0h 0m";
        return (minutes / 60) + "h " + (minutes % 60) + "m";
    }

    private static String relativeTime(long epochMs) {
        long diff = System.currentTimeMillis() - epochMs;
        long mins = diff / 60000;
        if (mins < 1)  return "just now";
        if (mins < 60) return mins + "m ago";
        long hrs = mins / 60;
        if (hrs < 24)  return hrs + "h ago";
        return (hrs / 24) + "d ago";
    }

    private static int getRootId(String size) {
        switch (size) {
            case "small": return R.id.widget_small_root;
            case "large": return R.id.widget_large_root;
            default:      return R.id.widget_medium_root;
        }
    }

    private static int getIconId(String size) {
        switch (size) {
            case "small": return R.id.widget_small_icon;
            case "large": return R.id.widget_large_icon;
            default:      return R.id.widget_medium_icon;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Data holder
    // ─────────────────────────────────────────────────────────────────────────

    static class WidgetData {
        String statusLabel = "Idle";
        String statusIcon  = "📍";
        String hoursToday  = "0h 0m";
        String checkIn     = "--:--";
        String checkOut    = "--:--";
        String lastGps     = "--";
        String updatedAt   = "never";
        int    streak      = 0;
    }
}
