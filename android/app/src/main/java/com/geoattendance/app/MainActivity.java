package com.geoattendance.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.equimaps.capacitor_background_geolocation.BackgroundGeolocation;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundGeolocation.class);
        super.onCreate(savedInstanceState);
    }
}
