package nz.org.rowing.recorder;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.pm.ServiceInfo;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Native session recorder — GPS + capsize run outside the WebView with a foreground service.
 */
public class CapsizeMonitorService extends Service implements SensorEventListener, LocationListener {

    private static final String TAG = "SessionRecorder";
    public static final String PREFS = "rnz_capsize_monitor";
    /** Collect fixes every 500ms; report interval follows user setting (KRI window model). */
    private static final long GPS_COLLECT_INTERVAL_MS = 500L;
    private static final float GPS_WEIGHT_MIN_ACC_M = 5f;
    private static final int GPS_WINDOW_MAX = 120;
    /** Fused/legacy minimum update interval while tracking. */
    private static final long FUSED_MIN_UPDATE_MS = 500L;
    private static WeakReference<CapsizeMonitorService> runningInstance;
    private static final String CHANNEL_ID = "rnz_capsize_native";
    private static final int NOTIF_ID_FOREGROUND = 9101;
    private static final int NOTIF_ID_ALERT = 9102;
    private static final int NOTIF_ID_BOOT_RESUME = 9103;
    private static final int NOTIF_ID_CREW_MESSAGE = 9105;
    private static final int NOTIF_ID_ZONE_WARNING = 9106;
    private static final int BOOT_RESUME_ALARM_REQUEST = 9104;
    private static final String BOOT_RETRY_COUNT_KEY = "bootRetryCount";
    private static final int MAX_BOOT_RESUME_RETRIES = 20;
    /** Keep trying after fast retries exhaust — user may unlock phone later. */
    private static final long BOOT_RESUME_PERSISTENT_INTERVAL_MS = 15L * 60L * 1000L;
    private static final float GRAVITY_ALPHA = 0.04f;
    private static final float STILL_VAR_MAX = 0.35f;
    private static final int CALIBRATE_MIN_SAMPLES = 8;
    private static final long CALIBRATE_WINDOW_MS = 2500L;
    private static final long CAPSIZE_HOLD_MS = 1200L;
    /** cos(~99°) — past horizontal; ignores brief vibration spikes. */
    private static final float CAPSIZE_TIP_DOT = -0.15f;
    private static final long CAPSIZE_UPLOAD_MIN_INTERVAL_MS = 4000L;
    /** Batched ingest — fewer HTTP posts while GPS still samples at gpsIntervalMs. */
    private static final long UPLOAD_FLUSH_INTERVAL_MS = 3_000L;
    private static final int UPLOAD_FLUSH_MAX_SAMPLES = 12;
    /** Keeps dashboard "online" when GPS fixes pause (independent of gpsIntervalMs). */
    private static final long HEARTBEAT_INTERVAL_MS = 10_000L;
    /** Battery % on ingest — every 10 min (session start always includes a reading). */
    private static final long BATTERY_REPORT_INTERVAL_MS = 10L * 60L * 1000L;
    /** Stroke rate from WebView or native motion — attach to GPS uploads when fresh. */
    private static final long STROKE_RATE_MAX_AGE_MS = 20_000L;
    private static final float STROKE_RATE_MIN = 15f;
    private static final float STROKE_RATE_MAX = 50f;
    private static final int STROKE_BUF_CAP = 256;
    private static final long STROKE_BUF_MS = 8000L;
    private static final long STROKE_COMPUTE_MIN_MS = 500L;
    private static final int STROKE_HP_WINDOW_MS = 450;
    private static final int MAX_PENDING_BATCHES = 60;
    private static final int MAX_PENDING_FLUSH_PER_CYCLE = 8;
    private static final int MAX_PENDING_FLUSH_ON_GPS = 2;
    private static final long PENDING_FLUSH_INTERVAL_MS = 45_000L;
    /** Reject stale satellite fix clock for callback-driven uploads. */
    private static final long GPS_MAX_UPLOAD_FIX_AGE_MS = 45_000L;
    /** Timer may repeat last good coords up to this age (indoor / stationary, Traccar-like). */
    private static final long GPS_MAX_SCHEDULED_CACHE_AGE_MS = 30L * 60L * 1000L;
    /** Use wall clock when Android fix time lags more than this (KRI model). */
    private static final long GPS_STALE_FIX_CLOCK_MS = 8_000L;
    /** Fused may deliver slightly aged fixes to refresh cache while stationary. */
    private static final long FUSED_MAX_UPDATE_AGE_MS = 5L * 60L * 1000L;
    /** Ignore duplicate coords within this window (repeat fused callbacks). */
    private static final long GPS_COORD_DEDUPE_MS = 500L;
    private static final String PENDING_BATCHES_KEY = "pendingIngestBatches";
    private static final String HEARTBEAT_GPS_COUNT_KEY = "heartbeatGpsCount";
    private static final String PULSE_LAST_GPS_UPLOAD_WALL_MS = "pulseLastGpsUploadWallMs";
    private static final String PULSE_LAST_GPS_OFFERED_WALL_MS = "pulseLastGpsOfferedWallMs";
    private static final String PULSE_LAST_FUSED_DELIVERY_WALL_MS = "pulseLastFusedDeliveryWallMs";
    private static final String PULSE_LATEST_GPS_CACHED_WALL_MS = "pulseLatestGpsCachedWallMs";
    private static final String PULSE_INGEST_BUFFER_COUNT = "pulseIngestBufferCount";
    /** Low-rate GPS while geofence standby is armed (matches web standby). */
    private static final long STANDBY_GPS_INTERVAL_MS = 5000L;
    /** Ignore stale fixes for standby dwell (matches geofence-standby.ts). */
    private static final long STANDBY_MAX_FIX_AGE_MS = 20_000L;
    private static final long STANDBY_DWELL_TICK_MS = 1000L;

    private boolean standbyMode;
    private long standbyOutsideSinceMs;
    private long standbyLastFreshFixMs;
    private String standbyInsideZoneName = "";
    private boolean standbyAutoStartTriggered;
    private final Runnable standbyDwellRunnable =
            () -> {
                if (!standbyMode || standbyAutoStartTriggered) return;
                tryStandbyAutoStart();
                scheduleStandbyDwellTick();
            };

    private SensorManager sensorManager;
    private Sensor accelerometer;
    private Sensor rotationVector;
    private Sensor magnetometer;
    private boolean compassAvailable;
    private float compassHeadingDeg = Float.NaN;
    private final float[] rotationMatrix = new float[9];
    private final float[] orientationAngles = new float[3];
    private final float[] magnetData = new float[3];
    private boolean magnetDataReady;
    private LocationManager locationManager;
    private FusedLocationProviderClient fusedClient;
    private LocationCallback fusedCallback;
    private PowerManager.WakeLock wakeLock;
    private ExecutorService uploadExecutor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private boolean enableGps;
    private boolean enableMotion = true;
    private long gpsIntervalMs = 1000L;
    private boolean economyActive = false;
    private boolean suppressRecordingActive = false;
    private long economyGpsIntervalMs = 30_000L;
    private long economyUploadIntervalMs = 30_000L;
    private boolean enableCapsizeDetection = true;

    private float gx;
    private float gy;
    private float gz = 9.81f;
    private float uprightX;
    private float uprightY = 0f;
    private float uprightZ = 1f;
    private boolean calibrated;
    private boolean capsizeActive;
    private long capsizeSinceMs;
    private long lastCapsizeUploadMs;
    private long lastBatteryReportMs;
    private long lastGpsUploadWallMs;
    /** When a GPS sample was last added to the ingest buffer (not timer intent). */
    private long lastGpsSampleOfferedMs;
    private long lastUploadedFixTimeMs;
    private long lastUploadedGpsBucket = -1L;
    /** Rate-limit stale-GPS fallback when timer stalls but ingest flush continues. */
    private long lastStaleGpsPiggybackWallMs;
    private double lastUploadedLat = Double.NaN;
    private double lastUploadedLon = Double.NaN;
    private Location latestGpsLocation;
    private long latestGpsCachedWallMs;
    /** Raw Android fix clock from last fused/legacy delivery (debug: gps.fixMs). */
    private long latestGpsRawFixClockMs;
    /** Underlying fused/gps/network provider from last real delivery. */
    private String latestGpsProvider;
    /** Last fused/legacy callback — detect when Android stops delivering fixes. */
    private long lastFusedDeliveryWallMs;
    private final ArrayList<GpsWindowFix> gpsWindowBuffer = new ArrayList<>();
    private long lastWindowCollectWallMs;
    private int nativeGpsCount;
    private int sampleCount;
    private float lastAx;
    private float lastAy;
    private float lastAz;
    private final float[] recentAx = new float[64];
    private final float[] recentAy = new float[64];
    private final float[] recentAz = new float[64];
    private final long[] recentT = new long[64];
    private int recentCount;
    private final long[] strokeT = new long[STROKE_BUF_CAP];
    private final float[] strokeAx = new float[STROKE_BUF_CAP];
    private final float[] strokeAy = new float[STROKE_BUF_CAP];
    private final float[] strokeAz = new float[STROKE_BUF_CAP];
    private int strokeCount;
    private long lastStrokeComputeMs;
    private JSONArray ingestBuffer = new JSONArray();
    private long lastIngestFlushMs;
    private long lastSuccessfulUploadMs;
    private final Runnable ingestFlushRunnable =
            () -> {
                if (uploadExecutor == null || uploadExecutor.isShutdown()) return;
                uploadExecutor.execute(
                        () -> {
                            maybeRefreshStaleGpsUpload();
                            maybeAutoFlushIngest(false);
                            mainHandler.post(CapsizeMonitorService.this::scheduleIngestFlush);
                        });
            };
    private final Runnable heartbeatRunnable =
            () -> {
                if (uploadExecutor == null || uploadExecutor.isShutdown()) return;
                uploadExecutor.execute(
                        () -> {
                            enqueueHeartbeatSample(System.currentTimeMillis());
                            CrewMessageHelper.pollMessages(getApplicationContext());
                        });
                scheduleHeartbeat();
            };
    private final Runnable pendingFlushRunnable =
            () -> {
                if (uploadExecutor == null || uploadExecutor.isShutdown()) return;
                uploadExecutor.execute(
                        () -> {
                            flushPendingIngest(
                                    getSharedPreferences(PREFS, MODE_PRIVATE),
                                    MAX_PENDING_FLUSH_PER_CYCLE);
                            mainHandler.post(CapsizeMonitorService.this::schedulePendingFlush);
                        });
            };
    private final Runnable gpsFlushRunnable =
            () -> {
                tickScheduledGpsUpload();
                scheduleGpsFlush();
            };

    private static final class GpsWindowFix {
        final double lat;
        final double lon;
        final float acc;
        final float spd;
        final float hdg;
        final float alt;
        final long t;

        GpsWindowFix(Location loc, long ingestT) {
            lat = loc.getLatitude();
            lon = loc.getLongitude();
            acc = loc.hasAccuracy() ? loc.getAccuracy() : 25f;
            spd = loc.hasSpeed() && loc.getSpeed() >= 0f ? loc.getSpeed() : -1f;
            hdg = loc.hasBearing() && loc.getBearing() >= 0f ? loc.getBearing() : -1f;
            alt = loc.hasAltitude() ? (float) loc.getAltitude() : Float.NaN;
            t = ingestT;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        runningInstance = new WeakReference<>(this);
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            rotationVector = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            magnetometer = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
            compassAvailable = rotationVector != null || magnetometer != null;
        }
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        fusedClient = LocationServices.getFusedLocationProviderClient(this);
        uploadExecutor = Executors.newSingleThreadExecutor();
        createNotificationChannel();
        loadUprightFromPrefs();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        promoteDeviceProtectedSessionPrefs();
        boolean bootResume = intent != null && intent.getBooleanExtra("bootResume", false);
        boolean standbyResume =
                intent != null && intent.getBooleanExtra("standbyResume", false);
        if (intent != null && !bootResume && !standbyResume) {
            saveConfigFromIntent(intent);
            lastNativeGeofenceSignature = "";
        }
        loadSessionFlagsFromPrefs();
        loadStandbyFlagsFromPrefs();
        loadUprightFromPrefs();

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean hasSession = hasActiveSessionPrefs(prefs) || hasStandbyPrefs(prefs);
        if (!hasSession) {
            Log.w(TAG, "Service started with no active session — stopping");
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean recordingActive = prefs.getBoolean("recordingActive", false);
        if (standbyMode && !recordingActive) {
            return startStandbyCommand(bootResume || standbyResume);
        }

        ingestBuffer = new JSONArray();
        lastIngestFlushMs = 0L;
        lastSuccessfulUploadMs = 0L;
        lastBatteryReportMs = 0L;
        lastGpsUploadWallMs = 0L;
        lastGpsSampleOfferedMs = 0L;
        latestGpsRawFixClockMs = 0L;
        lastUploadedFixTimeMs = 0L;
        lastUploadedGpsBucket = -1L;
        lastStaleGpsPiggybackWallMs = 0L;
        gpsWindowBuffer.clear();
        lastWindowCollectWallMs = 0L;
        if (!startForegroundWithTypes()) {
            return START_NOT_STICKY;
        }
        clearBootResumeNotification();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt(BOOT_RETRY_COUNT_KEY, 0).apply();
        mirrorSessionPrefsToDeviceProtected(getApplicationContext());
        acquireWakeLock();
        if (enableMotion || (enableGps && compassAvailable)) {
            registerSensors();
        }
        if (enableGps) {
            restoreCachedGpsIfNeeded();
            lastFusedDeliveryWallMs = System.currentTimeMillis();
            registerLocation();
            scheduleGpsFlush();
            tickScheduledGpsUpload();
            Location geofenceLoc = latestGpsLocation;
            if (geofenceLoc != null) {
                maybeApplyGeofenceEconomy(
                        geofenceLoc.getLatitude(), geofenceLoc.getLongitude());
            }
        }
        schedulePendingFlush();
        scheduleIngestFlush();
        uploadExecutor.execute(() -> enqueueSessionStartSample(System.currentTimeMillis()));
        scheduleHeartbeat();
        Log.i(
            TAG,
            (bootResume ? "Boot-resumed " : "")
                + "Native session service started gps="
                + enableGps
                + " motion="
                + enableMotion
                + " intervalMs="
                + gpsIntervalMs
                + " heartbeatMs="
                + HEARTBEAT_INTERVAL_MS
                + " compass="
                + compassAvailable);
        return START_STICKY;
    }

