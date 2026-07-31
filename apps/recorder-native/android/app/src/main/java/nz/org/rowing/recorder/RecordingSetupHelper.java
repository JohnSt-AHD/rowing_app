package nz.org.rowing.recorder;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.IntentCompat;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;

/**
 * Guides the user through notifications, location (including background), and
 * unrestricted battery — required for screen-off GPS recording.
 */
public final class RecordingSetupHelper {

    private static final String TAG = "RecordingSetup";
    private static final int REQ_NOTIFICATIONS = 9101;
    private static final int REQ_FINE_LOCATION = 9102;
    private static final int REQ_BACKGROUND_LOCATION = 9103;

    private static PluginCall pendingCall;

    private RecordingSetupHelper() {}

    public static void startPrepare(Plugin plugin, PluginCall call) {
        Activity activity = plugin.getActivity();
        if (activity == null) {
            call.reject("No activity");
            return;
        }
        pendingCall = call;
        runNextStep(activity);
    }

    public static void onRequestPermissionsResult(
            Activity activity, int requestCode, int[] grantResults) {
        if (pendingCall == null) return;
        if (grantResults == null || grantResults.length == 0) {
            if (requestCode == REQ_BACKGROUND_LOCATION) {
                finishPrepare(activity);
            }
            return;
        }
        for (int r : grantResults) {
            if (r != PackageManager.PERMISSION_GRANTED) {
                if (requestCode == REQ_BACKGROUND_LOCATION) {
                    finishPrepare(activity);
                    return;
                }
                break;
            }
        }
        runNextStep(activity);
    }

    private static void runNextStep(Activity activity) {
        if (pendingCall == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && !hasNotifications(activity)) {
            ActivityCompat.requestPermissions(
                    activity,
                    new String[] {Manifest.permission.POST_NOTIFICATIONS},
                    REQ_NOTIFICATIONS);
            return;
        }

        if (!hasFineLocation(activity)) {
            ActivityCompat.requestPermissions(
                    activity,
                    new String[] {
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    },
                    REQ_FINE_LOCATION);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && !hasBackgroundLocation(activity)) {
            ActivityCompat.requestPermissions(
                    activity,
                    new String[] {Manifest.permission.ACCESS_BACKGROUND_LOCATION},
                    REQ_BACKGROUND_LOCATION);
            return;
        }

        finishPrepare(activity);
    }

    private static void finishPrepare(Activity activity) {
        Context ctx = activity.getApplicationContext();
        JSObject out = buildStatus(ctx);

        String settingsStep = nextSettingsStep(ctx);
        out.put("openedLocationSettings", "location".equals(settingsStep));
        out.put("openedBatterySettings", "battery".equals(settingsStep));
        out.put("openedDataSaverSettings", "dataSaver".equals(settingsStep));
        out.put("openedUnusedAppSettings", "unusedApp".equals(settingsStep));

        PluginCall call = pendingCall;
        clearPending();
        call.resolve(out);

        if (settingsStep != null) {
            final String step = settingsStep;
            new Handler(Looper.getMainLooper())
                    .post(
                            () -> {
                                if (activity.isFinishing()) return;
                                openSettingsStep(activity, step);
                            });
        }
    }

    /** Highest-priority missing setting — only one screen per prepareRecording call. */
    private static String nextSettingsStep(Context ctx) {
        if (hasFineLocation(ctx) && !hasBackgroundLocation(ctx)) return "location";
        if (!isBatteryUnrestricted(ctx)) return "battery";
        if (!isDataSaverBypassed(ctx)) return "dataSaver";
        if (!isUnusedAppRestrictionsDisabled(ctx)) return "unusedApp";
        return null;
    }

    private static void openSettingsStep(Activity activity, String step) {
        if (activity.isFinishing()) return;
        try {
            switch (step) {
                case "location":
                    openAppDetailsSettings(activity);
                    break;
                case "battery":
                    openBatteryUnrestrictedSettings(activity);
                    break;
                case "dataSaver":
                    openDataSaverBypassSettings(activity);
                    break;
                case "unusedApp":
                    openUnusedAppRestrictionsSettings(activity);
                    break;
                default:
                    break;
            }
        } catch (Exception e) {
            Log.w(TAG, "Settings step " + step + " failed: " + e.getMessage());
        }
    }

    private static void clearPending() {
        pendingCall = null;
    }

    public static JSObject buildStatus(Context ctx) {
        boolean notif =
                Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                        || hasNotifications(ctx);
        boolean fine = hasFineLocation(ctx);
        boolean background =
                Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || hasBackgroundLocation(ctx);
        boolean battery = isBatteryUnrestricted(ctx);
        boolean dataSaverBypass = isDataSaverBypassed(ctx);
        boolean unusedAppRestrictionsDisabled = isUnusedAppRestrictionsDisabled(ctx);
        JSObject o = new JSObject();
        o.put("notifications", notif);
        o.put("locationForeground", fine);
        o.put("locationBackground", background);
        o.put("locationAlways", fine && background);
        o.put("batteryUnrestricted", battery);
        o.put("dataSaverBypass", dataSaverBypass);
        o.put("unusedAppRestrictionsDisabled", unusedAppRestrictionsDisabled);
        o.put(
                "ready",
                notif && fine && background && battery);
        return o;
    }

    private static boolean hasNotifications(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean hasFineLocation(Context ctx) {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean hasBackgroundLocation(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        return ContextCompat.checkSelfPermission(
                        ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean isBatteryUnrestricted(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm == null) return true;
        return pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    /** True when Data Saver is off or this app may use background mobile data. */
    private static boolean isDataSaverBypassed(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return true;
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            int status = cm.getRestrictBackgroundStatus();
            return status == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED
                    || status == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED;
        } catch (Exception e) {
            Log.w(TAG, "Data saver status unavailable: " + e.getMessage());
            return true;
        }
    }

    /** True when "Remove/Pause app if unused" style restrictions are off for this app. */
    private static boolean isUnusedAppRestrictionsDisabled(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return true;
        try {
            return ctx.getPackageManager().isAutoRevokeWhitelisted(ctx.getPackageName());
        } catch (Exception e) {
            return true;
        }
    }

    private static boolean openAppDetailsSettings(Activity activity) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", activity.getPackageName(), null));
            activity.startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean openBatteryUnrestrictedSettings(Activity activity) {
        try {
            Intent intent =
                    new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
            return true;
        } catch (Exception e) {
            try {
                Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                activity.startActivity(intent);
                return true;
            } catch (Exception e2) {
                return false;
            }
        }
    }

    private static boolean openDataSaverBypassSettings(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;
        try {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS);
            intent.setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Data saver settings intent failed: " + e.getMessage());
            return false;
        }
    }

    private static boolean openUnusedAppRestrictionsSettings(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false;
        try {
            Intent intent =
                    IntentCompat.createManageUnusedAppRestrictionsIntent(
                            activity, activity.getPackageName());
            activity.startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Unused-app settings intent failed: " + e.getMessage());
            return false;
        }
    }
}
