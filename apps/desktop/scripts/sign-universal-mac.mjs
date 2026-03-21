import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { TmpDir } = require("temp-file");
const { createKeychain, findIdentity, removeKeychain, sign } = require("app-builder-lib/out/codeSign/macCodeSign.js");
const { notarize } = require("@electron/notarize");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(await fs.readFile(path.join(appDir, "package.json"), "utf8"));
const macBuildOptions = packageJson.build?.mac ?? {};

function readFlag(name) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

function resolveAbsolute(input, fallback) {
  const value = input?.trim() || fallback;
  if (!value) {
    throw new Error("Missing required path argument");
  }
  return path.isAbsolute(value) ? value : path.resolve(appDir, value);
}

function hasValue(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim().length > 0);
}

function resolveBuildResource(filePath) {
  if (!filePath) return undefined;
  return path.isAbsolute(filePath) ? filePath : path.join(appDir, filePath);
}

function buildOptionsForFile(appPath) {
  const mainEntitlements = resolveBuildResource(macBuildOptions.entitlements);
  const inheritedEntitlements = resolveBuildResource(macBuildOptions.entitlementsInherit);
  const loginHelperEntitlements = resolveBuildResource(macBuildOptions.entitlementsLoginHelper);
  const requirements = resolveBuildResource(macBuildOptions.requirements);
  const additionalArguments = macBuildOptions.additionalArguments ?? [];
  const hardenedRuntime = macBuildOptions.hardenedRuntime !== false;

  return (filePath) => {
    let entitlements;
    if (filePath === appPath) {
      entitlements = mainEntitlements;
    } else if (filePath.includes("Library/LoginItems")) {
      entitlements = loginHelperEntitlements;
    } else {
      entitlements = inheritedEntitlements;
    }

    return {
      entitlements,
      hardenedRuntime,
      requirements,
      additionalArguments,
      timestamp: macBuildOptions.timestamp || undefined,
    };
  };
}

function buildNotarizeOptions(appPath) {
  if (hasValue("APPLE_API_KEY") && hasValue("APPLE_API_KEY_ID") && hasValue("APPLE_API_ISSUER")) {
    return {
      appPath,
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      appleApiIssuer: process.env.APPLE_API_ISSUER,
    };
  }

  if (hasValue("APPLE_ID") && hasValue("APPLE_APP_SPECIFIC_PASSWORD") && hasValue("APPLE_TEAM_ID")) {
    return {
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    };
  }

  if (hasValue("APPLE_KEYCHAIN_PROFILE")) {
    return {
      appPath,
      keychain: process.env.APPLE_KEYCHAIN,
      keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE,
    };
  }

  throw new Error("Missing notarization credentials for universal mac signing");
}

const appPath = resolveAbsolute(
  readFlag("--app") ?? process.env.ADE_UNIVERSAL_APP_PATH,
  path.join(appDir, "release", "mac-universal", "ADE.app"),
);

await fs.access(appPath);

const tmpDir = new TmpDir("ade-mac-release-sign");
let keychainFile;

try {
  const keychainInfo = await createKeychain({
    tmpDir,
    cscLink: process.env.CSC_LINK,
    cscKeyPassword: process.env.CSC_KEY_PASSWORD ?? "",
    cscILink: process.env.CSC_INSTALLER_LINK,
    cscIKeyPassword: process.env.CSC_INSTALLER_KEY_PASSWORD,
    currentDir: appDir,
  });

  keychainFile = keychainInfo.keychainFile;

  const identity = await findIdentity("Developer ID Application", process.env.CSC_NAME || null, keychainFile);
  if (!identity) {
    throw new Error("Unable to find a Developer ID Application certificate for signing");
  }

  console.log(`[release:mac] Signing universal app bundle at ${appPath}`);

  await sign({
    identityValidation: false,
    identity: identity.name,
    app: appPath,
    keychain: keychainFile || undefined,
    platform: "darwin",
    type: "distribution",
    version: packageJson.devDependencies?.electron?.replace(/^[^\d]*/, "") || undefined,
    strictVerify: macBuildOptions.strictVerify,
    preAutoEntitlements: macBuildOptions.preAutoEntitlements,
    provisioningProfile: resolveBuildResource(macBuildOptions.provisioningProfile),
    optionsForFile: buildOptionsForFile(appPath),
    ignore: (file) =>
      file.endsWith(".kext") ||
      file.includes("/node_modules/puppeteer/.local-chromium") ||
      file.includes("/node_modules/playwright-firefox/.local-browsers") ||
      file.includes("/node_modules/playwright/.local-browsers"),
  });

  console.log("[release:mac] Notarizing and stapling universal app bundle");
  await notarize(buildNotarizeOptions(appPath));

  console.log("[release:mac] Validating stapled app bundle");
  await execFileAsync("xcrun", ["stapler", "validate", appPath]);
  await execFileAsync("spctl", ["-a", "-vvv", "--type", "execute", appPath]);

  console.log("[release:mac] Universal app bundle is signed, notarized, and stapled");
} finally {
  if (keychainFile) {
    await removeKeychain(keychainFile, false).catch(() => {});
  }
  await tmpDir.cleanup().catch(() => {});
}
