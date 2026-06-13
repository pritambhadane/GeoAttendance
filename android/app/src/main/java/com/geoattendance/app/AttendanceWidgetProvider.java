package com.geoattendance.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * REBUILT Home-screen widget — 100% static RemoteViews.
 *
 * WHY NO ListView/RemoteViewsService:
 *   The previous implementation used a RemoteViewsService-backed ListView.
 *   On MIUI, OneUI, ColorOS, and other OEM ROMs the RemoteViewsFactory
 *   binding is deferred or skipped entirely, leaving the ListView in its
 *   "Loading…" placeholder indefinitely.  The only fully reliable approach
 *   is to pre-build every row as a fixed RemoteViews and set each one with
 *   setRemoteViews(container, rowId, rowViews). No service binding, no
 *   factory, no asynchronous data load — everything happens synchronously
 *   in onUpdate / updateWidget.
 *
 * LAYOUT STRUCTURE (widget_attendance.xml):
 *   - widget_header       → last GPS fix (coords, accuracy, time)
 *   - widget_row_0..3     → up to 4 static log rows (widget_row_item.xml)
 *   - widget_empty_view   → shown when there are 0 logs
 */
public class AttendanceWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "com.geoattendance.app.WIDGET_REFRESH";

    private static final TimeZone IST = TimeZone.getTimeZone("Asia/Kolkata");

    // ── AppWidgetProvider callbacks ──────────────────────────────────────────

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            updateWidget(context, mgr, id);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) {
            refreshAll(context);
        }
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** Call from AttendanceForegroundService after any state change. */
    public static void refreshAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        ComponentName provider = new ComponentName(context, AttendanceWidgetProvider.class);
        int[] ids = mgr.getAppWidgetIds(provider);
        if (ids == null || ids.length == 0) return;
        for (int id : ids) {
            updateWidget(context, mgr, id);
        }
    }

    // ── Core update ──────────────────────────────────────────────────────────

    private static void updateWidget(Context context, AppWidgetManager mgr, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_attendance);

        // ── 1. Header: last GPS fix ──────────────────────────────────────────
        bindHeader(context, views);

        // ── 2. Log rows ──────────────────────────────────────────────────────
        List<JSONObject> logs = loadRecentLogs(context);
        bindRows(context, views, logs);

        // ── 3. Tap → open app ────────────────────────────────────────────────
        Intent launch = context.getPackageManager()
                .getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            PendingIntent pi = PendingIntent.getActivity(
                    context, 0, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            views.setOnClickPendingIntent(R.id.widget_header, pi);
        }

        mgr.updateAppWidget(widgetId, views);
    }

    // ── Header binding ───────────────────────────────────────────────────────

    private static void bindHeader(Context context, RemoteViews views) {
        SharedPreferences state = context.getSharedPreferences(
                AttendanceForegroundService.PREFS_STATE, Context.MODE_PRIVATE);

        float lat = state.getFloat("lastLocLat",  Float.NaN);
        float lng = state.getFloat("lastLocLng",  Float.NaN);
        float acc = state.getFloat("lastLocAccuracy", -1f);
        long  ts  = state.getLong("lastLocTimestamp", 0L);

        if (!Float.isNaN(lat) && !Float.isNaN(lng)) {
            views.setTextViewText(R.id.widget_location_coords,
                    String.format(Locale.US, "%.5f, %.5f", lat, lng));
            views.setTextViewText(R.id.widget_location_accuracy,
                    acc >= 0 ? String.format(Locale.US, "±%.0f m", acc) : "—");
            views.setTextViewText(R.id.widget_location_time,
                    ts > 0 ? formatRelativeTime(ts) : "—");
        } else {
            views.setTextViewText(R.id.widget_location_coords, "No location yet");
            views.setTextViewText(R.id.widget_location_accuracy, "");
            views.setTextViewText(R.id.widget_location_time, "Waiting for GPS…");
        }

        // "Updated X ago" label
        long lastUpdated = state.getLong("lastUpdated", 0L);
        views.setTextViewText(R.id.widget_updated_time,
                lastUpdated > 0 ? "Updated " + formatRelativeTime(lastUpdated) : "");
    }

    // ── Row binding ──────────────────────────────────────────────────────────

    private static void bindRows(Context context, RemoteViews views, List<JSONObject> logs) {
        if (logs.isEmpty()) {
            views.setViewVisibility(R.id.widget_rows_container, View.GONE);
            views.setViewVisibility(R.id.widget_empty_view,     View.VISIBLE);
            return;
        }

        views.setViewVisibility(R.id.widget_rows_container, View.VISIBLE);
        views.setViewVisibility(R.id.widget_empty_view,     View.GONE);

        // removeAllViews + addView is the correct API-14+ way to populate
        // a container with dynamic child RemoteViews (setRemoteViews requires API 31).
        views.removeAllViews(R.id.widget_rows_container);
        for (int i = 0; i < Math.min(logs.size(), 4); i++) {
            views.addView(R.id.widget_rows_container, buildRow(context, logs.get(i)));
        }
    }

    private static RemoteViews buildRow(Context context, JSONObject log) {
        RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_row_item);

        String profileName = log.optString("profileName", "—");
        String date        = log.optString("date", "");
        String status      = log.optString("status", "auto");
        boolean attended   = log.optBoolean("attended", false);

        row.setTextViewText(R.id.row_profile_name, profileName);
        row.setTextViewText(R.id.row_date, formatDateShort(date));

        if ("absent".equals(status)) {
            row.setTextViewText(R.id.row_checkin,  "In: —");
            row.setTextViewText(R.id.row_checkout, "Out: —");
            row.setTextViewText(R.id.row_duration, "—");
            row.setTextViewText(R.id.row_status,   "Absent");
            // Red accent
            row.setInt(R.id.row_accent, "setBackgroundColor", 0xFFFF6B6B);
            row.setTextColor(R.id.row_status,                 0xFFFF6B6B);
            row.setInt(R.id.row_status, "setBackgroundColor", 0x22FF6B6B);
        } else {
            row.setTextViewText(R.id.row_checkin,
                    "In: " + formatTime(log.optString("checkIn", null)));
            row.setTextViewText(R.id.row_checkout,
                    "Out: " + (log.isNull("checkOut") ? "—" : formatTime(log.optString("checkOut", null))));
            row.setTextViewText(R.id.row_duration,
                    formatDuration(log.isNull("duration") ? -1 : log.optInt("duration", -1)));

            String statusLabel;
            int accentColor;
            int badgeBg;
            if (!attended) {
                statusLabel = "Active";
                accentColor = 0xFFFBBF24; // amber
                badgeBg     = 0x22FBBF24;
            } else if ("manual".equals(status)) {
                statusLabel = "Manual";
                accentColor = 0xFF818CF8; // indigo
                badgeBg     = 0x22818CF8;
            } else {
                statusLabel = "Auto";
                accentColor = 0xFF4ADE80; // green
                badgeBg     = 0x224ADE80;
            }

            row.setTextViewText(R.id.row_status, statusLabel);
            row.setInt(R.id.row_accent, "setBackgroundColor", accentColor);
            row.setTextColor(R.id.row_status,                 accentColor);
            row.setInt(R.id.row_status, "setBackgroundColor", badgeBg);
        }

        return row;
    }

    // ── Data loading ─────────────────────────────────────────────────────────

    private static List<JSONObject> loadRecentLogs(Context context) {
        List<JSONObject> result = new ArrayList<>();

        SharedPreferences prefs = context.getSharedPreferences(
                AttendanceForegroundService.PREFS_LOGS, Context.MODE_PRIVATE);
        JSONArray all;
        try {
            String raw = prefs.getString("logs", "[]");
            all = new JSONArray(raw);
        } catch (JSONException e) {
            return result;
        }

        // Build last-4-days date set (IST)
        List<String> last4 = new ArrayList<>();
        Calendar cal = Calendar.getInstance(IST);
        SimpleDateFormat dateFmt = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        dateFmt.setTimeZone(IST);
        for (int i = 0; i < 4; i++) {
            last4.add(dateFmt.format(cal.getTime()));
            cal.add(Calendar.DAY_OF_MONTH, -1);
        }

        // Filter
        List<JSONObject> filtered = new ArrayList<>();
        for (int i = 0; i < all.length(); i++) {
            try {
                JSONObject l = all.getJSONObject(i);
                if (last4.contains(l.optString("date"))) {
                    filtered.add(l);
                }
            } catch (JSONException ignored) {}
        }

        // Sort: newest date first, then by check-in descending
        filtered.sort((a, b) -> {
            int cmp = b.optString("date").compareTo(a.optString("date"));
            if (cmp != 0) return cmp;
            return b.optString("checkIn").compareTo(a.optString("checkIn"));
        });

        // Return at most 4
        int limit = Math.min(filtered.size(), 4);
        for (int i = 0; i < limit; i++) {
            result.add(filtered.get(i));
        }
        return result;
    }

    // ── Formatters ───────────────────────────────────────────────────────────

    private static String formatRelativeTime(long tsMs) {
        long diff = System.currentTimeMillis() - tsMs;
        long mins = diff / 60_000;
        if (mins < 1)  return "Just now";
        if (mins < 60) return mins + "m ago";
        long hrs = mins / 60;
        if (hrs < 24)  return hrs + "h ago";
        SimpleDateFormat sdf = new SimpleDateFormat("dd MMM, HH:mm", Locale.US);
        sdf.setTimeZone(IST);
        return sdf.format(new Date(tsMs));
    }

    private static String formatDateShort(String isoDate) {
        if (isoDate == null || isoDate.isEmpty()) return "—";
        try {
            SimpleDateFormat in  = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            SimpleDateFormat out = new SimpleDateFormat("EEE, dd MMM", Locale.US);
            Date d = in.parse(isoDate);
            return d != null ? out.format(d) : isoDate;
        } catch (Exception e) {
            return isoDate;
        }
    }

    private static String formatTime(String iso) {
        if (iso == null || iso.isEmpty()) return "—";
        try {
            SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US);
            Date d = parser.parse(iso);
            if (d == null) return "—";
            SimpleDateFormat out = new SimpleDateFormat("hh:mm a", Locale.US);
            out.setTimeZone(IST);
            return out.format(d);
        } catch (Exception e) {
            return "—";
        }
    }

    private static String formatDuration(int minutes) {
        if (minutes < 0) return "—";
        int h = minutes / 60;
        int m = minutes % 60;
        return h > 0 ? h + "h " + m + "m" : m + "m";
    }
}
