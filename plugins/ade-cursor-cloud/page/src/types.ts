/**
 * The Cursor Cloud shapes, copied down from the compiled product's own.
 *
 * The page holds no Cursor client and no key. Everything below is what the
 * plugin's child process already assembled — `fleet.js` for a row,
 * `pageActions.js` for a page read — so a phone, the web client and the desktop
 * all draw the same object the Mac shaped.
 *
 * Names track the compiled sources they came from:
 * `apps/desktop/src/main/services/chat/cursorCloudFleetService.ts`,
 * `apps/desktop/src/shared/cursorCloudFleetStatus.ts`,
 * `apps/desktop/src/renderer/components/app/CursorCloudFleetRow.tsx`.
 */

/** Every status a fleet row can wear once the latest run has refined it. */
export type CloudRunStatus =
  | "creating"
  | "running"
  | "finished"
  | "error"
  | "cancelled"
  | "expired";

/** What the row actually prints. `archived` wins over the run state. */
export type CloudDisplayStatus = CloudRunStatus | "archived";

/** One agent, as Cursor's list gives it, reduced to what a row needs. */
export type CloudAgent = {
  agentId: string;
  name: string;
  summary: string;
  archived: boolean;
  /** Absent on an archived agent — the list says ARCHIVED, the run says more. */
  status?: string;
  createdAt: number | null;
  lastModified: number | null;
  repos: string[];
  /** Cursor environment name, e.g. `arul28/ADE`. */
  envName?: string | null;
  webUrl: string | null;
  latestRunId: string | null;
};

/** Which ADE thing owns this agent, when anything does. */
export type CloudOwnership = {
  sessionId: string | null;
  sessionTitle: string | null;
  laneId: string | null;
  laneName: string | null;
  linearIssueId: string | null;
};

/** One assembled fleet row. `fleet.js:assembleFleet` builds exactly this. */
export type CloudFleetEntry = {
  agent: CloudAgent;
  runStatus?: CloudRunStatus;
  latestRunId: string | null;
  branch: string | null;
  prUrl: string | null;
  modelId: string | null;
  matchedBy: "both" | "session" | "repo";
  /** `owner/repo` for the row's second line. */
  repoLabel?: string | null;
  /** Cursor environment name, e.g. `arul28/ADE`. */
  envName?: string | null;
  filesChanged?: number | null;
  additions?: number | null;
  deletions?: number | null;
  /** `open` / `merged` / `closed` when we could read the PR. */
  prState?: string | null;
  ownership: CloudOwnership;
  /** Pre-formatted by the child, because a page must not do date maths. */
  age: string | null;
  status: CloudDisplayStatus;
  active: boolean;
};

export type CloudLaneOption = { id: string; name: string };

/** The unlinked buckets, keyed by repo and branch. */
export type CloudUnlinkedGroup = { key: string; label: string; entries: CloudFleetEntry[] };

export type CloudLaneGroup = { laneId: string; laneName: string; entries: CloudFleetEntry[] };

export type CloudFleetGroups = {
  active: CloudFleetEntry[];
  lanes: CloudLaneGroup[];
  unlinked: CloudUnlinkedGroup[];
};

/** The relay strip the fleet draws under its list. */
export type CloudWebhookState = {
  /** `"Endpoint ready"`, `"Live updates hit an error"`, … Already worded. */
  status: string;
  tone: "neutral" | "warning" | "danger";
  state: "ready" | "error" | "unconfigured";
  lastEvent: string | null;
  pendingDeliveries: number;
  drainError: string | null;
  url: string | null;
};

/**
 * What `pageFleet` answers.
 *
 * `state` decides which of five bodies the page draws — the same five the
 * compiled modal drew. `error` carries the sentence for `"error"`, and every
 * other field is present in every state so a page never branches on undefined.
 */
