const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Xcode 26's compiler rejects fmt 11's consteval format-string implementation
 * when React Native 0.81 is built from source. fmt defines its feature macro
 * unconditionally, so a compiler flag cannot override it; patch only the
 * vendored pod header after CocoaPods has materialized it.
 *
 * `expo-build-properties` enables source-built RN for the Expo dev-client
 * linker compatibility fallback. This companion plugin makes that fallback
 * reproducible after every `expo prebuild`, rather than relying on an edit in
 * the generated Pods directory.
 */
module.exports = function withFmtConstevalFix(config) {
  return withDangerousMod(config, ["ios", async modConfig => {
    const podfilePath = path.join(modConfig.modRequest.platformProjectRoot, "Podfile");
    if (!fs.existsSync(podfilePath)) return modConfig;

    const marker = "# OMNIBUS_FMT_XCODE26_SOURCE_FIX";
    const legacyMarker = "# OMNIBUS_FMT_XCODE26_COMPAT";
    let podfile = fs.readFileSync(podfilePath, "utf8");
    if (podfile.includes(marker)) return modConfig;

    // Clean up the first revision of this patch, which tried a preprocessor
    // setting. fmt redefines that macro in base.h, so it cannot be effective.
    const legacyIndex = podfile.indexOf(legacyMarker);
    if (legacyIndex >= 0) {
      const legacyStart = podfile.lastIndexOf("\n", legacyIndex);
      const postInstallClose = podfile.lastIndexOf("\n  end\nend");
      if (legacyStart < 0 || postInstallClose <= legacyStart) {
        throw new Error("Unable to replace the legacy fmt compatibility patch in the Podfile.");
      }
      podfile = `${podfile.slice(0, legacyStart)}${podfile.slice(postInstallClose)}`;
    }

    const insertionPoint = podfile.lastIndexOf("\n  end\nend");
    if (insertionPoint < 0) {
      throw new Error("Unable to locate the Podfile post_install block for the fmt compatibility patch.");
    }

    const compatibilityPatch = `
    ${marker}
    # RN 0.81 ships fmt 11.0.2. Xcode 26 cannot compile its consteval branch.
    # The source edit is applied inside post_install so every pod install starts
    # from the untouched dependency and then gets the same narrow workaround.
    fmt_base = File.join(installer.sandbox.pod_dir("fmt"), "include", "fmt", "base.h")
    if File.exist?(fmt_base)
      content = File.read(fmt_base)
      patched = content.gsub(/^#  define FMT_USE_CONSTEVAL 1$/, "#  define FMT_USE_CONSTEVAL 0")
      if patched != content
        File.chmod(0644, fmt_base)
        File.write(fmt_base, patched)
      end
    end
`;
    fs.writeFileSync(podfilePath, `${podfile.slice(0, insertionPoint)}${compatibilityPatch}${podfile.slice(insertionPoint)}`);
    return modConfig;
  }]);
};