    private int startStandbyCommand(boolean resumed) {
        if (!startForegroundWithTypes()) {
            return START_NOT_STICKY;
        }
        clearBootResumeNotification();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt(BOOT_RETRY_COUNT_KEY, 0).apply();
        mirrorSessionPrefsToDeviceProtected(getApplicationContext());
        acquireWakeLock();
        enableGps = true;
        enableMotion = false;
        economyActive = false;
        suppressRecordingActive = false;
        standbyAutoStartTriggered = false;
        if (enableGps) {
            restoreCachedGpsIfNeeded();
            lastFusedDeliveryWallMs = System.currentTimeMillis();
            registerLocation();
            Location loc = latestGpsLocation;
            if (loc != null) {
                handleStandbyLocation(loc);
            }
        }
        scheduleStandbyDwellTick();
        Log.i(
                TAG,
                (resumed ? "Boot-resumed " : "")
                        + "Native geofence standby armed gpsIntervalMs="
                        + STANDBY_GPS_INTERVAL_MS);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        mainHandler.removeCallbacks(standbyDwellRunnable);
        if (runningInstance != null && runningInstance.get() == this) {
            runningInstance.clear();
        }
        mainHandler.removeCallbacks(ingestFlushRunnable);
        mainHandler.removeCallbacks(heartbeatRunnable);
        mainHandler.removeCallbacks(pendingFlushRunnable);
        mainHandler.removeCallbacks(gpsFlushRunnable);
        unregisterSensor();
        unregisterLocation();
        releaseWakeLock();
        if (uploadExecutor != null) {
            uploadExecutor.execute(this::flushIngestBufferNow);
            uploadExecutor.shutdown();
            try {
                uploadExecutor.awaitTermination(3, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        Context app = getApplicationContext();
        if (shouldResumeAfterBoot(app)) {
            Log.i(TAG, "Service stopped with active session/standby — scheduling resume");
            mirrorSessionPrefsToDeviceProtected(app);
            scheduleBootResumeRetry(app);
        }
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Context app = getApplicationContext();
        if (shouldResumeAfterBoot(app)) {
            Log.i(TAG, "Task removed with active session/standby — requesting resume");
            mirrorSessionPrefsToDeviceProtected(app);
            if (!tryStartBootService(app)) {
                scheduleBootResumeRetry(app);
            }
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        int type = event.sensor.getType();
        if (type == Sensor.TYPE_ROTATION_VECTOR) {
            updateCompassFromRotationVector(event.values);
            return;
        }
        if (type == Sensor.TYPE_MAGNETIC_FIELD) {
            magnetData[0] = event.values[0];
            magnetData[1] = event.values[1];
            magnetData[2] = event.values[2];
            magnetDataReady = true;
            updateCompassFromAccelMag();
            return;
        }
        if (type != Sensor.TYPE_ACCELEROMETER) return;
        float ax = event.values[0];
        float ay = event.values[1];
        float az = event.values[2];
        long t = System.currentTimeMillis();
        lastAx = ax;
        lastAy = ay;
        lastAz = az;

        gx = GRAVITY_ALPHA * ax + (1f - GRAVITY_ALPHA) * gx;
        gy = GRAVITY_ALPHA * ay + (1f - GRAVITY_ALPHA) * gy;
        gz = GRAVITY_ALPHA * az + (1f - GRAVITY_ALPHA) * gz;
        sampleCount++;

        if (enableMotion) {
            pushRecent(t, ax, ay, az);
            pushStrokeSample(t, ax, ay, az);
            tryCalibrate(t);
            loadUprightFromPrefs();
            updateCapsize(t);
            updateNativeStrokeRate(t);
        }
        if (compassAvailable && rotationVector == null && magnetometer != null) {
            updateCompassFromAccelMag();
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    public void onLocationChanged(Location location) {
        deliverLocation(location);
    }

    private void cacheGpsLocation(Location location) {
        if (!enableGps || location == null) return;
        latestGpsLocation = location;
        latestGpsCachedWallMs = System.currentTimeMillis();
        String provider = location.getProvider();
        if (provider != null
                && !provider.isEmpty()
                && !"weighted".equals(provider)
                && !"cached".equals(provider)) {
            latestGpsProvider = provider;
        }
        long rawFix = location.getTime();
        long now = System.currentTimeMillis();
        if (rawFix > 0L && rawFix <= now + 5_000L) {
            latestGpsRawFixClockMs = rawFix;
        }
        saveLastGpsToPrefs(location, ingestTimeMs(location), nativeGpsCount);
    }

    private void deliverLocation(Location location) {
        if (!enableGps || location == null) return;
        lastFusedDeliveryWallMs = System.currentTimeMillis();
        savePulseDiagnostics();
        cacheGpsLocation(location);
        if (standbyMode) {
            handleStandbyLocation(location);
            return;
        }
        addFixToGpsWindow(location);
        maybeApplyGeofenceEconomy(location.getLatitude(), location.getLongitude());
        maybeNotifyZoneEntry(location.getLatitude(), location.getLongitude());
    }

    private String lastNativeGeofenceSignature = "";
    private String lastNotifyZoneKey = "";
    private boolean notifyZoneInitialized = false;

    private void maybeApplyGeofenceEconomy(double lat, double lon) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        JSONArray geofences;
        try {
            geofences = new JSONArray(prefs.getString(GeofenceHelper.PREFS_GEOFENCES_JSON, "[]"));
        } catch (Exception e) {
            return;
        }
        if (geofences.length() == 0) return;

        JSONObject match = GeofenceHelper.findBoatParkAt(getApplicationContext(), lat, lon);
        final String signature;
        if (match != null) {
            signature =
                    match.optString("name", "")
                            + "|"
                            + GeofenceHelper.economyIntervalSec(match)
                            + "|"
                            + GeofenceHelper.disableCapsize(match)
                            + "|"
                            + GeofenceHelper.suppressRecording(match);
        } else {
            signature = "";
        }
        loadEconomyFromPrefs();
        // Signature unchanged but economy can stay stuck (e.g. outside zone with economyActive true).
        if (signature.equals(lastNativeGeofenceSignature)) {
            if ((match != null) == economyActive) return;
        }
        lastNativeGeofenceSignature = signature;
        if (match != null) {
            long intervalMs =
                    Math.max(1000L, (long) GeofenceHelper.economyIntervalSec(match) * 1000L);
            boolean suppress = GeofenceHelper.suppressRecording(match);
            setEconomyMode(
                    getApplicationContext(),
                    true,
                    intervalMs,
                    intervalMs,
                    !GeofenceHelper.disableCapsize(match),
                    suppress);
            Log.i(
                    TAG,
                    "Native geofence active: "
                            + match.optString("name", "?")
                            + " gpsUploadMs="
                            + intervalMs
                            + " suppress="
                            + suppress);
        } else {
            loadSessionFlagsFromPrefs();
            setEconomyMode(
                    getApplicationContext(),
                    false,
                    gpsIntervalMs,
                    UPLOAD_FLUSH_INTERVAL_MS,
                    true,
                    false);
            Log.i(TAG, "Native geofence cleared — user GPS interval restored");
        }
    }

    private void maybeNotifyZoneEntry(double lat, double lon) {
        JSONObject zone =
                GeofenceHelper.findNotifyZoneAt(getApplicationContext(), lat, lon);
        String key = zone != null ? GeofenceHelper.zoneNotifyKey(zone) : "";
        if (!notifyZoneInitialized) {
            lastNotifyZoneKey = key;
            notifyZoneInitialized = true;
            return;
        }
        if (key.equals(lastNotifyZoneKey)) return;
        lastNotifyZoneKey = key;
        if (zone != null && !key.isEmpty()) {
            showZoneEntryNotification(zone);
        }
    }

    private void addFixToGpsWindow(Location location) {
        if (!enableGps || location == null || !isGpsFixUsable(location)) return;
        long now = System.currentTimeMillis();
        if (now - lastWindowCollectWallMs < GPS_COLLECT_INTERVAL_MS) return;
        lastWindowCollectWallMs = now;
        if (gpsWindowBuffer.size() >= GPS_WINDOW_MAX) {
            gpsWindowBuffer.remove(0);
        }
        gpsWindowBuffer.add(new GpsWindowFix(location, ingestTimeMs(location)));
    }

    private static float fixWeight(float accM) {
        float a = Math.max(accM, GPS_WEIGHT_MIN_ACC_M);
        return 1f / (a * a);
    }

    private Location windowFixToLocation(GpsWindowFix f) {
        Location loc = new Location("weighted");
        loc.setLatitude(f.lat);
        loc.setLongitude(f.lon);
        loc.setAccuracy(f.acc);
        loc.setTime(f.t);
        if (f.spd >= 0f) loc.setSpeed(f.spd);
        if (!Float.isNaN(f.alt)) loc.setAltitude(f.alt);
        if (f.hdg >= 0f) loc.setBearing(f.hdg);
        return loc;
    }

    private Location weightedAverageWindowLocation() {
        if (gpsWindowBuffer.isEmpty()) return null;
        if (gpsWindowBuffer.size() == 1) {
            return windowFixToLocation(gpsWindowBuffer.get(0));
        }
        double latSum = 0d;
        double lonSum = 0d;
        double wSum = 0d;
        double accSum = 0d;
        double spdSum = 0d;
        double spdW = 0d;
        double altSum = 0d;
        double altW = 0d;
        long t = gpsWindowBuffer.get(0).t;
        float bestHdg = -1f;
        float bestHdgW = 0f;
        for (GpsWindowFix f : gpsWindowBuffer) {
            float w = fixWeight(f.acc);
            wSum += w;
            latSum += f.lat * w;
            lonSum += f.lon * w;
            accSum += f.acc * w;
            if (f.t >= t) t = f.t;
            if (f.spd >= 0f) {
                spdSum += f.spd * w;
                spdW += w;
            }
            if (!Float.isNaN(f.alt)) {
                altSum += f.alt * w;
                altW += w;
            }
            if (f.hdg >= 0f && w >= bestHdgW) {
                bestHdgW = w;
                bestHdg = f.hdg;
            }
        }
        if (wSum <= 0d) {
            return windowFixToLocation(gpsWindowBuffer.get(gpsWindowBuffer.size() - 1));
        }
        Location loc = new Location("weighted");
        loc.setLatitude(latSum / wSum);
        loc.setLongitude(lonSum / wSum);
        loc.setAccuracy((float) (accSum / wSum));
        loc.setTime(t);
        if (spdW > 0d) loc.setSpeed((float) (spdSum / spdW));
        if (altW > 0d) loc.setAltitude(altSum / altW);
        if (bestHdg >= 0f) loc.setBearing(bestHdg);
        return loc;
    }

    /** One accuracy-weighted GPS sample per report interval (KRI window model). */
    private void uploadWindowAverageGps(boolean scheduledTick) {
        uploadWindowAverageGps(scheduledTick, null);
    }

    private void uploadWindowAverageGps(boolean scheduledTick, String forcedSampleSource) {
        if (!enableGps || uploadExecutor == null || uploadExecutor.isShutdown()) return;
        long interval = Math.max(GPS_COLLECT_INTERVAL_MS, effectiveGpsIntervalMs());
        long ingestT = System.currentTimeMillis();
        long bucket = ingestT / interval;
        if (bucket <= lastUploadedGpsBucket) {
            if (System.currentTimeMillis() - lastGpsUploadWallMs < interval) return;
            bucket = lastUploadedGpsBucket + 1;
        }
        Location windowAvg = weightedAverageWindowLocation();
        Location uploadLoc = windowAvg;
        if (uploadLoc == null) {
            uploadLoc = latestGpsLocation;
        }
        if (uploadLoc == null || !canUploadGpsFix(uploadLoc, scheduledTick)) return;
        long coordDedupeMs = Math.max(GPS_COORD_DEDUPE_MS, effectiveGpsIntervalMs());
        if (ingestT - lastUploadedFixTimeMs < coordDedupeMs
                && sameCoords(uploadLoc, lastUploadedLat, lastUploadedLon)) {
            gpsWindowBuffer.clear();
            return;
        }

        lastUploadedGpsBucket = bucket;
        lastGpsUploadWallMs = System.currentTimeMillis();
        lastUploadedFixTimeMs = ingestT;
        lastUploadedLat = uploadLoc.getLatitude();
        lastUploadedLon = uploadLoc.getLongitude();
        nativeGpsCount++;
        saveLastGpsToPrefs(uploadLoc, ingestT, nativeGpsCount);
        gpsWindowBuffer.clear();
        final Location averagedLoc = uploadLoc;
        final long sampleT = ingestT;
        final String sampleSource =
                forcedSampleSource != null
                        ? forcedSampleSource
                        : windowAvg != null
                                ? "window_avg"
                                : isGpsFixFresh(uploadLoc) ? "direct" : "scheduled_cache";
        uploadExecutor.execute(() -> enqueueGpsSample(averagedLoc, sampleT, false, sampleSource));
    }

    /** In-memory cache, then SharedPreferences last good fix. */
    private Location resolveCachedUploadLocation() {
        if (latestGpsLocation != null) {
            return copyLocationForUpload(latestGpsLocation);
        }
        Location prefLoc = locationFromPrefs(getSharedPreferences(PREFS, MODE_PRIVATE));
        if (prefLoc != null) {
            latestGpsLocation = prefLoc;
            if (latestGpsCachedWallMs <= 0L) {
                latestGpsCachedWallMs = System.currentTimeMillis();
            }
            return copyLocationForUpload(prefLoc);
        }
        return null;
    }

    private static Location locationFromPrefs(SharedPreferences p) {
        if (!p.contains("lastGpsLat") || !p.contains("lastGpsLon")) return null;
        Location loc = new Location("cached");
        loc.setLatitude(p.getFloat("lastGpsLat", 0f));
        loc.setLongitude(p.getFloat("lastGpsLon", 0f));
        float spd = p.getFloat("lastGpsSpd", -1f);
        if (spd >= 0f) loc.setSpeed(spd);
        float acc = p.getFloat("lastGpsAcc", -1f);
        if (acc >= 0f) loc.setAccuracy(acc);
        return isGpsFixUsable(loc) ? loc : null;
    }

    private void restoreCachedGpsIfNeeded() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        nativeGpsCount = p.getInt("nativeGpsCount", 0);
        if (latestGpsLocation != null) return;
        Location prefLoc = locationFromPrefs(p);
        if (prefLoc == null) return;
        latestGpsLocation = prefLoc;
        latestGpsCachedWallMs = System.currentTimeMillis();
        Log.i(TAG, "Restored cached GPS from prefs for timer uploads");
    }

    /** Raw Android fix clock — used when seeding fused/legacy cache. */
    private static boolean isGpsFixFresh(Location location) {
        if (location == null) return false;
        return System.currentTimeMillis() - location.getTime() <= GPS_MAX_UPLOAD_FIX_AGE_MS;
    }

    private static Location copyLocationForUpload(Location source) {
        Location out = new Location(source);
        out.setTime(System.currentTimeMillis());
        return out;
    }

    /** Timer uploads: fresh fix, or recent cached coords (indoor / stationary). */
    private boolean canUploadGpsFix(Location location, boolean scheduledTick) {
        if (!isGpsFixUsable(location)) return false;
        if (isGpsFixFresh(location)) return true;
        if (!scheduledTick || latestGpsCachedWallMs <= 0L) return false;
        return System.currentTimeMillis() - latestGpsCachedWallMs
                <= GPS_MAX_SCHEDULED_CACHE_AGE_MS;
    }

    private static boolean sameCoords(Location a, double lat, double lon) {
        if (a == null || !Double.isFinite(lat)) return false;
        return Math.abs(a.getLatitude() - lat) < 1e-6 && Math.abs(a.getLongitude() - lon) < 1e-6;
    }

    /** Timer-driven upload — upload first from window/cache, then refresh fix (KRI). */
    private void tickScheduledGpsUpload() {
        if (!enableGps) return;
        uploadWindowAverageGps(true);
        requestFreshGpsLocation(
                loc -> {
                    if (loc != null) {
                        cacheGpsLocation(loc);
                        addFixToGpsWindow(loc);
                    }
                });
    }

    private void requestGpsFlush() {
        tickScheduledGpsUpload();
    }

    private void requestFreshGpsLocation(java.util.function.Consumer<Location> onResult) {
        if (!enableGps) {
            onResult.accept(null);
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            onResult.accept(null);
            return;
        }
        if (fusedClient == null) {
            onResult.accept(null);
            return;
        }
        final AtomicBoolean finished = new AtomicBoolean(false);
        final java.util.function.Consumer<Location> finish =
                loc -> {
                    if (finished.compareAndSet(false, true)) {
                        onResult.accept(loc);
                    }
                };
        final Runnable timeout =
                () -> {
                    Log.w(TAG, "getCurrentLocation timed out");
                    finish.accept(null);
                };
        mainHandler.postDelayed(timeout, 4_000L);
        fusedClient
                .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
                .addOnSuccessListener(
                        loc -> {
                            mainHandler.removeCallbacks(timeout);
                            finish.accept(loc);
                        })
                .addOnFailureListener(
                        e -> {
                            mainHandler.removeCallbacks(timeout);
                            Log.w(TAG, "getCurrentLocation failed", e);
                            finish.accept(null);
                        });
    }

    private void scheduleGpsFlush() {
        mainHandler.removeCallbacks(gpsFlushRunnable);
        if (!enableGps) return;
        mainHandler.postDelayed(gpsFlushRunnable, Math.max(500L, effectiveGpsIntervalMs()));
    }

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {
        Log.w(TAG, "Location provider disabled: " + provider);
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    private void pushRecent(long t, float ax, float ay, float az) {
        if (recentCount < recentAx.length) {
            int i = recentCount++;
            recentT[i] = t;
            recentAx[i] = ax;
            recentAy[i] = ay;
            recentAz[i] = az;
        } else {
            System.arraycopy(recentAx, 1, recentAx, 0, recentAx.length - 1);
            System.arraycopy(recentAy, 1, recentAy, 0, recentAy.length - 1);
            System.arraycopy(recentAz, 1, recentAz, 0, recentAz.length - 1);
            System.arraycopy(recentT, 1, recentT, 0, recentT.length - 1);
            int i = recentAx.length - 1;
            recentT[i] = t;
            recentAx[i] = ax;
            recentAy[i] = ay;
            recentAz[i] = az;
        }
    }

    private void tryCalibrate(long t) {
        if (calibrated || recentCount < CALIBRATE_MIN_SAMPLES) return;
        int n = 0;
        for (int i = 0; i < recentCount; i++) {
            if (recentT[i] >= t - CALIBRATE_WINDOW_MS) n++;
        }
        if (n < CALIBRATE_MIN_SAMPLES) return;
        float vx = stdDevWindow(recentAx, t);
        float vy = stdDevWindow(recentAy, t);
        float vz = stdDevWindow(recentAz, t);
        if (vx + vy + vz > STILL_VAR_MAX) return;
        uprightX = gx;
        uprightY = gy;
        uprightZ = gz;
        normalizeUpright();
        calibrated = true;
        saveUprightToPrefs();
        Log.i(TAG, "Calibrated upright (native)");
    }

    private float stdDevWindow(float[] arr, long newestT) {
        float mean = 0f;
        int n = 0;
        for (int i = 0; i < recentCount; i++) {
            if (recentT[i] >= newestT - CALIBRATE_WINDOW_MS) {
                mean += arr[i];
                n++;
            }
        }
        if (n < 2) return 0f;
        mean /= n;
        float sum = 0f;
        for (int i = 0; i < recentCount; i++) {
            if (recentT[i] >= newestT - CALIBRATE_WINDOW_MS) {
                float d = arr[i] - mean;
                sum += d * d;
            }
        }
        return (float) Math.sqrt(sum / n);
    }

    private void updateCapsize(long t) {
        loadEconomyFromPrefs();
        if (!enableCapsizeDetection) {
            if (capsizeActive) {
                capsizeActive = false;
                capsizeSinceMs = 0;
                cancelAlertNotification();
            }
            return;
        }
        if (!calibrated) return;
        float mag = (float) Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (mag < 7f || mag > 12f) return;

        float nx = gx / mag;
        float ny = gy / mag;
        float nz = gz / mag;
        float dot = nx * uprightX + ny * uprightY + nz * uprightZ;
        int tiltDeg = (int) Math.round(Math.acos(clamp(dot, -1f, 1f)) * (180.0 / Math.PI));

        boolean tipped = dot < CAPSIZE_TIP_DOT;
        if (tipped) {
            if (capsizeSinceMs == 0) capsizeSinceMs = t;
            if (!capsizeActive && t - capsizeSinceMs >= CAPSIZE_HOLD_MS) {
                capsizeActive = true;
                onCapsizeTriggered(t, lastAx, lastAy, lastAz, tiltDeg);
            }
        } else if (dot > 0.55f) {
            capsizeSinceMs = 0;
            if (capsizeActive) {
                capsizeActive = false;
                cancelAlertNotification();
            }
        } else {
            capsizeSinceMs = 0;
        }
    }

    private void onCapsizeTriggered(long t, float ax, float ay, float az, int tiltDeg) {
        Log.w(TAG, "CAPSIZE detected (native)");
        showAlertNotification();
        if (t - lastCapsizeUploadMs < CAPSIZE_UPLOAD_MIN_INTERVAL_MS) return;
        lastCapsizeUploadMs = t;
        uploadExecutor.execute(() -> enqueueCapsizeSample(t, ax, ay, az, tiltDeg));
    }

    private void scheduleIngestFlush() {
        if (standbyMode) return;
        mainHandler.removeCallbacks(ingestFlushRunnable);
        mainHandler.postDelayed(ingestFlushRunnable, effectiveUploadFlushMs());
    }

    private void scheduleHeartbeat() {
        if (standbyMode) return;
        mainHandler.removeCallbacks(heartbeatRunnable);
        mainHandler.postDelayed(heartbeatRunnable, HEARTBEAT_INTERVAL_MS);
    }

    private void offerIngestSample(JSONObject sample, boolean flushNow) {
        loadEconomyFromPrefs();
        if (suppressRecordingActive) return;
        ingestBuffer.put(sample);
        maybeAutoFlushIngest(flushNow);
    }

    private void maybeAutoFlushIngest(boolean force) {
        if (ingestBuffer.length() == 0) return;
        long now = System.currentTimeMillis();
        if (force
                || ingestBuffer.length() >= UPLOAD_FLUSH_MAX_SAMPLES
                || now - lastIngestFlushMs >= effectiveUploadFlushMs()) {
            flushIngestBufferNow();
        }
    }

    private void flushIngestBufferNow() {
        if (ingestBuffer.length() == 0) return;
        JSONArray toSend = ingestBuffer;
        ingestBuffer = new JSONArray();
        lastIngestFlushMs = System.currentTimeMillis();
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String deviceId = p.getString("deviceId", "");
        String sessionId = p.getString("sessionId", "");
        if (deviceId.isEmpty() || sessionId.isEmpty()) {
            Log.e(TAG, "Missing ingest config — dropping " + toSend.length() + " buffered sample(s)");
            return;
        }
        savePulseDiagnostics();
        if (postBatch(p, sessionId, deviceId, toSend)) {
            lastSuccessfulUploadMs = System.currentTimeMillis();
            Log.d(TAG, "Ingest batch OK (" + toSend.length() + " samples)");
        } else {
            Log.w(TAG, "Ingest batch queued for retry (" + toSend.length() + " samples)");
        }
    }

    private void enqueueGpsSample(Location location, long t) {
        enqueueGpsSample(location, t, false, "direct");
    }

    private String resolveGpsProvider(Location location) {
        if (location == null) return latestGpsProvider;
        String provider = location.getProvider();
        if (provider == null || provider.isEmpty()) return latestGpsProvider;
        if ("weighted".equals(provider) || "cached".equals(provider)) return latestGpsProvider;
        return provider;
    }

    private JSONObject buildGpsJson(Location location, String sampleSource) throws Exception {
        JSONObject gps = new JSONObject();
        gps.put("lat", location.getLatitude());
        gps.put("lon", location.getLongitude());
        if (location.hasAccuracy()) gps.put("acc", location.getAccuracy());
        if (location.hasSpeed() && location.getSpeed() >= 0f) {
            gps.put("spd", Math.round(location.getSpeed() * 100) / 100.0);
        }
        if (location.hasBearing() && location.getBearing() >= 0f) {
            gps.put("hdg", Math.round(location.getBearing() * 10) / 10.0);
        }
        if (compassAvailable && !Float.isNaN(compassHeadingDeg)) {
            gps.put("compass", Math.round(compassHeadingDeg * 10) / 10.0);
        }
        if (location.hasAltitude()) {
            gps.put("alt", Math.round(location.getAltitude() * 10) / 10.0);
        }
        if (latestGpsRawFixClockMs > 0L) {
            gps.put("fixMs", latestGpsRawFixClockMs);
        }
        String provider = resolveGpsProvider(location);
        if (provider != null && !provider.isEmpty()) gps.put("provider", provider);
        if (sampleSource != null && !sampleSource.isEmpty()) gps.put("sampleSource", sampleSource);
        return gps;
    }

    /** Cached coords on heartbeat when the 1s GPS timer stalls (heartbeats fire ~every 10s). */
    private boolean appendCachedGpsToSample(JSONObject sample) {
        if (!enableGps) return false;
        Location loc = resolveCachedUploadLocation();
        if (loc == null || !isGpsFixUsable(loc)) return false;
        if (latestGpsCachedWallMs <= 0L
                || System.currentTimeMillis() - latestGpsCachedWallMs
                        > GPS_MAX_SCHEDULED_CACHE_AGE_MS) {
            return false;
        }
        try {
            sample.put("gps", buildGpsJson(loc, "heartbeat_cache"));
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Heartbeat GPS attach failed", e);
            return false;
        }
    }

    /**
     * Push cached GPS when the timer path stops enqueueing but HTTP ingest still succeeds
     * (heartbeats suppressed). Uses lastGpsSampleOfferedMs — not timer intent alone.
     */
    private void maybeRefreshStaleGpsUpload() {
        if (!enableGps) return;
        long interval = Math.max(500L, effectiveGpsIntervalMs());
        long now = System.currentTimeMillis();
        long sinceOffered =
                lastGpsSampleOfferedMs > 0L ? now - lastGpsSampleOfferedMs : Long.MAX_VALUE;
        if (sinceOffered < interval * 2L) return;

        long minGap = Math.max(effectiveUploadFlushMs(), interval);
        if (lastStaleGpsPiggybackWallMs > 0L && now - lastStaleGpsPiggybackWallMs < minGap) {
            return;
        }

        Location loc = resolveCachedUploadLocation();
        if (loc == null || !isGpsFixUsable(loc)) return;
        if (latestGpsLocation != null) {
            addFixToGpsWindow(latestGpsLocation);
        }
        if (!canUploadGpsFix(loc, true)) return;

        lastStaleGpsPiggybackWallMs = now;

        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        int fallback = p.getInt(HEARTBEAT_GPS_COUNT_KEY, 0) + 1;
        p.edit().putInt(HEARTBEAT_GPS_COUNT_KEY, fallback).apply();
        Log.i(
                TAG,
                "Stale GPS fallback (#"
                        + fallback
                        + ") — last offered "
                        + sinceOffered
                        + "ms ago, ingest still active");

        uploadWindowAverageGps(true, "stale_piggyback");
    }

    private void markGpsSampleOffered(long t) {
        lastGpsSampleOfferedMs = t;
        lastGpsUploadWallMs = t;
        savePulseDiagnostics();
    }

    private void enqueueGpsSample(Location location, long t, boolean flushNow, String sampleSource) {
        loadEconomyFromPrefs();
        if (suppressRecordingActive) {
            // Keep location cache for geofence checks; do not upload while in suppress zone.
            return;
        }
        try {
            JSONObject sample = new JSONObject();
            sample.put("t", t);
            sample.put("gps", buildGpsJson(location, sampleSource));
            if (enableMotion && (lastAx != 0f || lastAy != 0f || lastAz != 0f)) {
                JSONObject motion = new JSONObject();
                motion.put("ax", Math.round(lastAx * 100) / 100.0);
                motion.put("ay", Math.round(lastAy * 100) / 100.0);
                motion.put("az", Math.round(lastAz * 100) / 100.0);
                sample.put("motion", motion);
            }
            long now = System.currentTimeMillis();
            JSONObject derived = new JSONObject();
            boolean hasDerived = false;
            if (lastBatteryReportMs == 0L
                    || now - lastBatteryReportMs >= BATTERY_REPORT_INTERVAL_MS) {
                int batteryPct = readBatteryPct();
                if (batteryPct >= 0) {
                    derived.put("batteryPct", batteryPct);
                    lastBatteryReportMs = now;
                    hasDerived = true;
                }
            }
            if (appendFreshStrokeRate(derived)) hasDerived = true;
            if (appendEconomyDerived(derived)) hasDerived = true;
            if (hasDerived) sample.put("derived", derived);
            offerIngestSample(sample, flushNow);
            markGpsSampleOffered(t);
        } catch (Exception e) {
            recordUploadResult(-1, 1, false);
            Log.e(TAG, "GPS sample enqueue failed", e);
        }
    }

    private void enqueueSessionStartSample(long t) {
        try {
            JSONObject derived = new JSONObject();
            derived.put("heartbeat", true);
            int batteryPct = readBatteryPct();
            if (batteryPct >= 0) {
                derived.put("batteryPct", batteryPct);
                lastBatteryReportMs = t;
                Log.i(TAG, "Session start battery " + batteryPct + "%");
            }
            appendEconomyDerived(derived);
            JSONObject sample = new JSONObject();
            sample.put("t", t);
            sample.put("derived", derived);
            offerIngestSample(sample, true);
        } catch (Exception e) {
            Log.e(TAG, "Session start telemetry failed", e);
        }
    }

    private void enqueueHeartbeatSample(long t) {
        if (lastSuccessfulUploadMs > 0L
                && t - lastSuccessfulUploadMs < HEARTBEAT_INTERVAL_MS - 1000L) {
            maybeRefreshStaleGpsUpload();
            return;
        }
        try {
            JSONObject derived = new JSONObject();
            derived.put("heartbeat", true);
            boolean reportBattery =
                    lastBatteryReportMs == 0L
                            || t - lastBatteryReportMs >= BATTERY_REPORT_INTERVAL_MS;
            if (reportBattery) {
                int batteryPct = readBatteryPct();
                if (batteryPct >= 0) {
                    derived.put("batteryPct", batteryPct);
                    lastBatteryReportMs = t;
                    Log.i(TAG, "Including battery " + batteryPct + "% on heartbeat");
                }
            }
            appendEconomyDerived(derived);
            JSONObject sample = new JSONObject();
            sample.put("t", t);
            sample.put("derived", derived);
            boolean piggyback = appendCachedGpsToSample(sample);
            if (piggyback) {
                SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
                int hbGps = p.getInt(HEARTBEAT_GPS_COUNT_KEY, 0) + 1;
                p.edit().putInt(HEARTBEAT_GPS_COUNT_KEY, hbGps).apply();
                Log.d(TAG, "Heartbeat piggyback GPS (#" + hbGps + ")");
            }
            offerIngestSample(sample, false);
            if (piggyback) markGpsSampleOffered(t);
        } catch (Exception e) {
            Log.e(TAG, "Heartbeat sample enqueue failed", e);
        }
    }

    private int readBatteryPct() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            BatteryManager bm = (BatteryManager) getSystemService(BATTERY_SERVICE);
            if (bm != null) {
                int level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                if (level >= 0 && level <= 100) return level;
            }
        }
        return -1;
    }

    private void enqueueCapsizeSample(long t, float ax, float ay, float az, int tiltDeg) {
        try {
            JSONObject derived = new JSONObject();
            derived.put("capsize", true);
            derived.put("tiltDeg", tiltDeg);
            appendEconomyDerived(derived);
            JSONObject motion = new JSONObject();
            motion.put("ax", Math.round(ax * 100) / 100.0);
            motion.put("ay", Math.round(ay * 100) / 100.0);
            motion.put("az", Math.round(az * 100) / 100.0);
            JSONObject sample = new JSONObject();
            sample.put("t", t);
            sample.put("motion", motion);
            sample.put("derived", derived);
            offerIngestSample(sample, true);
            Log.i(TAG, "Capsize ingest queued");
        } catch (Exception e) {
            recordUploadResult(-1, 1, false);
            Log.e(TAG, "Capsize ingest failed", e);
        }
    }

    private JSONObject buildBatch(
            SharedPreferences p, String sessionId, String deviceId, JSONArray samples)
            throws Exception {
        JSONObject batch = new JSONObject();
        batch.put("sessionId", sessionId);
        batch.put("deviceId", deviceId);
        String athleteId = p.getString("athleteId", "");
        if (!athleteId.isEmpty()) batch.put("athleteId", athleteId);
        batch.put("samples", samples);
        return batch;
    }

    private boolean postBatch(
            SharedPreferences p, String sessionId, String deviceId, JSONArray samples) {
        try {
            return postBatchJson(p, buildBatch(p, sessionId, deviceId, samples), true);
        } catch (Exception e) {
            Log.e(TAG, "postBatch build failed", e);
            recordUploadResult(-1, samples.length(), false);
            return false;
        }
    }

    private boolean postBatchJson(SharedPreferences p, JSONObject batch, boolean requeueOnFailure) {
        int sampleCount = 0;
        try {
            JSONArray samples = batch.getJSONArray("samples");
            sampleCount = samples.length();
            return postIngestJson(p, batch.toString(), sampleCount, requeueOnFailure, batch);
        } catch (Exception e) {
            recordUploadResult(-1, sampleCount, false);
            Log.e(TAG, "postBatchJson build failed", e);
            if (requeueOnFailure) enqueuePendingBatch(p, batch);
            return false;
        }
    }

    private boolean postSessionEnd(
            SharedPreferences p, String sessionId, String deviceId, long endedAtMs) {
        try {
            JSONObject body = new JSONObject();
            body.put("action", "end");
            body.put("sessionId", sessionId);
            body.put("deviceId", deviceId);
            String athleteId = p.getString("athleteId", "");
            if (athleteId != null && !athleteId.isEmpty()) {
                body.put("athleteId", athleteId);
            }
            body.put("endedAt", endedAtMs);
            boolean ok = postIngestJson(p, body.toString(), 0, false, null);
            if (ok) {
                Log.i(
                        TAG,
                        "Session end posted for "
                                + (sessionId.length() > 8
                                        ? sessionId.substring(0, 8)
                                        : sessionId));
            }
            return ok;
        } catch (Exception e) {
            Log.w(TAG, "postSessionEnd failed", e);
            return false;
        }
    }

    private boolean postIngestJson(
            SharedPreferences p,
            String body,
            int sampleCount,
            boolean requeueOnFailure,
            JSONObject requeueBatch) {
        try {
            String ingestUrl = p.getString("ingestUrl", "");
            if (ingestUrl.isEmpty()) {
                recordUploadResult(-1, sampleCount, false);
                return false;
            }
            URL url = new URL(ingestUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            String token = p.getString("ingestToken", "");
            if (!token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            conn.disconnect();
            boolean ok = code >= 200 && code < 300;
            recordUploadResult(code, sampleCount, ok);
            if (!ok) {
                Log.w(TAG, "Ingest HTTP " + code);
                if (requeueOnFailure && requeueBatch != null) {
                    enqueuePendingBatch(p, requeueBatch);
                }
            }
            return ok;
        } catch (Exception e) {
            recordUploadResult(-1, sampleCount, false);
            Log.e(TAG, "Ingest POST failed", e);
            if (requeueOnFailure && requeueBatch != null) {
                enqueuePendingBatch(p, requeueBatch);
            }
            return false;
        }
    }

    private void enqueuePendingBatch(SharedPreferences p, JSONObject batch) {
        try {
            JSONArray queue = new JSONArray(p.getString(PENDING_BATCHES_KEY, "[]"));
            queue.put(batch);
            while (queue.length() > MAX_PENDING_BATCHES) {
                queue.remove(0);
            }
            p.edit().putString(PENDING_BATCHES_KEY, queue.toString()).apply();
            mirrorRecordingPrefsToDeviceProtected(getApplicationContext());
        } catch (Exception e) {
            Log.e(TAG, "enqueuePendingBatch failed", e);
        }
    }

    private void flushPendingIngest(SharedPreferences p) {
        flushPendingIngest(p, MAX_PENDING_FLUSH_PER_CYCLE);
    }

    private void flushPendingIngest(SharedPreferences p, int maxFlush) {
        try {
            JSONArray queue = new JSONArray(p.getString(PENDING_BATCHES_KEY, "[]"));
            if (queue.length() == 0) return;
            JSONArray remaining = new JSONArray();
            int sent = 0;
            for (int i = 0; i < queue.length(); i++) {
                JSONObject batch = queue.getJSONObject(i);
                if (postBatchJson(p, batch, false)) {
                    sent++;
                } else {
                    remaining.put(batch);
                }
                if (sent >= maxFlush) {
                    for (int j = i + 1; j < queue.length(); j++) {
                        remaining.put(queue.getJSONObject(j));
                    }
                    break;
                }
            }
            p.edit().putString(PENDING_BATCHES_KEY, remaining.toString()).apply();
            if (sent > 0) {
                Log.i(
                    TAG,
                    "Flushed "
                        + sent
                        + " pending ingest batch(es), "
                        + remaining.length()
                        + " left");
            }
        } catch (Exception e) {
            Log.e(TAG, "flushPendingIngest failed", e);
        }
    }

    private void recordUploadResult(int httpCode, int sampleCount, boolean ok) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        int seq = p.getInt("uploadSeq", 0) + 1;
        SharedPreferences.Editor ed =
            p.edit()
                .putInt("uploadSeq", seq)
                .putLong("lastUploadT", System.currentTimeMillis())
                .putBoolean("lastUploadOk", ok)
                .putInt("lastUploadCode", httpCode)
                .putInt("lastUploadSamples", sampleCount);
        if (ok) {
            ed.putInt("uploadOkCount", p.getInt("uploadOkCount", 0) + 1);
        } else {
            ed.putInt("uploadFailCount", p.getInt("uploadFailCount", 0) + 1);
        }
        ed.apply();
    }

    private void saveLastGpsToPrefs(Location location, long t, int count) {
        SharedPreferences.Editor ed =
            getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putLong("lastGpsT", t)
                .putFloat("lastGpsLat", (float) location.getLatitude())
                .putFloat("lastGpsLon", (float) location.getLongitude())
                .putFloat(
                    "lastGpsSpd",
                    location.hasSpeed() && location.getSpeed() >= 0f ? location.getSpeed() : -1f)
                .putFloat(
                    "lastGpsAcc",
                    location.hasAccuracy() ? location.getAccuracy() : -1f)
                .putInt("nativeGpsCount", count);
        if (latestGpsRawFixClockMs > 0L) {
            ed.putLong("lastGpsFixMs", latestGpsRawFixClockMs);
        }
        ed.apply();
    }

    private void saveConfigFromIntent(Intent intent) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        SharedPreferences.Editor ed =
            p.edit()
                .putString("sessionId", intent.getStringExtra("sessionId"))
                .putString("deviceId", intent.getStringExtra("deviceId"))
                .putString("ingestUrl", intent.getStringExtra("ingestUrl"))
                .putString("ingestToken", intent.getStringExtra("ingestToken"))
                .putString("athleteId", intent.getStringExtra("athleteId"))
                .putBoolean("enableGps", intent.getBooleanExtra("enableGps", false))
                .putBoolean("enableMotion", intent.getBooleanExtra("enableMotion", true))
                .putLong("gpsIntervalMs", intent.getLongExtra("gpsIntervalMs", 1000L))
                .putBoolean("economyActive", false)
                .putBoolean("suppressRecordingActive", false)
                .putBoolean("recordingActive", true)
                .putBoolean("standbyArmed", false)
                .putBoolean("standbyAutoStartTriggered", false)
                .putBoolean("autoStartedSession", false)
                .putInt(BOOT_RETRY_COUNT_KEY, 0)
                .putInt("uploadSeq", 0)
                .putInt("uploadOkCount", 0)
                .putInt("uploadFailCount", 0)
                .putInt(HEARTBEAT_GPS_COUNT_KEY, 0)
                .putString(PENDING_BATCHES_KEY, "[]")
                .putInt("pendingBatchCount", 0);
        long startedAt = intent.getLongExtra("startedAt", 0L);
        if (startedAt > 0L) {
            ed.putLong("recordingStartedAt", startedAt);
        } else if (p.getLong("recordingStartedAt", 0L) <= 0L) {
            ed.putLong("recordingStartedAt", System.currentTimeMillis());
        }
        ed.apply();
        mirrorRecordingPrefsToDeviceProtected(getApplicationContext());
    }

    private void loadSessionFlagsFromPrefs() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        enableGps = p.getBoolean("enableGps", false);
        enableMotion = p.getBoolean("enableMotion", true);
        gpsIntervalMs = Math.max(500L, p.getLong("gpsIntervalMs", 1000L));
        loadEconomyFromPrefs();
    }

    private void loadEconomyFromPrefs() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        economyActive = p.getBoolean("economyActive", false);
        suppressRecordingActive = p.getBoolean("suppressRecordingActive", false);
        economyGpsIntervalMs = Math.max(1000L, p.getLong("economyGpsIntervalMs", 30_000L));
        economyUploadIntervalMs = Math.max(1000L, p.getLong("economyUploadIntervalMs", 30_000L));
        enableCapsizeDetection = p.getBoolean("enableCapsizeDetection", true);
    }

    /** GPS upload interval — geofence economy overrides user setting when active. */
    private long effectiveGpsIntervalMs() {
        loadEconomyFromPrefs();
        loadSessionFlagsFromPrefs();
        return economyActive ? economyGpsIntervalMs : gpsIntervalMs;
    }

    /** Fused/legacy update rate — standby uses low-rate polling. */
    private long locationTrackingIntervalMs() {
        if (standbyMode) return STANDBY_GPS_INTERVAL_MS;
        return GPS_COLLECT_INTERVAL_MS;
    }

    private long effectiveUploadFlushMs() {
        loadEconomyFromPrefs();
        if (economyActive) return economyUploadIntervalMs;
        return UPLOAD_FLUSH_INTERVAL_MS;
    }

    public static boolean isServiceRunning() {
        CapsizeMonitorService inst = runningInstance != null ? runningInstance.get() : null;
        return inst != null;
    }

    private void savePulseDiagnostics() {
        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putLong(PULSE_LAST_GPS_UPLOAD_WALL_MS, lastGpsUploadWallMs)
                .putLong(PULSE_LAST_GPS_OFFERED_WALL_MS, lastGpsSampleOfferedMs)
                .putLong(PULSE_LAST_FUSED_DELIVERY_WALL_MS, lastFusedDeliveryWallMs)
                .putLong(PULSE_LATEST_GPS_CACHED_WALL_MS, latestGpsCachedWallMs)
                .putInt(PULSE_INGEST_BUFFER_COUNT, ingestBuffer.length())
                .apply();
    }

    /** Live + persisted diagnostics for WebView getPulse(). */
    public static JSONObject getPulseData(Context ctx) throws Exception {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        CapsizeMonitorService inst = runningInstance != null ? runningInstance.get() : null;
        long now = System.currentTimeMillis();
        JSONObject ret = new JSONObject();
        if (p.contains("lastGpsT")) {
            JSONObject gps = new JSONObject();
            gps.put("t", p.getLong("lastGpsT", 0L));
            gps.put("lat", p.getFloat("lastGpsLat", 0f));
            gps.put("lon", p.getFloat("lastGpsLon", 0f));
            float spd = p.getFloat("lastGpsSpd", -1f);
            if (spd >= 0f) gps.put("spd", spd);
            float acc = p.getFloat("lastGpsAcc", -1f);
            if (acc >= 0f) gps.put("acc", acc);
            long fixMs = p.getLong("lastGpsFixMs", 0L);
            if (fixMs > 0L) gps.put("fixMs", fixMs);
            ret.put("lastGps", gps);
        }
        ret.put("nativeGpsCount", p.getInt("nativeGpsCount", 0));
        ret.put("heartbeatGpsCount", p.getInt(HEARTBEAT_GPS_COUNT_KEY, 0));
        if (p.contains("lastUploadT")) {
            JSONObject upload = new JSONObject();
            upload.put("seq", p.getInt("uploadSeq", 0));
            upload.put("ok", p.getBoolean("lastUploadOk", false));
            upload.put("code", p.getInt("lastUploadCode", 0));
            upload.put("samples", p.getInt("lastUploadSamples", 0));
            upload.put("okCount", p.getInt("uploadOkCount", 0));
            upload.put("failCount", p.getInt("uploadFailCount", 0));
            upload.put("t", p.getLong("lastUploadT", 0L));
            ret.put("upload", upload);
        }
        JSONArray pending = new JSONArray(p.getString(PENDING_BATCHES_KEY, "[]"));
        ret.put("pendingIngestBatches", pending.length());

        long lastGpsUploadWallMs =
                inst != null
                        ? inst.lastGpsUploadWallMs
                        : p.getLong(PULSE_LAST_GPS_UPLOAD_WALL_MS, 0L);
        long lastGpsSampleOfferedMs =
                inst != null
                        ? inst.lastGpsSampleOfferedMs
                        : p.getLong(PULSE_LAST_GPS_OFFERED_WALL_MS, 0L);
        long lastFusedDeliveryWallMs =
                inst != null
                        ? inst.lastFusedDeliveryWallMs
                        : p.getLong(PULSE_LAST_FUSED_DELIVERY_WALL_MS, 0L);
        long latestGpsCachedWallMs =
                inst != null
                        ? inst.latestGpsCachedWallMs
                        : p.getLong(PULSE_LATEST_GPS_CACHED_WALL_MS, 0L);
        int ingestBufferCount =
                inst != null
                        ? inst.ingestBuffer.length()
                        : p.getInt(PULSE_INGEST_BUFFER_COUNT, 0);

        ret.put("serviceRunning", inst != null);
        ret.put(
                "lastGpsUploadAgoMs",
                lastGpsUploadWallMs > 0L ? now - lastGpsUploadWallMs : JSONObject.NULL);
        ret.put(
                "lastGpsSampleOfferedAgoMs",
                lastGpsSampleOfferedMs > 0L ? now - lastGpsSampleOfferedMs : JSONObject.NULL);
        ret.put(
                "lastFusedDeliveryAgoMs",
                lastFusedDeliveryWallMs > 0L ? now - lastFusedDeliveryWallMs : JSONObject.NULL);
        ret.put(
                "latestGpsCachedAgoMs",
                latestGpsCachedWallMs > 0L ? now - latestGpsCachedWallMs : JSONObject.NULL);
        ret.put("ingestBufferCount", ingestBufferCount);
        if (inst != null) {
            ret.put("enableGps", inst.enableGps);
            ret.put("gpsIntervalMs", inst.effectiveGpsIntervalMs());
        } else {
            ret.put("enableGps", p.getBoolean("enableGps", false));
            ret.put("gpsIntervalMs", Math.max(500L, p.getLong("gpsIntervalMs", 1000L)));
        }
        return ret;
    }

    public static void clearRecordingSession(Context ctx) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean("recordingActive", false)
            .putBoolean("standbyArmed", false)
            .putBoolean("standbyAutoStartTriggered", false)
            .putBoolean("autoStartedSession", false)
            .putBoolean("economyActive", false)
            .putInt(BOOT_RETRY_COUNT_KEY, 0)
            .apply();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            deviceProtectedPrefs(ctx).edit().clear().apply();
        }
        clearBootResumeNotification(ctx);
    }

