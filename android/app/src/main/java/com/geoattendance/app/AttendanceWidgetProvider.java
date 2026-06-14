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
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.TimeZone;

public class AttendanceWidgetProvider extends AppWidgetProvider {

    private static final String PREFS_STATE  = "AttendanceState";
    private static final String PREFS_LOGS   = "AttendanceLogs";
    private static final String PREFS_WIDGET = "WidgetPrefs";
    private static final String KEY_THEME    = "widget_theme";
    private static final String THEME_TEAL   = "teal";
    private static final String THEME_RAINBOW = "rainbow";

    private static final String ACTION_TOGGLE_THEME = "com.geoattendance.app.WIDGET_TOGGLE_THEME";

    // Extra key to carry size through the broadcast
    private static final String EXTRA_SIZE = "widget_size";

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        // Base class — size unknown here; sub-providers call updateWidget directly
        for (int id : ids) updateWidget(ctx, mgr, id, "medium");
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        if (ACTION_TOGGLE_THEME.equals(intent.getAction())) {
            toggleTheme(ctx);
            refreshAll(ctx);
        }
    }

    // ── Called by sub-providers with explicit size ────────────────────────────

    public static void updateWidget(Context ctx, AppWidgetManager mgr, int widgetId, String size) {
        WidgetData data = readData(ctx);
        String theme = getTheme(ctx);
        int bgDrawable = THEME_TEAL.equals(theme)
                ? R.drawable.widget_bg_teal : R.drawable.widget_bg_rainbow;

        RemoteViews views;
        switch (size) {
            case "small":  views = buildSmall(ctx, data, bgDrawable);  break;
            case "large":  views = buildLarge(ctx, data, bgDrawable);  break;
            default:       views = buildMedium(ctx, data, bgDrawable); break;
        }

        // Tap widget → open app
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent openApp = PendingIntent.getActivity(ctx, widgetId, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // Tap icon → toggle theme (broadcast back to this class)
        Intent toggleIntent = new Intent(ctx, AttendanceWidgetProvider.class);
        toggleIntent.setAction(ACTION_TOGGLE_THEME);
        PendingIntent togglePi = PendingIntent.getBroadcast(ctx, widgetId, toggleIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        views.setOnClickPendingIntent(getRootId(size), openApp);
        views.setOnClickPendingIntent(getIconId(size), togglePi);

        mgr.updateAppWidget(widgetId, views);
    }

    // ── Public refresh (called from ForegroundService) ────────────────────────

    public static void refreshAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);

        int[] small = mgr.getAppWidgetIds(new ComponentName(ctx, AttendanceWidgetSmall.class));
        for (int id : small) updateWidget(ctx, mgr, id, "small");

        int[] medium = mgr.getAppWidgetIds(new ComponentName(ctx, AttendanceWidgetMedium.class));
        for (int id : medium) updateWidget(ctx, mgr, id, "medium");

        int[] large = mgr.getAppWidgetIds(new ComponentName(ctx, AttendanceWidgetLarge.class));
        for (int id : large) updateWidget(ctx, mgr, id, "large");
    }

    // ── RemoteViews builders ──────────────────────────────────────────────────

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
        v.setInt(R.id.widget_large_root, "setBackgroundResource", bg);
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

    // ── Data reading ──────────────────────────────────────────────────────────

    private static WidgetData readData(Context ctx) {
        WidgetData d = new WidgetData();
        SharedPreferences state = ctx.getSharedPreferences(PREFS_STATE, Context.MODE_PRIVATE);

        String status = state.getString("todayStatus", "idle");
        switch (status) {
            case "checked-in":
                d.statusLabel = "Present"; d.statusIcon = "✅"; break;
            case "checked-out":
                d.statusLabel = "Done";    d.statusIcon = "🏁"; break;
            case "absent":
                d.statusLabel = "Absent";  d.statusIcon = "❌"; break;
            default:
                d.statusLabel = "Idle";    d.statusIcon = "📍"; break;
        }

        int totalMins = state.getInt("totalMinutesToday", 0);
        d.hoursToday  = formatDuration(totalMins);

        long locTs = state.getLong("lastLocTimestamp", 0);
        d.lastGps  = locTs > 0 ? relativeTime(locTs) : "--";

        long updTs = state.getLong("lastUpdated", 0);
        d.updatedAt = updTs > 0 ? relativeTime(updTs) : "never";

        readLogsData(ctx, d);
        return d;
    }

    private static void readLogsData(Context ctx, WidgetData d) {
        try {
            SharedPreferences logPrefs = ctx.getSharedPreferences(PREFS_LOGS, Context.MODE_PRIVATE);
            String raw = logPrefs.getString("logs", "[]");
            JSONArray logs = new JSONArray(raw);

            SimpleDateFormat dateFmt = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault());
            dateFmt.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));
            String today = dateFmt.format(new Date());

            SimpleDateFormat timeFmt = new SimpleDateFormat("HH:mm", Locale.getDefault());
            timeFmt.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));

            // Streak
            Set<String> attendedDates = new TreeSet<>(Collections.reverseOrder());
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (l.optBoolean("attended", false)) attendedDates.add(l.optString("date", ""));
            }
            int streak = 0;
            Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Kolkata"));
            SimpleDateFormat df2 = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault());
            df2.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));
            for (int back = 0; back < 365; back++) {
                if (attendedDates.contains(df2.format(cal.getTime()))) {
                    streak++;
                    cal.add(Calendar.DAY_OF_YEAR, -1);
                } else { break; }
            }
            d.streak = streak;

            // Today check-in / check-out
            SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.getDefault());
            for (int i = logs.length() - 1; i >= 0; i--) {
                JSONObject l = logs.getJSONObject(i);
                if (!today.equals(l.optString("date", ""))) continue;
                if ("absent".equals(l.optString("status", ""))) continue;
                String ci = l.optString("checkIn", "");
                if (!ci.isEmpty()) {
                    try { d.checkIn = timeFmt.format(iso.parse(ci)); } catch (Exception e) { d.checkIn = "--:--"; }
                }
                String co = l.isNull("checkOut") ? "" : l.optString("checkOut", "");
                if (!co.isEmpty()) {
                    try { d.checkOut = timeFmt.format(iso.parse(co)); } catch (Exception e) { d.checkOut = "--:--"; }
                }
                break;
            }
        } catch (Exception ignored) {}
    }

    // ── Theme ─────────────────────────────────────────────────────────────────

    private static String getTheme(Context ctx) {
        return ctx.getSharedPreferences(PREFS_WIDGET, Context.MODE_PRIVATE)
                .getString(KEY_THEME, THEME_TEAL);
    }

    private static void toggleTheme(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS_WIDGET, Context.MODE_PRIVATE);
        String cur = p.getString(KEY_THEME, THEME_TEAL);
        p.edit().putString(KEY_THEME, THEME_TEAL.equals(cur) ? THEME_RAINBOW : THEME_TEAL).apply();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static String formatDuration(int mins) {
        if (mins <= 0) return "0h 0m";
        return (mins / 60) + "h " + (mins % 60) + "m";
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

    // ── Data holder ───────────────────────────────────────────────────────────

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
