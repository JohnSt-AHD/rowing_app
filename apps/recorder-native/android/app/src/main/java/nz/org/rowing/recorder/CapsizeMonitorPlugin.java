package nz.org.rowing.recorder;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "CapsizeMonitor")
public class CapsizeMonitorPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String deviceId = call.getString("deviceId");
        String ingestUrl = call.getString("ingestUrl");
        if (sessionId == null || deviceId == null || ingestUrl == null) {
            call.reject("sessionId, deviceId, and ingestUrl are required");
            return;
        }
        Intent intent = new Intent(getContext(), CapsizeMonitorService.class);
        intent.putExtra("sessionId", sessionId);
        intent.putExtra("deviceId", deviceId);
        intent.putExtra("ingestUrl", ingestUrl);
        intent.putExtra("ingestToken", call.getString("ingestToken", ""));
        intent.putExtra("athleteId", call.getString("athleteId", ""));
        intent.putExtra("enableGps", call.getBoolean("enableGps", false));
        intent.putExtra("enableMotion", call.getBoolean("enableMotion", true));
        intent.putExtra("gpsIntervalMs", call.getInt("gpsIntervalMs", 1000));
        intent.putExtra("startedAt", call.getLong("startedAt", 0L));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        CapsizeMonitorService.clearRecordingSession(getContext());
        Intent intent = new Intent(getContext(), CapsizeMonitorService.class);
        getContext().stopService(intent);
        call.resolve();
    }

    @PluginMethod
    public void getActiveSession(PluginCall call) {
        SharedPreferences p =
            getContext().getSharedPreferences(CapsizeMonitorService.PREFS, android.content.Context.MODE_PRIVATE);
        boolean serviceRunning = CapsizeMonitorService.isServiceRunning();
        boolean standbyArmed = p.getBoolean("standbyArmed", false) && !p.getBoolean("recordingActive", false);
        boolean recordingActive = p.getBoolean("recordingActive", false);
        String sessionId = p.getString("sessionId", "");
        String deviceId = p.getString("deviceId", "");
        boolean hasSession =
            sessionId != null
                && !sessionId.isEmpty()
                && deviceId != null
                && !deviceId.isEmpty();
        boolean active = recordingActive && hasSession && !standbyArmed;

        JSObject ret = new JSObject();
        ret.put("active", active);
        ret.put("serviceRunning", serviceRunning);
        ret.put("standbyArmed", standbyArmed);
        ret.put("autoStartedSession", p.getBoolean("autoStartedSession", false));
        if (active) {
            ret.put("sessionId", sessionId);
            ret.put("deviceId", deviceId);
            ret.put("athleteId", p.getString("athleteId", ""));
            long startedAt = p.getLong("recordingStartedAt", 0L);
            if (startedAt > 0L) {
                ret.put("startedAt", startedAt);
            }
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void armGeofenceStandby(PluginCall call) {
        String deviceId = call.getString("deviceId");
        String ingestUrl = call.getString("ingestUrl");
        if (deviceId == null || ingestUrl == null) {
            call.reject("deviceId and ingestUrl are required");
            return;
        }
        CapsizeMonitorService.armGeofenceStandby(
                getContext(),
                deviceId,
                ingestUrl,
                call.getString("ingestToken", ""),
                call.getString("athleteId", ""),
                call.getBoolean("enableGps", true),
                call.getBoolean("enableMotion", true),
                call.getLong("gpsIntervalMs", 1000L));
        call.resolve();
    }

    @PluginMethod
    public void transitionToStandby(PluginCall call) {
        CapsizeMonitorService.transitionToStandby(getContext());
        call.resolve();
    }

    @PluginMethod
    public void disarmGeofenceStandby(PluginCall call) {
        CapsizeMonitorService.disarmGeofenceStandby(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getStandbyStatus(PluginCall call) {
        try {
            JSONObject data = CapsizeMonitorService.getStandbyStatus(getContext());
            call.resolve(jsonObjectToJSObject(data));
        } catch (Exception e) {
            call.reject("getStandbyStatus failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setStrokeRate(PluginCall call) {
        Double spm = call.getDouble("spm");
        if (spm == null) {
            call.reject("spm required");
            return;
        }
        CapsizeMonitorService.setStrokeRate(getContext(), spm.floatValue());
        call.resolve();
    }

    @PluginMethod
    public void setUpright(PluginCall call) {
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        Double z = call.getDouble("z");
        if (x == null || y == null || z == null) {
            call.reject("x, y, z required");
            return;
        }
        CapsizeMonitorService.setUpright(getContext(), x.floatValue(), y.floatValue(), z.floatValue());
        call.resolve();
    }

    @PluginMethod
    public void setGpsIntervalMs(PluginCall call) {
        Integer gpsIntervalMs = call.getInt("gpsIntervalMs", 1000);
        CapsizeMonitorService.setGpsIntervalMs(
            getContext(),
            gpsIntervalMs != null ? gpsIntervalMs.longValue() : 1000L);
        call.resolve();
    }

    @PluginMethod
    public void setEconomyMode(PluginCall call) {
        Boolean active = call.getBoolean("active", false);
        Integer gpsIntervalMs = call.getInt("gpsIntervalMs", 30000);
        Integer uploadIntervalMs = call.getInt("uploadIntervalMs", 30000);
        Boolean enableCapsize = call.getBoolean("enableCapsize", true);
        CapsizeMonitorService.setEconomyMode(
            getContext(),
            active != null && active,
            gpsIntervalMs != null ? gpsIntervalMs.longValue() : 30000L,
            uploadIntervalMs != null ? uploadIntervalMs.longValue() : 30000L,
            enableCapsize == null || enableCapsize,
            call.getBoolean("suppressRecording", false));
        call.resolve();
    }

    @PluginMethod
    public void setGeofences(PluginCall call) {
        com.getcapacitor.JSArray arr = call.getArray("geofences");
        String json = arr != null ? arr.toString() : "[]";
        CapsizeMonitorService.setGeofences(getContext(), json);
        call.resolve();
    }

    @PluginMethod
    public void checkRecordingSetup(PluginCall call) {
        call.resolve(RecordingSetupHelper.buildStatus(getContext()));
    }

    @PluginMethod
    public void prepareRecording(PluginCall call) {
        RecordingSetupHelper.startPrepare(this, call);
    }

    @PluginMethod
    public void getPulse(PluginCall call) {
        try {
            JSONObject data = CapsizeMonitorService.getPulseData(getContext());
            call.resolve(jsonObjectToJSObject(data));
        } catch (Exception e) {
            call.reject("getPulse failed: " + e.getMessage());
        }
    }

    private static JSObject jsonObjectToJSObject(JSONObject obj) throws Exception {
        JSObject out = new JSObject();
        JSONArray names = obj.names();
        if (names == null) return out;
        for (int i = 0; i < names.length(); i++) {
            String key = names.getString(i);
            Object value = obj.get(key);
            if (value instanceof JSONObject) {
                out.put(key, jsonObjectToJSObject((JSONObject) value));
            } else if (value == JSONObject.NULL) {
                out.put(key, null);
            } else {
                out.put(key, value);
            }
        }
        return out;
    }
}
