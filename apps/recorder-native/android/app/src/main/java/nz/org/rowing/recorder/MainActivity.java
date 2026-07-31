package nz.org.rowing.recorder;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CapsizeMonitorPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        new Handler(Looper.getMainLooper())
                .post(
                        () -> {
                            try {
                                CapsizeMonitorService.requestBootResume(getApplicationContext());
                            } catch (Exception ignored) {
                                /* optional resume */
                            }
                        });
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            @NonNull String[] permissions,
            @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        RecordingSetupHelper.onRequestPermissionsResult(this, requestCode, grantResults);
    }
}
