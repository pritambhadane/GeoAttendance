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
 * Core widget logic. Three size sub-providers delegate here.
 *
 * Shows:
 *  - Overall today status: Present / Done / Absent / Idle
 *  - Per-profile breakdown: "2 present, 1 absent" or "1 active"
 *  - Today's total hours, first check-in, first check-out
 *  - Streak of consecutive attended days
 *  - Last GPS scan time
 *
 * Long-press status label toggles teal / rainbow theme.
 */
public class AttendanceWidgetProvider extends AppWidgetProvider {

    static final String PREFS_STATE   = "AttendanceState";
    static final String PREFS_LOGS    = "AttendanceLogs";
    static final String PREFS_WIDGET  = "WidgetPrefs";
    static final String KEY_THEME     = "widget_theme";
    static final String THEME_TEAL    = "teal";
    static final String THEME_RAINBOW = "rainbow";

    static final String ACTION_TOGGLE_THEME = "com.geoattendance.app.WIDGET_TOGGLE_THEME";
    static final String ACTION_REFRESH      = "com.geoattendance.app.WIDGET_REFRESH";

    // Fixed table row/cell view IDs for the large widget (9 rows x 6 cols)
    static final int[] TABLE_ROW_IDS = {
            R.id.widget_large_row1, R.id.widget_large_row2, R.id.widget_large_row3,
            R.id.widget_large_row4, R.id.widget_large_row5, R.id.widget_large_row6,
            R.id.widget_large_row7, R.id.widget_large_row8, R.id.widget_large_row9 };
    static final int[][] TABLE_CELL_IDS = {
            { R.id.widget_large_r1_c1, R.id.widget_large_r1_c2, R.id.widget_large_r1_c3, R.id.widget_large_r1_c4, R.id.widget_large_r1_c5, R.id.widget_large_r1_c6 },
            { R.id.widget_large_r2_c1, R.id.widget_large_r2_c2, R.id.widget_large_r2_c3, R.id.widget_large_r2_c4, R.id.widget_large_r2_c5, R.id.widget_large_r2_c6 },
            { R.id.widget_large_r3_c1, R.id.widget_large_r3_c2, R.id.widget_large_r3_c3, R.id.widget_large_r3_c4, R.id.widget_large_r3_c5, R.id.widget_large_r3_c6 },
            { R.id.widget_large_r4_c1, R.id.widget_large_r4_c2, R.id.widget_large_r4_c3, R.id.widget_large_r4_c4, R.id.widget_large_r4_c5, R.id.widget_large_r4_c6 },
            { R.id.widget_large_r5_c1, R.id.widget_large_r5_c2, R.id.widget_large_r5_c3, R.id.widget_large_r5_c4, R.id.widget_large_r5_c5, R.id.widget_large_r5_c6 },
            { R.id.widget_large_r6_c1, R.id.widget_large_r6_c2, R.id.widget_large_r6_c3, R.id.widget_large_r6_c4, R.id.widget_large_r6_c5, R.id.widget_large_r6_c6 },
            { R.id.widget_large_r7_c1, R.id.widget_large_r7_c2, R.id.widget_large_r7_c3, R.id.widget_large_r7_c4, R.id.widget_large_r7_c5, R.id.widget_large_r7_c6 },
            { R.id.widget_large_r8_c1, R.id.widget_large_r8_c2, R.id.widget_large_r8_c3, R.id.widget_large_r8_c4, R.id.widget_large_r8_c5, R.id.widget_large_r8_c6 },
            { R.id.widget_large_r9_c1, R.id.widget_large_r9_c2, R.id.widget_large_r9_c3, R.id.widget_large_r9_c4, R.id.widget_large_r9_c5, R.id.widget_large_r9_c6 } };

