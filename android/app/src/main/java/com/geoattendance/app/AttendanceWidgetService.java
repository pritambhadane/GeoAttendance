package com.geoattendance.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

public class AttendanceWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new LogsRemoteViewsFactory(getApplicationContext());
    }

    static class LogsRemoteViewsFactory implements RemoteViewsFactory {

        private static final TimeZone IST = TimeZone.getTimeZone("Asia/Kolkata");

        private final Context context;
        private final List<JSONObject> items = new ArrayList<>();

        LogsRemoteViewsFactory(Context context) {
            this.context = context;
        }

        @Override public void onCreate() {}

        @Override
        public void onDataSetChanged() {
            items.clear();
            SharedPreferences prefs = context.getSharedPreferences(
                    AttendanceForegroundService.PREFS_LOGS, Context.MODE_PRIVATE);
            JSONArray logs;
            try {
                logs = new JSONArray(prefs.getString("logs", "[]"));
            } catch (JSONException e) {
                logs = new JSONArray();
            }

            // Build the set of last 4 calendar dates (including today), IST.
            List<String> last4Dates = new ArrayList<>();
            Calendar cal = Calendar.getInstance(IST);
            SimpleDateFormat dateFmt = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            dateFmt.setTimeZone(IST);
            for (int i = 0; i < 4; i++) {
                last4Dates.add(dateFmt.format(cal.getTime()));
                cal.add(Calendar.DAY_OF_MONTH, -1);
            }

            // Collect logs whose date falls in the last 4 days.
            List<JSONObject> filtered = new ArrayList<>();
            for (int i = 0; i < logs.length(); i++) {
                try {
                    JSONObject l = logs.getJSONObject(i);
                    if (last4Dates.contains(l.optString("date"))) {
                        filtered.add(l);
                    }
                } catch (JSONException ignored) {}
            }

            // Sort newest date first, then by check-in time descending.
            filtered.sort((a, b) -> {
                int dateCmp = b.optString("date").compareTo(a.optString("date"));
                if (dateCmp != 0) return dateCmp;
                return b.optString("checkIn").compareTo(a.optString("checkIn"));
            });

            items.addAll(filtered);
        }

        @Override public void onDestroy() { items.clear(); }

        @Override public int getCount() { return items.size(); }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_log_item);
            JSONObject log = items.get(position);

            String profileName = log.optString("profileName", "—");
            String date = log.optString("date", "");
            String status = log.optString("status", "auto");
            boolean attended = log.optBoolean("attended", false);

            row.setTextViewText(R.id.item_profile_name, profileName);
            row.setTextViewText(R.id.item_date, formatDateShort(date));

            if ("absent".equals(status)) {
                row.setTextViewText(R.id.item_checkin, "In: —");
                row.setTextViewText(R.id.item_checkout, "Out: —");
                row.setTextViewText(R.id.item_duration, "—");
                row.setTextViewText(R.id.item_status, "Absent");
                row.setTextColor(R.id.item_status, 0xFFFF6B6B);
                row.setInt(R.id.item_accent, "setBackgroundColor", 0xFFFF6B6B);
            } else {
                row.setTextViewText(R.id.item_checkin, "In: " + formatTime(log.optString("checkIn", null)));
                row.setTextViewText(R.id.item_checkout,
                        "Out: " + (log.isNull("checkOut") ? "—" : formatTime(log.optString("checkOut", null))));
                row.setTextViewText(R.id.item_duration, formatDuration(log.isNull("duration") ? -1 : log.optInt("duration", -1)));

                String statusLabel = "auto".equals(status) ? "Auto" : "Manual";
                if (!attended) statusLabel = "Incomplete";
                row.setTextViewText(R.id.item_status, statusLabel);
                int accentColor = attended ? 0xFF4ADE80 : 0xFFFBBF24;
                row.setTextColor(R.id.item_status, accentColor);
                row.setInt(R.id.item_accent, "setBackgroundColor", accentColor);
            }

            return row;
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return true; }

        private String formatTime(String iso) {
            if (iso == null) return "—";
            try {
                // Logs are stored as "yyyy-MM-dd'T'HH:mm:ss+05:30"
                SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US);
                Date d = parser.parse(iso);
                SimpleDateFormat out = new SimpleDateFormat("hh:mm a", Locale.US);
                out.setTimeZone(IST);
                return d != null ? out.format(d) : "—";
            } catch (Exception e) {
                return "—";
            }
        }

        private String formatDuration(int minutes) {
            if (minutes < 0) return "—";
            int h = minutes / 60;
            int m = minutes % 60;
            if (h > 0) return h + "h " + m + "m";
            return m + "m";
        }

        private String formatDateShort(String isoDate) {
            try {
                SimpleDateFormat in = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
                SimpleDateFormat out = new SimpleDateFormat("EEE, dd MMM", Locale.US);
                Date d = in.parse(isoDate);
                return d != null ? out.format(d) : isoDate;
            } catch (Exception e) {
                return isoDate;
            }
        }
    }
}
