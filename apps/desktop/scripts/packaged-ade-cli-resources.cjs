const fs = require("node:fs");
const path = require("node:path");

const defaultDesktopRoot = path.resolve(__dirname, "..");
const REQUIRED_PACKAGED_ADE_CLI_PAYLOAD_PATHS = Object.freeze([
  "cli.cjs",
  "bootstrap.cjs",
  "ptyHostWorker.cjs",
  "cursorSdkWorker.cjs",
  "droidSdkWorker.cjs",
  "usageLedgerWorker.cjs",
  "adeRpcServer.cjs",
  "tuiClient/cli.mjs",
  "bin/ade",
  "bin/ade.cmd",
  "install-path.sh",
  "install-path.cmd",
]);

function normalizeResourcePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function readDesktopPackageJson(desktopRoot = defaultDesktopRoot) {
  return JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
}

function packagedAdeCliResources(options = {}) {
  const desktopRoot = options.desktopRoot ?? defaultDesktopRoot;
  const packageJson = options.packageJson ?? readDesktopPackageJson(desktopRoot);
  const resources = packageJson.build?.extraResources;
  if (!Array.isArray(resources)) return [];

  return resources.flatMap((entry) => {
    if (!entry || typeof entry.from !== "string" || typeof entry.to !== "string") return [];
    const destination = normalizeResourcePath(entry.to);
    if (destination !== "ade-cli" && !destination.startsWith("ade-cli/")) return [];
    return [{
      from: entry.from,
      sourcePath: path.resolve(desktopRoot, entry.from),
      to: destination,
      relativePath: destination.slice("ade-cli/".length),
    }];
  });
}

function packagedAdeCliBuildResources(options = {}) {
  return packagedAdeCliResources(options).filter((entry) => {
    const source = normalizeResourcePath(entry.from);
    return source === "../ade-cli/dist" || source.startsWith("../ade-cli/dist/");
  });
}

function concretePayloadFile(resource, sourcePath, sourceRelativePath = "") {
  const relativeSuffix = normalizeResourcePath(sourceRelativePath);
  const destination = relativeSuffix
    ? path.posix.join(resource.to, relativeSuffix)
    : resource.to;
  return {
    ...resource,
    sourcePath,
    to: destination,
    relativePath: destination === "ade-cli"
      ? ""
      : destination.slice("ade-cli/".length),
  };
}

function expandResourcePayloadFiles(resource, options) {
  let stat;
  try {
    stat = fs.lstatSync(resource.sourcePath);
  } catch (error) {
    if (options.allowMissingSources && resource.relativePath) {
      return [concretePayloadFile(resource, resource.sourcePath)];
    }
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `[ade-cli:resources] Unable to inspect configured resource ${resource.from}${detail}`,
    );
  }

  if (!stat.isDirectory()) {
    return [concretePayloadFile(resource, resource.sourcePath)];
  }

  const files = [];
  const visit = (directoryPath) => {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      files.push(concretePayloadFile(
        resource,
        entryPath,
        path.relative(resource.sourcePath, entryPath),
      ));
    }
  };
  visit(resource.sourcePath);
  return files;
}

function packagedAdeCliPayloadFiles(options = {}) {
  return packagedAdeCliResources(options).flatMap((resource) => (
    expandResourcePayloadFiles(resource, options)
  ));
}

function missingRequiredPackagedAdeCliPayloadPaths(payloadFiles) {
  const packagedPaths = new Set(payloadFiles.map((resource) => resource.relativePath));
  return REQUIRED_PACKAGED_ADE_CLI_PAYLOAD_PATHS.filter((relativePath) => (
    !packagedPaths.has(relativePath)
  ));
}

function sourceContainsPath(sourcePath, candidatePath) {
  const relative = path.relative(sourcePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

module.exports = {
  REQUIRED_PACKAGED_ADE_CLI_PAYLOAD_PATHS,
  packagedAdeCliBuildResources,
  packagedAdeCliPayloadFiles,
  packagedAdeCliResources,
  missingRequiredPackagedAdeCliPayloadPaths,
  readDesktopPackageJson,
  sourceContainsPath,
};
