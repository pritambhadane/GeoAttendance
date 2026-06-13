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
import java.util.List;
import java.util.Locale;
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

        @Override
        public void onCreate() {
            // Load data immediately — on MIUI/Xiaomi and many OEM ROMs,
            // onDataSetChanged is NOT called automatically after onCreate on
            // first bind, leaving the factory empty → widget shows "Loading…"
            // forever. Calling it here guarantees data is ready before
            // getCount() / getViewAt() are first invoked.
            onDataSetChanged();
        }

        @Override
        public void onDataSetChanged() {
            items.clear();
            SharedPreferences prefs = context.getSharedPreferences(
                    AttendanceForegroundService.PREFS_LOGS, Context.MODE_PRIVATE);
            JSONArray logs;
            try {
                String raw = prefs.getString("logs", "[]");
                logs = new JSONArray(raw);
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

        @Override
        public void onDestroy() {
            items.clear();
        }

        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position < 0 || position >= items.size()) {
                return getLoadingView();
            }

            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_log_item);
            JSONObject log = items.get(position);

            String profileName = log.optString("profileName", "—");
            String date        = log.optString("date", "");
            String status      = log.optString("status", "auto");
            boolean attended   = log.optBoolean("attended", false);

            row.setTextViewText(R.id.item_profile_name, profileName);
            row.setTextViewText(R.id.item_date, formatDateShort(date));

            if ("absent".equals(status)) {
                row.setTextViewText(R.id.item_checkin,  "In: —");
                row.setTextViewText(R.id.item_checkout, "Out: —");
                row.setTextViewText(R.id.item_duration, "—");
                row.setTextViewText(R.id.item_status,   "Absent");
                row.setTextColor(R.id.item_status, 0xFFFF6B6B);
                row.setInt(R.id.item_accent, "setBackgroundColor", 0xFFFF6B6B);
            } else {
                row.setTextViewText(R.id.item_checkin,
                        "In: " + formatTime(log.optString("checkIn", null)));
                row.setTextViewText(R.id.item_checkout,
                        "Out: " + (log.isNull("checkOut") ? "—" : formatTime(log.optString("checkOut", null))));
                row.setTextViewText(R.id.item_duration,
                        formatDuration(log.isNull("duration") ? -1 : log.optInt("duration", -1)));

                String statusLabel = "auto".equals(status) ? "Auto" : "Manual";
                if (!attended) statusLabel = "Incomplete";
                row.setTextViewText(R.id.item_status, statusLabel);
                int accentColor = attended ? 0xFF4ADE80 : 0xFFFBBF24;
                row.setTextColor(R.id.item_status, accentColor);
                row.setInt(R.id.item_accent, "setBackgroundColor", accentColor);
            }

            return row;
        }

        /**
         * CRITICAL FIX: returning null here causes Android 12+ to display
         * its own indefinite spinner while the factory loads, making the
         * widget look permanently stuck on "Loading…".
         *
         * Return a minimal RemoteViews so the framework has something to
         * show immediately; it will be replaced row-by-row as getViewAt()
         * completes.
         */
        @Override
        public RemoteViews getLoadingView() {
            RemoteViews loading = new RemoteViews(context.getPackageName(), R.layout.widget_log_item);
            loading.setTextViewText(R.id.item_profile_name, "Loading…");
            loading.setTextViewText(R.id.item_date,     "");
            loading.setTextViewText(R.id.item_checkin,  "");
            loading.setTextViewText(R.id.item_checkout, "");
            loading.setTextViewText(R.id.item_duration, "");
            loading.setTextViewText(R.id.item_status,   "");
            return loading;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        /**
         * FIX: hasStableIds must be consistent with getItemId.
         * Returning true + position-based IDs is fine here because the list
         * is rebuilt from scratch on every onDataSetChanged and positions are
         * deterministic within a single load. This avoids unnecessary full
         * redraws caused by the mismatch that was present before.
         */
        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }

        // ── Formatters ────────────────────────────────────────────────────

        private String formatTime(String iso) {
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

        private String formatDuration(int minutes) {
            if (minutes < 0) return "—";
            int h = minutes / 60;
            int m = minutes % 60;
            return h > 0 ? h + "h " + m + "m" : m + "m";
        }

        private String formatDateShort(String isoDate) {
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
    }
}
