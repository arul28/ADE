// Pure helpers for the Beta track's CI (.github/workflows/beta.yml). Nothing
// here touches git, gh or the network, so every decision the beta workflow
// makes (which commit, which version, which notes, which releases to prune,
// how the feed manifests are rewritten) can be checked with plain node against
// fixture JSON. The I/O lives in resolve.mjs, feed.mjs and prune.mjs.
//
// The contracts are in docs/plans/beta-track.md: stable is vX.Y.Z, beta is
// vX.Y.Z-beta.N with X.Y.Z = latest stable + one patch, and the one-off test
// builds are vX.Y.Z-beta.0.preview.<run>, which sort below every real beta of
// the same base and still read as Beta (updateTrack.ts looks only at the first
// prerelease identifier).

export const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
export const BETA_TAG = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;
export const PREVIEW_TAG = /^v(\d+)\.(\d+)\.(\d+)-beta\.0\.preview\.(\d+)$/;
export const BETA_FEED_TAG = "beta-feed";

/** Minimum gap between two scheduled betas, so a busy day yields a few builds, not dozens. */
export const BETA_MIN_GAP_MS = 3 * 60 * 60 * 1000;
export const BETA_KEEP = 10;
export const PREVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What a desktop build is made of. A main commit that touches none of these
 * (docs, changelog, the SDK, the website) cannot change a beta, so it does not
 * earn one. Kept in step with the desktop list in scripts/release-tools/scope.sh.
 */
export const PRODUCT_PATHS = [
  "apps/desktop",
  "apps/ade-cli",
  "packages",
  ".github/workflows/release.yml",
  ".github/workflows/release-core.yml",
  ".github/workflows/release-publish.yml",
  ".github/workflows/beta.yml",
  "package.json",
  "package-lock.json",
];

function numbers(match) {
  return match.slice(1).map(Number);
}

