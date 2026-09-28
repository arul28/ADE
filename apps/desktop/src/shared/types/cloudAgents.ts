/**
 * One contract for every cloud agent ADE can show: a Devin Cloud session or a
 * Cursor Cloud agent. The two providers keep their own panels and their own
 * wire clients; this is the shape both panels render, so the list, the row and
 * the actions read the same whichever cloud you are looking at.
 */
export type CloudAgentProvider = "devin" | "cursor";

/**
 * - `starting`  VM is coming up / first turn not landed.
 * - `working`   the agent is doing something right now.
 * - `needs_you` it stopped to ask the human something.
 * - `idle`      it answered and is waiting for the next message.
 * - `finished`  its work is done (or it was stopped / suspended).
 * - `failed`    it errored.
 * - `archived`  hidden unless asked for.
 */
export type CloudAgentStatus = "starting" | "working" | "needs_you" | "idle" | "finished" | "failed" | "archived";

export type CloudAgentPullRequest = {
  url: string;
  number: number | null;
  state: "open" | "merged" | "closed" | "draft" | null;
  title: string | null;
  headRef: string | null;
  baseRef: string | null;
  additions: number | null;
  deletions: number | null;
};

/** The ADE side of a cloud agent, once it has one. */
export type CloudAgentLink = {
  chatSessionId: string;
  laneId: string;
  laneName: string | null;
  /** True when the lane is a cloud lane (its machine is the provider's cloud). */
  laneIsCloud: boolean;
};

export type CloudAgent = {
  provider: CloudAgentProvider;
  /** Provider id: Devin's bare session id, Cursor's `bc-…` agent id. */
  id: string;
  title: string;
  status: CloudAgentStatus;
  /** One short human line for the status ("Waiting for your response"). */
  statusText: string | null;
  /** Unread activity the user has not looked at (Devin reports this). */
  unread: boolean;
  webUrl: string | null;
  /** `owner/repo`. */
  repos: string[];
  /** The branch the work lives on, when known. */
  branch: string | null;
  pullRequest: CloudAgentPullRequest | null;
  /** Model label as the provider names it. */
  model: string | null;
  /** VM OS (Devin). */
  platform: string | null;
  /** Where it was started: "ADE", "web", "Slack", "CLI"… */
  origin: string | null;
  /** First message, trimmed, for context under the title. */
  excerpt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** True when one of `repos` is this project's origin. */
  inThisProject: boolean;
  link: CloudAgentLink | null;
};

export type CloudAgentCapabilities = {
  stop: boolean;
  archive: boolean;
  /** `devin ssh` / `devin forward` reach the VM. */
  vmShell: boolean;
  /** The provider's web view (live desktop on Cursor, session page on Devin). */
  web: boolean;
};

export type CloudAgentList = {
  provider: CloudAgentProvider;
  items: CloudAgent[];
  fetchedAt: string;
  capabilities: CloudAgentCapabilities;
  /** Why nothing can be listed (not signed in, CLI missing). Null when fine. */
  unavailableReason: string | null;
  /** Models the launch picker offers. Empty = the provider picks. */
  models: CloudAgentModelOption[];
};

export type CloudAgentListArgs = {
  provider: CloudAgentProvider;
  force?: boolean;
};

export type CloudAgentRef = {
  provider: CloudAgentProvider;
  id: string;
};

export type CloudAgentOpenResult = {
  chatSessionId: string;
  laneId: string;
  laneName: string | null;
  /** True when ADE created the cloud lane for this agent just now. */
  createdLane: boolean;
};

export type CloudAgentArchiveArgs = CloudAgentRef & { archived: boolean };

/** A model a cloud can run, for the launch picker. */
export type CloudAgentModelOption = {
  value: string;
  label: string;
  description?: string;
  badge?: string;
};

export type CloudAgentLaunchArgs = {
  provider: CloudAgentProvider;
  prompt: string;
  /** Devin: `devin_version`. Cursor: SDK model id. Null = provider default. */
  model?: string | null;
  /** Devin VM OS (`linux` | `macos` | `windows`). */
  platform?: string | null;
  /** Run in this existing cloud lane instead of a new one. */
  laneId?: string | null;
};
