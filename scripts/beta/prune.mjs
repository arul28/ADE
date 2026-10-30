#!/usr/bin/env node
// Deletes old beta and preview releases, and their tags.
//
//   node scripts/beta/prune.mjs --current <tag> [--dry-run]
//   node scripts/beta/prune.mjs --fixture <file.json> --current <tag>   (always a dry run)
//
// Keeps the newest 10 published betas, every beta whose commit is also a
// stable release's commit, the beta this run published, and previews younger
// than 7 days (beta-lib.mjs prunePlan). Stable releases and beta-feed are out
// of reach by construction: only names matching the beta and preview tag
// patterns are ever considered.
//
// Fixture shape: { "now": "<iso>", "tags": { "<tag>": "<sha>" },
//   "releases": [{ "tag", "draft", "prerelease", "publishedAt", "createdAt" }] }
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBetaTag, isPreviewTag, prunePlan, readReleases, readTagCommits } from "./beta-lib.mjs";

function run(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function parseArgs(argv) {
  const options = { dryRun: false, current: "", fixture: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--current") options.current = argv[++index] ?? "";
    else if (arg === "--fixture") options.fixture = argv[++index] ?? "";
    else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

function liveInputs(repo) {
  const git = (args) => execFileSync("git", args, { encoding: "utf8" });
  return { tags: readTagCommits(git), releases: readReleases(run, repo), now: Date.now() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || "arul28/ADE";
  const inputs = options.fixture
    ? (({ tags = {}, releases = [], now }) => ({ tags, releases, now: Date.parse(now) }))(JSON.parse(fs.readFileSync(options.fixture, "utf8")))
    : liveInputs(repo);
  const plan = prunePlan({ releases: inputs.releases, tagCommits: inputs.tags, now: inputs.now, currentTag: options.current });
  const dryRun = options.dryRun || Boolean(options.fixture);
  let failed = 0;
  for (const { tag, hasRelease, reason } of plan) {
    // Belt and braces: prunePlan only returns these, but a delete is forever.
    if (!isBetaTag(tag) && !isPreviewTag(tag)) throw new Error(`Refusing to delete non-beta tag ${tag}.`);
    console.log(`${dryRun ? "[dry run] would delete" : "delete"} ${tag} (${reason})`);
    if (dryRun) continue;
    try {
      if (hasRelease) run(["release", "delete", tag, "--repo", repo, "--cleanup-tag", "--yes"]);
      else run(["api", "--method", "DELETE", `repos/${repo}/git/refs/tags/${tag}`]);
    } catch (error) {
      // One stuck delete must not keep the rest of the list alive forever.
      failed += 1;
      console.error(`::warning::Could not delete ${tag}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`[beta-prune] ${plan.length} to delete, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}
