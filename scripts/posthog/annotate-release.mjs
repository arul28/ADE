// Marks a release on PostHog's charts: one project annotation per shipped build.
//
//   node scripts/posthog/annotate-release.mjs --desktop v1.2.130-beta.3
//       -> "Desktop 1.2.130-beta.3 · beta"   (beta.yml, once the beta feed serves it)
//   node scripts/posthog/annotate-release.mjs --desktop v1.2.130
//       -> "Desktop 1.2.130 · stable"        (release-annotation.yml, when the stable is published)
//   node scripts/posthog/annotate-release.mjs --ios 1.4 --build 212 [--app "iOS Beta"]
//       -> "iOS Beta 1.4 (212) · TestFlight" (ios-testflight.yml, after the upload)
//   node scripts/posthog/annotate-release.mjs --web <sha> [--surfaces webclient,push-relay]
//       -> "Web deploy abc1234 (webclient, push-relay)" (deploy-web.yml)
//   node scripts/posthog/annotate-release.mjs --content "<text>"
//
// Preview tags (vX.Y.Z-beta.0.preview.N) never reach a feed and are skipped.
// --dry-run prints the annotation without calling PostHog.
//
// A re-run does not duplicate: the recent annotations with the same text are
// read first, and an identical one is left alone.
//
// Needs POSTHOG_PERSONAL_API_KEY (scope: annotation write; annotation read for
// the duplicate check) and POSTHOG_PROJECT_ID; POSTHOG_HOST defaults to
// https://us.posthog.com. Skips with a notice without them, and never exits
// non-zero: PostHog must not fail a release. No dependencies (Node 18+ fetch).

import { DEFAULT_POSTHOG_HOST, notice, parseArgs, warn } from "./cli.mjs";
const TIMEOUT_MS = 15_000;


/** The annotation text, or null (with the reason) when nothing should be marked. */
function annotationContent(options) {
  if (typeof options.content === "string" && options.content.trim()) {
    return { content: options.content.trim().slice(0, 400) };
  }
  if (typeof options.desktop === "string" && options.desktop.trim()) {
    const version = options.desktop.trim().replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return { skip: `'${options.desktop}' is not a release version` };
    if (/preview/i.test(version)) return { skip: `${version} is a preview build, which never reaches a feed` };
    const track = /-beta\.\d+$/.test(version) ? "beta" : version.includes("-") ? null : "stable";
    if (!track) return { skip: `${version} is neither a beta nor a stable version` };
    return { content: `Desktop ${version} · ${track}` };
  }
  if (typeof options.ios === "string" && options.ios.trim()) {
    const app = typeof options.app === "string" && options.app.trim() ? options.app.trim() : "iOS";
    const build = typeof options.build === "string" && options.build.trim() ? ` (${options.build.trim()})` : "";
    return { content: `${app} ${options.ios.trim()}${build} · TestFlight` };
  }
  if (typeof options.web === "string" && options.web.trim()) {
    const surfaces = typeof options.surfaces === "string"
      ? options.surfaces.split(/[\s,]+/).filter(Boolean)
      : [];
    return { content: `Web deploy ${options.web.trim().slice(0, 7)}${surfaces.length ? ` (${surfaces.join(", ")})` : ""}` };
  }
  return { skip: "nothing to annotate; pass --desktop, --ios, --web or --content" };
}

async function request(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${new URL(url).pathname} answered ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolved = annotationContent(options);
  if (!resolved.content) {
    notice(`No PostHog annotation: ${resolved.skip}.`);
    return;
  }
  const { content } = resolved;
  if (options["dry-run"]) {
    notice(`Dry run; would annotate PostHog with "${content}".`);
    return;
  }
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = process.env.POSTHOG_PROJECT_ID?.trim();
  if (!apiKey || !projectId) {
    notice(`POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID is empty; skipping the PostHog annotation "${content}".`);
    return;
  }
  const host = (process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
  const base = `${host}/api/projects/${encodeURIComponent(projectId)}/annotations/`;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  try {
    const existing = await request(`${base}?search=${encodeURIComponent(content)}&limit=100`, { headers });
    const results = Array.isArray(existing?.results) ? existing.results : [];
    if (results.some((annotation) => annotation?.content === content && annotation?.deleted !== true)) {
      notice(`PostHog already has the annotation "${content}"; leaving it.`);
      return;
    }
  } catch (error) {
    // Without the read scope the check fails; a duplicate beats a missing mark.
    warn(`Could not read PostHog annotations (${error instanceof Error ? error.message : String(error)}); creating without the duplicate check.`);
  }

  const created = await request(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, date_marker: new Date().toISOString(), scope: "project" }),
  });
  console.log(`[posthog] Annotated "${content}" (id ${created?.id ?? "unknown"}).`);
}

main().catch((error) => {
  warn(`PostHog annotation failed: ${error instanceof Error ? error.message : String(error)}`);
});
