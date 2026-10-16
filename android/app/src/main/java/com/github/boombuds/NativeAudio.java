package com.github.boombuds;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.media.AudioAttributes;
import android.media.SoundPool;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.IOException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The game's effects and voices through Android's SoundPool. The WebView's audio output adds a noticeable delay on
 * TVs; preloaded native samples start at once. The page keeps its own Web Audio path for the music and for any
 * sound not loaded here yet (play() then returns false and the page plays it itself; nothing is ever queued).
 * Files are the packaged game's own (assets/data/audio/*.ogg, stored uncompressed in the APK).
 */
final class NativeAudio {
    /** SoundPool decodes its sounds one at a time: several pools decode in parallel */
    static final int POOLS = 4;
    private static final int STREAMS_PER_POOL = 16;
    private final AssetManager assets;
    private final ExecutorService loader = Executors.newSingleThreadExecutor();
    private final SoundPool[] pools = new SoundPool[POOLS];

    private static final class Sample {
        final int pool;
        final int id;
        boolean loaded;
        Sample(int pool, int id) { this.pool = pool; this.id = id; }
    }

    /** asset path -> sample, while loading or loaded */
    private final Map<String, Sample> samples = new HashMap<>();
    /** (pool, SoundPool id) -> sample */
    private final Map<Long, Sample> byId = new HashMap<>();
    /** (pool, SoundPool id) -> load status, for sounds decoded before they were registered */
    private final Map<Long, Integer> early = new HashMap<>();
    private final Set<String> failed = new HashSet<>();
    private int next;
    private int loadedCount;
    private boolean active;
    private boolean released;
    private int plays;
    private int fallbacks;
    private long firstRequestAt;
    private long lastLoadedAt;
    private String lastError = "";

    NativeAudio(Context context) {
        assets = context.getAssets();
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_GAME)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        try {
            for (int i = 0; i < POOLS; i++) {
                final int pool = i;
                pools[i] = new SoundPool.Builder().setMaxStreams(STREAMS_PER_POOL).setAudioAttributes(attributes).build();
                pools[i].setOnLoadCompleteListener((source, id, status) -> loadComplete(pool, id, status));
            }
        } catch (RuntimeException failure) {
            lastError = failure.getClass().getSimpleName();
            for (int i = 0; i < POOLS; i++) if (pools[i] != null) { pools[i].release(); pools[i] = null; }
        }
    }

    private static long key(int pool, int id) { return ((long) pool << 32) | (id & 0xffffffffL); }

    private synchronized void loadComplete(int pool, int id, int status) {
        if (released) return;
        Sample sample = byId.get(key(pool, id));
        if (sample == null) {
            // (decoded before load() registered it: it does when it gets the lock)
            early.put(key(pool, id), status);
            return;
        }
        finish(sample, status);
    }

    private void finish(Sample sample, int status) {
        if (status == 0) {
            sample.loaded = true;
            loadedCount++;
            lastLoadedAt = SystemClock.uptimeMillis();
        } else {
            lastError = "decoder status " + status;
            for (Map.Entry<String, Sample> e : samples.entrySet()) if (e.getValue() == sample) failed.add(e.getKey());
        }
    }

    /** "https://appassets.androidplatform.net/assets/data/audio/1000.ogg?v=...", "/assets/data/audio/1000.ogg",
     * "./data/audio/1000.ogg" or "data/audio/1000.ogg" -> the asset's path in the APK. */
    static String assetPath(String path) {
        if (path == null) return "";
        int q = path.indexOf('?');
        String p = q >= 0 ? path.substring(0, q) : path;
        int scheme = p.indexOf("://");
        if (scheme >= 0) {
            int slash = p.indexOf('/', scheme + 3);
            p = slash >= 0 ? p.substring(slash) : "";
        }
        if (p.startsWith("./")) p = p.substring(2);
        if (p.startsWith("/")) p = p.substring(1);
        if (p.startsWith("assets/")) p = p.substring("assets/".length());
        return p.contains("..") ? "" : p;
    }

    /** Load these sounds ahead of time, in this order (a JSON array of paths). */
    void preload(String json) {
        try {
            JSONArray list = new JSONArray(json);
            synchronized (this) { if (firstRequestAt == 0) firstRequestAt = SystemClock.uptimeMillis(); }
            for (int i = 0; i < list.length(); i++) {
                String path = assetPath(list.getString(i));
                loader.execute(() -> load(path));
            }
        } catch (JSONException e) {
            lastError = "preload list";
        }
    }

    private void load(String path) {
        int pool;
        SoundPool soundPool;
        synchronized (this) {
            if (released || pools[0] == null || path.isEmpty() || samples.containsKey(path) || failed.contains(path)) return;
            pool = next++ % POOLS;
            soundPool = pools[pool];
        }
        try (AssetFileDescriptor fd = assets.openFd(path)) {
            // (outside the lock: an older SoundPool's load() waits while its decoder is busy, and play() must not)
            int id = soundPool.load(fd, 1);
            synchronized (this) {
                if (released) return;
                if (id == 0) { failed.add(path); return; }
                Sample sample = new Sample(pool, id);
                samples.put(path, sample);
                byId.put(key(pool, id), sample);
                Integer status = early.remove(key(pool, id));
                if (status != null) finish(sample, status);
            }
        } catch (IOException | RuntimeException e) {
            synchronized (this) {
                failed.add(path);
                lastError = path + ": " + e.getClass().getSimpleName();
            }
            Log.w("BoomBudsNativeAudio", "Cannot load " + path + ": " + e);
        }
    }

    /** True when the sound was played (or deliberately silent); false asks the page to play it itself. */
    synchronized boolean play(String rawPath, double volume) {
        if (released || pools[0] == null) return false;
        String path = assetPath(rawPath);
        Sample sample = samples.get(path);
        if (sample == null || !sample.loaded) {
            if (sample == null && !failed.contains(path)) loader.execute(() -> load(path));
            fallbacks++;
            return false;
        }
        if (!active || !Double.isFinite(volume) || volume <= 0) return true;
        float gain = (float) Math.min(1, volume);
        if (pools[sample.pool].play(sample.id, gain, gain, 1, 0, 1) != 0) plays++;
        return true;
    }

    synchronized void setActive(boolean value) {
        active = value && !released;
        if (!active) stopAll();
    }

    synchronized void stopAll() {
        // Sounds are short: pausing them stops them; autoResume is never called, so nothing replays later.
        for (SoundPool pool : pools) if (pool != null) pool.autoPause();
    }

    synchronized String diagnostics() {
        long loadMs = lastLoadedAt > 0 ? lastLoadedAt - firstRequestAt : -1;
        return "{\"backend\":\"Android SoundPool\",\"pools\":" + POOLS + ",\"active\":" + active + ",\"loaded\":" + loadedCount
            + ",\"requested\":" + samples.size() + ",\"failed\":" + failed.size() + ",\"plays\":" + plays
            + ",\"fallbacks\":" + fallbacks + ",\"loadMs\":" + loadMs
            + ",\"lastError\":\"" + lastError.replace("\"", "'") + "\"}";
    }

    synchronized void release() {
        if (released) return;
        released = true;
        active = false;
        loader.shutdownNow();
        for (int i = 0; i < POOLS; i++) if (pools[i] != null) { pools[i].release(); pools[i] = null; }
        samples.clear();
        byId.clear();
        early.clear();
    }
}
