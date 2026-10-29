#!/usr/bin/env node
// Decides whether this beta.yml run builds anything, and what.
//
//   node scripts/beta/resolve.mjs [--force] [--preview-ref <ref>] [--run-number <n>]
//   node scripts/beta/resolve.mjs --fixture <file.json> [same flags]
//
// Scheduled and forced runs: finds the newest main commit with a green ci-pass
// that is newer than the last published beta, waits out the 3 h gap unless
// --force, and picks vX.Y.Z-beta.N (beta-lib.mjs has the rules). A preview run
// builds <ref> as vX.Y.Z-beta.0.preview.<run> and skips every check, because it
// never reaches the feed.
//
// Writes skip, reason, tag, sha, preview and notes to $GITHUB_OUTPUT (and a
// summary to $GITHUB_STEP_SUMMARY) when those are set; always prints JSON.
//
// --fixture replaces git and gh with a JSON file, so the decision can be run
// offline:
//   { "now": "<iso>", "tags": { "v1.2.3": "<sha>" },
//     "releases": [{ "tag", "draft", "prerelease", "publishedAt", "createdAt" }],
//     "commits": [{ "sha", "subject", "ciPass", "product": true }],   // newest first
//     "refs": { "my-branch": "<sha>" } }
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  PRODUCT_PATHS,
  decide,
  isBetaTag,
  lastPublishedBeta,
  latestStableTag,
  nextBetaTag,
  pickCandidate,
  previewTag,
  releaseNotes,
} from "./beta-lib.mjs";