    private static SharedPreferences deviceProtectedPrefs(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            return ctx.createDeviceProtectedStorageContext()
                    .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        }
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SharedPreferences resolvePrefsForResume(Context ctx) {
        SharedPreferences ce = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (hasActiveSessionPrefs(ce) || hasStandbyPrefs(ce)) return ce;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            SharedPreferences de = deviceProtectedPrefs(ctx);
            if (hasActiveSessionPrefs(de) || hasStandbyPrefs(de)) return de;
        }
        return ce;
    }

    private static boolean hasActiveSessionPrefs(SharedPreferences p) {
        if (!p.getBoolean("recordingActive", false)) return false;
        String sessionId = p.getString("sessionId", "");
        String deviceId = p.getString("deviceId", "");
        String ingestUrl = p.getString("ingestUrl", "");
        return sessionId != null
                && !sessionId.isEmpty()
                && deviceId != null
                && !deviceId.isEmpty()
                && ingestUrl != null
                && !ingestUrl.isEmpty();
    }

    private static SharedPreferences.Editor copySessionResumeFields(
            SharedPreferences.Editor ed, SharedPreferences src) {
        return ed.putBoolean("recordingActive", true)
                .putString("sessionId", src.getString("sessionId", ""))
                .putString("deviceId", src.getString("deviceId", ""))
                .putString("ingestUrl", src.getString("ingestUrl", ""))
                .putString("ingestToken", src.getString("ingestToken", ""))
                .putString("athleteId", src.getString("athleteId", ""))
                .putBoolean("enableGps", src.getBoolean("enableGps", false))
                .putBoolean("enableMotion", src.getBoolean("enableMotion", true))
                .putLong("gpsIntervalMs", src.getLong("gpsIntervalMs", 1000L))
                .putLong("recordingStartedAt", src.getLong("recordingStartedAt", 0L))
                .putInt(BOOT_RETRY_COUNT_KEY, src.getInt(BOOT_RETRY_COUNT_KEY, 0))
                .putBoolean("economyActive", src.getBoolean("economyActive", false))
                .putLong("economyGpsIntervalMs", src.getLong("economyGpsIntervalMs", 3000L))
                .putLong("economyUploadIntervalMs", src.getLong("economyUploadIntervalMs", 6000L))
                .putBoolean("enableCapsizeDetection", src.getBoolean("enableCapsizeDetection", true))
                .putBoolean("hasUpright", src.getBoolean("hasUpright", false))
                .putFloat("uprightX", src.getFloat("uprightX", 0f))
                .putFloat("uprightY", src.getFloat("uprightY", 0f))
                .putFloat("uprightZ", src.getFloat("uprightZ", 1f))
                .putString(PENDING_BATCHES_KEY, src.getString(PENDING_BATCHES_KEY, "[]"));
    }

    private static SharedPreferences.Editor copyStandbyResumeFields(
            SharedPreferences.Editor ed, SharedPreferences src) {
        return ed.putBoolean("standbyArmed", true)
                .putString("deviceId", src.getString("deviceId", ""))
                .putString("ingestUrl", src.getString("ingestUrl", ""))
                .putString("ingestToken", src.getString("ingestToken", ""))
                .putString("athleteId", src.getString("athleteId", ""))
                .putBoolean("enableGps", src.getBoolean("enableGps", false))
                .putBoolean("standbySavedEnableMotion", src.getBoolean("standbySavedEnableMotion", true))
                .putLong("standbySavedGpsIntervalMs", src.getLong("standbySavedGpsIntervalMs", 1000L))
                .putLong("standbyArmedAt", src.getLong("standbyArmedAt", 0L))
                .putLong("standbyOutsideSinceMs", src.getLong("standbyOutsideSinceMs", 0L))
                .putLong("standbyLastFreshFixMs", src.getLong("standbyLastFreshFixMs", 0L))
                .putString("standbyInsideZoneName", src.getString("standbyInsideZoneName", ""))
                .putBoolean("standbyAutoStartTriggered", src.getBoolean("standbyAutoStartTriggered", false));
    }

    private static void mirrorSessionPrefsToDeviceProtected(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        SharedPreferences ce = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences de = deviceProtectedPrefs(ctx);
        boolean recordingActive = ce.getBoolean("recordingActive", false);
        boolean standbyArmed = ce.getBoolean("standbyArmed", false);
        if (!recordingActive && !standbyArmed) {
            de.edit().clear().apply();
            return;
        }
        SharedPreferences.Editor ed = de.edit();
        if (recordingActive) {
            copySessionResumeFields(ed, ce);
        } else {
            ed.putBoolean("recordingActive", false);
        }
        if (standbyArmed) {
            copyStandbyResumeFields(ed, ce);
        } else {
            ed.putBoolean("standbyArmed", false);
        }
        ed.apply();
    }

    /** @deprecated use {@link #mirrorSessionPrefsToDeviceProtected(Context)} */
    private static void mirrorRecordingPrefsToDeviceProtected(Context ctx) {
        mirrorSessionPrefsToDeviceProtected(ctx);
    }

    private void promoteDeviceProtectedSessionPrefs() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        SharedPreferences ce = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (hasActiveSessionPrefs(ce) || hasStandbyPrefs(ce)) return;
        SharedPreferences de =
                createDeviceProtectedStorageContext().getSharedPreferences(PREFS, MODE_PRIVATE);
        if (hasActiveSessionPrefs(de)) {
            copySessionResumeFields(ce.edit(), de).apply();
            return;
        }
        if (hasStandbyPrefs(de)) {
            copyStandbyResumeFields(ce.edit(), de).apply();
        }
    }

    private static boolean hasStandbyPrefs(SharedPreferences p) {
        if (!p.getBoolean("standbyArmed", false)) return false;
        if (p.getBoolean("recordingActive", false)) return false;
        String deviceId = p.getString("deviceId", "");
        String ingestUrl = p.getString("ingestUrl", "");
        return deviceId != null
                && !deviceId.isEmpty()
                && ingestUrl != null
                && !ingestUrl.isEmpty();
    }

    public static boolean shouldResumeAfterBoot(Context ctx) {
        SharedPreferences p = resolvePrefsForResume(ctx);
        return hasActiveSessionPrefs(p) || hasStandbyPrefs(p);
    }

    public static void requestBootResume(Context ctx) {
        if (!shouldResumeAfterBoot(ctx) || isServiceRunning()) {
            Log.i(
                    TAG,
                    "Boot resume skipped active="
                            + shouldResumeAfterBoot(ctx)
                            + " running="
                            + isServiceRunning());
            return;
        }
        if (tryStartBootService(ctx)) return;
        launchBootResumeActivity(ctx);
    }

    public static boolean tryStartBootService(Context ctx) {
        Intent intent = new Intent(ctx, CapsizeMonitorService.class);
        intent.putExtra("bootResume", true);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
            Log.i(TAG, "Recording session restarted after boot (direct)");
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Boot resume direct start failed: " + e.getMessage());
            return false;
        }
    }

    private static void launchBootResumeActivity(Context ctx) {
        try {
            Intent act = new Intent(ctx, BootResumeLauncherActivity.class);
            act.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            ctx.startActivity(act);
            Log.i(TAG, "Boot resume via launcher activity");
        } catch (Exception e) {
            Log.w(TAG, "Boot resume activity failed: " + e.getMessage());
            scheduleBootResumeRetry(ctx);
        }
    }

    public static void scheduleBootResumeRetry(Context ctx) {
        SharedPreferences p = resolvePrefsForResume(ctx);
        if (!hasActiveSessionPrefs(p) && !hasStandbyPrefs(p)) return;
        int count = p.getInt(BOOT_RETRY_COUNT_KEY, 0);
        boolean persistent = count >= MAX_BOOT_RESUME_RETRIES;
        if (persistent) {
            showBootResumeNotification(ctx);
        } else {
            p.edit().putInt(BOOT_RETRY_COUNT_KEY, count + 1).apply();
            count++;
        }
        mirrorRecordingPrefsToDeviceProtected(ctx);

        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            showBootResumeNotification(ctx);
            return;
        }
        Intent intent = new Intent(ctx, RecordingBootReceiver.class);
        intent.setAction(RecordingBootReceiver.ACTION_BOOT_RESUME_RETRY);
        PendingIntent pi =
                PendingIntent.getBroadcast(
                        ctx,
                        BOOT_RESUME_ALARM_REQUEST,
                        intent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        long delayMs;
        if (persistent) {
            delayMs = BOOT_RESUME_PERSISTENT_INTERVAL_MS;
        } else if (count == 1) {
            delayMs = 15_000L;
        } else if (count == 2) {
            delayMs = 45_000L;
        } else if (count <= 5) {
            delayMs = 120_000L;
        } else {
            delayMs = 300_000L;
        }
        long trigger = System.currentTimeMillis() + delayMs;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, trigger, pi);
            }
            Log.i(TAG, "Scheduled boot resume retry #" + (count + 1) + " in " + delayMs + "ms");
        } catch (Exception e) {
            Log.w(TAG, "Boot resume alarm failed: " + e.getMessage());
            showBootResumeNotification(ctx);
        }
    }

    private static void showBootResumeNotification(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch =
                    new NotificationChannel(
                            CHANNEL_ID,
                            "Session recording (native)",
                            NotificationManager.IMPORTANCE_HIGH);
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
        SharedPreferences p = resolvePrefsForResume(ctx);
        boolean standbyOnly = hasStandbyPrefs(p) && !hasActiveSessionPrefs(p);
        Intent launch = new Intent(ctx, BootResumeLauncherActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi =
                PendingIntent.getActivity(
                        ctx,
                        0,
                        launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification =
                new NotificationCompat.Builder(ctx, CHANNEL_ID)
                        .setContentTitle(
                                standbyOnly ? "CrewSight geofence standby" : "CrewSight session recording")
                        .setContentText(
                                standbyOnly
                                        ? "Tap to restore standby GPS after restart"
                                        : "Tap to resume GPS after restart")
                        .setSmallIcon(R.drawable.ic_stat_rowing_shell)
                        .setContentIntent(pi)
                        .setAutoCancel(true)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .build();
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIF_ID_BOOT_RESUME, notification);
    }

    private void clearBootResumeNotification() {
        clearBootResumeNotification(this);
    }

    private static void clearBootResumeNotification(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTIF_ID_BOOT_RESUME);
    }

    private boolean startForegroundWithTypes() {
        Notification notification = buildForegroundNotification();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
                if (Build.VERSION.SDK_INT >= 34) {
                    types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
                }
                ServiceCompat.startForeground(this, NOTIF_ID_FOREGROUND, notification, types);
            } else {
                startForeground(NOTIF_ID_FOREGROUND, notification);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed: " + e.getMessage());
            clearRecordingSession(getApplicationContext());
            stopSelf();
            return false;
        }
    }

    /** Apply GPS upload interval from WebView settings (survives skipNativeStart reconnect). */
    public static void setGpsIntervalMs(Context ctx, long intervalMs) {
        long ms = Math.max(500L, intervalMs);
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putLong("gpsIntervalMs", ms)
            .apply();
        mirrorRecordingPrefsToDeviceProtected(ctx);
        CapsizeMonitorService inst = runningInstance != null ? runningInstance.get() : null;
        if (inst != null) {
            inst.mainHandler.post(inst::applyGpsIntervalChanged);
        }
    }

    private void applyGpsIntervalChanged() {
        loadSessionFlagsFromPrefs();
        if (!enableGps) return;
        lastGpsUploadWallMs = 0L;
        lastUploadedGpsBucket = -1L;
        gpsWindowBuffer.clear();
        lastWindowCollectWallMs = 0L;
        registerLocation();
        scheduleGpsFlush();
        tickScheduledGpsUpload();
        Log.i(TAG, "GPS interval updated gpsIntervalMs=" + gpsIntervalMs);
    }

    public static void setEconomyMode(
            Context ctx,
            boolean active,
            long gpsInterval,
            long uploadInterval,
            boolean enableCapsize) {
        setEconomyMode(ctx, active, gpsInterval, uploadInterval, enableCapsize, false);
    }

    public static void setEconomyMode(
            Context ctx,
            boolean active,
            long gpsInterval,
            long uploadInterval,
            boolean enableCapsize,
            boolean suppressRecording) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean("economyActive", active)
            .putBoolean("suppressRecordingActive", active && suppressRecording)
            .putLong("economyGpsIntervalMs", Math.max(1000L, gpsInterval))
            .putLong("economyUploadIntervalMs", Math.max(1000L, uploadInterval))
            .putBoolean("enableCapsizeDetection", enableCapsize)
            .apply();
        mirrorRecordingPrefsToDeviceProtected(ctx);
        CapsizeMonitorService inst = runningInstance != null ? runningInstance.get() : null;
        if (inst != null) {
            inst.mainHandler.post(inst::applyEconomyModeChanged);
        }
    }

    public static void setGeofences(Context ctx, String geofencesJson) {
        GeofenceHelper.saveGeofences(ctx, geofencesJson != null ? geofencesJson : "[]");
        CapsizeMonitorService inst = runningInstance != null ? runningInstance.get() : null;
        if (inst != null) {
            inst.mainHandler.post(
                    () -> {
                        Location loc = inst.latestGpsLocation;
                        if (loc != null) {
                            inst.maybeApplyGeofenceEconomy(
                                    loc.getLatitude(), loc.getLongitude());
                        }
                    });
        }
    }

    private void applyEconomyModeChanged() {
        loadEconomyFromPrefs();
        if (enableGps) {
            lastGpsUploadWallMs = 0L;
            lastUploadedGpsBucket = -1L;
            registerLocation();
            scheduleGpsFlush();
            tickScheduledGpsUpload();
        }
        scheduleIngestFlush();
        Log.i(
            TAG,
            "Economy mode "
                + (economyActive ? "on" : "off")
                + " gpsUploadMs="
                + effectiveGpsIntervalMs()
                + " trackMs="
                + locationTrackingIntervalMs());
    }

    private void loadUprightFromPrefs() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!p.getBoolean("hasUpright", false)) return;
        uprightX = p.getFloat("uprightX", 0f);
        uprightY = p.getFloat("uprightY", 0f);
        uprightZ = p.getFloat("uprightZ", 1f);
        normalizeUpright();
        calibrated = true;
    }

    private void saveUprightToPrefs() {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean("hasUpright", true)
            .putFloat("uprightX", uprightX)
            .putFloat("uprightY", uprightY)
            .putFloat("uprightZ", uprightZ)
            .apply();
        mirrorRecordingPrefsToDeviceProtected(getApplicationContext());
    }

    public static void setUpright(Context ctx, float x, float y, float z) {
        float mag = (float) Math.sqrt(x * x + y * y + z * z);
        if (mag < 1e-3f) return;
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean("hasUpright", true)
            .putFloat("uprightX", x / mag)
            .putFloat("uprightY", y / mag)
            .putFloat("uprightZ", z / mag)
            .apply();
        mirrorRecordingPrefsToDeviceProtected(ctx);
    }

    /** Latest stroke rate (spm) from WebView or native motion — included on GPS uploads only. */
    public static void setStrokeRate(Context ctx, float spm) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putFloat("lastStrokeRate", spm)
            .putLong("lastStrokeRateMs", System.currentTimeMillis())
            .apply();
    }

    private void pushStrokeSample(long t, float ax, float ay, float az) {
        if (strokeCount < STROKE_BUF_CAP) {
            int i = strokeCount++;
            strokeT[i] = t;
            strokeAx[i] = ax;
            strokeAy[i] = ay;
            strokeAz[i] = az;
        } else {
            System.arraycopy(strokeAx, 1, strokeAx, 0, STROKE_BUF_CAP - 1);
            System.arraycopy(strokeAy, 1, strokeAy, 0, STROKE_BUF_CAP - 1);
            System.arraycopy(strokeAz, 1, strokeAz, 0, STROKE_BUF_CAP - 1);
            System.arraycopy(strokeT, 1, strokeT, 0, STROKE_BUF_CAP - 1);
            int i = STROKE_BUF_CAP - 1;
            strokeT[i] = t;
            strokeAx[i] = ax;
            strokeAy[i] = ay;
            strokeAz[i] = az;
        }
    }

    private void updateNativeStrokeRate(long t) {
        if (!calibrated || strokeCount < 30 || t - lastStrokeComputeMs < STROKE_COMPUTE_MIN_MS) {
            return;
        }
        lastStrokeComputeMs = t;
        long cutoff = t - STROKE_BUF_MS;
        int start = 0;
        while (start < strokeCount && strokeT[start] < cutoff) start++;
        int n = strokeCount - start;
        if (n < 30) return;

        float sx = 0f;
        float sy = 0f;
        float sz = 0f;
        float[] lx = new float[n];
        float[] ly = new float[n];
        float[] lz = new float[n];
        for (int i = 0; i < n; i++) {
            int j = start + i;
            lx[i] = strokeAx[j] - gx;
            ly[i] = strokeAy[j] - gy;
            lz[i] = strokeAz[j] - gz;
            sx += lx[i];
            sy += ly[i];
            sz += lz[i];
        }
        sx = stdDevArray(lx, sx / n);
        sy = stdDevArray(ly, sy / n);
        sz = stdDevArray(lz, sz / n);
        float[] raw;
        if (sy >= sx && sy >= sz) raw = ly;
        else if (sz >= sx && sz >= sy) raw = lz;
        else raw = lx;

        long t0 = strokeT[start];
        long t1 = strokeT[strokeCount - 1];
        float dt = (t1 - t0) / Math.max(1f, n - 1f);
        int radius = Math.max(2, Math.round(STROKE_HP_WINDOW_MS / Math.max(1f, dt)));
        float[] hp = new float[n];
        float sumSq = 0f;
        for (int i = 0; i < n; i++) {
            float sum = 0f;
            int count = 0;
            for (int k = i - radius; k <= i + radius; k++) {
                if (k >= 0 && k < n) {
                    sum += raw[k];
                    count++;
                }
            }
            hp[i] = raw[i] - (count > 0 ? sum / count : raw[i]);
            sumSq += hp[i] * hp[i];
        }
        float rms = (float) Math.sqrt(sumSq / n);
        float minProminence = Math.max(0.08f, rms * 0.35f);
        float minPeakMs = 60000f / STROKE_RATE_MAX;
        float maxPeakMs = 60000f / STROKE_RATE_MIN;

        int peakCount = 0;
        long[] peakT = new long[16];
        float[] peakV = new float[16];
        for (int i = 2; i < n - 2; i++) {
            float v = hp[i];
            if (v <= hp[i - 1] || v <= hp[i + 1] || v < minProminence) continue;
            long pt = strokeT[start + i];
            if (peakCount > 0 && pt - peakT[peakCount - 1] < minPeakMs) {
                if (v > peakV[peakCount - 1]) {
                    peakT[peakCount - 1] = pt;
                    peakV[peakCount - 1] = v;
                }
                continue;
            }
            if (peakCount < peakT.length) {
                peakT[peakCount] = pt;
                peakV[peakCount] = v;
                peakCount++;
            }
        }
        if (peakCount < 3) return;

        int intervalCount = 0;
        float[] intervals = new float[peakCount];
        for (int i = 1; i < peakCount; i++) {
            float dtMs = peakT[i] - peakT[i - 1];
            if (dtMs >= minPeakMs && dtMs <= maxPeakMs) {
                intervals[intervalCount++] = dtMs;
            }
        }
        if (intervalCount < 2) return;
        java.util.Arrays.sort(intervals, 0, intervalCount);
        float medianMs = intervals[intervalCount / 2];
        float spm = Math.round((60000f / medianMs) * 10f) / 10f;
        if (spm < STROKE_RATE_MIN || spm > STROKE_RATE_MAX) return;
        setStrokeRate(this, spm);
    }

    private static float stdDevArray(float[] values, float mean) {
        if (values.length < 2) return 0f;
        float sum = 0f;
        for (float v : values) {
            float d = v - mean;
            sum += d * d;
        }
        return (float) Math.sqrt(sum / values.length);
    }

    private boolean appendFreshStrokeRate(JSONObject derived) throws org.json.JSONException {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!p.contains("lastStrokeRate")) return false;
        long age = System.currentTimeMillis() - p.getLong("lastStrokeRateMs", 0L);
        if (age > STROKE_RATE_MAX_AGE_MS) return false;
        float spm = p.getFloat("lastStrokeRate", -1f);
        if (spm < STROKE_RATE_MIN || spm > STROKE_RATE_MAX) return false;
        derived.put("strokeRate", Math.round(spm * 10) / 10.0);
        return true;
    }

    /** Mirrors recorder.ts derived.inBoatPark for server/debug visibility. */
    private boolean appendEconomyDerived(JSONObject derived) throws org.json.JSONException {
        loadEconomyFromPrefs();
        if (!economyActive) return false;
        derived.put("inBoatPark", true);
        return true;
    }

    private void normalizeUpright() {
        float mag = (float) Math.sqrt(uprightX * uprightX + uprightY * uprightY + uprightZ * uprightZ);
        if (mag < 1e-3f) return;
        uprightX /= mag;
        uprightY /= mag;
        uprightZ /= mag;
    }

    private void schedulePendingFlush() {
        mainHandler.removeCallbacks(pendingFlushRunnable);
        mainHandler.postDelayed(pendingFlushRunnable, PENDING_FLUSH_INTERVAL_MS);
    }

    private void registerSensors() {
        if (sensorManager == null) return;
        if (enableMotion && accelerometer != null) {
            sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME);
        } else if (enableGps && compassAvailable && accelerometer != null) {
            sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_UI);
        }
        if (enableGps && compassAvailable) {
            if (rotationVector != null) {
                sensorManager.registerListener(this, rotationVector, SensorManager.SENSOR_DELAY_UI);
            } else if (magnetometer != null) {
                sensorManager.registerListener(this, magnetometer, SensorManager.SENSOR_DELAY_UI);
            }
        }
    }

    private void updateCompassFromRotationVector(float[] rvIn) {
        try {
            float[] rv = rvIn;
            if (rvIn.length > 4) {
                float[] trimmed = new float[4];
                System.arraycopy(rvIn, 0, trimmed, 0, 4);
                rv = trimmed;
            }
            SensorManager.getRotationMatrixFromVector(rotationMatrix, rv);
            SensorManager.getOrientation(rotationMatrix, orientationAngles);
            float deg = (float) Math.toDegrees(orientationAngles[0]);
            compassHeadingDeg = (deg + 360f) % 360f;
        } catch (Exception e) {
            compassHeadingDeg = Float.NaN;
        }
    }

    private void updateCompassFromAccelMag() {
        if (!magnetDataReady || magnetometer == null || rotationVector != null) return;
        float[] gravity = new float[] { gx, gy, gz };
        float[] geomagnetic = new float[] { magnetData[0], magnetData[1], magnetData[2] };
        if (SensorManager.getRotationMatrix(rotationMatrix, null, gravity, geomagnetic)) {
            SensorManager.getOrientation(rotationMatrix, orientationAngles);
            float deg = (float) Math.toDegrees(orientationAngles[0]);
            compassHeadingDeg = (deg + 360f) % 360f;
        }
    }

    private void unregisterSensor() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
        magnetDataReady = false;
        compassHeadingDeg = Float.NaN;
    }

    /** Reject null-island / invalid coords only (accuracy filtered server-side for smoothing). */
    private static boolean isGpsFixUsable(Location location) {
        if (location == null) return false;
        double lat = location.getLatitude();
        double lon = location.getLongitude();
        if (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4) return false;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
        return true;
    }

    /**
     * Sample ingest timestamp — prefer fix time; use wall clock when fix clock stalls (KRI model).
     */
    private static long ingestTimeMs(Location location) {
        long now = System.currentTimeMillis();
        if (location == null) return now;
        long fixTime = location.getTime();
        if (fixTime <= 0L || fixTime > now + 5_000L) return now;
        long fixAge = now - fixTime;
        if (fixAge > GPS_STALE_FIX_CLOCK_MS) return now;
        return fixTime;
    }

    private void registerLocation() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "ACCESS_FINE_LOCATION not granted — native GPS disabled");
            return;
        }
        unregisterLocation();
        registerFusedLocation();
    }

    private void registerFusedLocation() {
        if (fusedClient == null) {
            registerLegacyLocation();
            return;
        }
        long interval = locationTrackingIntervalMs();
        long minUpdate = Math.max(FUSED_MIN_UPDATE_MS, interval / 2);
        LocationRequest request =
                new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, interval)
                        .setMinUpdateIntervalMillis(minUpdate)
                        .setMaxUpdateDelayMillis(interval)
                        .setMaxUpdateAgeMillis(FUSED_MAX_UPDATE_AGE_MS)
                        .setWaitForAccurateLocation(false)
                        .build();
        fusedCallback =
                new LocationCallback() {
                    @Override
                    public void onLocationResult(@NonNull LocationResult result) {
                        Location loc = result.getLastLocation();
                        if (loc != null) deliverLocation(loc);
                    }
                };
        fusedClient
                .requestLocationUpdates(request, fusedCallback, Looper.getMainLooper())
                .addOnSuccessListener(
                        unused -> Log.i(TAG, "Fused location registered (" + interval + "ms)"))
                .addOnFailureListener(
                        e -> {
                            Log.w(TAG, "Fused location unavailable, using legacy", e);
                            registerLegacyLocation();
                        });
        fusedClient
                .getLastLocation()
                .addOnSuccessListener(
                        loc -> {
                            if (loc != null && isGpsFixFresh(loc)) {
                                deliverLocation(loc);
                            } else if (loc != null) {
                                cacheGpsLocation(loc);
                            }
                        });
    }

    private void registerLegacyLocation() {
        if (locationManager == null) {
            Log.e(TAG, "No LocationManager");
            return;
        }
        long minTime = locationTrackingIntervalMs();
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.GPS_PROVIDER, minTime, 0f, this, mainHandler.getLooper());
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.NETWORK_PROVIDER, minTime, 0f, this, mainHandler.getLooper());
            }
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last == null) {
                last = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            }
            if (last != null && isGpsFixFresh(last)) {
                deliverLocation(last);
            } else if (last != null) {
                cacheGpsLocation(last);
            }
            Log.i(TAG, "Legacy location updates registered (" + minTime + "ms)");
        } catch (SecurityException e) {
            Log.e(TAG, "Location permission error", e);
        }
    }

    private void unregisterLocation() {
        if (fusedClient != null && fusedCallback != null) {
            fusedClient.removeLocationUpdates(fusedCallback);
            fusedCallback = null;
        }
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
            } catch (SecurityException ignored) {
            }
        }
    }

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CrewSight::SessionRecorder");
        wakeLock.acquire(4 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch =
            new NotificationChannel(
                CHANNEL_ID,
                "Session recording (native)",
                NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("GPS and capsize monitoring while recording");
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(ch);

        NotificationChannel alertCh =
            new NotificationChannel(
                CHANNEL_ID + "_alert",
                "Capsize alerts",
                NotificationManager.IMPORTANCE_HIGH);
        alertCh.enableVibration(true);
        if (nm != null) nm.createNotificationChannel(alertCh);

        NotificationChannel crewCh =
            new NotificationChannel(
                CrewMessageHelper.CHANNEL_ID,
                "Coach messages",
                NotificationManager.IMPORTANCE_HIGH);
        crewCh.enableVibration(true);
        if (nm != null) nm.createNotificationChannel(crewCh);

        NotificationChannel zoneCh =
            new NotificationChannel(
                CHANNEL_ID + "_zone",
                "Course warnings",
                NotificationManager.IMPORTANCE_HIGH);
        zoneCh.enableVibration(true);
        if (nm != null) nm.createNotificationChannel(zoneCh);
    }

    private void loadStandbyFlagsFromPrefs() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        standbyMode = p.getBoolean("standbyArmed", false) && !p.getBoolean("recordingActive", false);
        standbyOutsideSinceMs = p.getLong("standbyOutsideSinceMs", 0L);
        standbyLastFreshFixMs = p.getLong("standbyLastFreshFixMs", 0L);
        standbyInsideZoneName = p.getString("standbyInsideZoneName", "");
        standbyAutoStartTriggered = p.getBoolean("standbyAutoStartTriggered", false);
    }

    private void persistStandbyState() {
        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putBoolean("standbyArmed", standbyMode)
                .putLong("standbyOutsideSinceMs", standbyOutsideSinceMs)
                .putLong("standbyLastFreshFixMs", standbyLastFreshFixMs)
                .putString("standbyInsideZoneName", standbyInsideZoneName != null ? standbyInsideZoneName : "")
                .putBoolean("standbyAutoStartTriggered", standbyAutoStartTriggered)
                .apply();
        mirrorSessionPrefsToDeviceProtected(getApplicationContext());
    }

    private void scheduleStandbyDwellTick() {
        if (!standbyMode) return;
        mainHandler.removeCallbacks(standbyDwellRunnable);
        mainHandler.postDelayed(standbyDwellRunnable, STANDBY_DWELL_TICK_MS);
    }

    private void handleStandbyLocation(Location location) {
        if (!standbyMode || standbyAutoStartTriggered || location == null) return;
        long now = System.currentTimeMillis();
        long fixMs = ingestTimeMs(location);
        long fixAge = now - fixMs;
        if (fixAge > STANDBY_MAX_FIX_AGE_MS) {
            updateStandbyNotification("GPS stale — waiting for fresh fix…");
            return;
        }
        standbyLastFreshFixMs = fixMs;
        maybeNotifyZoneEntry(location.getLatitude(), location.getLongitude());
        boolean inside =
                GeofenceHelper.isInsideAutoStartBlockingZone(
                        getApplicationContext(), location.getLatitude(), location.getLongitude());
        if (inside) {
            standbyOutsideSinceMs = 0L;
            standbyInsideZoneName =
                    GeofenceHelper.autoStartBlockingZoneName(
                            getApplicationContext(), location.getLatitude(), location.getLongitude());
            updateStandbyNotification("In " + standbyInsideZoneName + " — leave park to auto-start");
        } else {
            if (standbyOutsideSinceMs <= 0L) {
                standbyOutsideSinceMs = now;
            }
            long dwellMs = GeofenceHelper.standbyDwellMs(getApplicationContext());
            long elapsed = now - standbyOutsideSinceMs;
            if (elapsed < dwellMs) {
                int left = (int) Math.ceil((dwellMs - elapsed) / 1000.0);
                updateStandbyNotification("Outside park — auto-start in " + left + "s");
            } else {
                updateStandbyNotification("Starting session…");
            }
            tryStandbyAutoStart();
        }
        persistStandbyState();
    }

    private void tryStandbyAutoStart() {
        if (!standbyMode || standbyAutoStartTriggered) return;
        long now = System.currentTimeMillis();
        if (standbyOutsideSinceMs <= 0L) return;
        if (now - standbyLastFreshFixMs > STANDBY_MAX_FIX_AGE_MS) return;
        long dwellMs = GeofenceHelper.standbyDwellMs(getApplicationContext());
        if (now - standbyOutsideSinceMs < dwellMs) return;
        standbyAutoStartTriggered = true;
        persistStandbyState();
        triggerNativeAutoStart();
    }

    private void triggerNativeAutoStart() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String deviceId = p.getString("deviceId", "");
        String ingestUrl = p.getString("ingestUrl", "");
        if (deviceId == null || deviceId.isEmpty() || ingestUrl == null || ingestUrl.isEmpty()) {
            Log.e(TAG, "Auto-start aborted — missing ingest config");
            standbyAutoStartTriggered = false;
            persistStandbyState();
            return;
        }
        String sessionId = UUID.randomUUID().toString();
        long startedAt = System.currentTimeMillis();
        boolean restoreMotion = p.getBoolean("standbySavedEnableMotion", true);
        long restoreGpsInterval = Math.max(500L, p.getLong("standbySavedGpsIntervalMs", 1000L));
        p.edit()
                .putString("sessionId", sessionId)
                .putBoolean("recordingActive", true)
                .putBoolean("standbyArmed", false)
                .putBoolean("standbyAutoStartTriggered", false)
                .putBoolean("autoStartedSession", true)
                .putLong("recordingStartedAt", startedAt)
                .putBoolean("enableGps", true)
                .putBoolean("enableMotion", restoreMotion)
                .putLong("gpsIntervalMs", restoreGpsInterval)
                .putBoolean("economyActive", false)
                .putBoolean("suppressRecordingActive", false)
                .putInt("uploadSeq", 0)
                .putInt("uploadOkCount", 0)
                .putInt("uploadFailCount", 0)
                .putInt(HEARTBEAT_GPS_COUNT_KEY, 0)
                .putString(PENDING_BATCHES_KEY, "[]")
                .apply();
        mirrorSessionPrefsToDeviceProtected(getApplicationContext());
        Log.i(TAG, "Geofence auto-start — new session " + sessionId.substring(0, 8));
        enterRecordingModeFromStandby();
        final String ingestToken = p.getString("ingestToken", "");
        uploadExecutor.execute(
                () -> {
                    boolean synced =
                            GeofenceSyncHelper.fetchAndSaveGeofences(
                                    getApplicationContext(), ingestUrl, ingestToken);
                    if (synced) {
                        mainHandler.post(
                                () -> {
                                    Location loc = latestGpsLocation;
                                    if (loc != null) {
                                        maybeApplyGeofenceEconomy(
                                                loc.getLatitude(), loc.getLongitude());
                                    }
                                });
                    }
                    enqueueSessionStartSample(startedAt);
                });
        updateRecordingNotification("Session auto-started — GPS tracking active");
    }

    private void enterRecordingModeFromStandby() {
        standbyMode = false;
        standbyOutsideSinceMs = 0L;
        standbyInsideZoneName = "";
        standbyAutoStartTriggered = false;
        mainHandler.removeCallbacks(standbyDwellRunnable);
        loadSessionFlagsFromPrefs();
        ingestBuffer = new JSONArray();
        lastIngestFlushMs = 0L;
        lastSuccessfulUploadMs = 0L;
        lastBatteryReportMs = 0L;
        lastGpsUploadWallMs = 0L;
        lastGpsSampleOfferedMs = 0L;
        latestGpsRawFixClockMs = 0L;
        lastUploadedFixTimeMs = 0L;
        lastUploadedGpsBucket = -1L;
        lastStaleGpsPiggybackWallMs = 0L;
        gpsWindowBuffer.clear();
        lastWindowCollectWallMs = 0L;
        lastNativeGeofenceSignature = "";
        lastNotifyZoneKey = "";
        notifyZoneInitialized = false;
        if (enableMotion || (enableGps && compassAvailable)) {
            registerSensors();
        }
        if (enableGps) {
            registerLocation();
            scheduleGpsFlush();
            tickScheduledGpsUpload();
        }
        schedulePendingFlush();
        scheduleIngestFlush();
        scheduleHeartbeat();
    }

    private void enterStandbyModeFromRecording() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String sessionId = p.getString("sessionId", "");
        String deviceId = p.getString("deviceId", "");
        if (sessionId != null
                && !sessionId.isEmpty()
                && deviceId != null
                && !deviceId.isEmpty()) {
            final String sid = sessionId;
            final String did = deviceId;
            uploadExecutor.execute(
                    () -> postSessionEnd(p, sid, did, System.currentTimeMillis()));
        }
        uploadExecutor.execute(this::flushIngestBufferNow);
        mainHandler.removeCallbacks(heartbeatRunnable);
        mainHandler.removeCallbacks(ingestFlushRunnable);
        mainHandler.removeCallbacks(pendingFlushRunnable);
        mainHandler.removeCallbacks(gpsFlushRunnable);
        unregisterSensor();
        standbyMode = true;
        standbyAutoStartTriggered = false;
        standbyOutsideSinceMs = 0L;
        standbyInsideZoneName = "";
        enableMotion = false;
        economyActive = false;
        suppressRecordingActive = false;
        capsizeActive = false;
        cancelAlertNotification();
        ingestBuffer = new JSONArray();
        gpsWindowBuffer.clear();
        persistStandbyState();
        if (enableGps) {
            registerLocation();
            Location loc = latestGpsLocation;
            if (loc != null) {
                handleStandbyLocation(loc);
            }
        }
        scheduleStandbyDwellTick();
        updateStandbyNotification("Armed — waiting for GPS…");
        Log.i(TAG, "Transitioned recording → geofence standby");
    }

    private void updateStandbyNotification(String detail) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pi =
                PendingIntent.getActivity(
                        this,
                        0,
                        launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification =
                new NotificationCompat.Builder(this, CHANNEL_ID)
                        .setContentTitle("CrewSight standby")
                        .setContentText(detail)
                        .setSmallIcon(R.drawable.ic_stat_rowing_shell)
                        .setContentIntent(pi)
                        .setOngoing(true)
                        .setPriority(NotificationCompat.PRIORITY_LOW)
                        .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            if (Build.VERSION.SDK_INT >= 34) {
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
            }
            ServiceCompat.startForeground(this, NOTIF_ID_FOREGROUND, notification, types);
        } else {
            startForeground(NOTIF_ID_FOREGROUND, notification);
        }
    }

    private void updateRecordingNotification(String detail) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pi =
                PendingIntent.getActivity(
                        this,
                        0,
                        launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification =
                new NotificationCompat.Builder(this, CHANNEL_ID)
                        .setContentTitle("CrewSight session recording")
                        .setContentText(detail)
                        .setSmallIcon(R.drawable.ic_stat_rowing_shell)
                        .setContentIntent(pi)
                        .setOngoing(true)
                        .setPriority(NotificationCompat.PRIORITY_LOW)
                        .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            if (Build.VERSION.SDK_INT >= 34) {
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
            }
            ServiceCompat.startForeground(this, NOTIF_ID_FOREGROUND, notification, types);
        } else {
            startForeground(NOTIF_ID_FOREGROUND, notification);
        }
    }

    public static void armGeofenceStandby(
            Context ctx,
            String deviceId,
            String ingestUrl,
            String ingestToken,
            String athleteId,
            boolean enableGps,
            boolean enableMotion,
            long gpsIntervalMs) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        p.edit()
                .putString("deviceId", deviceId != null ? deviceId : "")
                .putString("ingestUrl", ingestUrl != null ? ingestUrl : "")
                .putString("ingestToken", ingestToken != null ? ingestToken : "")
                .putString("athleteId", athleteId != null ? athleteId : "")
                .putBoolean("enableGps", enableGps)
                .putBoolean("standbySavedEnableMotion", enableMotion)
                .putLong("standbySavedGpsIntervalMs", Math.max(500L, gpsIntervalMs))
                .putBoolean("recordingActive", false)
                .putBoolean("standbyArmed", true)
                .putLong("standbyArmedAt", System.currentTimeMillis())
                .putLong("standbyOutsideSinceMs", 0L)
                .putLong("standbyLastFreshFixMs", 0L)
                .putString("standbyInsideZoneName", "")
                .putBoolean("standbyAutoStartTriggered", false)
                .putBoolean("autoStartedSession", false)
                .apply();
        mirrorSessionPrefsToDeviceProtected(ctx);
        CapsizeMonitorService inst = runningInstance != null ? runningInstance.get() : null;
        if (inst != null && !p.getBoolean("recordingActive", false)) {
            inst.mainHandler.post(inst::enterStandbyModeFromRecording);
            return;
        }
        Intent intent = new Intent(ctx, CapsizeMonitorService.class);
        intent.putExtra("standbyResume", true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
    }

    public static void transitionToStandby(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        p.edit()
                .putBoolean("recordingActive", false)
                .putBoolean("standbyArmed", true)
                .putLong("standbyArmedAt", System.currentTimeMillis())
                .putLong("standbyOutsideSinceMs", 0L)
                .putLong("standbyLastFreshFixMs", 0L)
                .putString("standbyInsideZoneName", "")
                .putBoolean("standbyAutoStartTriggered", false)
                .putBoolean("autoStartedSession", false)
                .putBoolean("standbySavedEnableMotion", p.getBoolean("enableMotion", true))
                .putLong("standbySavedGpsIntervalMs", Math.max(500L, p.getLong("gpsIntervalMs", 1000L)))
                .apply();
        mirrorSessionPrefsToDeviceProtected(ctx);
        CapsizeMonitorService inst = runningInstance != null ? runningInstance.get() : null;
        if (inst != null) {
            inst.mainHandler.post(inst::enterStandbyModeFromRecording);
            return;
        }
        Intent intent = new Intent(ctx, CapsizeMonitorService.class);
        intent.putExtra("standbyResume", true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
    }

    public static void disarmGeofenceStandby(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean recordingActive = p.getBoolean("recordingActive", false);
        p.edit()
                .putBoolean("standbyArmed", false)
                .putLong("standbyOutsideSinceMs", 0L)
                .putBoolean("standbyAutoStartTriggered", false)
                .apply();
        mirrorSessionPrefsToDeviceProtected(ctx);
        CapsizeMonitorService inst = runningInstance != null ? runningInstance.get() : null;
        if (inst != null && !recordingActive) {
            inst.stopSelf();
        }
    }

    public static JSONObject getStandbyStatus(Context ctx) throws Exception {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        JSONObject ret = new JSONObject();
        boolean armed = p.getBoolean("standbyArmed", false) && !p.getBoolean("recordingActive", false);
        ret.put("armed", armed);
        if (!armed) {
            ret.put("inside", false);
            ret.put("zoneName", JSONObject.NULL);
            ret.put("message", "Standby off");
            ret.put("outsideDwellRemainingSec", JSONObject.NULL);
            return ret;
        }
        long outsideSince = p.getLong("standbyOutsideSinceMs", 0L);
        long lastFresh = p.getLong("standbyLastFreshFixMs", 0L);
        String zoneName = p.getString("standbyInsideZoneName", "");
        boolean inside = outsideSince <= 0L && zoneName != null && !zoneName.isEmpty();
        ret.put("inside", inside);
        ret.put("zoneName", inside && zoneName != null && !zoneName.isEmpty() ? zoneName : JSONObject.NULL);
        long now = System.currentTimeMillis();
        if (now - lastFresh > STANDBY_MAX_FIX_AGE_MS) {
            ret.put("message", "GPS stale — waiting for fresh fix…");
            ret.put("outsideDwellRemainingSec", JSONObject.NULL);
            return ret;
        }
        if (inside) {
            ret.put("message", "In " + zoneName + " — leave park to auto-start");
            ret.put("outsideDwellRemainingSec", JSONObject.NULL);
            return ret;
        }
        if (outsideSince <= 0L) {
            ret.put("message", "Armed — waiting for GPS…");
            ret.put("outsideDwellRemainingSec", JSONObject.NULL);
            return ret;
        }
        long dwellMs = GeofenceHelper.standbyDwellMs(ctx);
        long elapsed = now - outsideSince;
        if (elapsed < dwellMs) {
            int left = (int) Math.ceil((dwellMs - elapsed) / 1000.0);
            ret.put("message", "Outside park — auto-start in " + left + "s");
            ret.put("outsideDwellRemainingSec", left);
        } else {
            ret.put("message", "Starting session…");
            ret.put("outsideDwellRemainingSec", 0);
        }
        return ret;
    }

    private Notification buildForegroundNotification() {
        Intent launch = new Intent(this, MainActivity.class);
        if (standbyMode) {
            String detail =
                    standbyInsideZoneName != null && !standbyInsideZoneName.isEmpty()
                            ? "In " + standbyInsideZoneName + " — leave park to auto-start"
                            : "Leave boat park to auto-start session";
            PendingIntent pi =
                    PendingIntent.getActivity(
                            this,
                            0,
                            launch,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            return new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setContentTitle("CrewSight standby")
                    .setContentText(detail)
                    .setSmallIcon(R.drawable.ic_stat_rowing_shell)
                    .setContentIntent(pi)
                    .setOngoing(true)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .build();
        }
        PendingIntent pi =
            PendingIntent.getActivity(
                this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String detail;
        if (enableGps && enableMotion) {
            detail = "GPS + capsize — runs with screen off";
        } else if (enableGps) {
            detail = "GPS tracking — runs with screen off";
        } else {
            detail = "Capsize monitoring — runs with screen off";
        }
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CrewSight session recording")
            .setContentText(detail)
            .setSmallIcon(R.drawable.ic_stat_rowing_shell)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void showAlertNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pi =
            PendingIntent.getActivity(
                this, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n =
            new NotificationCompat.Builder(this, CHANNEL_ID + "_alert")
                .setContentTitle("CAPSIZE ALERT")
                .setContentText("Boat tipped — check crew immediately")
                .setSmallIcon(R.drawable.ic_stat_rnz_alert)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
                .build();
        nm.notify(NOTIF_ID_ALERT, n);
    }

    private void showZoneEntryNotification(JSONObject zone) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || zone == null) return;
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pi =
            PendingIntent.getActivity(
                this, 3, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String body = GeofenceHelper.entryNotifyMessage(zone);
        Notification n =
            new NotificationCompat.Builder(this, CHANNEL_ID + "_zone")
                .setContentTitle("Course warning")
                .setContentText(body)
                .setSmallIcon(R.drawable.ic_stat_rowing_shell)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
                .build();
        nm.notify(NOTIF_ID_ZONE_WARNING, n);
        Log.i(TAG, "Geofence entry notification: " + zone.optString("name", "?"));
    }

    private void cancelAlertNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTIF_ID_ALERT);
    }

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
