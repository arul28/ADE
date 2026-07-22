const fs = require("node:fs");
const path = require("node:path");

const defaultDesktopRoot = path.resolve(__dirname, "..");

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

function sourceContainsPath(sourcePath, candidatePath) {
  const relative = path.relative(sourcePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

module.exports = {
  packagedAdeCliBuildResources,
  packagedAdeCliResources,
  readDesktopPackageJson,
  sourceContainsPath,
};
