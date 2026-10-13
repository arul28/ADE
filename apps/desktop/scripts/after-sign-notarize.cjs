// Notarizes and staples the signed macOS app, with retries on Apple's network
// errors.
//
// electron-builder's built-in `mac.notarize` runs the same two steps once each,
// so a single dropped connection to the notary or ticket service failed the
// whole signed build: the app was notarized, and then the staple lost its
// connection to CloudKit. `mac.notarize` is therefore `false` in package.json
// and this hook does the work instead. electron-builder only calls `afterSign`
// when it actually signed the app, so unsigned `dist:mac:dir` builds skip it.
//
// Credentials are read exactly as electron-builder reads them: an app-specific
// password, an App Store Connect API key, or a keychain profile. With none set
// it skips silently, as electron-builder does.
const path = require("node:path");
const { notarizeAndWaitForNotaryTool } = require("@electron/notarize/lib/notarytool");
const { stapleApp } = require("@electron/notarize/lib/staple");

function notaryCredentials() {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (APPLE_ID || APPLE_APP_SPECIFIC_PASSWORD) {
    if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
      throw new Error("[release:mac] APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID must all be set.");
    }
    return { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID };
  }
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (APPLE_API_KEY || APPLE_API_KEY_ID || APPLE_API_ISSUER) {
    if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
      throw new Error("[release:mac] APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER must all be set.");
    }
    return { appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER };
  }
  if (process.env.APPLE_KEYCHAIN_PROFILE) {
    const keychain = process.env.APPLE_KEYCHAIN ? { keychain: process.env.APPLE_KEYCHAIN } : {};
    return { keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE, ...keychain };
  }
  return null;
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const credentials = notaryCredentials();
  if (!credentials) {
    console.log("[release:mac] No notarization credentials; skipping app notarization.");
    return;
  }

  // release-retry.mjs is ESM, so this CommonJS hook loads it with import().
  const { isAppleNetworkError, retryTransient } = await import("./release-retry.mjs");
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  console.log(`[release:mac] Notarizing app: ${appPath}`);
  await retryTransient(
    `notarization of ${path.basename(appPath)}`,
    () => notarizeAndWaitForNotaryTool({ appPath, ...credentials }),
    { attempts: 4, delayMs: 30_000, isTransient: isAppleNetworkError },
  );
  await retryTransient(
    `stapling ${path.basename(appPath)}`,
    () => stapleApp({ appPath }),
    { attempts: 6, delayMs: 15_000, isTransient: isAppleNetworkError },
  );
  console.log(`[release:mac] App notarized and stapled: ${appPath}`);
};
