import type { createJiraService } from "../jira/jiraService";
import type { createGithubService } from "../github/githubService";
import type { IssueTracker as LinearIssueTracker } from "../cto/issueTracker";
import type { EffectiveProjectConfig } from "../../../shared/types/config";
import {
  issueRefFromUrl,
  jiraIssueRef,
  normalizeJiraIssueKey,
  normalizeLinearIdentifier,
  parseStoredIssueRef,
  type IssueRef,
} from "../../../shared/issueRefs";
import type {
  IssueListArgs,
  IssueTrackerAdapter,
  IssueTrackerKind,
  IssueTrackerResolution,
  IssueTrackerService,
  IssueUpdateArgs,
} from "../../../shared/types/issueTrackers";
import { IssueTrackerError, normalizeIssueTrackerError, withIssueTrackerError } from "./issueTrackerError";
import { normalizeJiraSiteUrl } from "../jira/jiraClient";
import {
  createGithubIssueTrackerAdapter,
  createJiraIssueTrackerAdapter,
  createLinearIssueTrackerAdapter,
} from "./adapters";

type GithubService = ReturnType<typeof createGithubService>;
type JiraService = ReturnType<typeof createJiraService>;

export type IssueTrackerServiceArgs = {
  linearIssueTracker?: LinearIssueTracker | null;
  githubService?: GithubService | null;
  jiraService?: JiraService | null;
  getProjectConfig?: () => EffectiveProjectConfig | null;
};

const TEAM_KEY_CACHE_MS = 60_000;
const JIRA_PROJECT_CACHE_MS = 60_000;