function parseArgs(argv) {
  const options = { force: false, previewRef: "", runNumber: process.env.GITHUB_RUN_NUMBER ?? "", fixture: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--preview-ref") options.previewRef = argv[++index] ?? "";
    else if (arg === "--run-number") options.runNumber = argv[++index] ?? "";
    else if (arg === "--fixture") options.fixture = argv[++index] ?? "";
    else throw new Error(`Unknown argument ${arg}`);
  }
  options.previewRef = options.previewRef.trim();
  return options;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Reads the live repository: tags from origin, releases and check runs from the API, history from git. */
function liveSource() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GH_REPO or GITHUB_REPOSITORY is required.");
  return {
    repo,
    now: Date.now(),
    tagCommits() {
      // Annotated tags (the stable ones) list their commit on the ^{} line.
      const tags = {};
      for (const line of run("git", ["ls-remote", "--tags", "origin"]).split("\n").filter(Boolean)) {
        const [sha, ref] = line.split(/\s+/);
        const peeled = ref.endsWith("^{}");
        const name = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
        if (peeled || !tags[name]) tags[name] = sha;
      }
      return tags;
    },
    releases() {
      const out = run("gh", [
        "api", `repos/${repo}/releases?per_page=100`, "--paginate",
        "--jq", ".[] | {tag: .tag_name, draft, prerelease, publishedAt: .published_at, createdAt: .created_at}",
      ]);
      return out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    mainCommits() {
      return run("git", ["log", "--first-parent", "--format=%H", "-n", "100", "origin/main"])
        .split("\n").filter(Boolean).map((sha) => ({ sha }));
    },
    ciPassOf(sha) {
      // Same pick as scripts/require-release-ci-pass.sh: the latest-finished
      // ci-pass run on the commit, which is what release-core.yml will check.
      const out = run("gh", [
        "api", `repos/${repo}/commits/${sha}/check-runs`, "--method", "GET",
        "-f", "check_name=ci-pass", "-f", "per_page=100",
        "--jq", '[.check_runs[]] | sort_by(.completed_at // "") | last | if . == null then "" elif .status == "completed" then .conclusion else "" end',
      ]);
      return out || null;
    },
    productChanged(from, to) {
      if (!from) return true;
      return run("git", ["diff", "--name-only", `${from}..${to}`, "--", ...PRODUCT_PATHS]).length > 0;
    },
    subjectsBetween(from, to) {
      const range = from ? `${from}..${to}` : to;
      return run("git", ["log", "--first-parent", "--format=%s", "-n", "500", range]).split("\n").filter(Boolean);
    },
    resolveRef(ref) {
      // The checkout has every branch; a sha that is on none is asked of the API.
      for (const candidate of [`origin/${ref}^{commit}`, `${ref}^{commit}`]) {
        try {
          return run("git", ["rev-parse", "--verify", "--quiet", candidate]);
        } catch {
          // try the next spelling
        }
      }
      return run("gh", ["api", `repos/${repo}/commits/${ref}`, "--jq", ".sha"]);
    },
  };
}

function fixtureSource(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const commits = data.commits ?? [];
  const indexOf = (sha) => commits.findIndex((commit) => commit.sha === sha);
  // Commits newer than `from` up to and including `to`, newest first.
  const between = (from, to) => {
    const start = indexOf(to);
    const end = from && indexOf(from) >= 0 ? indexOf(from) : commits.length;
    return start < 0 ? [] : commits.slice(start, end);
  };
  return {
    repo: "arul28/ADE",
    now: Date.parse(data.now ?? new Date().toISOString()),
    tagCommits: () => data.tags ?? {},
    releases: () => data.releases ?? [],
    mainCommits: () => commits.map(({ sha }) => ({ sha })),
    ciPassOf: (sha) => commits.find((commit) => commit.sha === sha)?.ciPass ?? null,
    productChanged: (from, to) => !from || between(from, to).some((commit) => commit.product !== false),
    subjectsBetween: (from, to) => between(from, to).map((commit) => commit.subject ?? ""),
    resolveRef: (ref) => {
      const sha = data.refs?.[ref];
      if (!sha) throw new Error(`Fixture has no ref ${ref}.`);
      return sha;
    },
  };
}

export async function resolveBeta(source, { force, previewRef, runNumber }) {
  const tagCommits = source.tagCommits();
  const tags = Object.keys(tagCommits);
  const releases = source.releases();
  // Tags and release names together: a draft whose tag was never pushed still
  // owns its N.
  const knownTags = [...new Set([...tags, ...releases.map((release) => release.tag)])];
  const lastBeta = lastPublishedBeta(releases, tagCommits);
  const stable = latestStableTag(tags);

  if (previewRef) {
    const sha = source.resolveRef(previewRef);
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Could not resolve ${previewRef} to a commit.`);
    const tag = previewTag(knownTags, runNumber);
    return {
      skip: false, preview: true, tag, sha, previousTag: stable ?? "",
      reason: `preview of ${previewRef}`,
      notes: releaseNotes({ subjects: [], previousTag: null, sha, preview: previewRef }),
    };
  }

  // Notes and the "anything changed" test start from the last beta, or from
  // the last stable when there has never been a beta.
  const base = lastBeta ?? (stable ? { tag: stable, commit: tagCommits[stable] } : null);
  const { sha, checked } = await pickCandidate({
    commits: source.mainCommits(),
    stopAt: lastBeta?.commit ?? null,
    ciPassOf: (commit) => source.ciPassOf(commit),
  });
  const productChanged = sha ? source.productChanged(base?.commit ?? null, sha) : false;
  const decision = decide({ now: source.now, lastBeta, candidate: sha, productChanged, force });
  if (decision.skip) {
    return { skip: true, preview: false, reason: decision.reason, tag: "", sha: sha ?? "", previousTag: lastBeta?.tag ?? "", notes: "", checked };
  }
  const tag = nextBetaTag(knownTags);
  if (!isBetaTag(tag)) throw new Error(`Computed tag ${tag} is not a beta tag.`);
  const notes = releaseNotes({ subjects: source.subjectsBetween(base?.commit ?? null, sha), previousTag: base?.tag ?? null, sha });
  return { skip: false, preview: false, reason: `build ${sha.slice(0, 9)} as ${tag}`, tag, sha, previousTag: base?.tag ?? "", notes, checked };
}

function writeOutputs(result) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const delimiter = `BETA_NOTES_${Date.now()}`;
    fs.appendFileSync(outputFile, [
      `skip=${result.skip}`,
      `reason=${result.reason.replace(/\n/g, " ")}`,
      `tag=${result.tag}`,
      `sha=${result.sha}`,
      `preview=${result.preview}`,
      `previous_tag=${result.previousTag}`,
      `notes<<${delimiter}`, result.notes, delimiter, "",
    ].join("\n"));
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    fs.appendFileSync(summaryFile, `### Beta: ${result.skip ? "skipped" : result.tag}\n\n${result.reason}\n\n${result.notes ?? ""}\n`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const source = options.fixture ? fixtureSource(options.fixture) : liveSource();
  const result = await resolveBeta(source, options);
  writeOutputs(result);
  console.log(JSON.stringify(result, null, 2));
}
