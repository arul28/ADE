#!/usr/bin/env node
// Gives a beta build its own What's new notes. Run by release-core.yml before
// packaging, on every macOS and Windows job of a beta.
//
//   ADE_RELEASE_TAG=v1.2.128-beta.3 ADE_BETA_NOTES="$notes" node scripts/beta/write-beta-changelog.mjs
//
// ADE_BETA_NOTES is the text resolve.mjs wrote for the GitHub release
// (`releaseNotes` in beta-lib.mjs): a header, "Changes since <tag>:" and one
// "- <PR title> (#N)" line per merged pull request. This writes the same list
// as changelog/v<version>.mdx in the runner's checkout, where
// apps/desktop/scripts/bundle-release-notes.mjs bakes it into the app. Only
// the app reads it, as plain text; nothing here is committed or put on the
// website.
//
// Nothing is written for a stable tag, a preview, or a beta with no merged
// pull request: What's new then shows no notes, as before.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBetaTag } from "./beta-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tag = (process.env.ADE_RELEASE_TAG ?? "").trim();
const notes = process.env.ADE_BETA_NOTES ?? "";

if (!isBetaTag(tag)) {
  console.log(`write-beta-changelog: ${tag || "(no tag)"} is not a beta; nothing to write.`);
  process.exit(0);
}

const items = notes
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^- .*\(#\d+\)$/.test(line));
if (items.length === 0) {
  console.log(`write-beta-changelog: no pull requests in the notes for ${tag}; nothing to write.`);
  process.exit(0);
}

const version = tag.slice(1);
const since = /^Changes since (v\S+):$/m.exec(notes)?.[1] ?? null;
const summary = since
  ? `ADE ${version} is a Beta build. It has the pull requests merged since ${since}.`
  : `ADE ${version} is a Beta build. It has the pull requests below.`;
const mdx = `---
title: "v${version}"
description: "Beta build notes for ADE v${version}"
---

${summary}

## Changes

${items.join("\n")}
`;

const target = path.join(repoRoot, "changelog", `v${version}.mdx`);
fs.writeFileSync(target, mdx);
console.log(`write-beta-changelog: wrote ${path.relative(repoRoot, target)} with ${items.length} pull request(s).`);
