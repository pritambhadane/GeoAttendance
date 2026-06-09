package com.geoattendance.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register our native attendance plugin
        // (BackgroundGeolocation plugin REMOVED — replaced by AttendanceForegroundService)
        registerPlugin(AttendancePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
