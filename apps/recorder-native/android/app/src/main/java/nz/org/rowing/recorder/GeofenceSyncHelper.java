package nz.org.rowing.recorder;

import android.content.Context;
import android.util.Log;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fetch geofence zones from CrewSight API (same source as WebView sync). */
final class GeofenceSyncHelper {
    private static final String TAG = "GeofenceSync";

    private GeofenceSyncHelper() {}

    static String geofencesUrlFromIngest(String ingestUrl) {
        if (ingestUrl == null || ingestUrl.isEmpty()) return "";
        String base = ingestUrl.replaceAll("(?i)/api/ingest/?$", "");
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base + "/api/geofences";
    }

    /**
     * GET /api/geofences and persist JSON for {@link GeofenceHelper}.
     *
     * @return true when zones were saved
     */
    static boolean fetchAndSaveGeofences(Context ctx, String ingestUrl, String ingestToken) {
        String urlStr = geofencesUrlFromIngest(ingestUrl);
        if (urlStr.isEmpty()) return false;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            if (ingestToken != null && !ingestToken.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + ingestToken);
            }
            int code = conn.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
            if (stream == null) {
                Log.w(TAG, "Geofences HTTP " + code + " (no body)");
                return false;
            }
            BufferedReader reader =
                    new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "Geofences HTTP " + code);
                return false;
            }
            JSONObject body = new JSONObject(sb.toString());
            if (!body.optBoolean("ok", false)) {
                Log.w(TAG, "Geofences response not ok");
                return false;
            }
            JSONArray geofences = body.optJSONArray("geofences");
            if (geofences == null) {
                Log.w(TAG, "Geofences missing array");
                return false;
            }
            GeofenceHelper.saveGeofences(ctx, geofences.toString());
            Log.i(TAG, "Synced " + geofences.length() + " geofence(s) from server");
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Geofence fetch failed: " + e.getMessage());
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
