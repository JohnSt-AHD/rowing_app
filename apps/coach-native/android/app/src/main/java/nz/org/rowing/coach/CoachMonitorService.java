package nz.org.rowing.coach;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.content.pm.ServiceInfo;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Polls fleet API, raises capsize alerts, and can upload coach GPS while monitoring is on. */
public class CoachMonitorService extends Service {

    public static final String PREFS = "coach_monitor";
    public static final String ACTION_STOP = "nz.org.rowing.coach.STOP_MONITORING";

    private static final String TAG = "CoachMonitor";
    private static final String CHANNEL_FG = "coach_monitor_fg";
    private static final String CHANNEL_ALERT = "coach_monitor_alert";
    private static final int NOTIF_ID_FG = 9201;
    private static final int NOTIF_ID_ALERT = 9202;
    private static final long DEFAULT_POLL_MS = 3000L;
    private static final long DEFAULT_LOCATION_MS = 20_000L;
    private static final long CAPSIZE_REPEAT_MS = 45_000L;

    private static WeakReference<CoachMonitorService> runningInstance;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ExecutorService pollExecutor;
    private volatile boolean pollInFlight;
    private volatile boolean locationUploadInFlight;
    private long lastCapsizeAlertMs;
    private String lastAlertKey = "";
    private LocationManager locationManager;
    private LocationListener locationListener;
    private volatile Location lastLocation;
    private long lastLocationUploadMs;

    private final Runnable pollRunnable =
            new Runnable() {
                @Override
                public void run() {
                    if (!isMonitoringActive(CoachMonitorService.this)) {
                        return;
                    }
                    scheduleNextPoll();
                    if (pollInFlight) return;
                    pollInFlight = true;
                    pollExecutor.execute(
                            () -> {
                                try {
                                    pollFleetOnce();
                                    uploadCoachLocationIfDue(false);
                                } finally {
                                    pollInFlight = false;
                                }
                            });
                }
            };

    public static boolean isServiceRunning() {
        CoachMonitorService inst = runningInstance != null ? runningInstance.get() : null;
        return inst != null;
    }

    public static boolean isMonitoringActive(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean("monitoringActive", false);
    }

    public static void clearMonitoring(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean("monitoringActive", false)
                .apply();
        cancelAlertNotification(ctx);
    }

