package com.geoattendance.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * BootReceiver — restarts AttendanceForegroundService after the phone reboots.
 *
 * Requires in AndroidManifest.xml:
 *   <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
 *   <receiver android:name=".BootReceiver" android:exported="true">
 *       <intent-filter>
 *           <action android:name="android.intent.action.BOOT_COMPLETED"/>
 *       </intent-filter>
 *   </receiver>
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Log.i(TAG, "Boot completed — restarting AttendanceForegroundService");
            Intent serviceIntent = new Intent(context, AttendanceForegroundService.class);
            serviceIntent.setAction("START");
            // Flag so the service knows this is a cold boot start, not a user/JS start.
            // The service uses this to:
            //   1. Delay the catch-up GPS scan longer (GPS needs ~60s cold-fix after reboot)
            //   2. Warn via notification if profiles are missing from SharedPreferences
            serviceIntent.putExtra(AttendanceForegroundService.EXTRA_IS_BOOT, true);
            ContextCompat.startForegroundService(context, serviceIntent);
        }
    }
}
