import assert from "node:assert/strict";
import test from "node:test";

import { docRouteForFile, isDocFile, normalizeTarget, toRouteId } from "./validate-docs.mjs";

const WIN = "\\";
const POSIX = "/";

test("converts native Windows paths into forward-slash route ids", () => {
  assert.equal(toRouteId("configuration\\ai-providers.mdx", WIN), "configuration/ai-providers.mdx");
  assert.equal(toRouteId("docs\\guides\\deep\\nested.md", WIN), "docs/guides/deep/nested.md");
  assert.equal(toRouteId("welcome.mdx", WIN), "welcome.mdx");
});

test("leaves POSIX paths untouched, including literal backslashes in filenames", () => {
  assert.equal(toRouteId("configuration/ai-providers.mdx", POSIX), "configuration/ai-providers.mdx");
  // A backslash is a legal filename character on POSIX and must survive verbatim.
  assert.equal(toRouteId("guides/odd\\name.mdx", POSIX), "guides/odd\\name.mdx");
});

test("selects docs/**/*.md regardless of the host separator", () => {
  // Regression: the raw Windows path never matched the "docs/" prefix, so every
  // docs/**/*.md file was silently skipped on Windows.
  assert.equal(isDocFile("docs\\playbooks\\ship-lane.md"), false);
  assert.equal(isDocFile(toRouteId("docs\\playbooks\\ship-lane.md", WIN)), true);
  assert.equal(isDocFile(toRouteId("docs/playbooks/ship-lane.md", POSIX)), true);

  assert.equal(isDocFile("README.md"), true);
  assert.equal(isDocFile("AGENTS.md"), true);
  assert.equal(isDocFile(toRouteId("configuration\\ai-providers.mdx", WIN)), true);
  // Markdown outside docs/ is still out of scope on both platforms.
  assert.equal(isDocFile(toRouteId("guides\\notes.md", WIN)), false);
  assert.equal(isDocFile("guides/notes.md"), false);
});

test("derives the same absolute mdx route on Windows and POSIX", () => {
  for (const [input, sep] of [
    ["configuration\\ai-providers.mdx", WIN],
    ["configuration/ai-providers.mdx", POSIX],
  ]) {
    assert.equal(docRouteForFile(toRouteId(input, sep)), "/configuration/ai-providers");
  }

  assert.equal(docRouteForFile(toRouteId("index.mdx", WIN)), "/");
  assert.equal(docRouteForFile(toRouteId("changelog\\index.mdx", WIN)), "/changelog");
  assert.equal(docRouteForFile(toRouteId("changelog/index.mdx", POSIX)), "/changelog");
});

test("resolves relative link targets against a Windows-derived source file", () => {
  const fromFile = toRouteId("ai-tools\\claude-code.mdx", WIN);

  assert.equal(normalizeTarget("./cursor", fromFile).absolute, "/ai-tools/cursor");
  assert.equal(normalizeTarget("../quickstart", fromFile).absolute, "/quickstart");
  assert.equal(normalizeTarget("windsurf", fromFile).absolute, "/ai-tools/windsurf");
  assert.equal(normalizeTarget("/configuration/ai-providers", fromFile).absolute, "/configuration/ai-providers");
});

test("resolves relative link targets identically from a POSIX source file", () => {
  const fromFile = "ai-tools/claude-code.mdx";

  assert.equal(normalizeTarget("./cursor", fromFile).absolute, "/ai-tools/cursor");
  assert.equal(normalizeTarget("../quickstart", fromFile).absolute, "/quickstart");
  assert.equal(normalizeTarget("windsurf", fromFile).absolute, "/ai-tools/windsurf");
});

test("strips fragments and query strings and skips non-repo targets", () => {
  const fromFile = "welcome.mdx";

  assert.equal(normalizeTarget("/configuration#providers", fromFile).absolute, "/configuration");
  assert.equal(normalizeTarget("/configuration?tab=a", fromFile).absolute, "/configuration");

  for (const skipped of ["https://example.com", "http://example.com", "mailto:a@b.c", "tel:+1", "…", "...", ""]) {
    assert.equal(normalizeTarget(skipped, fromFile), null);
  }
});
