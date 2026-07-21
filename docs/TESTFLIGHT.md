# Omnibus: first TestFlight build

This runbook gets Omnibus onto your own iPhone for the hackathon demo. It uses Apple-managed signing for speed and Fastlane for repeatable archives/uploads. Do not add Apple IDs, passwords, provisioning profiles, `.p8` API keys, or `fastlane/.env` to git.

## 1. Decide the permanent bundle ID first

Choose an identifier that is unique to you and will remain stable after the first upload. Recommended pattern:

```text
com.<your-domain-or-name>.omnibus
```

The project is configured for the registered explicit App ID `com.app.omnibus`; it must remain an exact match in the Apple Developer portal, `mobile/app.json`, and `mobile/fastlane/.env`.

Set the chosen value in these two places:

1. `mobile/app.json` → `expo.ios.bundleIdentifier`
2. `mobile/fastlane/.env` → `APP_IDENTIFIER`

Then run `npm run mobile:native-sync` so the generated Xcode project matches it. Never change this ID after you have uploaded a build.

## 2. Apple Developer portal: create the App ID

You need an active paid Apple Developer Program membership with two-factor authentication. In the developer account, open **Certificates, Identifiers & Profiles** → **Identifiers** → **+** and choose:

| Field | Value |
| --- | --- |
| Type | App IDs → App |
| Description | Omnibus |
| Bundle ID | Explicit, then the exact identifier chosen above |
| Capabilities | None for the current app |

Camera access is covered by the existing `NSCameraUsageDescription`; CoreHaptics requires no App ID capability. Register the identifier.

## 3. App Store Connect: create the app record

Open **Apps** → **+** → **New App**, then choose:

| Field | Value |
| --- | --- |
| Platforms | iOS |
| Name | Omnibus |
| Primary language | English (U.S.) or your preference |
| Bundle ID | The App ID from step 2 |
| SKU | `OMNIBUS-2026` (any unique internal ID is fine; it cannot be changed later) |
| User access | Full Access |

Create the record. You do not need store metadata or screenshots to distribute an internal TestFlight build.

## 4. Configure signing once in Xcode

Open `mobile/ios/Omnibus.xcworkspace` — not the `.xcodeproj`. Select target **Omnibus** → **Signing & Capabilities**, then:

1. Enable **Automatically manage signing**.
2. Choose the team associated with your paid Developer Program membership.
3. Confirm the bundle identifier is the one registered in step 2.
4. Build/run once on a connected iPhone if Xcode asks to create a development certificate or profile.

Copy the 10-character Team ID into `APPLE_TEAM_ID` later. Fastlane can ask Xcode to update provisioning during an archive, but it cannot perform this first interactive account sign-in for you.

## 5. Create an App Store Connect API key for Fastlane

For a one-person laptop workflow, create an **Individual API Key** in App Store Connect under **Users and Access** → **Integrations**. If your role does not expose individual keys, ask an Account Holder/Admin to create a Team API key with App Manager/Developer access instead.

Download the `.p8` file immediately — Apple only presents it once — and put it outside this repository, for example in a private `Keys/` folder. Copy its Key ID. For a Team key, also copy the Issuer ID. Keep the Team key scope tight; it has access across the team’s apps.

Create your ignored local configuration:

```bash
cp mobile/fastlane/.env.example mobile/fastlane/.env
```

Fill it like this:

```ini
APP_IDENTIFIER=com.app.omnibus
APPLE_TEAM_ID=ABCDE12345
ASC_KEY_ID=ABC123DEFG
ASC_KEY_FILE=/absolute/path/outside-this-repository/AuthKey_ABC123DEFG.p8
# Set this only for a Team API key:
# ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## 6. Build, upload, and install

Fastlane is installed on this development Mac. On a new Mac, install it with Homebrew (`brew install fastlane`) before using the npm shortcuts.

```bash
npm install
npm run mobile:native-sync  # only after native/app config changes
npm run mobile:verify       # unsigned simulator compile
npm run mobile:archive      # signed IPA at mobile/artifacts/ios/Omnibus.ipa
npm run mobile:testflight:check # validates API key, app record, and bundle ID only
npm run mobile:testflight   # next build number + upload
```

The first source-built React Native compile can take several minutes on Xcode
26. This is expected: Omnibus keeps Reanimated 4's required New Architecture
and uses a reproducible prebuild compatibility patch instead of a manual Pods
edit.

The `upload_testflight` lane (invoked by `npm run mobile:testflight`) first synchronizes Expo native modules, then queries the highest TestFlight build for the current version, increments the native build number, archives with automatic signing, and uploads. It keeps the build internal (`distribute_external: false`). Wait for Apple processing to finish before it appears in TestFlight.

## 7. Add yourself as an internal tester

In the app record, go to **TestFlight**. Under **Internal Testing**, create a group, add your App Store Connect user, choose the processed build, and enter a short "What to Test" note, such as:

> Scan the laptop bridge QR code, shape an idea, and observe the local review, IDE-ready brief, and haptics.

Install the TestFlight app on your iPhone, accept the invitation, then install Omnibus. Internal testing is fastest for your demo. External/public TestFlight distribution needs additional beta information and Apple’s beta review; it is not required to screen-record your own build.

## Demo-day checklist

1. On a fresh Mac, run `npm install --global omnibus-bridge` followed by
   `omnibus-bridge setup --install-runtime --pull-models && omnibus-bridge start`
   on the laptop. The setup command asks before installing the verified local
   runtime and downloading the configured local model team.
2. Confirm the bridge prints a fresh tunnel URL and QR pairing code.
3. Open the TestFlight build on the physical iPhone and scan the QR code.
4. Use a safe demo idea and show the pairing tutorial, local-review progress, mist-to-brief transition, and final IDE-ready brief.
5. Record with iOS Screen Recording and narrate the Codex/GPT-5.6 role within the required three-minute Devpost video.

The TestFlight package does not host the bridge. For the live demo, keep the laptop bridge running and pair only through the one-time QR token.