function compareNumberLists(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isStableTag(tag) {
  return STABLE_TAG.test(tag);
}

export function isBetaTag(tag) {
  return BETA_TAG.test(tag);
}

export function isPreviewTag(tag) {
  return PREVIEW_TAG.test(tag);
}

/** Same rule as updateTrackOfVersion() in apps/desktop/src/shared/updateTrack.ts. */
export function trackOfTag(tag) {
  const version = String(tag ?? "").trim().replace(/^v/i, "").split("+")[0];
  const dash = version.indexOf("-");
  if (dash < 0) return "stable";
  return version.slice(dash + 1).split(".")[0].toLowerCase() === "beta" ? "beta" : "stable";
}

/** Newest stable tag by version, or null. */
export function latestStableTag(tags) {
  let best = null;
  for (const tag of tags) {
    const match = STABLE_TAG.exec(tag);
    if (match && (!best || compareNumberLists(numbers(match), best.parts) > 0)) {
      best = { tag, parts: numbers(match) };
    }
  }
  return best?.tag ?? null;
}

/** Real betas (not previews), newest first. */
export function sortBetaTagsDescending(tags) {
  return tags
    .filter(isBetaTag)
    .sort((a, b) => compareNumberLists(numbers(BETA_TAG.exec(b)), numbers(BETA_TAG.exec(a))));
}

/** X.Y.(Z+1) of the newest stable tag. */
export function betaBaseVersion(tags) {
  const stable = latestStableTag(tags);
  if (!stable) throw new Error("No stable vX.Y.Z tag exists, so there is no base for a beta version.");
  const [major, minor, patch] = numbers(STABLE_TAG.exec(stable));
  return `${major}.${minor}.${patch + 1}`;
}

/** vX.Y.Z-beta.N with N one above the highest beta of that base (drafts and orphan tags included). */
export function nextBetaTag(tags) {
  const base = betaBaseVersion(tags);
  let highest = 0;
  for (const tag of tags) {
    const match = BETA_TAG.exec(tag);
    if (match && `${match[1]}.${match[2]}.${match[3]}` === base) {
      highest = Math.max(highest, Number(match[4]));
    }
  }
  return `v${base}-beta.${highest + 1}`;
}

export function previewTag(tags, runNumber) {
  if (!/^\d+$/.test(String(runNumber))) throw new Error(`Preview run number must be digits, got ${runNumber}.`);
  return `v${betaBaseVersion(tags)}-beta.0.preview.${runNumber}`;
}

/**
 * The newest PUBLISHED real beta. A draft is a beta whose run failed before it
 * went public; it never reached anyone, so it is neither the gap's start nor
 * the notes' base, and its commit simply gets built again under the next N.
 */
export function lastPublishedBeta(releases, tagCommits) {
  const published = new Map(
    releases.filter((release) => !release.draft && isBetaTag(release.tag)).map((release) => [release.tag, release]),
  );
  for (const tag of sortBetaTagsDescending([...published.keys()])) {
    const commit = tagCommits[tag];
    if (commit) return { tag, commit, publishedAt: published.get(tag).publishedAt };
  }
  return null;
}

/**
 * The newest main commit with a green ci-pass that is newer than `stopAt`.
 * `commits` is newest first. `ciPassOf(sha)` answers the ci-pass conclusion
 * ("success", "failure", null when it has not finished). Stops at the first
 * green commit, so a normal run costs one or two check-run lookups.
 */
export async function pickCandidate({ commits, stopAt, ciPassOf }) {
  const checked = [];
  for (const { sha } of commits) {
    if (stopAt && sha === stopAt) break;
    const conclusion = await ciPassOf(sha);
    checked.push({ sha, conclusion: conclusion ?? "pending" });
    if (conclusion === "success") return { sha, checked };
  }
  return { sha: null, checked };
}

/**
 * The scheduling decision, in the order the plan states it. Returns
 * { skip: true, reason } or { skip: false }.
 */
export function decide({ now, lastBeta, candidate, productChanged, force }) {
  if (!candidate) {
    return { skip: true, reason: lastBeta
      ? `no main commit newer than ${lastBeta.tag} has a green ci-pass yet`
      : "no main commit has a green ci-pass" };
  }
  if (lastBeta && candidate === lastBeta.commit) {
    return { skip: true, reason: `${lastBeta.tag} already builds ${candidate.slice(0, 9)}` };
  }
  if (!force && lastBeta?.publishedAt) {
    const age = now - Date.parse(lastBeta.publishedAt);
    if (age < BETA_MIN_GAP_MS) {
      const minutes = Math.ceil((BETA_MIN_GAP_MS - age) / 60000);
      return { skip: true, reason: `${lastBeta.tag} is under 3 h old; next beta in about ${minutes} min (dispatch with force to override)` };
    }
  }
  if (!force && productChanged === false) {
    return { skip: true, reason: `nothing that ships changed since ${lastBeta?.tag ?? "the last stable"}` };
  }
  return { skip: false };
}

/**
 * Release notes: one line per merged PR, from squash or merge subjects that end
 * in "(#NNNN)". Release-notes commits are skipped; they describe a stable
 * release, not a change in this beta.
 */
export function releaseNotes({ subjects, previousTag, sha, preview }) {
  if (preview) {
    return `Preview build of ${preview} (${sha}) for one-time tests. It is never offered as an update.\n`;
  }
  const lines = [];
  const seen = new Set();
  for (const raw of subjects) {
    const subject = String(raw).trim();
    const match = /\(#(\d+)\)\s*$/.exec(subject);
    if (!match || /^docs\(release\)/i.test(subject) || seen.has(match[1])) continue;
    seen.add(match[1]);
    lines.push(`- ${subject}`);
  }
  const header = `Beta build of main at ${sha}.`;
  const since = previousTag ? `Changes since ${previousTag}:` : "Changes:";
  const body = lines.length > 0 ? lines.join("\n") : "- No pull requests merged in this range.";
  return `${header}\n\n${since}\n\n${body}\n`;
}

/**
 * Which beta and preview releases (and bare tags) to delete. Never returns a
 * stable tag or beta-feed: only BETA_TAG / PREVIEW_TAG names are eligible.
 *
 * Kept: the newest BETA_KEEP published betas, any beta whose commit is also a
 * stable release's commit (that stable was promoted from it), the tag this run
 * just published, and previews younger than seven days.
 */
export function prunePlan({ releases, tagCommits, now, currentTag, keep = BETA_KEEP }) {
  const byTag = new Map(releases.map((release) => [release.tag, release]));
  const allTags = new Set([...Object.keys(tagCommits), ...byTag.keys()]);
  const stableCommits = new Set(
    Object.entries(tagCommits).filter(([tag]) => isStableTag(tag)).map(([, commit]) => commit),
  );
  const publishedBetas = sortBetaTagsDescending(
    [...allTags].filter((tag) => byTag.has(tag) && !byTag.get(tag).draft),
  );
  const kept = new Set(publishedBetas.slice(0, keep));
  const plan = [];
  for (const tag of [...allTags].sort()) {
    if (tag === currentTag) continue;
    const release = byTag.get(tag) ?? null;
    if (isBetaTag(tag)) {
      if (kept.has(tag)) continue;
      if (tagCommits[tag] && stableCommits.has(tagCommits[tag])) continue;
      const reason = !release ? "orphan beta tag" : release.draft ? "unpublished beta draft" : `older than the newest ${keep} betas`;
      plan.push({ tag, hasRelease: Boolean(release), reason });
    } else if (isPreviewTag(tag)) {
      // A bare preview tag has no date to judge it by; leave it.
      if (!release) continue;
      const created = Date.parse(release.publishedAt ?? release.createdAt ?? "");
      if (!Number.isFinite(created) || now - created < PREVIEW_MAX_AGE_MS) continue;
      plan.push({ tag, hasRelease: true, reason: "preview older than 7 days" });
    }
  }
  return plan;
}

/**
 * Rewrites an electron-builder update manifest (latest-mac.yml / latest.yml,
 * already parsed) so every file it names is an absolute URL on the versioned
 * release. The beta feed lives on a different release (beta-feed) than the
 * files, and electron-updater resolves a relative url against the feed's own
 * folder; an absolute one it uses as is. sha512, size and every other field
 * are kept byte for byte.
 */
export function absolutizeUpdateInfo(doc, { repo, tag }) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.files) || doc.files.length === 0) {
    throw new Error("Update manifest has no files[] entries.");
  }
  const base = `https://github.com/${repo}/releases/download/${tag}/`;
  const referenced = new Set();
  const absolute = (value, field) => {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Update manifest ${field} is empty.`);
    if (/^https?:\/\//.test(value)) {
      if (!value.startsWith(base)) throw new Error(`Update manifest ${field} points outside ${base}: ${value}`);
      referenced.add(decodeURIComponent(value.slice(base.length)));
      return value;
    }
    if (value.includes("/")) throw new Error(`Update manifest ${field} is not a bare asset name: ${value}`);
    referenced.add(value);
    return `${base}${encodeURIComponent(value)}`;
  };
  const out = { ...doc };
  out.files = doc.files.map((file, index) => {
    if (!file?.sha512) throw new Error(`Update manifest files[${index}] has no sha512.`);
    return { ...file, url: absolute(file.url, `files[${index}].url`) };
  });
  if (doc.path !== undefined) out.path = absolute(doc.path, "path");
  return { doc: out, referenced: [...referenced] };
}
