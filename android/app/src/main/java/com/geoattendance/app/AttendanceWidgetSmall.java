package com.geoattendance.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;

public class AttendanceWidgetSmall extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) AttendanceWidgetProvider.updateWidget(ctx, mgr, id, "small");
    }
}
