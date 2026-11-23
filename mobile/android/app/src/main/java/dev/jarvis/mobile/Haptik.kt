package dev.jarvis.mobile

import android.content.Context
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class Impuls(val key: String, val title: String, val primitive: Int, val fallback: Int) {
    CLICK("hapticsClick", "Klick", VibrationEffect.Composition.PRIMITIVE_CLICK, VibrationEffect.EFFECT_CLICK),
    TOOL("hapticsTool", "Werkzeug", VibrationEffect.Composition.PRIMITIVE_LOW_TICK, VibrationEffect.EFFECT_TICK),
    THINK("hapticsThink", "Nachdenken", VibrationEffect.Composition.PRIMITIVE_LOW_TICK, VibrationEffect.EFFECT_TICK),
    TICK("hapticsType", "Schreiben", VibrationEffect.Composition.PRIMITIVE_TICK, VibrationEffect.EFFECT_TICK),
}
enum class Stärke(val title: String, val scale: Float) { LEICHT("Leicht", .30f), MITTEL("Mittel", .55f), STARK("Stark", .85f) }

class Haptik(context: Context, private val scope: CoroutineScope) {
    private val vibrator: Vibrator? = context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    private val prefs = context.getSharedPreferences("haptik", Context.MODE_PRIVATE)
    var foreground = false
        set(value) { field = value; if (!value) stop() }
    var enabled: Boolean
        get() = prefs.getBoolean("haptics", true)
        set(value) { prefs.edit().putBoolean("haptics", value).apply(); if (!value) stop() }
    var strength: Stärke
        get() = Stärke.entries.firstOrNull { it.name == prefs.getString("hapticsStrength", null) } ?: Stärke.MITTEL
        set(value) { prefs.edit().putString("hapticsStrength", value.name).apply() }
    private var thinking: Job? = null
    private var ticks: Job? = null
    private var lastText = 0L

    fun active(kind: Impuls) = prefs.getBoolean(kind.key, true)
    fun set(kind: Impuls, on: Boolean) { prefs.edit().putBoolean(kind.key, on).apply() }

    fun pulse(kind: Impuls) {
        val motor = vibrator ?: return
        if (!foreground || !enabled || !active(kind) || !motor.hasVibrator()) return
        val scale = strength.scale * when (kind) { Impuls.THINK -> .42f; Impuls.TICK -> .32f; else -> 1f }
        val effect = if (motor.areAllPrimitivesSupported(kind.primitive))
            VibrationEffect.startComposition().addPrimitive(kind.primitive, scale).compose()
        else if (motor.hasAmplitudeControl())
            VibrationEffect.createOneShot(if (kind == Impuls.CLICK) 22 else 11, (scale * 255).toInt().coerceIn(1, 255))
        else VibrationEffect.createPredefined(kind.fallback)
        motor.vibrate(effect)
    }

    fun think(on: Boolean) {
        if (!on) { thinking?.cancel(); thinking = null; return }
        if (!foreground || !enabled || thinking?.isActive == true) return
        thinking = scope.launch {
            while (true) { delay(900); pulse(Impuls.THINK) }
        }
    }
    fun text() {
        think(false)
        if (!foreground || !enabled || !active(Impuls.TICK)) return
        lastText = SystemClock.elapsedRealtime()
        if (ticks?.isActive == true) return
        ticks = scope.launch {
            while (SystemClock.elapsedRealtime() - lastText < 160) { pulse(Impuls.TICK); delay(55) }
        }
    }
    fun stop() {
        think(false)
        ticks?.cancel(); ticks = null
        vibrator?.cancel()
    }
}
