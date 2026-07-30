package nz.org.rowing.recorder;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Poll regatta/coach messages while native session service runs (background-safe). */
final class CrewMessageHelper {
    private static final String TAG = "CrewMessages";
    private static final String PREFS_LAST_MESSAGE_ID = "lastRegattaMessageId";
    static final String CHANNEL_ID = "rnz_capsize_native_crew";
    static final int NOTIF_ID = 9105;

    private CrewMessageHelper() {}

    static String messagesUrlFromIngest(String ingestUrl, String deviceId) {
        if (ingestUrl == null || ingestUrl.isEmpty() || deviceId == null || deviceId.isEmpty()) {
            return "";
        }
        String base = ingestUrl.replaceAll("(?i)/api/ingest/?$", "");
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base + "/api/messages?deviceId=" + deviceId;
    }

    static void pollMessages(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(CapsizeMonitorService.PREFS, Context.MODE_PRIVATE);
        String deviceId = p.getString("deviceId", "");
        String ingestUrl = p.getString("ingestUrl", "");
        if (deviceId == null || deviceId.isEmpty() || ingestUrl == null || ingestUrl.isEmpty()) {
            return;
        }
        String urlStr = messagesUrlFromIngest(ingestUrl, deviceId);
        if (urlStr.isEmpty()) return;

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            String token = p.getString("ingestToken", "");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            int code = conn.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
            if (stream == null) return;
            BufferedReader reader =
                    new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            if (code < 200 || code >= 300) return;

            JSONObject body = new JSONObject(sb.toString());
            if (!body.optBoolean("ok", false)) return;

            JSONObject message = body.optJSONObject("message");
            int lastId = p.getInt(PREFS_LAST_MESSAGE_ID, 0);
            if (message == null) {
                if (lastId != 0) {
                    p.edit().putInt(PREFS_LAST_MESSAGE_ID, 0).apply();
                }
                return;
            }
            int msgId = message.optInt("id", 0);
            if (msgId <= 0 || msgId == lastId) return;

            String text = message.optString("text", "").trim();
            if (text.isEmpty()) return;

            p.edit().putInt(PREFS_LAST_MESSAGE_ID, msgId).apply();
            showCrewMessageNotification(ctx, text);
            Log.i(TAG, "Coach message notification id=" + msgId);
        } catch (Exception e) {
            Log.w(TAG, "Message poll failed: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static void showCrewMessageNotification(Context ctx, String body) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        Intent launch = new Intent(ctx, MainActivity.class);
        PendingIntent pi =
                PendingIntent.getActivity(
                        ctx,
                        2,
                        launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n =
                new NotificationCompat.Builder(ctx, CHANNEL_ID)
                        .setContentTitle("Coach message")
                        .setContentText(body)
                        .setSmallIcon(R.drawable.ic_stat_rowing_shell)
                        .setContentIntent(pi)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                        .setAutoCancel(true)
                        .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
                        .build();
        nm.notify(NOTIF_ID, n);
    }
}
