import CoreHaptics
import ExpoModulesCore
import Foundation

public final class HapticBridgeModule: Module {
  private var engine: CHHapticEngine?
  private var activePlayer: CHHapticAdvancedPatternPlayer?

  public func definition() -> ModuleDefinition {
    Name("HapticBridge")

    AsyncFunction("play") { (patternName: String, durationMs: Double) in
      try self.play(patternName: patternName, durationMs: durationMs)
    }
  }

  private func play(patternName: String, durationMs: Double) throws {
    guard #available(iOS 13.0, *) else { return }
    guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
    guard let url = Bundle.main.url(forResource: patternName, withExtension: "ahap")
      ?? Bundle(for: HapticBridgeModule.self).url(forResource: patternName, withExtension: "ahap") else {
      throw HapticBridgeError.missingPattern(patternName)
    }

    if engine == nil {
      engine = try CHHapticEngine()
      engine?.stoppedHandler = { [weak self] _ in self?.engine = nil }
      engine?.resetHandler = { [weak self] in try? self?.engine?.start() }
    }
    try engine?.start()
    let pattern = try loadPattern(from: url)
    let player = try engine!.makeAdvancedPlayer(with: pattern)
    activePlayer = player
    try player.start(atTime: CHHapticTimeImmediate)

    // AHAP carries the calibrated intensity/sharpness curve. The optional stop
    // time lets a Skia/Reanimated interaction cut a continuous rumble short.
    if durationMs > 0 {
      DispatchQueue.main.asyncAfter(deadline: .now() + durationMs / 1000) { [weak self] in
        try? self?.activePlayer?.stop(atTime: CHHapticTimeImmediate)
      }
    }
  }

  /// `init(contentsOf:)` is a convenience initializer introduced in iOS 16.
  /// Omnibus supports iOS 15.1, so older devices parse the same bundled AHAP
  /// JSON into CoreHaptics' dictionary initializer instead of losing haptics.
  private func loadPattern(from url: URL) throws -> CHHapticPattern {
    if #available(iOS 16.0, *) {
      return try CHHapticPattern(contentsOf: url)
    }

    let data = try Data(contentsOf: url)
    guard let dictionary = try JSONSerialization.jsonObject(with: data) as? [CHHapticPattern.Key: Any] else {
      throw HapticBridgeError.invalidPattern(url.lastPathComponent)
    }
    return try CHHapticPattern(dictionary: dictionary)
  }
}

private enum HapticBridgeError: Error, LocalizedError {
  case missingPattern(String)
  case invalidPattern(String)

  var errorDescription: String? {
    switch self {
    case .missingPattern(let name): return "Missing AHAP pattern: \(name)"
    case .invalidPattern(let name): return "Invalid AHAP pattern: \(name)"
    }
  }
}
