import fs from "node:fs/promises";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const packageJsonPath = path.join(appDir, "package.json");
const originalPackageJson = await fs.readFile(packageJsonPath, "utf8");
const packageJson = JSON.parse(originalPackageJson);
const authorName =
  typeof packageJson.author === "string" ? packageJson.author : packageJson.author?.name ?? null;
const args = process.argv.slice(2);
const zipOnly = args.includes("--zip-only");

function readFlag(name) {
  const prefix = `${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }
  return null;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseEnvFile(contents) {
  const env = {};
  let currentKey = null;

  for (const line of contents.split(/\r?\n/)) {
    if (/^[A-Z0-9_]+=/.test(line)) {
      const separatorIndex = line.indexOf("=");
      currentKey = line.slice(0, separatorIndex);
      env[currentKey] = line.slice(separatorIndex + 1);
      continue;
    }

    if (line.trim() === "") {
      currentKey = null;
      continue;
    }

    if (currentKey) {
      env[currentKey] += `\n${line}`;
    }
  }

  return env;
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: appDir,
    env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(" ")} failed with exit code ${result.status || 1}`);
    error.exitCode = result.status || 1;
    throw error;
  }
}

function maybeUseInstalledIdentity(env) {
  const hasImportedCertificate = Boolean(env.CSC_LINK && env.CSC_KEY_PASSWORD);

  if (hasImportedCertificate) {
    delete env.CSC_NAME;
    return;
  }

  if (env.CSC_NAME) {
    return;
  }

  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return;
  }

  const identities = result.stdout
    .split("\n")
    .map((line) => {
      const firstQuoteIndex = line.indexOf('"');
      const lastQuoteIndex = line.lastIndexOf('"');
      if (firstQuoteIndex === -1 || lastQuoteIndex <= firstQuoteIndex) {
        return null;
      }
      return line.slice(firstQuoteIndex + 1, lastQuoteIndex);
    })
    .filter((identity) => identity?.startsWith("Developer ID Application: "));

  const preferredIdentity =
    identities.find((identity) => authorName && identity.includes(authorName)) ?? identities[0] ?? null;

  if (!preferredIdentity) {
    return;
  }

  env.CSC_NAME = preferredIdentity.replace(/^Developer ID Application:\s*/, "");
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
}

const releaseTag =
  (args.find((arg) => !arg.startsWith("--")) ?? process.env.ADE_RELEASE_TAG ?? "").trim();
if (!releaseTag) {
  throw new Error("Usage: npm run release:mac:local -- v1.2.3 [--zip-only]");
}

if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(releaseTag)) {
  throw new Error(`Release tag must look like v1.2.3, received: ${releaseTag}`);
}

const localEnvPath = path.join(repoRoot, ".env.local");
let temporaryAppleKeyDir = null;

let exitCode = 0;
let failure = null;

try {
  const env = { ...process.env, ADE_RELEASE_TAG: releaseTag };
  const x64AppPath = readFlag("--x64-app");
  const x64ZipPath = readFlag("--x64-zip");

  try {
    const localEnv = parseEnvFile(await fs.readFile(localEnvPath, "utf8"));
    for (const [key, value] of Object.entries(localEnv)) {
      if (!env[key]) {
        env[key] = value;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (env.APPLE_API_KEY_P8 && !env.APPLE_API_KEY) {
    temporaryAppleKeyDir = mkdtempSync(path.join(os.tmpdir(), "ade-release-"));
    const appleKeyPath = path.join(temporaryAppleKeyDir, `AuthKey_${env.APPLE_API_KEY_ID}.p8`);
    writeFileSync(appleKeyPath, env.APPLE_API_KEY_P8);
    chmodSync(appleKeyPath, 0o600);
    env.APPLE_API_KEY = appleKeyPath;
  }

  env.ELECTRON_CACHE ||= path.join(appDir, ".cache", "electron");
  env.ELECTRON_BUILDER_CACHE ||= path.join(appDir, ".cache", "electron-builder");
  maybeUseInstalledIdentity(env);

  if (x64AppPath) {
    env.ADE_X64_APP_PATH = path.isAbsolute(x64AppPath) ? x64AppPath : path.resolve(repoRoot, x64AppPath);
  }

  if (x64ZipPath) {
    env.ADE_X64_APP_ZIP = path.isAbsolute(x64ZipPath) ? x64ZipPath : path.resolve(repoRoot, x64ZipPath);
  }

  await fs.rm(path.join(appDir, "release"), { recursive: true, force: true });
  await fs.mkdir(path.dirname(env.ELECTRON_CACHE), { recursive: true });
  await fs.mkdir(env.ELECTRON_BUILDER_CACHE, { recursive: true });

  run("npm", ["run", "version:release"], env);

  const hasPreparedX64Inputs =
    (await pathExists(
      path.join(
        appDir,
        "node_modules",
        "@img",
        "sharp-darwin-x64",
        "lib",
        "sharp-darwin-x64.node",
      ),
    )) &&
    (await pathExists(
      path.join(
        appDir,
        "node_modules",
        "@openai",
        "codex-darwin-x64",
        "vendor",
        "x86_64-apple-darwin",
        "codex",
        "codex",
      ),
    )) &&
    (await pathExists(
      path.join(
        appDir,
        "node_modules",
        "@huggingface",
        "transformers",
        "node_modules",
        "onnxruntime-node",
        "bin",
        "napi-v3",
        "darwin",
        "x64",
        "onnxruntime_binding.node",
      ),
    )) &&
    (await pathExists(path.join(appDir, "vendor", "crsqlite", "darwin-x64", "crsqlite.dylib")));

  if (env.ADE_X64_APP_PATH || env.ADE_X64_APP_ZIP || !hasPreparedX64Inputs) {
    run("npm", ["run", "prepare:mac:universal"], env);
  }

  if (zipOnly) {
    run("npm", ["run", "dist:mac:universal:signed:zip"], env);
    run("npm", ["run", "validate:mac:artifacts", "--", "--skip-dmg"], env);
  } else {
    run("npm", ["run", "dist:mac:universal:signed"], env);
    run("npm", ["run", "notarize:mac:dmg"], env);
    run("npm", ["run", "validate:mac:artifacts"], env);
  }
} catch (error) {
  exitCode = error?.exitCode ?? 1;
  failure = error;
} finally {
  await fs.writeFile(packageJsonPath, originalPackageJson);

  if (temporaryAppleKeyDir) {
    rmSync(temporaryAppleKeyDir, { recursive: true, force: true });
  }

  process.exitCode = exitCode;
}

if (failure) {
  throw failure;
}
