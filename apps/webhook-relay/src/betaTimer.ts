// Starts ADE's Beta workflow (.github/workflows/beta.yml) every half hour.
//
// GitHub's own `schedule` trigger ran hours late for this repo and dropped the
// ticks it missed (2026-11-02: about one Beta run every 3.5-7.5 hours instead
// of every half hour), so Cloudflare's cron is the timer and the workflow's
// schedule is only a backup. This only starts the run. The workflow still
// decides whether a beta is due (green main commit, 3 h gap, something that
// ships changed), so a start that finds nothing to do ends in a minute.

export type BetaTimerEnv = {
  /**
   * Fine-grained GitHub token for arul28/ADE with "Actions: read and write"
   * (wrangler secret). Unset, the timer does nothing.
   */
  GITHUB_BETA_DISPATCH_TOKEN?: string;
};

const WORKFLOW_URL = "https://api.github.com/repos/arul28/ADE/actions/workflows/beta.yml";

// A 4xx means the token or the workflow is wrong, which only a person can fix,
// so it throws and reaches Sentry. A 5xx is GitHub having a bad moment; the
// next tick tries again.
function checkResponse(response: Response, step: string): boolean {
  if (response.ok) return true;
  if (response.status >= 500) {
    console.warn("beta_timer.github_unavailable", { step, status: response.status });
    return false;
  }
  throw new Error(`beta timer: GitHub answered ${response.status} to ${step}`);
}

export async function runBetaTimer(env: BetaTimerEnv): Promise<void> {
  const token = env.GITHUB_BETA_DISPATCH_TOKEN?.trim();
  if (!token) {
    console.log("beta_timer.no_token");
    return;
  }
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "ade-github-webhook-relay",
    "x-github-api-version": "2022-11-28",
  };

  // A beta that is building takes about 40 minutes. A start now would only
  // wait behind it in the workflow's concurrency group, so skip this tick.
  // A preview run counts too; it only delays the next beta by a tick or two.
  const runs = await fetch(`${WORKFLOW_URL}/runs?per_page=10`, { headers });
  if (!checkResponse(runs, "list runs")) return;
  const { workflow_runs: recent = [] } = (await runs.json()) as { workflow_runs?: Array<{ status?: string }> };
  if (recent.some((run) => run.status !== "completed")) {
    console.log("beta_timer.run_active");
    return;
  }

  const dispatch = await fetch(`${WORKFLOW_URL}/dispatches`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: "main" }),
  });
  if (!checkResponse(dispatch, "start the workflow")) return;
  console.log("beta_timer.dispatched");
}
