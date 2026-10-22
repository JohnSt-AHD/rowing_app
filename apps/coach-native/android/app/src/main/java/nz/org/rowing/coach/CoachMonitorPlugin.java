package nz.org.rowing.coach;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
        name = "CoachMonitor",
        permissions = {
            @Permission(
                    alias = "location",
                    strings = {
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    })
        })
public class CoachMonitorPlugin extends Plugin {

    private static final int REQ_BACKGROUND_LOCATION = 9211;

    @PluginMethod
    public void startMonitoring(PluginCall call) {
        String apiBaseUrl = call.getString("apiBaseUrl");
        if (apiBaseUrl == null || apiBaseUrl.trim().isEmpty()) {
            call.reject("apiBaseUrl is required");
            return;
        }
        boolean share = Boolean.TRUE.equals(call.getBoolean("shareLocation", false));
        if (share && getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "onLocationPerms");
            return;
        }
        launchService(call);
        maybeAskBackgroundLocation(share);
        call.resolve();
    }

    @PermissionCallback
    private void onLocationPerms(PluginCall call) {
        launchService(call);
        maybeAskBackgroundLocation(Boolean.TRUE.equals(call.getBoolean("shareLocation", false)));
        call.resolve();
    }

    @PluginMethod
    public void stopMonitoring(PluginCall call) {
        CoachMonitorService.clearMonitoring(getContext());
        Intent intent = new Intent(getContext(), CoachMonitorService.class);
        intent.setAction(CoachMonitorService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        SharedPreferences p =
                getContext()
                        .getSharedPreferences(
                                CoachMonitorService.PREFS, android.content.Context.MODE_PRIVATE);
        boolean active = p.getBoolean("monitoringActive", false);
        boolean running = CoachMonitorService.isServiceRunning();
        JSObject ret = new JSObject();
        ret.put("active", active);
        ret.put("serviceRunning", running);
        ret.put("shareLocation", p.getBoolean("shareLocation", false));
        call.resolve(ret);
    }

    private void launchService(PluginCall call) {
        Intent intent = new Intent(getContext(), CoachMonitorService.class);
        intent.putExtra("apiBaseUrl", call.getString("apiBaseUrl", "").trim());
        intent.putExtra("ingestToken", call.getString("ingestToken", ""));
        Integer pollMs = call.getInt("pollIntervalMs", 3000);
        intent.putExtra("pollIntervalMs", pollMs != null ? pollMs.longValue() : 3000L);
        boolean share = Boolean.TRUE.equals(call.getBoolean("shareLocation", false));
        intent.putExtra("shareLocation", share);
        intent.putExtra("coachName", call.getString("coachName", ""));
        Integer locMs = call.getInt("locationIntervalMs", 20_000);
        intent.putExtra("locationIntervalMs", locMs != null ? locMs.longValue() : 20_000L);
        intent.putExtra("sessionId", call.getString("sessionId", ""));
        getContext()
                .getSharedPreferences(CoachMonitorService.PREFS, android.content.Context.MODE_PRIVATE)
                .edit()
                .putBoolean("monitoringActive", true)
                .apply();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }

    private void maybeAskBackgroundLocation(boolean share) {
        if (!share || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        Activity activity = getActivity();
        if (activity == null) return;
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(
                activity,
                new String[] {Manifest.permission.ACCESS_BACKGROUND_LOCATION},
                REQ_BACKGROUND_LOCATION);
    }
}
