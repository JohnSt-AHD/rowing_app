package nz.org.rowing.recorder;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;
import java.net.HttpURLConnection;
import java.net.URL;

/** Dismiss sticky help-on-the-way crew notification and clear the server message. */
public class CrewMessageDismissReceiver extends BroadcastReceiver {
    public static final String ACTION = "nz.org.rowing.recorder.DISMISS_CREW_MESSAGE";
    private static final String TAG = "CrewMessages";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        Context app = context.getApplicationContext();
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(CrewMessageHelper.NOTIF_ID);

        SharedPreferences p =
                app.getSharedPreferences(CapsizeMonitorService.PREFS, Context.MODE_PRIVATE);
        p.edit().putInt(CrewMessageHelper.PREFS_LAST_MESSAGE_ID, 0).apply();

        final PendingResult pending = goAsync();
        new Thread(
                        () -> {
                            try {
                                deleteActiveMessage(app, p);
                            } finally {
                                pending.finish();
                            }
                        },
                        "crew-msg-dismiss")
                .start();
    }

    private static void deleteActiveMessage(Context ctx, SharedPreferences p) {
        String deviceId = p.getString("deviceId", "");
        String ingestUrl = p.getString("ingestUrl", "");
        if (deviceId == null || deviceId.isEmpty() || ingestUrl == null || ingestUrl.isEmpty()) {
            return;
        }
        String urlStr = CrewMessageHelper.messagesUrlFromIngest(ingestUrl, deviceId);
        if (urlStr.isEmpty()) return;

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);
            conn.setRequestMethod("DELETE");
            conn.setRequestProperty("Accept", "application/json");
            String token = p.getString("ingestToken", "");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            int code = conn.getResponseCode();
            Log.i(TAG, "Dismiss DELETE messages → " + code);
        } catch (Exception e) {
            Log.w(TAG, "Dismiss DELETE failed: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
