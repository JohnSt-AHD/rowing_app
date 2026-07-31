package nz.org.rowing.recorder;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;

/**
 * Guides the user through notifications, location (including background), and
 * unrestricted battery — required for screen-off GPS recording.
 */
public final class RecordingSetupHelper {

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

        boolean openedLocationSettings = false;
        if (hasFineLocation(ctx) && !hasBackgroundLocation(ctx)) {
            openedLocationSettings = openAppDetailsSettings(activity);
        }
        out.put("openedLocationSettings", openedLocationSettings);

        boolean openedBatterySettings = false;
        if (!isBatteryUnrestricted(ctx)) {
            openedBatterySettings = openBatteryUnrestrictedSettings(activity);
        }
        out.put("openedBatterySettings", openedBatterySettings);

        PluginCall call = pendingCall;
        clearPending();
        call.resolve(out);
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
        JSObject o = new JSObject();
        o.put("notifications", notif);
        o.put("locationForeground", fine);
        o.put("locationBackground", background);
        o.put("locationAlways", fine && background);
        o.put("batteryUnrestricted", battery);
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
}
