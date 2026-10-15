package com.github.boombuds;

import org.junit.Test;
import static org.junit.Assert.*;

public class DisplayPolicyTest {
    @Test public void acceptsUhdAtCurrentCadence() {
        assertTrue(DisplayPolicy.isMatchingUhd(3840, 2160, 60f, 60f));
        assertTrue(DisplayPolicy.isMatchingUhd(3840, 2160, 59.94f, 60f));
        assertTrue(DisplayPolicy.isMatchingUhd(3840, 2160, 50f, 50f));
    }

    @Test public void neverTradesMotionForMorePixels() {
        assertFalse(DisplayPolicy.isMatchingUhd(3840, 2160, 30f, 60f));
        assertFalse(DisplayPolicy.isMatchingUhd(3840, 2160, 30f, 30f));
        assertFalse(DisplayPolicy.isMatchingUhd(3840, 2160, 60f, 120f));
        assertFalse(DisplayPolicy.isMatchingUhd(3840, 2160, 60f, 50f));
    }

    @Test public void requiresRealUhdAndValidRate() {
        assertFalse(DisplayPolicy.isMatchingUhd(1920, 1080, 60f, 60f));
        assertFalse(DisplayPolicy.isMatchingUhd(7680, 4320, 60f, 60f));
        assertFalse(DisplayPolicy.isMatchingUhd(3840, 2160, Float.NaN, 60f));
    }
}
