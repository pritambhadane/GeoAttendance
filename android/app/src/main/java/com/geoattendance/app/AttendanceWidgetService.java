package com.geoattendance.app;

import android.content.Intent;
import android.widget.RemoteViewsService;

/**
 * STUB — no longer used.
 *
 * The widget was rebuilt to use static RemoteViews instead of a
 * RemoteViewsService-backed ListView (see AttendanceWidgetProvider).
 * This file is kept only to avoid any stale import errors; it is not
 * declared in AndroidManifest and will be stripped by ProGuard/R8.
 */
public class AttendanceWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return null; // unused
    }
}
