# ASC Spatial iOS — native LiDAR build

The LiDAR scanner is a local Expo Swift module in `modules/asc-lidar/ios`. It
uses ARKit scene reconstruction and is not included in Expo Go.

## Build and test on a physical iPhone or iPad

The Replit Expo Go preview cannot load this local Swift module. Replit Expo
Launch can compile it for an App Store build; the latest publish log reached
Xcode and identified a Swift source error. For local device development, build
on a Mac with Xcode and CocoaPods:

1. Clone the workspace and install dependencies from the repository root:

   ```sh
   pnpm install
   ```

2. Set a unique `ios.bundleIdentifier` in `app.json` before signing the app.
   Keep it consistent with the Apple Developer app record.

3. Provide the public build-time configuration in the shell used for the build:

   ```sh
   export EXPO_PUBLIC_DOMAIN="<public-host-serving-the-ASC-Spatial-API>"
   export EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY="<Clerk-publishable-key>"
   ```

   `EXPO_PUBLIC_DOMAIN` is a hostname only; the app adds `https://` and calls
   the API's `/api/...` routes. Use a publicly reachable Replit API host, not
   `localhost` or a Metro host. If the Clerk setup uses a proxy, also provide
   `EXPO_PUBLIC_CLERK_PROXY_URL` with the full proxy URL.

4. From the repository root, generate the native iOS project and run it on the
   connected device:

   ```sh
   pnpm --filter @workspace/asc-spatial-ios exec expo prebuild --platform ios
   pnpm --filter @workspace/asc-spatial-ios exec expo run:ios --device
   ```

5. Test capture on a LiDAR-equipped iPhone Pro or iPad Pro. A simulator can
   verify screens and navigation, but cannot verify the LiDAR sensor.

Do not commit local environment files or credentials. The Replit backend and
its scan storage remain the app's backend; the iOS build only changes where
the native client is compiled.

## Replit preview

The Replit Expo Go preview remains useful for the non-LiDAR app screens and
uploading existing `.ply` or `.obj` files. It cannot load the custom ARKit
module or start a LiDAR scan.

## Cloud iOS compile check

The GitHub Actions workflow at `.github/workflows/asc-spatial-ios.yml` uses a
hosted macOS runner to generate the native iOS project and compile the app for
the iOS Simulator. It runs manually from the repository's **Actions** tab or
when relevant iOS source files are pushed to `main`.

This checks that the Swift module and iOS project compile. It is an unsigned
simulator build, not an installable iPhone/iPad app, and it cannot verify the
LiDAR sensor. Installing on a physical device still requires Apple signing and
a LiDAR-equipped device.

## Installable iPhone/iPad build

The manual GitHub Actions workflow at `.github/workflows/asc-spatial-ios-device.yml`
creates a signed IPA using the repository's encrypted Actions secrets. Before
running it, add these secrets under **Settings → Secrets and variables →
Actions** in the GitHub repository:

- `ASC_IOS_CERTIFICATE_P12_BASE64` — base64-encoded `.p12` signing certificate
- `ASC_IOS_CERTIFICATE_PASSWORD` — password used when exporting that certificate
- `ASC_IOS_PROVISIONING_PROFILE_BASE64` — base64-encoded `.mobileprovision` file
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` — the app's Clerk publishable key
- `EXPO_PUBLIC_CLERK_PROXY_URL` — optional; set only if Clerk uses a proxy

Use a matching Apple Development certificate and Development profile for
`development`, or an Apple Distribution certificate and Ad Hoc profile for
`ad-hoc`. The profile must use bundle ID `app.replit.ascspatialios`; a
Development or Ad Hoc profile must also include the device UDID for direct
installation. Do not commit signing files or paste their contents into chat.

Then open **Actions → ASC Spatial iOS device build → Run workflow**, choose the
matching export method, and download the `.ipa` from the completed run's
**Artifacts** section. The IPA can be installed only on devices included in the
profile; the build does not submit the app to the App Store.

References:

- [Replit native mobile apps](https://docs.replit.com/features/artifact-types/building-mobile-apps)
- [Expo local app development](https://docs.expo.dev/guides/local-app-development/)
- [Expo local modules](https://docs.expo.dev/modules/get-started/)
