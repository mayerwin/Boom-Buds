package com.github.boombuds;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class NativeAudioTest {
    @Test public void mapsEveryFormOfTheGameUrlToTheAssetPath() {
        assertEquals("data/audio/1000.ogg", NativeAudio.assetPath("./data/audio/1000.ogg"));
        assertEquals("data/audio/1000.ogg", NativeAudio.assetPath("data/audio/1000.ogg"));
        assertEquals("data/audio/1000.ogg", NativeAudio.assetPath("/assets/data/audio/1000.ogg?v=ab12"));
        assertEquals("data/audio/1000.ogg", NativeAudio.assetPath("https://appassets.androidplatform.net/assets/data/audio/1000.ogg?v=ab12"));
    }

    @Test public void refusesPathsOutsideTheGame() {
        assertEquals("", NativeAudio.assetPath("../secrets.txt"));
        assertEquals("", NativeAudio.assetPath("./data/../../x.ogg"));
        assertEquals("", NativeAudio.assetPath(null));
    }
}
