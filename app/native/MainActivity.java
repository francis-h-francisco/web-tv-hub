package io.github.francishfrancisco.webtvhub;

import android.os.Bundle;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WthCastPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /** While casting, the phone's volume buttons change the TV's volume. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (WthCastPlugin.handleVolumeKey(event)) return true;
        return super.dispatchKeyEvent(event);
    }
}
