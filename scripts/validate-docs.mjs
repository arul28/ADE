import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const ignoredTopLevel = new Set([
  ".git",
  ".github",
  ".ade",
  "apps",
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

    if (
      relPath === "README.md" ||
      relPath === "AGENTS.md" ||
      relPath.endsWith(".mdx") ||
      (relPath.startsWith("docs/") && relPath.endsWith(".md"))
    ) {
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
      if (withoutExtension === "index") return "/";
      if (withoutExtension.endsWith("/index")) {
        return `/${withoutExtension.slice(0, -"/index".length)}`;
      }
      return `/${withoutExtension}`;
    })
);

const docsConfig = JSON.parse(await fs.readFile(path.join(repoRoot, "docs.json"), "utf8"));
const errors = [];

function normalizeTarget(rawTarget, fromFile) {
  const stripped = rawTarget.split("#")[0]?.split("?")[0] ?? "";
  if (stripped === "…" || stripped === "...") return null;
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
const leakedAgentMarkupPattern = /<\/(?:invoke|content)>|<parameter\b|antml:/g;

function lineNumberForIndex(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

for (const file of docFiles) {
  const content = await fs.readFile(path.join(repoRoot, file), "utf8");
  const seenTargets = new Set();

  if (file.endsWith(".mdx")) {
    leakedAgentMarkupPattern.lastIndex = 0;
    let artifactMatch;
    while ((artifactMatch = leakedAgentMarkupPattern.exec(content)) !== null) {
      errors.push(`${file}:${lineNumberForIndex(content, artifactMatch.index)}: remove leaked agent tool-call markup ${artifactMatch[0]}`);
    }
  }

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

function parseSemverTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!match) return null;
  return {
    raw: tag.trim(),
    version: `${match[1]}.${match[2]}.${match[3]}`,
    parts: match.slice(1).map(Number),
  };
}

function compareSemver(a, b) {
  for (let index = 0; index < 3; index += 1) {
    const diff = a.parts[index] - b.parts[index];
    if (diff !== 0) return diff;
  }
  return 0;
}

function semverGitTags() {
  let output;
  try {
    output = execFileSync("git", ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  return output
    .split(/\r?\n/)
    .map(parseSemverTag)
    .filter(Boolean)
    .sort(compareSemver);
}

async function validateReleaseDocs() {
  const gitTags = semverGitTags();
  if (gitTags === null) {
    errors.push("CHANGELOG.md: failed to read git tags; ensure git is installed and this is a git checkout");
    return;
  }

  const latestTag = gitTags.at(-1) ?? null;
  if (!latestTag) {
    const message = "CHANGELOG.md: no vX.Y.Z git tags found; fetch tags before validating release docs";
    if (process.env.CI) {
      errors.push(message);
    } else {
      console.warn(`Documentation validation warning: ${message}`);
    }
    return;
  }

  const changelog = await fs.readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const topVersion = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  if (!topVersion) {
    errors.push("CHANGELOG.md: missing a released ## [x.y.z] heading after Unreleased");
  } else if (topVersion !== latestTag.version) {
    errors.push(`CHANGELOG.md: top release ${topVersion} does not match latest git tag ${latestTag.raw}`);
  }

  const linkRefs = new Set([...changelog.matchAll(/^\[([^\]]+)\]:\s+\S+/gm)].map((match) => match[1]));
  const releaseHeadings = new Set();
  for (const match of changelog.matchAll(/^## \[([^\]]+)\]/gm)) {
    const heading = match[1];
    releaseHeadings.add(heading);
    if (!linkRefs.has(heading)) {
      errors.push(`CHANGELOG.md: missing link reference for [${heading}]`);
    }
  }
  for (const tag of gitTags) {
    if (!releaseHeadings.has(tag.version)) {
      errors.push(`CHANGELOG.md: missing release heading for git tag ${tag.raw}`);
    }
  }

  if (!(await targetExists({ absolute: `/changelog/${latestTag.raw}`, source: latestTag.raw, fromFile: "CHANGELOG.md" }))) {
    errors.push(`changelog/${latestTag.raw}.mdx: missing docs page for latest git tag ${latestTag.raw}`);
  }

  let changelogIndex;
  try {
    changelogIndex = await fs.readFile(path.join(repoRoot, "changelog/index.mdx"), "utf8");
  } catch {
    errors.push("changelog/index.mdx: file is missing; create it with a latest-release Card");
    return;
  }
  if (!changelogIndex.includes(`/changelog/${latestTag.raw}`)) {
    errors.push(`changelog/index.mdx: latest release card must link to /changelog/${latestTag.raw}`);
  }
  if (!changelogIndex.includes(latestTag.raw)) {
    errors.push(`changelog/index.mdx: latest release copy must mention ${latestTag.raw}`);
  }

  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  const stableChangelogUrl = "https://www.ade-app.dev/docs/changelog";
  if (!readme.includes(stableChangelogUrl)) {
    errors.push(`README.md: missing stable changelog link ${stableChangelogUrl}`);
  }
  if (/https:\/\/www\.ade-app\.dev\/docs\/changelog\/v\d+\.\d+\.\d+/.test(readme)) {
    errors.push("README.md: changelog links must use /docs/changelog, not a version-pinned release page");
  }
}

await validateReleaseDocs();

if (errors.length > 0) {
  console.error("Documentation validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Documentation validation passed for ${docFiles.length} files.`);