function isGithubReference(value: string): Extract<IssueRef, { provider: "github" }> | null {
  const match = /^([^/\s#]+)\/([^/\s#]+)#([1-9]\d*)$/.exec(value.trim());
  const number = Number(match?.[3]);
  if (!match || !Number.isSafeInteger(number)) return null;
  return { provider: "github", owner: match[1]!, repo: match[2]!, number };
}

function issueProjectPrefix(ref: string): string | null {
  const dash = ref.lastIndexOf("-");
  if (dash <= 0) return null;
  return normalizeJiraIssueKey(ref.slice(0, dash + 1) + ref.slice(dash + 1))
    ? ref.slice(0, dash).toUpperCase()
    : null;
}

function parseReferenceString(value: string): IssueRef | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const fromUrl = issueRefFromUrl(normalized);
  if (fromUrl) return fromUrl;
  const github = isGithubReference(normalized);
  if (github) return github;
  return null;
}

export function createIssueTrackerService(args: IssueTrackerServiceArgs): IssueTrackerService {
  const adapters = new Map<IssueTrackerKind, IssueTrackerAdapter>();
  if (args.linearIssueTracker) adapters.set("linear", createLinearIssueTrackerAdapter(args.linearIssueTracker));
  if (args.githubService) adapters.set("github", createGithubIssueTrackerAdapter(args.githubService));
  if (args.jiraService) adapters.set("jira", createJiraIssueTrackerAdapter(args.jiraService));

  const connectedInFlight = new Map<IssueTrackerKind, Promise<boolean>>();
  let jiraProjects: { keys: Set<string>; expiresAt: number } | null = null;
  let jiraProjectFetchError: IssueTrackerError | null = null;
  let jiraProjectRetryAt = 0;
  let linearTeams: { keys: Set<string>; expiresAt: number } | null = null;

  const getProjectConfig = () => {
    try {
      return args.getProjectConfig?.() ?? null;
    } catch {
      return null;
    }
  };

  const isConnected = async (kind: IssueTrackerKind): Promise<boolean> => {
    const adapter = adapters.get(kind);
    if (!adapter) return false;
    const pending = connectedInFlight.get(kind);
    if (pending) return await pending;
    const probe = (async () => {
      try {
        if (kind === "linear" && args.linearIssueTracker) return (await args.linearIssueTracker.getConnectionStatus()).connected;
        if (kind === "github" && args.githubService) return (await args.githubService.getStatus()).connected;
        if (kind === "jira" && args.jiraService) return (await args.jiraService.getConnectionStatus()).connected;
      } catch {
        return false;
      }
      return false;
    })().finally(() => connectedInFlight.delete(kind));
    connectedInFlight.set(kind, probe);
    return await probe;
  };

  const getJiraSiteUrl = async (): Promise<string | null> => {
    if (!args.jiraService) return null;
    const status = await args.jiraService.getConnectionStatus().catch(() => null);
    return status?.siteUrl ?? null;
  };

  const jiraProjectKeys = async (): Promise<{ keys: Set<string>; fetchError: IssueTrackerError | null }> => {
    const configured = getProjectConfig()?.issueTrackers?.jira?.projectKeys ?? [];
    const keys = new Set(configured.map((key) => key.trim().toUpperCase()).filter(Boolean));
    if (!args.jiraService || !(await isConnected("jira"))) return { keys, fetchError: null };
    const currentTime = Date.now();
    if ((!jiraProjects || jiraProjects.expiresAt <= currentTime) && jiraProjectRetryAt <= currentTime) {
      try {
        const projects = await args.jiraService.listProjects();
        jiraProjects = { keys: new Set(projects.map((project) => project.key.toUpperCase())), expiresAt: Date.now() + JIRA_PROJECT_CACHE_MS };
        jiraProjectFetchError = null;
        jiraProjectRetryAt = 0;
      } catch (error) {
        jiraProjectFetchError = normalizeIssueTrackerError("jira", "resolve", error);
        jiraProjectRetryAt = Date.now() + JIRA_PROJECT_CACHE_MS;
      }
    }
    for (const key of jiraProjects?.keys ?? []) keys.add(key);
    return { keys, fetchError: jiraProjectFetchError };
  };

  const linearTeamKeys = async (): Promise<Set<string>> => {
    if (!args.linearIssueTracker || !(await isConnected("linear"))) return new Set();
    if (!linearTeams || linearTeams.expiresAt <= Date.now()) {
      try {
        const states = await args.linearIssueTracker.listWorkflowStates();
        linearTeams = { keys: new Set(states.map((state) => state.teamKey.toUpperCase())), expiresAt: Date.now() + TEAM_KEY_CACHE_MS };
      } catch {
        linearTeams = { keys: new Set(), expiresAt: Date.now() + TEAM_KEY_CACHE_MS };
      }
    }
    return linearTeams.keys;
  };

  const resolve = async (input: string | IssueRef): Promise<IssueRef> => {
    if (typeof input !== "string") {
      const parsed = parseStoredIssueRef(input);
      if (!parsed) throw new IssueTrackerError("linear", "resolve", "invalid", "The issue reference is malformed.");
      // Keep the original Jira base URL for site validation. The persisted-ref
      // parser canonicalizes Jira refs for identity, but that drops a
      // self-hosted context path that is part of the configured site.
      const reference = parsed.provider === "jira" && input.provider === "jira"
        ? { ...parsed, siteUrl: input.siteUrl }
        : parsed;
      return await validateTrackerSite(reference);
    }
    const raw = input.trim();
    const parsed = parseReferenceString(raw);
    if (parsed) return await validateTrackerSite(parsed);

    if (/^#[1-9]\d*$/.test(raw)) {
      const repo = await args.githubService?.detectRepo().catch(() => null);
      const number = Number(raw.slice(1));
      if (!repo) throw new IssueTrackerError("github", "resolve", "not-connected", "Pass owner/repository#number or connect this project to a GitHub repository.");
      return { provider: "github", owner: repo.owner, repo: repo.name, number };
    }

    const jiraKey = normalizeJiraIssueKey(raw);
    const prefix = issueProjectPrefix(raw);
    if (jiraKey && prefix) {
      const teams = await linearTeamKeys();
      if (teams.has(prefix)) return { provider: "linear", identifier: normalizeLinearIdentifier(raw)! };
      const projects = await jiraProjectKeys();
      const siteUrl = await getJiraSiteUrl();
      if (projects.keys.has(prefix) && siteUrl) return { provider: "jira", siteUrl, key: jiraKey };
      if (projects.fetchError) throw projects.fetchError;
    }
    throw new IssueTrackerError("linear", "resolve", "not-found", `Could not identify an issue tracker for '${raw}'.`);
  };

  const validateTrackerSite = async (reference: IssueRef): Promise<IssueRef> => {
    if (reference.provider !== "jira") return reference;
    const connectedSite = await getJiraSiteUrl();
    if (!connectedSite) throw new IssueTrackerError("jira", "resolve", "not-connected", "Connect the Jira site before resolving this issue.");
    const normalizeSite = (siteUrl: string): string | null => {
      try {
        return normalizeJiraSiteUrl(siteUrl).toLowerCase();
      } catch {
        return null;
      }
    };
    if (normalizeSite(connectedSite) !== normalizeSite(reference.siteUrl)) {
      throw new IssueTrackerError("jira", "resolve", "not-connected", `The issue is on ${reference.siteUrl}, but the connected Jira site is ${connectedSite}.`);
    }
    return { ...reference, siteUrl: connectedSite };
  };

  const requireCapability = (
    adapter: IssueTrackerAdapter,
    capability: keyof IssueTrackerAdapter["capabilities"],
    operation: string,
  ): void => {
    if (!adapter.capabilities[capability]) {
      throw new IssueTrackerError(adapter.kind, operation, "invalid", `${adapter.kind} does not support ${capability}.`);
    }
  };

  const adapterFor = async (
    reference: IssueRef,
    capabilities: Array<keyof IssueTrackerAdapter["capabilities"]> = [],
    operation = "resolve",
  ): Promise<IssueTrackerAdapter> => {
    const kind: IssueTrackerKind = reference.provider;
    const adapter = adapters.get(kind);
    if (!adapter) throw new IssueTrackerError(kind, "resolve", "not-connected", `${kind} is not available on this machine.`);
    for (const capability of capabilities) requireCapability(adapter, capability, operation);
    if (!(await isConnected(kind))) throw new IssueTrackerError(kind, "resolve", "not-connected", `${kind} is not connected on this machine.`);
    return adapter;
  };

  const resolveAndAdapter = async (
    reference: string | IssueRef,
    capabilities: Array<keyof IssueTrackerAdapter["capabilities"]> = [],
    operation = "resolve",
  ) => {
    const resolved = await resolve(reference);
    return { reference: resolved, adapter: await adapterFor(resolved, capabilities, operation) };
  };

  const service: IssueTrackerService = {
    async resolve({ reference }) {
      const resolved = await resolve(reference);
      const adapter = adapters.get(resolved.provider);
      if (!adapter) throw new IssueTrackerError(resolved.provider, "resolve", "not-connected", `${resolved.provider} is not available on this machine.`);
      return { kind: adapter.kind, reference: resolved, capabilities: adapter.capabilities } satisfies IssueTrackerResolution;
    },
    async getViewer({ tracker }) {
      const adapter = adapters.get(tracker);
      if (!adapter || !(await isConnected(tracker))) throw new IssueTrackerError(tracker, "getViewer", "not-connected", `${tracker} is not connected on this machine.`);
      return await withIssueTrackerError(tracker, "getViewer", () => adapter.getViewer());
    },
    async list(input: IssueListArgs) {
      const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 25)));
      if (input.tracker) {
        const adapter = adapters.get(input.tracker);
        if (!adapter || !(await isConnected(input.tracker))) throw new IssueTrackerError(input.tracker, "list", "not-connected", `${input.tracker} is not connected on this machine.`);
        return await withIssueTrackerError(input.tracker, "list", () => adapter.listIssues({ ...input, limit }));
      }
      const connected = await Promise.all([...adapters.values()].map(async (adapter) => ({ adapter, connected: await isConnected(adapter.kind) })));
      const active = connected.filter((entry) => entry.connected);
      if (!active.length) throw new IssueTrackerError("linear", "list", "not-connected", "No issue tracker is connected on this machine.");
      const pages = await Promise.all(active.map(async ({ adapter }) => await withIssueTrackerError(adapter.kind, "list", () => adapter.listIssues({ ...input, cursor: null, limit }))));
      return {
        issues: pages.flatMap((page) => page.issues).sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")).slice(0, limit),
        nextCursor: null,
      };
    },
    async get({ reference }) {
      const resolved = await resolveAndAdapter(reference);
      return await withIssueTrackerError(resolved.adapter.kind, "getIssue", () => resolved.adapter.getIssue(resolved.reference));
    },
    async getComments({ reference, cursor }) {
      const resolved = await resolveAndAdapter(reference);
      return await withIssueTrackerError(resolved.adapter.kind, "getComments", () => resolved.adapter.getComments(resolved.reference, cursor));
    },
    async comment({ reference, body }) {
      const resolved = await resolveAndAdapter(reference, ["comment"], "comment");
      await withIssueTrackerError(resolved.adapter.kind, "comment", () => resolved.adapter.comment(resolved.reference, body));
    },
    async update(input: IssueUpdateArgs) {
      const patch = {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        ...(input.assignees !== undefined ? { assignees: input.assignees } : {}),
      };
      if (!Object.keys(patch).length) throw new IssueTrackerError("linear", "update", "invalid", "At least one issue field is required.");
      const capabilities: Array<keyof IssueTrackerAdapter["capabilities"]> = [];
      if (patch.title !== undefined || patch.body !== undefined) capabilities.push("edit");
      if (patch.labels !== undefined) capabilities.push("labels");
      if (patch.assignees !== undefined) capabilities.push("assignees");
      const resolved = await resolveAndAdapter(input.reference, capabilities, "update");
      await withIssueTrackerError(resolved.adapter.kind, "update", () => resolved.adapter.update(resolved.reference, patch));
    },
    async setState({ reference, state }) {
      const resolved = await resolveAndAdapter(reference, ["states"], "setState");
      await withIssueTrackerError(resolved.adapter.kind, "setState", () => resolved.adapter.setState(resolved.reference, state));
    },
    async create(input) {
      const adapter = adapters.get(input.tracker);
      if (!adapter) throw new IssueTrackerError(input.tracker, "create", "not-connected", `${input.tracker} is not available on this machine.`);
      requireCapability(adapter, "create", "create");
      if (input.template) requireCapability(adapter, "templates", "create");
      if (input.labels?.length) requireCapability(adapter, "labels", "create");
      if (input.assignees?.length) requireCapability(adapter, "assignees", "create");
      if (input.state) requireCapability(adapter, "states", "create");
      if (!(await isConnected(input.tracker))) throw new IssueTrackerError(input.tracker, "create", "not-connected", `${input.tracker} is not connected on this machine.`);
      return await withIssueTrackerError(input.tracker, "create", async () => {
        const created = await adapter.create(input);
        if (!input.state) return created;
        await adapter.setState(created.reference, input.state);
        return await adapter.getIssue(created.reference);
      });
    },
    async listStates(input) {
      let adapter: IssueTrackerAdapter | undefined;
      let reference: IssueRef | undefined;
      if (input.reference) {
        const resolved = await resolveAndAdapter(input.reference, ["states"], "listStates");
        adapter = resolved.adapter;
        reference = resolved.reference;
      } else if (input.tracker) {
        adapter = adapters.get(input.tracker);
        if (!adapter) throw new IssueTrackerError(input.tracker, "listStates", "not-connected", `${input.tracker} is not available on this machine.`);
        requireCapability(adapter, "states", "listStates");
        if (!(await isConnected(input.tracker))) throw new IssueTrackerError(input.tracker, "listStates", "not-connected", `${input.tracker} is not connected on this machine.`);
      } else {
        throw new IssueTrackerError("linear", "listStates", "invalid", "Pass a tracker or issue reference.");
      }
      requireCapability(adapter, "states", "listStates");
      return await withIssueTrackerError(adapter.kind, "listStates", () => adapter.listStates({ scope: input.scope, reference }));
    },
    isConnected,
  };

  return service;
}
