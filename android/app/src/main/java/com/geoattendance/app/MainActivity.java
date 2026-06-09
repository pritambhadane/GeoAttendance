package com.geoattendance.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.equimapper.capacitor.plugin.backgroundgeolocation.BackgroundGeolocationPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundGeolocationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}