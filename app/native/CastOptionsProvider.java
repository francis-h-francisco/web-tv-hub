package io.github.francishfrancisco.webtvhub;

import android.content.Context;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.framework.CastOptions;
import com.google.android.gms.cast.framework.OptionsProvider;
import com.google.android.gms.cast.framework.SessionProvider;
import java.util.List;

/** Google Cast setup: Google's free Default Media Receiver plays the HLS stream on the TV. */
public class CastOptionsProvider implements OptionsProvider {
    @Override
    public CastOptions getCastOptions(Context context) {
        return new CastOptions.Builder()
                .setReceiverApplicationId(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
                .setResumeSavedSession(true)
                .build();
    }

    @Override
    public List<SessionProvider> getAdditionalSessionProviders(Context context) {
        return null;
    }
}
