package com.github.boombuds;

/** Input math kept separate so stick drift and trigger ranges can be tested on the JVM. */
final class InputMath {
    private InputMath() {}

    static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    static float centered(float value, float min, float max, float flat) {
        float scale = Math.max(Math.abs(min), Math.abs(max));
        if (scale <= 0) return 0;
        float normalized = clamp(value / scale, -1, 1);
        float deadzone = clamp(Math.max(0.12f, flat / scale), 0, 0.9f);
        if (Math.abs(normalized) <= deadzone) return 0;
        return Math.copySign((Math.abs(normalized) - deadzone) / (1 - deadzone), normalized);
    }

    static float trigger(float value, float min, float max, float flat) {
        if (max <= min) return 0;
        float normalized = clamp((value - min) / (max - min), 0, 1);
        float deadzone = clamp(Math.max(0.04f, flat / (max - min)), 0, 0.9f);
        return normalized <= deadzone ? 0 : (normalized - deadzone) / (1 - deadzone);
    }
}
