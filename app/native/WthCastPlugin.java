package io.github.francishfrancisco.webtvhub;

import android.net.Uri;
import android.view.KeyEvent;
import androidx.mediarouter.app.MediaRouteChooserDialog;
import androidx.mediarouter.app.MediaRouteControllerDialog;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.CastState;
import com.google.android.gms.cast.framework.CastStateListener;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.images.WebImage;
import java.util.concurrent.Executors;

/**
 * Chromecast for the Web TV Hub app: device picker, send a live channel, play/pause, mute, volume.
 * The web app (loaded from webtv-hub.pages.dev) calls this as Capacitor.Plugins.WthCast.
 */
@CapacitorPlugin(name = "WthCast")
public class WthCastPlugin extends Plugin {
    private static CastContext cast;
    private CastStateListener stateListener;
    private SessionManagerListener<CastSession> sessionListener;
    private RemoteMediaClient.Callback mediaCallback;

    static boolean handleVolumeKey(KeyEvent e) {
        int code = e.getKeyCode();
        if (cast == null || (code != KeyEvent.KEYCODE_VOLUME_UP && code != KeyEvent.KEYCODE_VOLUME_DOWN)) return false;
        CastSession s = cast.getSessionManager().getCurrentCastSession();
        if (s == null || !s.isConnected()) return false;
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            try {
                double v = s.getVolume() + (code == KeyEvent.KEYCODE_VOLUME_UP ? 0.05 : -0.05);
                s.setVolume(Math.max(0, Math.min(1, v)));
            } catch (Exception ignored) { }
        }
        return true;
    }

    private CastSession session() {
        return cast == null ? null : cast.getSessionManager().getCurrentCastSession();
    }

    private JSObject state() {
        JSObject o = new JSObject();
        if (cast == null) { o.put("available", false); o.put("state", "unavailable"); return o; }
        int st = cast.getCastState();
        o.put("available", true);
        o.put("state", st == CastState.NO_DEVICES_AVAILABLE ? "no_devices"
                : st == CastState.NOT_CONNECTED ? "not_connected"
                : st == CastState.CONNECTING ? "connecting" : "connected");
        CastSession s = session();
        if (s != null && s.isConnected()) {
            if (s.getCastDevice() != null) o.put("device", s.getCastDevice().getFriendlyName());
            try { o.put("volume", s.getVolume()); o.put("muted", s.isMute()); } catch (Exception ignored) { }
            RemoteMediaClient rmc = s.getRemoteMediaClient();
            if (rmc != null && rmc.getMediaStatus() != null) {
                int ps = rmc.getMediaStatus().getPlayerState();
                o.put("player", ps == MediaStatus.PLAYER_STATE_PLAYING ? "playing" : ps == MediaStatus.PLAYER_STATE_PAUSED ? "paused"
                        : ps == MediaStatus.PLAYER_STATE_BUFFERING || ps == MediaStatus.PLAYER_STATE_LOADING ? "buffering" : "idle");
                if (ps == MediaStatus.PLAYER_STATE_IDLE) {
                    int r = rmc.getMediaStatus().getIdleReason();
                    if (r == MediaStatus.IDLE_REASON_ERROR) o.put("error", true);
                }
            }
        }
        return o;
    }

    private void emit() { notifyListeners("state", state(), true); }

    private void watchMedia(CastSession s) {
        if (s == null) return;
        RemoteMediaClient rmc = s.getRemoteMediaClient();
        if (rmc == null) return;
        if (mediaCallback == null) mediaCallback = new RemoteMediaClient.Callback() {
            @Override public void onStatusUpdated() { emit(); }
        };
        rmc.unregisterCallback(mediaCallback);
        rmc.registerCallback(mediaCallback);
    }

    @PluginMethod
    public void initialize(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (cast != null) { call.resolve(state()); return; }
            try {
                CastContext.getSharedInstance(getContext(), Executors.newSingleThreadExecutor())
                    .addOnSuccessListener(getActivity(), c -> {
                        cast = c;
                        stateListener = st -> emit();
                        c.addCastStateListener(stateListener);
                        sessionListener = new SessionManagerListener<CastSession>() {
                            @Override public void onSessionStarted(CastSession s, String id) { watchMedia(s); emit(); }
                            @Override public void onSessionResumed(CastSession s, boolean b) { watchMedia(s); emit(); }
                            @Override public void onSessionEnded(CastSession s, int e) { emit(); }
                            @Override public void onSessionStartFailed(CastSession s, int e) { emit(); }
                            @Override public void onSessionResumeFailed(CastSession s, int e) { emit(); }
                            @Override public void onSessionStarting(CastSession s) { }
                            @Override public void onSessionEnding(CastSession s) { }
                            @Override public void onSessionResuming(CastSession s, String id) { }
                            @Override public void onSessionSuspended(CastSession s, int r) { emit(); }
                        };
                        c.getSessionManager().addSessionManagerListener(sessionListener, CastSession.class);
                        watchMedia(session());
                        call.resolve(state());
                    })
                    .addOnFailureListener(getActivity(), e -> {
                        JSObject o = new JSObject(); o.put("available", false); o.put("state", "unavailable"); o.put("reason", String.valueOf(e.getMessage()));
                        call.resolve(o);
                    });
            } catch (Exception e) {
                // no Google Play services (some TV boxes, de-Googled phones): casting just isn't offered
                JSObject o = new JSObject(); o.put("available", false); o.put("state", "unavailable"); o.put("reason", String.valueOf(e.getMessage()));
                call.resolve(o);
            }
        });
    }

    @PluginMethod
    public void getState(PluginCall call) { getActivity().runOnUiThread(() -> call.resolve(state())); }

    /** Device picker when not casting; "playing on ... / stop casting" dialog when casting. */
    @PluginMethod
    public void showPicker(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (cast == null) { call.reject("Casting isn't available on this device"); return; }
            try {
                CastSession s = session();
                if (s != null && s.isConnected()) {
                    new MediaRouteControllerDialog(getActivity()).show();
                } else {
                    MediaRouteChooserDialog d = new MediaRouteChooserDialog(getActivity());
                    d.setRouteSelector(cast.getMergedSelector());
                    d.show();
                }
                call.resolve();
            } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
        });
    }

    @PluginMethod
    public void load(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) { call.reject("bad url"); return; }
        getActivity().runOnUiThread(() -> {
            CastSession s = session();
            if (s == null || !s.isConnected() || s.getRemoteMediaClient() == null) { call.reject("not connected"); return; }
            MediaMetadata md = new MediaMetadata(MediaMetadata.MEDIA_TYPE_GENERIC);
            md.putString(MediaMetadata.KEY_TITLE, call.getString("title", ""));
            md.putString(MediaMetadata.KEY_SUBTITLE, call.getString("subtitle", ""));
            String img = call.getString("image");
            if (img != null && img.startsWith("https://")) md.addImage(new WebImage(Uri.parse(img)));
            MediaInfo info = new MediaInfo.Builder(url)
                    .setStreamType(MediaInfo.STREAM_TYPE_LIVE)
                    .setContentType("application/x-mpegURL")
                    .setMetadata(md)
                    .build();
            watchMedia(s);
            s.getRemoteMediaClient().load(new MediaLoadRequestData.Builder().setMediaInfo(info).setAutoplay(true).build())
                    .setResultCallback(r -> {
                        if (r.getStatus().isSuccess()) call.resolve(state());
                        else call.reject("The TV couldn't play this channel (" + r.getStatus().getStatusCode() + ")");
                    });
        });
    }

    @PluginMethod
    public void play(PluginCall call) { media(call, true); }

    @PluginMethod
    public void pause(PluginCall call) { media(call, false); }

    private void media(PluginCall call, boolean play) {
        getActivity().runOnUiThread(() -> {
            CastSession s = session();
            if (s == null || s.getRemoteMediaClient() == null) { call.reject("not connected"); return; }
            if (play) s.getRemoteMediaClient().play(); else s.getRemoteMediaClient().pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        boolean m = Boolean.TRUE.equals(call.getBoolean("muted", false));
        getActivity().runOnUiThread(() -> {
            CastSession s = session();
            if (s == null) { call.reject("not connected"); return; }
            try { s.setMute(m); call.resolve(); } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
        });
    }

    @PluginMethod
    public void changeVolume(PluginCall call) {
        double d = call.getDouble("delta", 0.1);
        getActivity().runOnUiThread(() -> {
            CastSession s = session();
            if (s == null) { call.reject("not connected"); return; }
            try { s.setVolume(Math.max(0, Math.min(1, s.getVolume() + d))); call.resolve(); } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (cast != null) cast.getSessionManager().endCurrentSession(true);
            call.resolve();
        });
    }
}
