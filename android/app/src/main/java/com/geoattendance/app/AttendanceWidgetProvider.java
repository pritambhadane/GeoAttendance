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
import java.util.TimeZone;
import java.util.TreeSet;

/**
 * Core widget logic. Three size sub-providers delegate here with an explicit
 * size string so we never need to inspect AppWidgetInfo at runtime (which can
 * return null and crash).
 *
 * Key design decisions to avoid "An error occurred when loading widget":
 *  1. NO emoji in any RemoteViews.setTextViewText() call — crashes on many OEMs.
 *  2. NO runtime setBackgroundResource — use separate teal/rainbow layout files
 *     per theme so the background is baked into the XML.
 *  3. setOnClickPendingIntent ONLY on the root view — not on nested children.
 *  4. All SharedPreferences reads are wrapped in try/catch with safe defaults.
 */
public class AttendanceWidgetProvider extends AppWidgetProvider {

    static final String PREFS_STATE   = "AttendanceState";
    static final String PREFS_LOGS    = "AttendanceLogs";
    static final String PREFS_WIDGET  = "WidgetPrefs";
    static final String KEY_THEME     = "widget_theme";
    static final String THEME_TEAL    = "teal";
    static final String THEME_RAINBOW = "rainbow";

    static final String ACTION_TOGGLE_THEME = "com.geoattendance.app.WIDGET_TOGGLE_THEME";

    // ── AppWidgetProvider entry point (fallback only) ─────────────────────────
    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
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

