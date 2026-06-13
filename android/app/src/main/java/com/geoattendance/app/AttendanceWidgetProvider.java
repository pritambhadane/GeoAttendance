package com.geoattendance.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Home-screen widget showing:
 *  - Header: last GPS location scanned (lat/lng), timestamp, and accuracy.
 *  - List:   last 4 days of attendance logs — profile name, check-in,
 *            check-out, duration, and status.
 *
 * Data is read directly from the SharedPreferences written by
 * AttendanceForegroundService, so the widget works even if the app's
 * UI/WebView is not running.
 */
public class AttendanceWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "com.geoattendance.app.WIDGET_REFRESH";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int widgetId : appWidgetIds) {
            updateWidget(context, appWidgetManager, widgetId);
        }
    }

    /** Call from anywhere (service, plugin) to push fresh data to all widget instances. */
    public static void refreshAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        ComponentName provider = new ComponentName(context, AttendanceWidgetProvider.class);
        int[] ids = mgr.getAppWidgetIds(provider);
        if (ids == null || ids.length == 0) return;
        for (int id : ids) {
            updateWidget(context, mgr, id);
        }
        // Notify the RemoteViewsFactory to reload its data.
        // Called once here (not again inside updateWidget) to avoid the
        // duplicate notifyAppWidgetViewDataChanged that was causing the
        // factory to reset mid-render on some launchers.
        mgr.notifyAppWidgetViewDataChanged(ids, R.id.widget_log_list);
    }

    private static void updateWidget(Context context, AppWidgetManager appWidgetManager, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_attendance);

        // ── Header: last location scanned ───────────────────────────────────
        SharedPreferences state = context.getSharedPreferences(
                AttendanceForegroundService.PREFS_STATE, Context.MODE_PRIVATE);

        float lat = state.getFloat("lastLocLat", Float.NaN);
        float lng = state.getFloat("lastLocLng", Float.NaN);
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
            views.setTextViewText(R.id.widget_location_accuracy, "—");
            views.setTextViewText(R.id.widget_location_time, "—");
        }

        // ── List: last 4 days of logs ───────────────────────────────────────
        Intent listIntent = new Intent(context, AttendanceWidgetService.class);
        listIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        // Unique data URI per widget ID — required so Android doesn't reuse
        // the same RemoteViewsService instance across widget instances.
        listIntent.setData(Uri.parse(listIntent.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.widget_log_list, listIntent);

        // FIX: setEmptyView works correctly now that widget_empty_view is a
        // FrameLayout sibling of widget_log_list (see widget_attendance.xml).
        views.setEmptyView(R.id.widget_log_list, R.id.widget_empty_view);

        // Tapping the widget opens the app.
        Intent launchIntent = context.getPackageManager()
                .getLaunchIntentForPackage(context.getPackageName());
        if (launchIntent != null) {
            android.app.PendingIntent pendingIntent = android.app.PendingIntent.getActivity(
                    context, 0, launchIntent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT |
                    android.app.PendingIntent.FLAG_IMMUTABLE);
            views.setOnClickPendingIntent(R.id.widget_header, pendingIntent);
        }

        appWidgetManager.updateAppWidget(widgetId, views);
        // NOTE: notifyAppWidgetViewDataChanged is intentionally NOT called here.
        // It is called once in refreshAll() after all widget IDs are updated,
        // or by the system's own update cycle for periodic refreshes.
        // Calling it here AND in refreshAll was causing a double-reset race
        // on OEM launchers that manifested as the "permanent loading" symptom.
    }

    private static String formatRelativeTime(long timestampMs) {
        long diffMs = System.currentTimeMillis() - timestampMs;
        long mins = diffMs / 60000;
        if (mins < 1)  return "Just now";
        if (mins < 60) return mins + "m ago";
        long hours = mins / 60;
        if (hours < 24) return hours + "h ago";
        SimpleDateFormat sdf = new SimpleDateFormat("dd MMM, HH:mm", Locale.US);
        return sdf.format(new Date(timestampMs));
    }
}
