import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const ignoredTopLevel = new Set([
  ".git",
  ".github",
  ".ade",
  "apps",
  "docs",
  "infra",
  "node_modules",
  "plans",
  "dist",
]);

const docFiles = [];

async function walkDocs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      if (entry.name !== ".well-known") continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(repoRoot, fullPath);

    if (entry.isDirectory()) {
      if (dir === repoRoot && ignoredTopLevel.has(entry.name)) continue;
      await walkDocs(fullPath);
      continue;
    }

    if (relPath === "README.md" || relPath.endsWith(".mdx")) {
      docFiles.push(relPath);
    }
  }
}

await walkDocs(repoRoot);

const routeSet = new Set(
  docFiles
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => {
      const withoutExtension = file.replace(/\.mdx$/, "");
      return withoutExtension === "index" ? "/" : `/${withoutExtension}`;
    })
);

const docsConfig = JSON.parse(await fs.readFile(path.join(repoRoot, "docs.json"), "utf8"));
const errors = [];

function normalizeTarget(rawTarget, fromFile) {
  const stripped = rawTarget.split("#")[0]?.split("?")[0] ?? "";
  if (!stripped || stripped.startsWith("http://") || stripped.startsWith("https://") || stripped.startsWith("mailto:") || stripped.startsWith("tel:")) {
    return null;
  }

  if (stripped.startsWith("/")) {
    return { absolute: stripped, source: rawTarget, fromFile };
  }

  const fromDir = path.posix.dirname(fromFile.replaceAll(path.sep, "/"));
  const resolved = path.posix.normalize(path.posix.join(fromDir === "." ? "" : fromDir, stripped));
  return { absolute: `/${resolved}`, source: rawTarget, fromFile };
}

function targetExists(target) {
  const clean = target.absolute;

  if (routeSet.has(clean)) {
    return true;
  }

  const repoPath = path.join(repoRoot, clean.slice(1));
  return fs.access(repoPath).then(() => true).catch(() => false);
}

function collectConfigTargets(config) {
  const targets = [];

  for (const tab of config.navigation?.tabs ?? []) {
    for (const group of tab.groups ?? []) {
      for (const page of group.pages ?? []) {
        targets.push({ absolute: `/${page}`, source: page, fromFile: "docs.json" });
      }
    }
  }

  const hrefContainers = [
    ...(config.navigation?.global?.anchors ?? []),
    ...(config.footer?.links ?? []).flatMap((section) => section.items ?? []),
    config.navbar?.primary ?? {},
    ...(config.navbar?.links ?? []),
  ];

  for (const item of hrefContainers) {
    if (typeof item?.href === "string" && !item.href.startsWith("http")) {
      targets.push({ absolute: item.href.startsWith("/") ? item.href : `/${item.href}`, source: item.href, fromFile: "docs.json" });
    }
  }

  for (const logoPath of [config.favicon, config.logo?.light, config.logo?.dark]) {
    if (typeof logoPath === "string" && logoPath.startsWith("/")) {
      targets.push({ absolute: logoPath, source: logoPath, fromFile: "docs.json" });
    }
  }

  return targets;
}

for (const target of collectConfigTargets(docsConfig)) {
  if (!(await targetExists(target))) {
    errors.push(`${target.fromFile}: missing target ${target.source}`);
  }
}

const inlineHrefPattern = /\b(?:href|src)=["']([^"']+)["']/g;
const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

for (const file of docFiles) {
  const content = await fs.readFile(path.join(repoRoot, file), "utf8");
  const seenTargets = new Set();

  for (const pattern of [inlineHrefPattern, markdownLinkPattern]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const rawTarget = match[1]?.trim();
      const normalized = normalizeTarget(rawTarget, file);
      if (!normalized) continue;
      const dedupeKey = `${file}:${normalized.absolute}`;
      if (seenTargets.has(dedupeKey)) continue;
      seenTargets.add(dedupeKey);

      if (!(await targetExists(normalized))) {
        errors.push(`${file}: missing target ${rawTarget}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Documentation validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Documentation validation passed for ${docFiles.length} files.`);

