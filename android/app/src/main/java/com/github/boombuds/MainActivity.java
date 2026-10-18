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
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

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
    /** guards `pending`: WebView's own bridge thread takes events from it too (HostBridge.drainInput) */
    private final Object inputLock = new Object();
    private final SparseArray<JSONObject> devices = new SparseArray<>();
    /** the axes last sent for each device (the same values again are not sent) */
    private final SparseArray<String> lastAxes = new SparseArray<>();
    /** events on their way to the page (it also takes them itself when it samples its controllers) */
    private final ArrayList<JSONObject> pending = new ArrayList<>();
    private WebView webView;
    private InputManager inputManager;
    private DisplayManager displayManager;
    private NativeAudio nativeAudio;
    private volatile String displayInfo = "{}";
    private volatile boolean ready;
    private boolean flushPosted;
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

            /** The page's renderer died (out of memory on a small TV, a crash): start again rather than close. */
            @androidx.annotation.RequiresApi(26)
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (view == webView) recreate();
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                ready = false;
                lastAxes.clear();
                if (nativeAudio != null) nativeAudio.stopAll();
                clearInput();
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
                remoteKey(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK, 0);
                remoteKey(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK, 0);
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
                clearInput();
                devices.clear();
                lastAxes.clear();
                // gamepads first, then the remote: the same controllers get the same places at every launch
                int[] ids = InputDevice.getDeviceIds();
                for (int id : ids) if (!describeDevice(id).optBoolean("remote")) onInputDeviceAdded(id);
                for (int id : ids) if (describeDevice(id).optBoolean("remote")) onInputDeviceAdded(id);
                emit(json("type", "lifecycle", "action", resumed ? "resume" : "pause"));
            });
        }
        /**
         * The events waiting for the page, taken by the page itself: android/tv/tv.js asks for them when the
         * game samples its controllers, so a press reaches the very frame that follows it instead of the next
         * one. Runs on WebView's bridge thread; `inputLock` guards the queue it shares with the UI thread.
         */
        @JavascriptInterface public String drainInput() {
            String batch = takeInput();
            return batch == null ? "" : batch;
        }
        /** The clock of the forwarded events' `time` (SystemClock.uptimeMillis), to compare with the page's. */
        @JavascriptInterface public long now() { return android.os.SystemClock.uptimeMillis(); }
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

    /** The keys tv.js gives a meaning (its BUTTONS); a gamepad's or remote's other keys keep their usual behavior. */
    private static final Set<Integer> GAME_KEYS = new HashSet<>(Arrays.asList(
        KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
        KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_BUTTON_X, KeyEvent.KEYCODE_BUTTON_C, KeyEvent.KEYCODE_BUTTON_Y,
        KeyEvent.KEYCODE_BUTTON_Z, KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_BUTTON_L2,
        KeyEvent.KEYCODE_BUTTON_R2, KeyEvent.KEYCODE_BUTTON_SELECT, KeyEvent.KEYCODE_BUTTON_START, KeyEvent.KEYCODE_MENU,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_BUTTON_THUMBL, KeyEvent.KEYCODE_BUTTON_THUMBR,
        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
        KeyEvent.KEYCODE_BUTTON_MODE));

    @SuppressLint("GestureBackNavigation")
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (Build.VERSION.SDK_INT >= 33) return super.dispatchKeyEvent(event);
            // (held, Back repeats: tv.js reads only the first press, so a long Back cannot also leave the app)
            if (event.getAction() == KeyEvent.ACTION_DOWN || event.getAction() == KeyEvent.ACTION_UP) remoteKey(event.getAction(), KeyEvent.KEYCODE_BACK, event.getRepeatCount());
            return true;
        }
        // Home, voice assistant, search, volume and the other keys the game does not use keep their normal TV behavior.
        if (GAME_KEYS.contains(event.getKeyCode()) && bridged(event.getDevice())
            && (event.getAction() == KeyEvent.ACTION_DOWN || event.getAction() == KeyEvent.ACTION_UP)) {
            key(event);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private void key(KeyEvent event) {
        String code = KeyEvent.keyCodeToString(event.getKeyCode()).replace("KEYCODE_", "");
        emit(json("type", "key", "device", device(event.getDeviceId()), "action",
            event.getAction() == KeyEvent.ACTION_UP ? "up" : "down", "code", code,
            "repeat", event.getRepeatCount(), "time", event.getEventTime()));
    }

    private void remoteKey(int action, int keyCode, int repeat) {
        String code = KeyEvent.keyCodeToString(keyCode).replace("KEYCODE_", "");
        emit(json("type", "key", "device", json("id", REMOTE_BACK_DEVICE, "name", "TV remote", "remote", true),
            "action", action == KeyEvent.ACTION_UP ? "up" : "down", "code", code, "repeat", repeat, "time", android.os.SystemClock.uptimeMillis()));
    }

    private static final String[] AXIS_NAMES = {"x", "y", "z", "rz", "rx", "ry", "hatX", "hatY", "ltrigger", "rtrigger", "brake", "gas"};
    private static final int[] AXIS_CODES = {
        MotionEvent.AXIS_X, MotionEvent.AXIS_Y, MotionEvent.AXIS_Z, MotionEvent.AXIS_RZ,
        MotionEvent.AXIS_RX, MotionEvent.AXIS_RY, MotionEvent.AXIS_HAT_X, MotionEvent.AXIS_HAT_Y,
        MotionEvent.AXIS_LTRIGGER, MotionEvent.AXIS_RTRIGGER, MotionEvent.AXIS_BRAKE, MotionEvent.AXIS_GAS};

    @Override public boolean dispatchGenericMotionEvent(MotionEvent event) {
        if (event.isFromSource(InputDevice.SOURCE_JOYSTICK) || event.isFromSource(InputDevice.SOURCE_GAMEPAD)) {
            JSONObject axes = new JSONObject();
            // only the axes the device has: tv.js tells the right stick (Z / RZ) from triggers reported on RX / RY
            InputDevice input = event.getDevice();
            for (int i = 0; i < AXIS_CODES.length; i++) {
                InputDevice.MotionRange range = input == null ? null : input.getMotionRange(AXIS_CODES[i], event.getSource());
                if (range == null && input != null) range = input.getMotionRange(AXIS_CODES[i]);
                if (range != null) put(axes, AXIS_NAMES[i], axis(event, AXIS_CODES[i], range, i >= 8, i == 6 || i == 7));
            }
            // a stick wobbling inside its dead zone sends the same values again and again: nothing to tell the page
            String values = axes.toString();
            if (values.equals(lastAxes.get(event.getDeviceId()))) return true;
            lastAxes.put(event.getDeviceId(), values);
            emit(json("type", "motion", "device", device(event.getDeviceId()), "axes", axes, "time", event.getEventTime()));
            return true;
        }
        return super.dispatchGenericMotionEvent(event);
    }

    /** Which axes are pushed past half way, either way: a d-pad on the hat axes, triggers, a stick's direction. */
    private static int digital(JSONObject axes) {
        int signature = 0;
        if (axes == null) return 0;
        for (int i = 0; i < AXIS_NAMES.length; i++) {
            double v = axes.optDouble(AXIS_NAMES[i], 0);
            signature |= (v > 0.5 ? 1 : v < -0.5 ? 2 : 0) << (2 * i);
        }
        return signature;
    }

    private static float axis(MotionEvent event, int code, InputDevice.MotionRange range, boolean trigger, boolean hat) {
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
        lastAxes.remove(id);
        emit(json("type", "device", "action", "disconnected", "device", value == null ? json("id", id) : value));
    }

    private void emit(JSONObject event) {
        if (!ready || webView == null) return;
        synchronized (inputLock) {
            // Preserve every button edge. Collapse only adjacent stick snapshots for the same device, and only when
            // no axis crossed half way (a d-pad on the hat axes or a trigger tapped between two frames must still
            // arrive).
            if ("motion".equals(event.optString("type")) && !pending.isEmpty()) {
                JSONObject previous = pending.get(pending.size() - 1);
                if ("motion".equals(previous.optString("type")) && previous.optJSONObject("device") != null
                    && previous.optJSONObject("device").optInt("id") == event.optJSONObject("device").optInt("id")
                    && digital(previous.optJSONObject("axes")) == digital(event.optJSONObject("axes"))) {
                    pending.set(pending.size() - 1, event);
                } else pending.add(event);
            } else pending.add(event);
        }
        // Sent as soon as this input dispatch is over, not on the next display frame: that wait cost up to a frame
        // of its own, right before the frame the press should already be in.
        if (flushPosted) return;
        flushPosted = true;
        handler.post(this::flush);
    }

    /** The events waiting for the page as a JSON array, or null when there are none. */
    private String takeInput() {
        synchronized (inputLock) {
            if (pending.isEmpty()) return null;
            String batch = new JSONArray(pending).toString();
            pending.clear();
            return batch;
        }
    }

    private void clearInput() {
        synchronized (inputLock) {
            pending.clear();
        }
    }

    private void flush() {
        flushPosted = false;
        if (!ready || webView == null) return;
        String batch = takeInput();
        if (batch == null) return;
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
        // (tv.js lets go of everything: the sticks are sent again from their next movement)
        lastAxes.clear();
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
            lastAxes.clear();
            emit(json("type", "lifecycle", "action", "pause"));
            flush();
        }
    }

    @Override protected void onDestroy() {
        if (nativeAudio != null) nativeAudio.release();
        ready = false;
        clearInput();
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
