/**
 * The check-runs GitHub returned for PR #988 (`ade/pr-merged-lane-mapping`) at
 * head `d56fbb420` — the payload that made ADE render "CI passed · 3 jobs".
 *
 * Provenance: `Vercel Preview Comments` (success) and `Mintlify Deployment`
 * (skipped) were recovered live from
 * `GET /repos/arul28/ADE/commits/d56fbb420/check-runs`; GitHub had already
 * pruned the rest by the time this was written. The remaining rows are
 * transcribed from the ADE-135 report, which recorded `gh pr checks 988` in
 * full:
 *
 *     CodeRabbit               pass   0   "Review rate limited"
 *     Vercel                   pass   0   "Canceled by Ignored Build Step"
 *     Vercel Preview Comments  pass   0
 *
 * The essential facts this fixture preserves:
 *   - Three checks report `success`, and not one of them verified the code.
 *     CodeRabbit was rate-limited, so its review never happened. Vercel was
 *     cancelled by an ignored-build step, so its build never ran.
 *   - `github-actions` registered NO check run at all. Every required job in
 *     ci.yml — install, test-desktop 1-8, test-ade-cli, and the ci-pass gate —
 *     is absent, not failing.
 *   - Absence is exactly what the old rollup could not represent.
 */
export const PR988_CHECK_RUNS = [
  { name: "CodeRabbit", status: "completed", conclusion: "success", appSlug: "coderabbitai" },
  { name: "Vercel", status: "completed", conclusion: "success", appSlug: "vercel" },
  { name: "Vercel Preview Comments", status: "completed", conclusion: "success", appSlug: "vercel" },
  { name: "Mintlify Deployment", status: "completed", conclusion: "skipped", appSlug: "mintlify" },
] as const;

/**
 * `main`'s required contexts, read live from
 * `GET /repos/arul28/ADE/rules/branches/main` — the rulesets tier, which needs
 * only read access. None of these reported on #988's head.
 */
export const ADE_MAIN_REQUIRED_CONTEXTS = ["ci-pass"] as const;
