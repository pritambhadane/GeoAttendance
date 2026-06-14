package com.geoattendance.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;

/** 4×2 home-screen widget. Delegates all logic to AttendanceWidgetProvider. */
public class AttendanceWidgetMedium extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) AttendanceWidgetProvider.updateWidget(ctx, mgr, id);
    }
}
