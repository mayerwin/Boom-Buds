package com.github.boombuds;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.hardware.display.DisplayManager;
import android.hardware.input.InputManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.SparseArray;
import android.view.Choreographer;
import android.view.Display;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/**
 * TV host for the shared web game (the same build as the website, packaged offline). Keyboards and mice reach the
 * WebView as usual. Gamepads and the TV remote are forwarded to android/tv/tv.js, which presents them to the game
 * as standard gamepads: the WebView offers no Gamepad API of its own, and a remote's OK and Back would otherwise
 * be Enter and a page "back".
 */
public final class MainActivity extends Activity implements InputManager.InputDeviceListener, DisplayManager.DisplayListener {
    private static final String GAME_URL = "https://appassets.androidplatform.net/assets/index.html";
    /** device id used for Back from the TV remote (the system's Back callback carries no device) */
    private static final int REMOTE_BACK_DEVICE = -2;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final SparseArray<JSONObject> devices = new SparseArray<>();
    private final ArrayList<JSONObject> pending = new ArrayList<>();
    private WebView webView;
    private InputManager inputManager;
    private DisplayManager displayManager;
    private NativeAudio nativeAudio;
    private volatile String displayInfo = "{}";
    private boolean ready;
    private boolean frameScheduled;
    private boolean resumed;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        nativeAudio = new NativeAudio(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        inputManager = (InputManager) getSystemService(INPUT_SERVICE);
        displayManager = (DisplayManager) getSystemService(DISPLAY_SERVICE);
        displayManager.registerDisplayListener(this, handler);
        inputManager.registerInputDeviceListener(this, handler);
        webView = new WebView(this);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        webView.setBackgroundColor(Color.rgb(13, 10, 28));
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setVerticalScrollBarEnabled(false);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        // The game is served from the APK under an HTTPS origin; only network games reach the internet
        // (the meeting brokers over WebSocket, the other players over WebRTC).
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", gameAssets()).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isLocal(request.getUrl());
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!isLocal(request.getUrl())) return null; // network games: let the WebView connect
                WebResourceResponse result = loader.shouldInterceptRequest(request.getUrl());
                if (result == null) return blocked();
                Map<String, String> headers = new HashMap<>();
                if (result.getResponseHeaders() != null) headers.putAll(result.getResponseHeaders());
                headers.put("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'none'; object-src 'none'; base-uri 'self'");
                headers.put("X-Content-Type-Options", "nosniff");
                result.setResponseHeaders(headers);
                return result;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                ready = false;
                if (nativeAudio != null) nativeAudio.stopAll();
                pending.clear();
            }
        });
        webView.addJavascriptInterface(new HostBridge(), "AndroidHost");
        setContentView(webView);
        webView.addOnLayoutChangeListener((view, l, t, r, b, oldL, oldT, oldR, oldB) -> updateDisplayInfo());
        configureDisplay();
        webView.requestFocus();
        immersive();
        if (Build.VERSION.SDK_INT >= 33) {
            // On API 33+ this callback is the only producer of Back (the key also arrived here twice before).
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> {
                remoteKey(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK);
                remoteKey(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK);
            });
        }
        webView.loadUrl(GAME_URL);
    }

    private static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
            && uri.getPath() != null && uri.getPath().startsWith("/assets/");
    }

    /**
     * The packaged game. The Android build unpacks gzip assets (data/**.gz) and drops their extension, so a
     * request for "x.gz" is answered with "x"; the game reads gzip and plain data alike.
     */
    private WebViewAssetLoader.PathHandler gameAssets() {
        WebViewAssetLoader.AssetsPathHandler assets = new WebViewAssetLoader.AssetsPathHandler(this);
        return path -> assets.handle(path.endsWith(".gz") ? path.substring(0, path.length() - 3) : path);
    }

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", null, new ByteArrayInputStream(new byte[0]));
    }

    private void immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    private final class HostBridge {
        @JavascriptInterface public String getDisplayInfo() { return displayInfo; }
        /** Short effects through the native mixer; false: not loaded yet, the page plays it itself. */
        @JavascriptInterface public boolean playSound(String path, double volume) {
            return nativeAudio != null && nativeAudio.play(path, volume);
        }
        @JavascriptInterface public void preloadSounds(String json) { if (nativeAudio != null) nativeAudio.preload(json); }
        @JavascriptInterface public void stopSounds() { if (nativeAudio != null) nativeAudio.stopAll(); }
        @JavascriptInterface public String getAudioInfo() { return nativeAudio == null ? "{}" : nativeAudio.diagnostics(); }
        @JavascriptInterface public void ready() {
            runOnUiThread(() -> {
                ready = true;
                pending.clear();
                devices.clear();
                // gamepads first, then the remote: the same controllers get the same places at every launch
                int[] ids = InputDevice.getDeviceIds();
                for (int id : ids) if (!describeDevice(id).optBoolean("remote")) onInputDeviceAdded(id);
                for (int id : ids) if (describeDevice(id).optBoolean("remote")) onInputDeviceAdded(id);
                emit(json("type", "lifecycle", "action", resumed ? "resume" : "pause"));
            });
        }
        @JavascriptInterface public String getDevices() {
            JSONArray result = new JSONArray();
            for (int id : InputDevice.getDeviceIds()) result.put(describeDevice(id));
            return result.toString();
        }
        /** The on-screen keyboard for the focused text field (a remote's OK does not open it by itself here). */
        @JavascriptInterface public void showKeyboard() {
            runOnUiThread(() -> {
                InputMethodManager ime = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (ime != null && webView != null) ime.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT);
            });
        }
        @JavascriptInterface public void exit() { runOnUiThread(() -> finish()); }
    }

    @SuppressWarnings("deprecation")
    private void configureDisplay() {
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode current = display.getMode();
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        int requested = 0;
        if (current.getPhysicalWidth() <= 3840 && current.getPhysicalHeight() <= 2160) {
            for (Display.Mode candidate : display.getSupportedModes()) {
                if (DisplayPolicy.isMatchingUhd(candidate.getPhysicalWidth(), candidate.getPhysicalHeight(),
                    candidate.getRefreshRate(), current.getRefreshRate())) {
                    requested = candidate.getModeId();
                    if (requested == current.getModeId()) break;
                }
            }
        }
        if (attributes.preferredDisplayModeId != requested) {
            attributes.preferredDisplayModeId = requested;
            getWindow().setAttributes(attributes);
        }
        // Request the TV's game/low-latency mode without changing user settings.
        if (Build.VERSION.SDK_INT >= 30) getWindow().setPreferMinimalPostProcessing(true);
        updateDisplayInfo();
    }

    @SuppressWarnings("deprecation")
    private void updateDisplayInfo() {
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode actual = display.getMode();
        // Output timing and the actual WebView surface are deliberately separate:
        // some TV platforms expose 4K HDMI while composing app UI at 1080p.
        displayInfo = json("outputWidth", actual.getPhysicalWidth(), "outputHeight", actual.getPhysicalHeight(),
            "refreshRate", actual.getRefreshRate(), "windowWidth", webView == null ? 0 : webView.getWidth(),
            "windowHeight", webView == null ? 0 : webView.getHeight(),
            "density", getResources().getDisplayMetrics().density,
            "requestedModeId", getWindow().getAttributes().preferredDisplayModeId).toString();
    }

    @Override public void onDisplayAdded(int id) { configureDisplay(); }
    @Override public void onDisplayRemoved(int id) { configureDisplay(); }
    @Override public void onDisplayChanged(int id) { configureDisplay(); }

    /** Gamepads and joysticks, and the TV remote (a d-pad without letter keys), go to tv.js as gamepads. */
    private static boolean bridged(InputDevice input) {
        if (input == null) return false;
        int sources = input.getSources();
        if ((sources & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
            || (sources & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK) return true;
        return (sources & InputDevice.SOURCE_DPAD) == InputDevice.SOURCE_DPAD
            && input.getKeyboardType() != InputDevice.KEYBOARD_TYPE_ALPHABETIC;
    }

    @SuppressLint("GestureBackNavigation")
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (Build.VERSION.SDK_INT >= 33) return super.dispatchKeyEvent(event);
            if (event.getAction() == KeyEvent.ACTION_DOWN || event.getAction() == KeyEvent.ACTION_UP) remoteKey(event.getAction(), KeyEvent.KEYCODE_BACK);
            return true;
        }
        // Home, voice assistant, volume and other OS-owned keys keep their normal TV behavior.
        switch (event.getKeyCode()) {
            case KeyEvent.KEYCODE_HOME:
            case KeyEvent.KEYCODE_POWER:
            case KeyEvent.KEYCODE_SLEEP:
            case KeyEvent.KEYCODE_WAKEUP:
            case KeyEvent.KEYCODE_VOLUME_UP:
            case KeyEvent.KEYCODE_VOLUME_DOWN:
            case KeyEvent.KEYCODE_VOLUME_MUTE:
            case KeyEvent.KEYCODE_MUTE:
            case KeyEvent.KEYCODE_ASSIST:
            case KeyEvent.KEYCODE_VOICE_ASSIST:
            case KeyEvent.KEYCODE_APP_SWITCH:
            case KeyEvent.KEYCODE_SETTINGS:
            case KeyEvent.KEYCODE_PAIRING:
                return super.dispatchKeyEvent(event);
            default:
                if (bridged(event.getDevice()) && (event.getAction() == KeyEvent.ACTION_DOWN || event.getAction() == KeyEvent.ACTION_UP)) {
                    key(event);
                    return true;
                }
                return super.dispatchKeyEvent(event);
        }
    }

    private void key(KeyEvent event) {
        String code = KeyEvent.keyCodeToString(event.getKeyCode()).replace("KEYCODE_", "");
        emit(json("type", "key", "device", device(event.getDeviceId()), "action",
            event.getAction() == KeyEvent.ACTION_UP ? "up" : "down", "code", code,
            "repeat", event.getRepeatCount(), "time", event.getEventTime()));
    }

    private void remoteKey(int action, int keyCode) {
        String code = KeyEvent.keyCodeToString(keyCode).replace("KEYCODE_", "");
        emit(json("type", "key", "device", json("id", REMOTE_BACK_DEVICE, "name", "TV remote", "remote", true),
            "action", action == KeyEvent.ACTION_UP ? "up" : "down", "code", code, "repeat", 0, "time", android.os.SystemClock.uptimeMillis()));
    }

    @Override public boolean dispatchGenericMotionEvent(MotionEvent event) {
        if (event.isFromSource(InputDevice.SOURCE_JOYSTICK) || event.isFromSource(InputDevice.SOURCE_GAMEPAD)) {
            JSONObject axes = new JSONObject();
            String[] names = {"x", "y", "z", "rz", "rx", "ry", "hatX", "hatY", "ltrigger", "rtrigger", "brake", "gas"};
            int[] codes = {
                MotionEvent.AXIS_X, MotionEvent.AXIS_Y, MotionEvent.AXIS_Z, MotionEvent.AXIS_RZ,
                MotionEvent.AXIS_RX, MotionEvent.AXIS_RY, MotionEvent.AXIS_HAT_X, MotionEvent.AXIS_HAT_Y,
                MotionEvent.AXIS_LTRIGGER, MotionEvent.AXIS_RTRIGGER, MotionEvent.AXIS_BRAKE, MotionEvent.AXIS_GAS};
            for (int i = 0; i < codes.length; i++) put(axes, names[i], axis(event, codes[i], i >= 8, i == 6 || i == 7));
            emit(json("type", "motion", "device", device(event.getDeviceId()), "axes", axes, "time", event.getEventTime()));
            return true;
        }
        return super.dispatchGenericMotionEvent(event);
    }

    private float axis(MotionEvent event, int code, boolean trigger, boolean hat) {
        InputDevice input = event.getDevice();
        if (input == null) return 0;
        InputDevice.MotionRange range = input.getMotionRange(code, event.getSource());
        if (range == null) range = input.getMotionRange(code);
        if (range == null) return 0;
        float value = event.getAxisValue(code);
        if (hat) return InputMath.clamp(value, -1, 1);
        return trigger ? InputMath.trigger(value, range.getMin(), range.getMax(), range.getFlat())
            : InputMath.centered(value, range.getMin(), range.getMax(), range.getFlat());
    }

    private JSONObject device(int id) {
        JSONObject cached = devices.get(id);
        if (cached != null) return cached;
        JSONObject value = describeDevice(id);
        devices.put(id, value);
        return value;
    }

    private JSONObject describeDevice(int id) {
        InputDevice input = InputDevice.getDevice(id);
        if (input == null) return json("id", id, "name", "TV remote", "remote", true, "bridged", true);
        int sources = input.getSources();
        boolean pad = (sources & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
            || (sources & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
        return json("id", id, "name", input.getName(), "descriptor", input.getDescriptor(),
            "vendorId", input.getVendorId(), "productId", input.getProductId(), "sources", sources,
            "remote", !pad, "bridged", bridged(input), "virtual", input.isVirtual());
    }

    @Override public void onInputDeviceAdded(int id) {
        JSONObject value = describeDevice(id);
        devices.put(id, value);
        emit(json("type", "device", "action", "connected", "device", value));
    }

    @Override public void onInputDeviceChanged(int id) { onInputDeviceAdded(id); }

    @Override public void onInputDeviceRemoved(int id) {
        JSONObject value = devices.get(id);
        devices.remove(id);
        emit(json("type", "device", "action", "disconnected", "device", value == null ? json("id", id) : value));
    }

    private void emit(JSONObject event) {
        if (!ready || webView == null) return;
        // Preserve every button edge. Collapse only adjacent stick snapshots for the same device.
        if ("motion".equals(event.optString("type")) && !pending.isEmpty()) {
            JSONObject previous = pending.get(pending.size() - 1);
            if ("motion".equals(previous.optString("type")) && previous.optJSONObject("device") != null
                && previous.optJSONObject("device").optInt("id") == event.optJSONObject("device").optInt("id")) {
                pending.set(pending.size() - 1, event);
            } else pending.add(event);
        } else pending.add(event);
        if (frameScheduled) return;
        frameScheduled = true;
        Choreographer.getInstance().postFrameCallback(time -> flush());
    }

    private void flush() {
        frameScheduled = false;
        if (!ready || webView == null || pending.isEmpty()) return;
        JSONArray batch = new JSONArray(pending);
        pending.clear();
        webView.evaluateJavascript("if(window.BoomBudsAndroid&&window.BoomBudsAndroid.onInput){" + batch
            + ".forEach(function(e){window.BoomBudsAndroid.onInput(e);});}", null);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        if (nativeAudio != null) nativeAudio.setActive(webView != null && webView.hasWindowFocus());
        if (webView != null) configureDisplay();
        if (webView != null) webView.onResume();
        emit(json("type", "lifecycle", "action", "resume"));
        immersive();
    }

    @Override protected void onPause() {
        resumed = false;
        if (nativeAudio != null) nativeAudio.setActive(false);
        emit(json("type", "lifecycle", "action", "pause"));
        flush();
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (nativeAudio != null) nativeAudio.setActive(hasFocus && resumed);
        if (hasFocus) {
            immersive();
            if (resumed) emit(json("type", "lifecycle", "action", "resume"));
        } else {
            emit(json("type", "lifecycle", "action", "pause"));
            flush();
        }
    }

    @Override protected void onDestroy() {
        if (nativeAudio != null) nativeAudio.release();
        ready = false;
        pending.clear();
        if (inputManager != null) inputManager.unregisterInputDeviceListener(this);
        if (displayManager != null) displayManager.unregisterDisplayListener(this);
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidHost");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private static JSONObject json(Object... entries) {
        JSONObject result = new JSONObject();
        for (int i = 0; i < entries.length; i += 2) put(result, (String) entries[i], entries[i + 1]);
        return result;
    }

    private static void put(JSONObject target, String name, Object value) {
        try { target.put(name, value); } catch (JSONException ignored) { /* Values are fixed primitives / finite axes. */ }
    }
}
