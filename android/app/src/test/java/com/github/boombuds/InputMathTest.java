package com.github.boombuds;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class InputMathTest {
    @Test public void suppressesStickDriftAndKeepsFullTravel() {
        assertEquals(0, InputMath.centered(0.08f, -1, 1, 0), 0.0001f);
        assertEquals(0, InputMath.centered(-0.1f, -1, 1, 0), 0.0001f);
        assertEquals(1, InputMath.centered(1, -1, 1, 0), 0.0001f);
        assertEquals(-1, InputMath.centered(-1, -1, 1, 0), 0.0001f);
    }

    @Test public void honorsDeviceReportedFlatAndIsContinuousAtThreshold() {
        assertEquals(0, InputMath.centered(0.2f, -1, 1, 0.25f), 0.0001f);
        float first = InputMath.centered(0.251f, -1, 1, 0.25f);
        assertTrue(first > 0 && first < 0.002f);
    }

    @Test public void handlesSignedAndUnsignedTriggers() {
        assertEquals(0, InputMath.trigger(-1, -1, 1, 0), 0.0001f);
        assertEquals(0, InputMath.trigger(0, 0, 1, 0), 0.0001f);
        assertEquals(1, InputMath.trigger(1, -1, 1, 0), 0.0001f);
        assertEquals(1, InputMath.trigger(1, 0, 1, 0), 0.0001f);
    }

    @Test public void handlesInvalidAndOutOfRangeAxes() {
        assertEquals(0, InputMath.centered(1, 0, 0, 0), 0.0001f);
        assertEquals(0, InputMath.trigger(1, 1, 1, 0), 0.0001f);
        assertEquals(1, InputMath.centered(2, -1, 1, 0), 0.0001f);
        assertEquals(0, InputMath.trigger(-2, -1, 1, 0), 0.0001f);
    }
}
