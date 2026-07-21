Pod::Spec.new do |s|
  s.name = "OmnibusHaptics"
  s.version = "1.0.0"
  s.summary = "CoreHaptics patterns for Omnibus"
  s.homepage = "https://github.com"
  s.authors = { "Omnibus" => "noreply@localhost" }
  s.license = { :type => "Proprietary", :text => "Copyright 2026 Omnibus." }
  s.platforms = { :ios => "13.0" }
  s.source = { :git => "https://example.invalid/omnibus-haptics.git", :tag => s.version.to_s }
  s.static_framework = true
  s.source_files = "ios/**/*.{swift,h,m}"
  s.resources = "ios/*.ahap"
  s.dependency "ExpoModulesCore"
  s.swift_version = "5.9"
end
