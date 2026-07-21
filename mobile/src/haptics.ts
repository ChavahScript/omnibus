import { requireOptionalNativeModule } from "expo-modules-core";

type NativeHaptics = { play(pattern: "HeavySwitch" | "RotaryRumble", durationMs: number): Promise<void> };
// Haptics enhance the physical-office illusion but must never prevent the
// dashboard from mounting. `requireNativeModule` throws synchronously when a
// native build is stale or a platform does not expose this optional module;
// `requireOptionalNativeModule` lets the UI retain a safe no-haptics fallback.
const nativeHaptics = requireOptionalNativeModule<NativeHaptics>("HapticBridge");

export function playOfficeHaptic(pattern: "HeavySwitch" | "RotaryRumble", durationMs = 0): void {
  if (!nativeHaptics) return;
  void nativeHaptics.play(pattern, durationMs).catch(() => {
    // Haptics are additive; the dashboard remains fully usable on simulators.
  });
}
