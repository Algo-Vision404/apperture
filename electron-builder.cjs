/* electron-builder configuration.
 *
 * Moved out of package.json so signing can be chosen by the environment rather
 * than hardcoded — the same shape NitroAI uses.
 *
 *   • Signed + notarized — set MAC_SIGN=1 with a "Developer ID Application"
 *     identity reachable in the keychain (or CSC_LINK in CI), plus
 *     APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID. electron-builder
 *     signs with the hardened runtime, notarizes, and staples. The app then
 *     opens on the first double-click with no warning at all.
 *
 *   • Ad-hoc fallback (no cert) — identity:null, so a fork or a secret-less CI
 *     run still produces a valid (not "damaged") build. It is NOT distributable:
 *     macOS refuses it after a download, and since macOS 15 the old
 *     right-click → Open escape hatch is gone.
 */

// Gated on an explicit flag rather than on CSC_LINK: a bare .p12 carries only
// the leaf certificate, and signing with an incomplete chain fails in a way
// that looks like a wrong password.
const hasCert = process.env.MAC_SIGN === "1";
const canNotarize =
  hasCert &&
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  !!process.env.APPLE_TEAM_ID;
// Windows Authenticode signing is opt-in. electron-builder will still try to
// "sign" with signtool when this is left on without a real cert, which mutates
// the NSIS installer after its CRC is embedded and breaks uninstall.
const hasWinCert = process.env.WIN_SIGN === "1" && !!process.env.CSC_LINK;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.apperture.overlay",
  productName: "apperture",
  copyright: "Copyright © apperture",
  asar: false,
  // Baked into app-update.yml so installed apps know where to check. Builds do
  // not upload to GitHub unless you pass electron-builder --publish (never in dist:*).
  publish: {
    provider: "github",
    owner: "Algo-Vision404",
    repo: "apperture"
  },
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  // An allowlist, so anything new has to be added here or it simply is not in
  // the shipped app — and the only symptom is a require() that throws at
  // launch, in a build that ran fine from source.
  files: ["main.js", "preload.js", "src/**/*", "renderer/**/*", "vendor/**/*"],
  directories: { buildResources: "build-resources" },
  afterPack: "scripts/after-pack.js",
  mac: {
    target: [{ target: "zip", arch: ["x64", "arm64"] }],
    category: "public.app-category.productivity",
    // With a real cert, let electron-builder discover it and apply the hardened
    // runtime (notarization is refused without it). Without one, identity:null
    // makes it skip signing rather than fail.
    identity: hasCert ? undefined : null,
    hardenedRuntime: hasCert,
    gatekeeperAssess: false,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
    // electron-builder 26 wants a boolean; the credentials come from
    // APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID in the env.
    notarize: canNotarize,
    extendInfo: {
      LSUIElement: true,
      NSMicrophoneUsageDescription:
        "apperture transcribes your microphone so it can help you in conversations.",
      NSCameraUsageDescription: "apperture does not use the camera.",
      NSAudioCaptureUsageDescription:
        "apperture captures system audio to transcribe the other participant in a call.",
    },
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "${productName}-win-${arch}.${ext}",
    icon: "build-resources/icon.ico",
  // Embed honest apperture metadata/icons; only Authenticode-sign when a cert is set.
    signAndEditExecutable: true,
    signExecutable: hasWinCert,
    verifyUpdateCodeSignature: hasWinCert,
  },
  // Per-machine install: ships Uninstall apperture.exe in the install folder,
  // registers in Windows Settings > Apps, and can be removed from there.
  nsis: {
    oneClick: false,
    perMachine: true,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "apperture",
    menuCategory: "apperture",
    uninstallDisplayName: "apperture",
    guid: "7f3c8e2a-4b1d-5a9e-8c6d-0e1f2a3b4c5d",
    installerIcon: "build-resources/icon.ico",
    uninstallerIcon: "build-resources/icon.ico",
    differentialPackage: false,
    include: "build-resources/installer.nsh",
  },
  linux: {
    target: [{ target: "AppImage", arch: ["x64", "arm64"] }],
    category: "Utility",
  },
};