export type CloudFleetPage = {
  state: "loading" | "no-key" | "error" | "empty" | "list";
  error: string | null;
  entries: CloudFleetEntry[];
  groups: CloudFleetGroups;
  laneOptions: CloudLaneOption[];
  archivedCount: number;
  counts: { active: number; lanes: number; unlinked: number; total: number; archived: number };
  webhook: CloudWebhookState | null;
  /** Pre-formatted: `"12 agents · updated just now"`. */
  footer: string;
  fetchedAt: string;
};

/** Per-agent cost and tokens. Optional decoration; absence draws no chip. */
export type CloudUsage = {
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costCents: number | null;
  /** `"$1.20"`, or null when nothing was billed. */
  cost: string | null;
};

/**
 * One file a finished run produced.
 *
 * `url` is always null on a `CloudAgentPage`: a signed download is minted per
 * file and expires, so `pageAgent` lists the files and `pageArtifactUrls` mints
 * every link at once when the reader opens the section. The field stays on the
 * row because that is where the page puts the minted link.
 */
export type CloudArtifact = {
  path: string;
  bytes: number | null;
  url: string | null;
};

/** What `pageArtifactUrls` answers: one signed link per listed artifact. */
export type CloudArtifactUrls = {
  urls: { path: string; url: string | null }[];
  error: string | null;
};

/** One run of one agent, for the detail pane's run strip. */
export type CloudRun = {
  runId: string;
  status: CloudRunStatus | null;
  modelId: string | null;
  branch: string | null;
  prUrl: string | null;
  createdAt: string | null;
  age: string | null;
};

/** What `pageAgent` answers. `entry` is null when the agent is not in scope. */
export type CloudAgentPage = {
  entry: CloudFleetEntry | null;
  usage: CloudUsage | null;
  runs: CloudRun[];
  artifacts: CloudArtifact[];
  /** The chat this agent is bound to in ADE, when it is bound to one. */
  sessionId: string | null;
  error: string | null;
};

/* ── The launch form ─────────────────────────────────────────────────────── */

export type CloudModelOption = {
  id: string;
  label: string;
  /** The reasoning tiers Cursor's catalog names for this model, if any. */
  reasoningEfforts: { value: string; label: string }[];
  /** Whether this model names a speed parameter at all. */
  speed: boolean;
};

/** A pull request already open on the lane's branch. Cursor attaches to it. */
export type CloudExistingPr = {
  prUrl: string;
  prNumber: number | null;
  title: string | null;
};

/**
 * What `pageLaunchContext` answers.
 *
 * `unavailable` is the ONE field the form branches on first: a non-null value
 * is the compiled composer's own sentence for why Cursor Cloud cannot take this
 * work, and the form draws that instead of its fields.
 */
export type CloudLaunchContext = {
  unavailable: string | null;
  /** The repo Cursor will clone, already matched against the lane's remote. */
  repoUrl: string | null;
  repoLabel: string | null;
  /** `"Cursor clones owner/repo and pushes back to it."` */
  repoCaption: string | null;
  laneRemote: string | null;
  lanes: CloudLaneOption[];
  laneId: string | null;
  branch: string | null;
  models: CloudModelOption[];
  /** Cursor's catalog names a speed parameter on at least one model. */
  showSpeed: boolean;
  reasoningOptions: { value: string; label: string }[];
  /** Every project secret name this launch may attach. Names only, never values. */
  secretNames: string[];
  selectedSecrets: string[];
  rememberSecretNames: boolean;
  autoOpenPr: boolean;
  existingPr: CloudExistingPr | null;
  draft: string;
};

/** What every mutating page action answers. Never a throw for a Cursor refusal. */
export type PageActionResult = {
  ok: boolean;
  message?: string | null;
  [key: string]: unknown;
};

/** What `pageLaunch` answers on success. */
export type CloudLaunchResult = PageActionResult & {
  agentId?: string | null;
  sessionId?: string | null;
  laneId?: string | null;
};

/** What `pageConnection` answers: is there a key, and whose. Never the key. */
export type CloudConnection = {
  hasKey: boolean;
  apiKeyName: string | null;
  userEmail: string | null;
  message: string | null;
};
