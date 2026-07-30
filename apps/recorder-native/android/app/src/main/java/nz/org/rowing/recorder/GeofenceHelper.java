package nz.org.rowing.recorder;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

/** Boat-park geofence geometry (mirrors recorder-pwa geofence.ts). */
final class GeofenceHelper {
    static final String PREFS_GEOFENCES_JSON = "geofencesJson";

    private static final double EARTH_RADIUS_M = 6371000d;

    private GeofenceHelper() {}

    static void saveGeofences(Context ctx, String json) {
        ctx.getSharedPreferences(CapsizeMonitorService.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(PREFS_GEOFENCES_JSON, json != null ? json : "[]")
                .apply();
    }

    static JSONObject findBoatParkAt(Context ctx, double lat, double lon) {
        if (!Double.isFinite(lat) || !Double.isFinite(lon)) return null;
        JSONArray geofences = loadGeofences(ctx);
        for (int i = 0; i < geofences.length(); i++) {
            JSONObject g = geofences.optJSONObject(i);
            if (g != null && pointInGeofence(g, lat, lon)) return g;
        }
        return null;
    }

    /** First enabled zone with notifyOnEnter at this point (any kind). */
    static JSONObject findNotifyZoneAt(Context ctx, double lat, double lon) {
        if (!Double.isFinite(lat) || !Double.isFinite(lon)) return null;
        JSONArray geofences = loadGeofences(ctx);
        for (int i = 0; i < geofences.length(); i++) {
            JSONObject g = geofences.optJSONObject(i);
            if (g != null && notifyOnEnter(g) && pointInZoneGeometry(g, lat, lon)) return g;
        }
        return null;
    }

    static boolean notifyOnEnter(JSONObject g) {
        if (g == null) return false;
        if (g.has("notifyOnEnter")) return g.optBoolean("notifyOnEnter", false);
        return g.optBoolean("notify_on_enter", false);
    }

    static String entryNotifyMessage(JSONObject g) {
        if (g == null) return "Check course ahead";
        String custom = g.optString("entryNotifyMessage", g.optString("entry_notify_message", "")).trim();
        if (!custom.isEmpty()) return custom;
        String name = g.optString("name", "zone").trim();
        if (name.isEmpty()) name = "zone";
        return "Please check course, " + name + " ahead";
    }

    static String zoneNotifyKey(JSONObject g) {
        if (g == null) return "";
        int id = g.optInt("id", -1);
        if (id > 0) return "id:" + id;
        return "name:" + g.optString("name", "");
    }

    private static JSONArray loadGeofences(Context ctx) {
        SharedPreferences p =
                ctx.getSharedPreferences(CapsizeMonitorService.PREFS, Context.MODE_PRIVATE);
        try {
            return new JSONArray(p.getString(PREFS_GEOFENCES_JSON, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static boolean pointInZoneGeometry(JSONObject g, double lat, double lon) {
        if (g == null || !g.optBoolean("enabled", true)) return false;
        String shape = g.optString("shapeType", g.optString("shape_type", "circle"));
        if ("polygon".equalsIgnoreCase(shape)) {
            return pointInPolygon(lat, lon, g.optJSONArray("polygonCoords"));
        }
        double centerLat = g.optDouble("centerLat", g.optDouble("center_lat", Double.NaN));
        double centerLon = g.optDouble("centerLon", g.optDouble("center_lon", Double.NaN));
        double radiusM = g.optDouble("radiusM", g.optDouble("radius_m", Double.NaN));
        return pointInCircle(lat, lon, centerLat, centerLon, radiusM);
    }

    static boolean pointInGeofence(JSONObject g, double lat, double lon) {
        if (g == null || g.optBoolean("enabled", true) == false) return false;
        if (!"boat_park".equals(g.optString("kind", "boat_park"))) return false;
        return pointInZoneGeometry(g, lat, lon);
    }

    static int economyIntervalSec(JSONObject g) {
        if (g == null) return 30;
        int unified = g.optInt("economyIntervalSec", -1);
        if (unified < 0) unified = g.optInt("economy_interval_sec", -1);
        if (unified >= 1) return Math.max(1, unified);
        int gps = g.optInt("economyGpsIntervalSec", -1);
        if (gps < 0) gps = g.optInt("economy_gps_interval_sec", -1);
        int upload = g.optInt("economyUploadIntervalSec", -1);
        if (upload < 0) upload = g.optInt("economy_upload_interval_sec", -1);
        if (gps >= 1 && upload >= 1) return Math.max(1, Math.max(gps, upload));
        if (gps >= 1) return Math.max(1, gps);
        if (upload >= 1) return Math.max(1, upload);
        return 30;
    }

    static boolean disableCapsize(JSONObject g) {
        if (g == null) return true;
        if (g.has("disableCapsize")) return g.optBoolean("disableCapsize", true);
        return g.optBoolean("disable_capsize", true);
    }

    static boolean suppressRecording(JSONObject g) {
        if (g == null) return false;
        if (g.has("suppressRecording")) return g.optBoolean("suppressRecording", false);
        return g.optBoolean("suppress_recording", false);
    }

    static boolean autoStopOnEnter(JSONObject g) {
        if (g == null) return false;
        if (g.has("autoStopOnEnter")) return g.optBoolean("autoStopOnEnter", false);
        return g.optBoolean("auto_stop_on_enter", false);
    }

    static boolean autoStartOnExit(JSONObject g) {
        if (g == null) return false;
        if (g.has("autoStartOnExit")) return g.optBoolean("autoStartOnExit", false);
        return g.optBoolean("auto_start_on_exit", false);
    }

    static int sessionDwellSec(JSONObject g) {
        if (g == null) return 45;
        int v = g.optInt("sessionDwellSec", -1);
        if (v < 0) v = g.optInt("session_dwell_sec", -1);
        if (v >= 5) return Math.min(600, Math.max(5, v));
        return 45;
    }

    /** Dwell before auto-start — mirrors geofence-standby.ts (min 5s). */
    static long standbyDwellMs(Context ctx) {
        JSONArray geofences = loadGeofences(ctx);
        for (int i = 0; i < geofences.length(); i++) {
            JSONObject g = geofences.optJSONObject(i);
            if (g != null && g.optBoolean("enabled", true) && autoStartOnExit(g)) {
                return Math.max(5000L, (long) sessionDwellSec(g) * 1000L);
            }
        }
        return 45_000L;
    }

    /** True when inside a boat-park zone that blocks auto-start until exit. */
    static boolean isInsideAutoStartBlockingZone(Context ctx, double lat, double lon) {
        JSONObject match = findBoatParkAt(ctx, lat, lon);
        return match != null && autoStartOnExit(match);
    }

    static String autoStartBlockingZoneName(Context ctx, double lat, double lon) {
        JSONObject match = findBoatParkAt(ctx, lat, lon);
        if (match != null && autoStartOnExit(match)) {
            return match.optString("name", "boat park");
        }
        return "";
    }

    private static boolean pointInCircle(
            double lat, double lon, double centerLat, double centerLon, double radiusM) {
        if (!Double.isFinite(centerLat)
                || !Double.isFinite(centerLon)
                || !Double.isFinite(radiusM)
                || radiusM <= 0d) {
            return false;
        }
        return distanceM(lat, lon, centerLat, centerLon) <= radiusM;
    }

    private static boolean pointInPolygon(double lat, double lon, JSONArray ring) {
        if (ring == null || ring.length() < 3) return false;
        boolean inside = false;
        for (int i = 0, j = ring.length() - 1; i < ring.length(); j = i++) {
            JSONArray pi = ring.optJSONArray(i);
            JSONArray pj = ring.optJSONArray(j);
            if (pi == null || pj == null || pi.length() < 2 || pj.length() < 2) return false;
            double yi = pi.optDouble(0);
            double xi = pi.optDouble(1);
            double yj = pj.optDouble(0);
            double xj = pj.optDouble(1);
            if (!Double.isFinite(yi)
                    || !Double.isFinite(xi)
                    || !Double.isFinite(yj)
                    || !Double.isFinite(xj)) {
                return false;
            }
            boolean intersect =
                    (yi > lat) != (yj > lat)
                            && lon
                                    < ((xj - xi) * (lat - yi))
                                            / (yj - yi + Double.MIN_VALUE)
                                            + xi;
            if (intersect) inside = !inside;
        }
        return inside;
    }

    private static double distanceM(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a =
                Math.sin(dLat / 2d) * Math.sin(dLat / 2d)
                        + Math.cos(Math.toRadians(lat1))
                                * Math.cos(Math.toRadians(lat2))
                                * Math.sin(dLon / 2d)
                                * Math.sin(dLon / 2d);
        return 2d * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
    }
}