    // ── Called by sub-providers ───────────────────────────────────────────────
    static void updateWidget(Context ctx, AppWidgetManager mgr, int widgetId, String size) {
        try {
            WidgetData data  = readData(ctx);
            boolean rainbow  = THEME_RAINBOW.equals(getTheme(ctx));
            RemoteViews views = buildViews(ctx, size, rainbow, data);

            // Single tap target: root view opens the app
            Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            if (launch != null) {
                PendingIntent pi = PendingIntent.getActivity(ctx, widgetId, launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                views.setOnClickPendingIntent(getRootId(size, rainbow), pi);
            }

            // Long-press root → toggle theme via broadcast
            Intent toggle = new Intent(ctx, AttendanceWidgetProvider.class);
            toggle.setAction(ACTION_TOGGLE_THEME);
            PendingIntent togglePi = PendingIntent.getBroadcast(ctx, widgetId + 10000, toggle,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            // We wire toggle to the status text (safe nested view for click)
            views.setOnClickPendingIntent(getStatusId(size), togglePi);

            mgr.updateAppWidget(widgetId, views);
        } catch (Exception e) {
            // Prevent crash loop — do nothing, widget will retry on next update period
        }
    }

    // ── Public refresh called from ForegroundService ──────────────────────────
    public static void refreshAll(Context ctx) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);

            int[] small = mgr.getAppWidgetIds(new ComponentName(ctx, AttendanceWidgetSmall.class));
            for (int id : small) updateWidget(ctx, mgr, id, "small");

            int[] medium = mgr.getAppWidgetIds(new ComponentName(ctx, AttendanceWidgetMedium.class));
            for (int id : medium) updateWidget(ctx, mgr, id, "medium");

            int[] large = mgr.getAppWidgetIds(new ComponentName(ctx, AttendanceWidgetLarge.class));
            for (int id : large) updateWidget(ctx, mgr, id, "large");
        } catch (Exception ignored) {}
    }

    // ── RemoteViews builder — picks layout by size + theme ───────────────────
    private static RemoteViews buildViews(Context ctx, String size, boolean rainbow, WidgetData d) {
        String pkg = ctx.getPackageName();
        RemoteViews v;

        switch (size) {
            case "small":
                v = new RemoteViews(pkg, rainbow ? R.layout.widget_small_rainbow : R.layout.widget_small_teal);
                v.setTextViewText(R.id.widget_small_icon,   d.statusTag);
                v.setTextViewText(R.id.widget_small_status, d.statusLabel);
                v.setTextViewText(R.id.widget_small_hours,  d.hoursToday);
                v.setTextViewText(R.id.widget_small_streak, d.streak + "d streak");
                break;

            case "large":
                v = new RemoteViews(pkg, rainbow ? R.layout.widget_large_rainbow : R.layout.widget_large_teal);
                v.setTextViewText(R.id.widget_large_icon,     d.statusTag);
                v.setTextViewText(R.id.widget_large_status,   d.statusLabel);
                v.setTextViewText(R.id.widget_large_streak,   d.streak + " day streak");
                v.setTextViewText(R.id.widget_large_hours,    d.hoursToday);
                v.setTextViewText(R.id.widget_large_checkin,  d.checkIn);
                v.setTextViewText(R.id.widget_large_checkout, d.checkOut);
                v.setTextViewText(R.id.widget_large_gps,      d.lastGps);
                v.setTextViewText(R.id.widget_large_updated,  d.updatedAt);
                break;

            default: // medium
                v = new RemoteViews(pkg, rainbow ? R.layout.widget_medium_rainbow : R.layout.widget_medium_teal);
                v.setTextViewText(R.id.widget_medium_icon,     d.statusTag);
                v.setTextViewText(R.id.widget_medium_status,   d.statusLabel);
                v.setTextViewText(R.id.widget_medium_streak,   d.streak + " day streak");
                v.setTextViewText(R.id.widget_medium_hours,    d.hoursToday + " today");
                v.setTextViewText(R.id.widget_medium_checkin,  "In: " + d.checkIn);
                v.setTextViewText(R.id.widget_medium_checkout, "Out: " + d.checkOut);
                v.setTextViewText(R.id.widget_medium_gps,      "GPS: " + d.lastGps);
                break;
        }
        return v;
    }

    // ── Data reading ──────────────────────────────────────────────────────────
    private static WidgetData readData(Context ctx) {
        WidgetData d = new WidgetData();
        try {
            SharedPreferences state = ctx.getSharedPreferences(PREFS_STATE, Context.MODE_PRIVATE);
            String status = state.getString("todayStatus", "idle");

            // No emoji — plain ASCII tags that are safe in all RemoteViews
            switch (status) {
                case "checked-in":
                    d.statusLabel = "Present"; d.statusTag = "[IN]";  break;
                case "checked-out":
                    d.statusLabel = "Done";    d.statusTag = "[OK]";  break;
                case "absent":
                    d.statusLabel = "Absent";  d.statusTag = "[--]";  break;
                default:
                    d.statusLabel = "Idle";    d.statusTag = "[  ]";  break;
            }

            int totalMins = state.getInt("totalMinutesToday", 0);
            d.hoursToday  = formatDuration(totalMins);

            long locTs = state.getLong("lastLocTimestamp", 0);
            d.lastGps  = locTs > 0 ? relativeTime(locTs) : "--";

            long updTs = state.getLong("lastUpdated", 0);
            d.updatedAt = updTs > 0 ? relativeTime(updTs) : "never";

            readLogsData(ctx, d);
        } catch (Exception ignored) {}
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
            SimpleDateFormat isoFmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.getDefault());

            // Streak: consecutive attended days going backwards from today
            Set<String> attendedDates = new TreeSet<>(Collections.reverseOrder());
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (l.optBoolean("attended", false)) {
                    attendedDates.add(l.optString("date", ""));
                }
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

            // Today's check-in / check-out
            for (int i = logs.length() - 1; i >= 0; i--) {
                JSONObject l = logs.getJSONObject(i);
                if (!today.equals(l.optString("date", ""))) continue;
                if ("absent".equals(l.optString("status", ""))) continue;

                String ci = l.optString("checkIn", "");
                if (!ci.isEmpty()) {
                    try { d.checkIn = timeFmt.format(isoFmt.parse(ci)); }
                    catch (Exception e) { d.checkIn = "--:--"; }
                }
                String co = l.isNull("checkOut") ? "" : l.optString("checkOut", "");
                if (!co.isEmpty()) {
                    try { d.checkOut = timeFmt.format(isoFmt.parse(co)); }
                    catch (Exception e) { d.checkOut = "--:--"; }
                }
                break;
            }
        } catch (Exception ignored) {}
    }

    // ── Theme helpers ─────────────────────────────────────────────────────────
    private static String getTheme(Context ctx) {
        return ctx.getSharedPreferences(PREFS_WIDGET, Context.MODE_PRIVATE)
                .getString(KEY_THEME, THEME_TEAL);
    }

    private static void toggleTheme(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS_WIDGET, Context.MODE_PRIVATE);
        String cur = p.getString(KEY_THEME, THEME_TEAL);
        p.edit().putString(KEY_THEME, THEME_TEAL.equals(cur) ? THEME_RAINBOW : THEME_TEAL).apply();
    }

    // ── View ID helpers ───────────────────────────────────────────────────────
    private static int getRootId(String size, boolean rainbow) {
        switch (size) {
            case "small": return R.id.widget_small_root;
            case "large": return R.id.widget_large_root;
            default:      return R.id.widget_medium_root;
        }
    }

    private static int getStatusId(String size) {
        switch (size) {
            case "small": return R.id.widget_small_status;
            case "large": return R.id.widget_large_status;
            default:      return R.id.widget_medium_status;
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────
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

    // ── Data holder ───────────────────────────────────────────────────────────
    static class WidgetData {
        String statusLabel = "Idle";
        String statusTag   = "[  ]";
        String hoursToday  = "0h 0m";
        String checkIn     = "--:--";
        String checkOut    = "--:--";
        String lastGps     = "--";
        String updatedAt   = "never";
        int    streak      = 0;
    }
}