    private static void cancelAlertNotification(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTIF_ID_ALERT);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        runningInstance = new WeakReference<>(this);
        pollExecutor = Executors.newSingleThreadExecutor();
        createNotificationChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopMonitoringInternal();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            saveConfigFromIntent(intent);
        }
        if (!isMonitoringActive(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForegroundWithTypes();
        lastCapsizeAlertMs = 0L;
        lastAlertKey = "";
        startLocationUpdates();
        scheduleNextPoll();
        Log.i(TAG, "Coach monitoring started");
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopLocationUpdates();
        if (runningInstance != null && runningInstance.get() == this) {
            runningInstance.clear();
        }
        mainHandler.removeCallbacks(pollRunnable);
        if (pollExecutor != null) {
            pollExecutor.shutdownNow();
        }
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (isMonitoringActive(getApplicationContext())) {
            Intent restart = new Intent(this, CoachMonitorService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(restart);
            } else {
                startService(restart);
            }
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void saveConfigFromIntent(Intent intent) {
        String apiBaseUrl = intent.getStringExtra("apiBaseUrl");
        String ingestToken = intent.getStringExtra("ingestToken");
        String coachName = intent.getStringExtra("coachName");
        String sessionId = intent.getStringExtra("sessionId");
        SharedPreferences.Editor ed = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        ed.putBoolean("monitoringActive", true);
        ed.putString("apiBaseUrl", apiBaseUrl != null ? apiBaseUrl : "");
        ed.putString("ingestToken", ingestToken != null ? ingestToken : "");
        ed.putLong(
                "pollIntervalMs",
                Math.max(2000L, intent.getLongExtra("pollIntervalMs", DEFAULT_POLL_MS)));
        ed.putBoolean("shareLocation", intent.getBooleanExtra("shareLocation", false));
        ed.putString("coachName", coachName != null ? coachName.trim() : "");
        ed.putLong(
                "locationIntervalMs",
                Math.max(5_000L, intent.getLongExtra("locationIntervalMs", DEFAULT_LOCATION_MS)));
        if (sessionId != null && !sessionId.trim().isEmpty()) {
            ed.putString("sessionId", sessionId.trim());
        }
        ed.apply();
    }

    private long pollIntervalMs() {
        return Math.max(
                2000L,
                getSharedPreferences(PREFS, MODE_PRIVATE).getLong("pollIntervalMs", DEFAULT_POLL_MS));
    }

    private long locationIntervalMs() {
        return Math.max(
                5_000L,
                getSharedPreferences(PREFS, MODE_PRIVATE)
                        .getLong("locationIntervalMs", DEFAULT_LOCATION_MS));
    }

    private boolean shareLocationEnabled() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        return p.getBoolean("shareLocation", false)
                && !TextUtils.isEmpty(p.getString("coachName", ""));
    }

    private boolean hasFineLocation() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void scheduleNextPoll() {
        mainHandler.removeCallbacks(pollRunnable);
        mainHandler.postDelayed(pollRunnable, pollIntervalMs());
    }

    private void stopMonitoringInternal() {
        Log.i(TAG, "Coach monitoring stopped by user");
        clearMonitoring(this);
        stopLocationUpdates();
        mainHandler.removeCallbacks(pollRunnable);
        stopForeground(true);
        stopSelf();
    }

    private void startLocationUpdates() {
        stopLocationUpdates();
        if (!shareLocationEnabled() || !hasFineLocation()) return;
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (locationManager == null) return;
        locationListener =
                new LocationListener() {
                    @Override
                    public void onLocationChanged(Location location) {
                        lastLocation = location;
                        if (pollExecutor != null && !pollExecutor.isShutdown()) {
                            pollExecutor.execute(() -> uploadCoachLocationIfDue(true));
                        }
                    }

                    @Override
                    public void onStatusChanged(String provider, int status, android.os.Bundle extras) {}

                    @Override
                    public void onProviderEnabled(String provider) {}

                    @Override
                    public void onProviderDisabled(String provider) {}
                };
        long interval = locationIntervalMs();
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.GPS_PROVIDER, interval, 4f, locationListener, Looper.getMainLooper());
            }
        } catch (SecurityException e) {
            Log.w(TAG, "GPS updates denied: " + e.getMessage());
        }
        try {
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.NETWORK_PROVIDER,
                        interval,
                        8f,
                        locationListener,
                        Looper.getMainLooper());
            }
        } catch (SecurityException e) {
            Log.w(TAG, "Network location denied: " + e.getMessage());
        }
        try {
            Location gps = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            Location net = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (gps != null) lastLocation = gps;
            else if (net != null) lastLocation = net;
        } catch (SecurityException ignored) {
            /* already checked */
        }
        if (lastLocation != null && pollExecutor != null && !pollExecutor.isShutdown()) {
            pollExecutor.execute(() -> uploadCoachLocationIfDue(true));
        }
    }

    private void stopLocationUpdates() {
        if (locationManager != null && locationListener != null) {
            try {
                locationManager.removeUpdates(locationListener);
            } catch (Exception ignored) {
                /* already gone */
            }
        }
        locationListener = null;
        locationManager = null;
    }

    private void uploadCoachLocationIfDue(boolean forceIfFresh) {
        if (!isMonitoringActive(this) || !shareLocationEnabled()) return;
        Location loc = lastLocation;
        if (loc == null) return;
        long now = System.currentTimeMillis();
        long due = locationIntervalMs();
        if (!forceIfFresh && now - lastLocationUploadMs < due) return;
        if (forceIfFresh && now - lastLocationUploadMs < Math.min(due, 8_000L)) return;
        if (locationUploadInFlight) return;
        locationUploadInFlight = true;
        try {
            uploadCoachLocation(loc, now);
            lastLocationUploadMs = now;
        } catch (Exception e) {
            Log.w(TAG, "Coach location upload failed: " + e.getMessage());
        } finally {
            locationUploadInFlight = false;
        }
    }

    private void uploadCoachLocation(Location loc, long now) throws Exception {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String base = p.getString("apiBaseUrl", "");
        if (base == null || base.isEmpty()) return;
        String coachName = String.valueOf(p.getString("coachName", "")).trim();
        String deviceId = "Coach " + coachName;
        String sessionId = p.getString("sessionId", "");
        if (sessionId == null || sessionId.trim().isEmpty()) {
            sessionId = UUID.randomUUID().toString();
            p.edit().putString("sessionId", sessionId).apply();
        }
        JSONObject gps = new JSONObject();
        gps.put("lat", loc.getLatitude());
        gps.put("lon", loc.getLongitude());
        if (loc.hasAccuracy()) gps.put("acc", loc.getAccuracy());
        if (loc.hasBearing()) gps.put("hdg", loc.getBearing());
        gps.put("fixMs", loc.getTime() > 0 ? loc.getTime() : now);
        gps.put("sampleSource", "manager_watch");
        JSONObject derived = new JSONObject();
        derived.put("heartbeat", true);
        JSONObject sample = new JSONObject();
        sample.put("t", now);
        sample.put("gps", gps);
        sample.put("derived", derived);
        JSONArray samples = new JSONArray();
        samples.put(sample);
        JSONObject body = new JSONObject();
        body.put("sessionId", sessionId);
        body.put("deviceId", deviceId);
        body.put("athleteId", coachName);
        body.put("boatClass", "Coach");
        body.put("source", "manager");
        body.put("samples", samples);
        postJson(base.replaceAll("/$", "") + "/api/ingest", p.getString("ingestToken", ""), body.toString());
    }

    private static void postJson(String urlStr, String token, String json) throws Exception {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Content-Type", "application/json");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            byte[] raw = json.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(raw.length);
            OutputStream out = conn.getOutputStream();
            out.write(raw);
            out.flush();
            int code = conn.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
            if (stream != null) readUtf8(stream);
            if (code < 200 || code >= 300) {
                throw new IllegalStateException("Ingest " + code);
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void pollFleetOnce() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String base = p.getString("apiBaseUrl", "");
        if (base == null || base.isEmpty()) return;
        String urlStr =
                base.replaceAll("/$", "")
                        + "/api/devices?windowSec=60&onlineSec=120";
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            String token = p.getString("ingestToken", "");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            int code = conn.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
            if (stream == null) return;
            String body = readUtf8(stream);
            List<String> capsized = parseCapsizedDevices(body);
            mainHandler.post(() -> handleCapsizeDevices(capsized));
        } catch (Exception e) {
            Log.w(TAG, "Fleet poll failed: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readUtf8(InputStream stream) throws java.io.IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while ((n = stream.read(chunk)) != -1) {
            buf.write(chunk, 0, n);
        }
        return buf.toString(StandardCharsets.UTF_8.name());
    }

    private static List<String> parseCapsizedDevices(String jsonBody) {
        List<String> out = new ArrayList<>();
        try {
            JSONObject root = new JSONObject(jsonBody);
            JSONArray devices = root.optJSONArray("devices");
            if (devices == null) return out;
            for (int i = 0; i < devices.length(); i++) {
                JSONObject d = devices.getJSONObject(i);
                JSONObject rowing = d.optJSONObject("rowing");
                if (rowing != null && rowing.optBoolean("capsize", false)) {
                    out.add(d.optString("deviceId", "unknown"));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Parse devices failed: " + e.getMessage());
        }
        Collections.sort(out);
        return out;
    }

    private void handleCapsizeDevices(List<String> capsized) {
        if (!isMonitoringActive(this)) return;
        updateForegroundNotification(capsized.size());
        if (capsized.isEmpty()) {
            lastAlertKey = "";
            return;
        }
        String key = TextUtils.join(",", capsized);
        long now = System.currentTimeMillis();
        boolean changed = !key.equals(lastAlertKey);
        boolean repeat = now - lastCapsizeAlertMs >= CAPSIZE_REPEAT_MS;
        if (changed || repeat) {
            lastAlertKey = key;
            lastCapsizeAlertMs = now;
            showCapsizeAlert(capsized);
        }
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel fg =
                new NotificationChannel(
                        CHANNEL_FG, "Fleet monitoring", NotificationManager.IMPORTANCE_LOW);
        NotificationChannel alert =
                new NotificationChannel(
                        CHANNEL_ALERT, "Capsize alerts", NotificationManager.IMPORTANCE_HIGH);
        alert.enableVibration(true);
        nm.createNotificationChannel(fg);
        nm.createNotificationChannel(alert);
    }

    private void startForegroundWithTypes() {
        Notification notification = buildForegroundNotification(0);
        int types = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            types = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            if (shareLocationEnabled() && hasFineLocation()) {
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            }
            startForeground(NOTIF_ID_FG, notification, types);
        } else {
            startForeground(NOTIF_ID_FG, notification);
        }
    }

    private void updateForegroundNotification(int capsizeCount) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.notify(NOTIF_ID_FG, buildForegroundNotification(capsizeCount));
    }

    private Notification buildForegroundNotification(int capsizeCount) {
        Intent launch = new Intent(this, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi =
                PendingIntent.getActivity(
                        this,
                        0,
                        launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, CoachMonitorService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopPi =
                PendingIntent.getService(
                        this,
                        1,
                        stop,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String detail;
        if (capsizeCount > 0) {
            detail = capsizeCount + " CAPSIZE — tap to open";
        } else if (shareLocationEnabled()) {
            detail = "Watching fleet · sharing coach location";
        } else {
            detail = "Watching fleet — tap Stop to turn off";
        }
        return new NotificationCompat.Builder(this, CHANNEL_FG)
                .setContentTitle("CrewSight Manager")
                .setContentText(detail)
                .setSmallIcon(R.drawable.ic_stat_rowing_shell)
                .setContentIntent(openPi)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .addAction(0, "Stop monitoring", stopPi)
                .build();
    }

    private void showCapsizeAlert(List<String> deviceIds) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Intent launch = new Intent(this, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi =
                PendingIntent.getActivity(
                        this,
                        2,
                        launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String body =
                deviceIds.size() == 1
                        ? "Boat " + deviceIds.get(0) + " — check crew immediately"
                        : deviceIds.size() + " boats capsized — check crew immediately";
        Notification n =
                new NotificationCompat.Builder(this, CHANNEL_ALERT)
                        .setContentTitle("CAPSIZE ALERT")
                        .setContentText(body)
                        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                        .setSmallIcon(R.drawable.ic_stat_rnz_alert)
                        .setContentIntent(pi)
                        .setPriority(NotificationCompat.PRIORITY_MAX)
                        .setCategory(NotificationCompat.CATEGORY_ALARM)
                        .setAutoCancel(true)
                        .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
                        .build();
        nm.notify(NOTIF_ID_ALERT, n);
    }
}
