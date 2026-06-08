import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.geoattendance.app',
  appName: 'GeoAttendance',
  webDir: 'dist',
  plugins: {
    // Geolocation: run in background on Android
    Geolocation: {
      // Ask for background location (needed for auto check-in/out when screen is off)
      // The AndroidManifest.xml permissions below unlock this
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_notify',
      iconColor: '#10b981',
      sound: 'beep.wav',
    },
  },
  android: {
    // Allow the WebView to access the internet (for Supabase)
    allowMixedContent: false,
    // Use hardware back button to navigate
    hardwareBackButton: true,
    // Capture precise location
    useLegacyBridge: false,
  },
};

export default config;