    static final int COLOR_PRESENT = 0xFF7CFFB2;  // green
    static final int COLOR_ABSENT  = 0xFFFF9E9E;  // red
    static final int COLOR_ACTIVE  = 0xFFFFE08A;  // amber
    static final int COLOR_LEAVE   = 0xFF9EC9FF;  // blue
    static final int COLOR_NONE    = 0x66FFFFFF;  // faint

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
        if (ACTION_REFRESH.equals(intent.getAction())) {
            refreshAll(ctx);
        }
    }

    // ── Called by sub-providers ───────────────────────────────────────────────
    static void updateWidget(Context ctx, AppWidgetManager mgr, int widgetId, String size) {
        try {
            WidgetData data = readData(ctx);
            boolean rainbow = THEME_RAINBOW.equals(getTheme(ctx));
            RemoteViews views = buildViews(ctx, size, rainbow, data);

            // Tap root → open app
            Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            if (launch != null) {
                PendingIntent pi = PendingIntent.getActivity(ctx, widgetId, launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                views.setOnClickPendingIntent(getRootId(size, rainbow), pi);
            }

            // Long-press status label → toggle theme
            Intent toggle = new Intent(ctx, AttendanceWidgetProvider.class);
            toggle.setAction(ACTION_TOGGLE_THEME);
            PendingIntent togglePi = PendingIntent.getBroadcast(ctx, widgetId + 10000, toggle,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            views.setOnClickPendingIntent(getStatusId(size), togglePi);

            // Tap the timestamp / GPS label → refresh the widget data
            Intent refresh = new Intent(ctx, AttendanceWidgetProvider.class);
            refresh.setAction(ACTION_REFRESH);
            PendingIntent refreshPi = PendingIntent.getBroadcast(ctx, widgetId + 20000, refresh,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            if ("large".equals(size)) {
                views.setOnClickPendingIntent(R.id.widget_large_updated, refreshPi);
            } else if ("medium".equals(size)) {
                views.setOnClickPendingIntent(R.id.widget_medium_gps, refreshPi);
            }

            mgr.updateAppWidget(widgetId, views);
        } catch (Exception ignored) {}
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

    // ── RemoteViews builder ───────────────────────────────────────────────────
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
                v.setTextViewText(R.id.widget_large_gps,      d.locLine);
                v.setTextViewText(R.id.widget_large_updated,  "Updated: " + d.updatedAt);
                // Profile summary line (e.g. "2 done, 1 absent")
                if (d.profileSummary != null && !d.profileSummary.isEmpty()) {
                    v.setTextViewText(R.id.widget_large_streak, d.streak + "d streak | " + d.profileSummary);
                }
                // ── Attendance table: last 3 days × profiles ─────────────
                for (int r = 0; r < TABLE_ROW_IDS.length; r++) {
                    if (r < d.tableRowCount) {
                        v.setViewVisibility(TABLE_ROW_IDS[r], android.view.View.VISIBLE);
                        for (int c = 0; c < 6; c++) {
                            v.setTextViewText(TABLE_CELL_IDS[r][c], d.tableCells[r][c]);
                        }
                        v.setTextColor(TABLE_CELL_IDS[r][5], d.tableStatusColor[r]);
                    } else {
                        v.setViewVisibility(TABLE_ROW_IDS[r], android.view.View.GONE);
                    }
                }
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
                v.setTextViewText(R.id.widget_medium_history,  d.historyLine);
                break;
        }
        return v;
    }

    // ── Data reading ──────────────────────────────────────────────────────────
    private static WidgetData readData(Context ctx) {
        WidgetData d = new WidgetData();
        try {
            SharedPreferences state = ctx.getSharedPreferences(PREFS_STATE, Context.MODE_PRIVATE);
            String status       = state.getString("todayStatus", "idle");
            int profilesPresent = state.getInt("profilesPresent", 0);
            int profilesAbsent  = state.getInt("profilesAbsent",  0);
            int profilesActive  = state.getInt("profilesActive",  0);

            // Status tag and label — now includes absent
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

            // Build profile summary string
            StringBuilder sb = new StringBuilder();
            if (profilesActive > 0)  sb.append(profilesActive).append(" active");
            if (profilesPresent > 0) {
                if (sb.length() > 0) sb.append(", ");
                sb.append(profilesPresent).append(" done");
            }
            if (profilesAbsent > 0) {
                if (sb.length() > 0) sb.append(", ");
                sb.append(profilesAbsent).append(" absent");
            }
            d.profileSummary = sb.toString();

            int totalMins = state.getInt("totalMinutesToday", 0);
            d.hoursToday  = formatDuration(totalMins);

            long locTs = state.getLong("lastLocTimestamp", 0);
            d.lastGps  = locTs > 0 ? relativeTime(locTs) : "--";

            // Coordinates + accuracy line for the large widget header
            float lat = state.getFloat("lastLocLat", 0f);
            float lng = state.getFloat("lastLocLng", 0f);
            float acc = state.getFloat("lastLocAccuracy", 0f);
            if (locTs > 0 && (lat != 0f || lng != 0f)) {
                d.locLine = String.format(Locale.US, "GPS %.5f, %.5f  \u00B1%.0fm  (%s)",
                        lat, lng, acc, d.lastGps);
            } else {
                d.locLine = "GPS: no fix yet";
            }

            long updTs = state.getLong("lastUpdated", 0);
            d.updatedAt = updTs > 0 ? relativeTime(updTs) : "never";

            // Read check-in/out and streak from logs
            readLogsData(ctx, d, state);

        } catch (Exception ignored) {}
        return d;
    }

    private static void readLogsData(Context ctx, WidgetData d, SharedPreferences state) {
        try {
            // Use firstCheckIn/firstCheckOut stored by ForegroundService if available
            String fcIn  = state.getString("firstCheckIn",  "");
            String fcOut = state.getString("firstCheckOut", "");

            SimpleDateFormat timeFmt = new SimpleDateFormat("HH:mm", Locale.getDefault());
            timeFmt.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));
            SimpleDateFormat isoFmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.getDefault());

            if (!fcIn.isEmpty()) {
                try { d.checkIn = timeFmt.format(isoFmt.parse(fcIn)); } catch (Exception e) { d.checkIn = "--:--"; }
            }
            if (!fcOut.isEmpty()) {
                try { d.checkOut = timeFmt.format(isoFmt.parse(fcOut)); } catch (Exception e) { d.checkOut = "--:--"; }
            }

            // Streak from logs
            SharedPreferences logPrefs = ctx.getSharedPreferences(PREFS_LOGS, Context.MODE_PRIVATE);
            String raw = logPrefs.getString("logs", "[]");
            JSONArray logs = new JSONArray(raw);

            Set<String> attendedDates = new TreeSet<>(Collections.reverseOrder());
            Set<String> leaveDates = new TreeSet<>();
            for (int i = 0; i < logs.length(); i++) {
                JSONObject l = logs.getJSONObject(i);
                if (l.optBoolean("attended", false)) {
                    attendedDates.add(l.optString("date", ""));
                }
                if ("leave".equals(l.optString("status"))) {
                    leaveDates.add(l.optString("date", ""));
                }
            }
            int streak = 0;
            Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Kolkata"));
            SimpleDateFormat df2 = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault());
            df2.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));
            for (int back = 0; back < 365; back++) {
                String ds = df2.format(cal.getTime());
                if (attendedDates.contains(ds)) {
                    streak++;
                    cal.add(Calendar.DAY_OF_YEAR, -1);
                } else if (leaveDates.contains(ds)) {
                    // Leave days don't break the streak — skip without counting
                    cal.add(Calendar.DAY_OF_YEAR, -1);
                } else { break; }
            }
            d.streak = streak;

            // ── Last 3 days, all profiles ─────────────────────────────────
            // Per day: "Thu 09  Office ✓7h50m · SiteB ✗ · Home –"
            SharedPreferences state2 = ctx.getSharedPreferences(PREFS_STATE, Context.MODE_PRIVATE);
            JSONArray profiles;
            try { profiles = new JSONArray(state2.getString("profiles", "[]")); }
            catch (Exception e) { profiles = new JSONArray(); }

            SimpleDateFormat dayLbl = new SimpleDateFormat("EEE dd", Locale.getDefault());
            dayLbl.setTimeZone(TimeZone.getTimeZone("Asia/Kolkata"));
            Calendar dayCal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Kolkata"));

            StringBuilder compact = new StringBuilder();
            int tRow = 0;
            for (int back = 0; back < 3; back++) {
                String dateStr = df2.format(dayCal.getTime());
                String label   = (back == 0) ? "Today" : dayLbl.format(dayCal.getTime());

                int presentCnt = 0, absentCnt = 0;

                for (int pi = 0; pi < profiles.length(); pi++) {
                    JSONObject prof = profiles.getJSONObject(pi);
                    String pid   = prof.optString("id", "");
                    String pname = prof.optString("name", "?");
                    if (pname.length() > 9) pname = pname.substring(0, 9);

                    int totalMins   = 0;
                    boolean present = false, absent = false, open = false, leave = false;
                    long earliestIn = Long.MAX_VALUE, latestOut = Long.MIN_VALUE;
                    for (int li = 0; li < logs.length(); li++) {
                        JSONObject l = logs.getJSONObject(li);
                        if (!pid.equals(l.optString("profileId"))) continue;
                        if (!dateStr.equals(l.optString("date")))  continue;
                        if ("absent".equals(l.optString("status"))) { absent = true; continue; }
                        if ("leave".equals(l.optString("status")))  { leave  = true; continue; }
                        present = true;
                        try {
                            Date ci = isoFmt.parse(l.optString("checkIn", ""));
                            if (ci != null && ci.getTime() < earliestIn) earliestIn = ci.getTime();
                        } catch (Exception ignored2) {}
                        if (l.isNull("checkOut")) {
                            open = true;
                        } else {
                            try {
                                Date co = isoFmt.parse(l.optString("checkOut", ""));
                                if (co != null && co.getTime() > latestOut) latestOut = co.getTime();
                            } catch (Exception ignored2) {}
                            if (!l.isNull("duration")) totalMins += l.optInt("duration", 0);
                        }
                    }
                    if (present) presentCnt++;
                    if (absent && !present) absentCnt++;

                    // Fill one table row for this profile+day (large widget)
                    if (tRow < 9 && (present || absent || leave)) {
                        d.tableCells[tRow][0] = label;
                        d.tableCells[tRow][1] = pname;
                        d.tableCells[tRow][2] = (earliestIn != Long.MAX_VALUE)
                                ? timeFmt.format(new Date(earliestIn)) : "--:--";
                        d.tableCells[tRow][3] = open ? "..."
                                : (latestOut != Long.MIN_VALUE ? timeFmt.format(new Date(latestOut)) : "--:--");
                        d.tableCells[tRow][4] = present
                                ? (open && totalMins == 0 ? "..." : formatDuration(totalMins).replace(" ", ""))
                                : "--";
                        if (open) {
                            d.tableCells[tRow][5] = "Active";
                            d.tableStatusColor[tRow] = COLOR_ACTIVE;
                        } else if (present) {
                            d.tableCells[tRow][5] = "Present";
                            d.tableStatusColor[tRow] = COLOR_PRESENT;
                        } else if (leave) {
                            d.tableCells[tRow][5] = "Leave";
                            d.tableStatusColor[tRow] = COLOR_LEAVE;
                        } else {
                            d.tableCells[tRow][5] = "Absent";
                            d.tableStatusColor[tRow] = COLOR_ABSENT;
                        }
                        tRow++;
                        label = "";  // only show the date on the first row of each day
                    }
                }

                // Compact line for the medium widget: "Today ✓2 · Thu ✓1✗1 · Wed –"
                if (back > 0) compact.append(" · ");
                compact.append(back == 0 ? "Today" : dayLbl.format(dayCal.getTime()).split(" ")[0]).append(" ");
                if (presentCnt == 0 && absentCnt == 0) compact.append("–");
                else {
                    if (presentCnt > 0) compact.append("✓").append(presentCnt);
                    if (absentCnt  > 0) compact.append("✗").append(absentCnt);
                }

                dayCal.add(Calendar.DAY_OF_YEAR, -1);
            }
            d.historyLine = compact.toString();
            d.tableRowCount = tRow;
            if (tRow == 0) {
                // No records at all — show a single placeholder row
                d.tableCells[0][0] = "Today";
                d.tableCells[0][1] = "--";
                d.tableCells[0][2] = "--:--";
                d.tableCells[0][3] = "--:--";
                d.tableCells[0][4] = "--";
                d.tableCells[0][5] = "No data";
                d.tableStatusColor[0] = COLOR_NONE;
                d.tableRowCount = 1;
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
        String statusLabel   = "Idle";
        String statusTag     = "[  ]";
        String hoursToday    = "0h 0m";
        String checkIn       = "--:--";
        String checkOut      = "--:--";
        String lastGps       = "--";
        String updatedAt     = "never";
        String profileSummary = "";
        int    streak        = 0;
        String   locLine     = "GPS: no fix yet";
        // Last 3 days, all profiles (index 0 = today)
        String[] dayHistory  = { "--", "--", "--" };
        String   historyLine = "--";
        // Table for the large widget: up to 9 rows x 6 cols
        String[][] tableCells     = new String[9][6];
        int[]      tableStatusColor = new int[9];
        int        tableRowCount  = 0;
    }
}
