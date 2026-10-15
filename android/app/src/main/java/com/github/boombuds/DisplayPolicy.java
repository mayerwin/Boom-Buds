package com.github.boombuds;

/** Prefer UHD only when it preserves smooth motion and the current TV cadence. */
final class DisplayPolicy {
    private DisplayPolicy() { }

    static boolean isMatchingUhd(int width, int height, float refreshRate, float currentRate) {
        return width == 3840 && height == 2160 && refreshRate >= 50f
            && Math.abs(refreshRate - currentRate) <= 0.5f;
    }
}
