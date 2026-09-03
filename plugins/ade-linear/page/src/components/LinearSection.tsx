/**
 * The Linear settings section, moved into the plugin's own page.
 *
 * This is `apps/desktop/src/renderer/components/settings/LinearSection.tsx`,
 * moved rather than rewritten: every class name, every pixel value, every
 * string and every behaviour is the compiled section's. Three things changed,
 * and only three:
 *
 *  1. **Host calls.** `window.ade.cto.*` and `window.ade.github.*` became the
 *     page actions in `../host/actions`, which the plugin's own child answers.
 *  2. **Persistence.** The three preference keys the plugin declares in
 *     `plugin.json` are read and written through the bridge's `config` verbs.
 *  3. **Imports.** `../lanes/laneDesignTokens` and `../ui/Button` became
 *     `@ade-dev/ui`; `../../../shared/types` became `../types`.
 *
 * Two blocks are additions rather than ports, because the compiled section has
 * no equivalent: the PREFERENCES form (the plugin's own `settings` keys, one of
 * which — the launch-prompt clipboard toggle — used to be an ADE preference) and
 * the AUTOMATIONS/webhook strip (the plugin's `webhookIngress`). Both are drawn
 * in the compiled section's visual vocabulary — its card, its label, its type
 * scale — and both say exactly what `panels/settings.js` already says, word for
 * word, because that panel is the behavioural spec for what the plugin can do.
 *
 * ## The OAuth flow, and what is gone
 *
 * The compiled section started a flow with `startLinearOAuth()`, opened the URL
 * itself, then POLLED `getLinearOAuthSession({sessionId})` every 1500 ms for up
 * to five minutes. All of that machinery is DELETED. The plugin's OAuth is
 * host-driven: `connectOAuth(origin)` answers `{authSession}`, the bridge
 * applies that control-flow answer — opening the browser or the phone's auth
 * view — before the promise resolves, and the plugin's child settles the
 * sign-in on its own `auth.completed` listener. So there is no session id for
 * the page to hold and nothing for it to poll. The page awaits the action,
 * refetches the connection, and if the credential has not landed yet it waits
 * on the host's `changed` event (`useCollectionChanges`) rather than on a
 * timer. The five-minute give-up is kept, with the compiled section's own
 * wording, because a reader who closed the browser tab still needs the button
 * to come back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsLeftRight,
  ArrowsClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  Key,
  Lightning,
  LinkSimple,
  Plugs,
  XCircle,
} from "@phosphor-icons/react";
import { COLORS, SANS_FONT, MONO_FONT, LABEL_STYLE, SettingsToggle, formatTimestamp } from "@ade-dev/ui";
import { Button } from "@ade-dev/ui";

import type { CtoLinearProject, GitHubAutolink, LinearConnectionStatus } from "../types";
import type { PluginWebviewContext } from "../bridge";
import { requireBridge } from "../bridge";
import {
  connectOAuth,
  createAutolink,
  disconnect,
  getAutolinks,
  getConnection,
  getProjects,
  saveApiKey,
  saveWebhookSecret,
  type PageActionResult,
  type PageAutolinkState,
} from "../host/actions";
import { openLink, writeClipboard } from "../host/ui";
import { useCollectionChanges } from "../host/useHostEntities";

const LINEAR_BRAND = "#5E6AD2";
const LINEAR_API_SETTINGS_URL = "https://linear.app/settings/api";

/**
 * Copied from `apps/desktop/src/shared/deeplinks.ts` (`ADE_DEEPLINK_HTTPS_HOST`
 * + `ADE_DEEPLINK_HTTPS_PATH`, joined there as `ADE_DEEPLINK_HTTPS_BASE_URL`).
 * A plugin page is built outside the app and cannot import from it.
 */
const ADE_DEEPLINK_HTTPS_BASE_URL = "https://ade-app.dev/open";

/** The `authSessions[].id` origin this panel names — `connect.js:AUTH_ORIGINS`. */
const AUTH_ORIGIN_SETTINGS = "settings";

/** How long the page waits for a host-driven sign-in before giving the button back. */
const OAUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

/** The setting keys `plugin.json` declares. Spelled once, as `panels/settings.js` does. */
const SETTING_MOVE_ON_MERGE = "moveToDoneOnMerge";
const SETTING_MOVE_ON_LAUNCH = "moveToStartedOnLaunch";
const SETTING_DEFAULT_TEAM = "defaultTeamKey";
/**
 * The launch-prompt clipboard toggle.
 *
 * It was an ADE preference (`launchPromptClipboardEnabled` on the app store)
 * that the compiled launch flow read and ADE's own "Copy prompts to clipboard"
 * settings card wrote. A guest can read neither, so the preference is the
 * plugin's own now and this section draws the toggle — which is also the right
 * home for it: the only prompt it copies is a Linear kickoff.
 */
const SETTING_LAUNCH_CLIPBOARD = "launchPromptClipboard";

type PluginSettings = Record<string, string | number | boolean | null>;

function LinearWorkspaceAvatar({
  organizationName,
  logoUrl,
}: {
  organizationName: string | null | undefined;
  logoUrl: string | null | undefined;
}) {
  const normalizedLogoUrl = logoUrl?.trim() || null;
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const showLogo = normalizedLogoUrl != null && failedLogoUrl !== normalizedLogoUrl;
  const monogram = organizationName?.trim().charAt(0).toUpperCase() || "L";

  return (
    <div
      aria-hidden="true"
      style={{
        width: 24,
        height: 24,
        flex: "0 0 24px",
        overflow: "hidden",
        borderRadius: 7,
        border: `1px solid color-mix(in srgb, ${LINEAR_BRAND} 28%, transparent)`,
        background: `color-mix(in srgb, ${LINEAR_BRAND} 14%, transparent)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: COLORS.textPrimary,
        fontFamily: SANS_FONT,
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {showLogo ? (
        <img
          src={normalizedLogoUrl}
          alt=""
          onError={() => setFailedLogoUrl(normalizedLogoUrl)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : monogram}
    </div>
  );
}

type GitHubAutolinkCandidate = {
  id: string;
  title: string;
  desc: string;
  keyPrefix: string;
  urlTemplate: string;
  isAlphanumeric: boolean;
  command: string;
  configured: boolean;
  /**
   * What `createAutolink` is called with. The plugin's action takes one string
   * — `panels/settings.js` presses it as `{prefix}` and the page action names
   * the same value `teamKey` — so it is the key prefix with its trailing dash
   * removed: `ENG-` → `ENG`, `ADEPR-` → `ADEPR`.
   */
  teamKey: string;
};

const FEATURES = [
  { icon: ArrowsLeftRight, title: "Issue routing", desc: "Attach Linear issues to lanes, chats, and the work that happened there" },
  { icon: Lightning, title: "PR linkage", desc: "Carry Linear refs, ADE links, and issue lists into GitHub PRs" },
  { icon: ArrowsClockwise, title: "Linear timeline", desc: "Publish ADE lane and PR cards back onto the Linear issue" },
  { icon: Plugs, title: "CTO workflows", desc: "Dispatch work directly from Linear and keep status context close" },
];

/** The connection a mutating page action carries back, when it carries one. */
function connectionFromResult(result: PageActionResult | null | undefined): LinearConnectionStatus | null {
  const value = (result as { connection?: unknown } | null | undefined)?.connection;
  return value && typeof value === "object" ? (value as LinearConnectionStatus) : null;
}

export function LinearSection({
  context,
  embedded = false,
}: {
  context: PluginWebviewContext;
  embedded?: boolean;
}) {
  // Linear connection, GitHub repo, and team keys are all scoped to the active
  // project (credentials are project-scoped). Re-run the loaders whenever the
  // active project changes so the autolink commands target the right repo and
  // Linear workspace instead of a stale previously-loaded project.
  const projectRoot = context.project?.root ?? null;
  // Linear OAuth uses a 127.0.0.1 loopback callback server. When the project is
  // bound to a remote runtime that server runs on the remote host, but the
  // browser opens locally and redirects to localhost on THIS machine — so the
  // callback never arrives. Steer remote sessions to the API-key path, which
  // routes cleanly to the remote machine's credential store.
  const isRemoteRuntime = context.project?.binding === "remote";
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [projects, setProjects] = useState<CtoLinearProject[]>([]);
  const [githubRepo, setGithubRepo] = useState<{ owner: string; name: string } | null>(null);
  const [githubAutolinks, setGithubAutolinks] = useState<GitHubAutolink[]>([]);
  const [autolinkTeams, setAutolinkTeams] = useState<PageAutolinkState["teams"]>([]);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [webhookSecretStored, setWebhookSecretStored] = useState(false);
  const [webhooksPossible, setWebhooksPossible] = useState<boolean | undefined>(undefined);
  /**
   * The host's delivery ledger, as the settings PANEL prints it.
   *
   * "Last event", "Waiting (n unacked)" and "Drain" are the three rows the
   * plugin's vocabulary panel draws under Automations and the compiled section
   * had nowhere to put. They answer the one question the endpoint and the
   * secret between them cannot: whether deliveries are actually ARRIVING.
   */
  const [webhookLedger, setWebhookLedger] = useState<{
    lastEvent: string | null;
    pendingDeliveries: number;
    drainError: string | null;
  }>({ lastEvent: null, pendingDeliveries: 0, drainError: null });
  const [autolinksLoading, setAutolinksLoading] = useState(false);
  const [autolinkError, setAutolinkError] = useState<string | null>(null);
  const [creatingAutolinkId, setCreatingAutolinkId] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<PluginSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [savingSettingKey, setSavingSettingKey] = useState<string | null>(null);
  const [teamKeyDraft, setTeamKeyDraft] = useState<string | null>(null);
  const [webhookSecretInput, setWebhookSecretInput] = useState("");
  const [savingWebhookSecret, setSavingWebhookSecret] = useState(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [webhookUrlCopied, setWebhookUrlCopied] = useState(false);
  const validatingRef = useRef(false);
  const oauthStartingRef = useRef(false);
  const requestEpochRef = useRef(0);
  const autolinksRequestIdRef = useRef(0);

  const invalidateLoadRequests = useCallback(() => {
    requestEpochRef.current += 1;
    return requestEpochRef.current;
  }, []);

  const isCurrentLoadRequest = useCallback((requestId: number) => requestEpochRef.current === requestId, []);

  const setValidatingState = useCallback((value: boolean) => {
    validatingRef.current = value;
    setValidating(value);
  }, []);

  const setOauthStartingState = useCallback((value: boolean) => {
    oauthStartingRef.current = value;
    setOauthStarting(value);
  }, []);

  const isConnected = Boolean(connection?.connected);
  const authModeLabel = useMemo(() => {
    if (!connection?.authMode) return null;
    return connection.authMode === "oauth" ? "OAuth" : "API key";
  }, [connection?.authMode]);
  const workspaceLabel = connection?.organizationName?.trim() || connection?.organizationUrlKey?.trim() || null;
  const workspaceUrlKey = connection?.organizationUrlKey?.trim() || "YOUR-WORKSPACE";
  const githubRepoSlug = githubRepo ? `${githubRepo.owner}/${githubRepo.name}` : null;
  // The plugin's DATA wins: `getAutolinks()` answers the workspace's teams
  // directly, which is a better source than inferring keys from the project
  // list. The project-derived keys stay as the fallback so a host that answers
  // no teams still draws the compiled section's rows.
  const teamKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const team of autolinkTeams) {
      const key = team.teamKey?.trim();
      if (key) keys.add(key.toUpperCase());
    }
    for (const project of projects) {
      const key = project.teamKey?.trim();
      if (key) keys.add(key.toUpperCase());
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }, [autolinkTeams, projects]);
  const teamNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const team of autolinkTeams) {
      const key = team.teamKey?.trim().toUpperCase();
      if (key && team.teamName) names.set(key, team.teamName);
    }
    for (const project of projects) {
      const key = project.teamKey?.trim().toUpperCase();
      if (key && project.teamName && !names.has(key)) names.set(key, project.teamName);
    }
    return names;
  }, [autolinkTeams, projects]);
  const teamUrlTemplates = useMemo(() => {
    const templates = new Map<string, string>();
    for (const team of autolinkTeams) {
      const key = team.teamKey?.trim().toUpperCase();
      if (key && team.urlTemplate) templates.set(key, team.urlTemplate);
    }
    return templates;
  }, [autolinkTeams]);
  const autolinkCandidates = useMemo<GitHubAutolinkCandidate[]>(() => {
    const repoSlug = githubRepoSlug ?? "OWNER/REPO";
    const adePrTemplate = `${ADE_DEEPLINK_HTTPS_BASE_URL}?type=pr&repo=${encodeURIComponent(repoSlug)}&number=<num>`;
    const baseCandidates: Array<Omit<GitHubAutolinkCandidate, "configured" | "command" | "teamKey">> = [
      {
        id: "ade-pr",
        title: "Open PRs in ADE",
        desc: "Turns ADEPR-123 in GitHub text into a link that opens that PR in this ADE project.",
        keyPrefix: "ADEPR-",
        urlTemplate: adePrTemplate,
        isAlphanumeric: false,
      },
      ...teamKeys.map((teamKey) => ({
        id: `linear-${teamKey}`,
        title: `${teamKey} Linear issues`,
        desc: `Turns ${teamKey}-123 in GitHub text into a Linear issue link.`,
        keyPrefix: `${teamKey}-`,
        urlTemplate:
          teamUrlTemplates.get(teamKey)
          ?? `https://linear.app/${encodeURIComponent(workspaceUrlKey)}/issue/${teamKey}-<num>`,
        isAlphanumeric: false,
      })),
    ];
    return baseCandidates.map((candidate) => {
      const configured = githubAutolinks.some((autolink) =>
        autolink.keyPrefix.toLowerCase() === candidate.keyPrefix.toLowerCase()
      );
      const command = [
        "gh",
        "repo",
        "autolink",
        "create",
        candidate.keyPrefix,
        `"${candidate.urlTemplate}"`,
        "--numeric",
        `--repo ${githubRepoSlug ?? "OWNER/REPO"}`,
      ].join(" ");
      return { ...candidate, configured, command, teamKey: candidate.keyPrefix.replace(/-$/, "") };
    });
  }, [githubAutolinks, githubRepoSlug, teamKeys, teamUrlTemplates, workspaceUrlKey]);

  /* ── Load helpers ── */
  const loadProjects = useCallback(async (requestIdArg?: number) => {
    const requestId = requestIdArg ?? invalidateLoadRequests();
    try {
      const nextProjects = await getProjects();
      if (!isCurrentLoadRequest(requestId)) return;
      setProjects(Array.isArray(nextProjects) ? nextProjects : []);
    } catch {
      if (!isCurrentLoadRequest(requestId)) return;
      setProjects([]);
    }
  }, [invalidateLoadRequests, isCurrentLoadRequest]);

  const loadGithubAutolinks = useCallback(async () => {
    // Guard against stale responses: if the active project changes while a
    // `pageAutolinks` call is in flight, an older response must not repopulate
    // the repo/autolinks (which would make the displayed repo and generated
    // `gh repo autolink` commands wrong for the new project).
    const requestId = ++autolinksRequestIdRef.current;
    setAutolinksLoading(true);
    setAutolinkError(null);
    try {
      const state = await getAutolinks();
      if (autolinksRequestIdRef.current !== requestId) return;
      const repo = state?.repo ?? null;
      setGithubRepo(repo);
      setAutolinkTeams(Array.isArray(state?.teams) ? state.teams : []);
      setWebhookUrl(state?.webhookUrl ?? null);
      setWebhookSecretStored(state?.webhookSecretStored === true);
      setWebhooksPossible(state?.webhooksPossible);
      setWebhookLedger({
        lastEvent: state?.lastEvent ?? null,
        pendingDeliveries: Number(state?.pendingDeliveries) || 0,
        drainError: state?.drainError ?? null,
      });
      if (!repo) {
        setGithubAutolinks([]);
        setAutolinkError("No GitHub origin remote was detected for this project.");
        return;
      }
      setGithubAutolinks(Array.isArray(state?.autolinks) ? state.autolinks : []);
    } catch (err) {
      if (autolinksRequestIdRef.current !== requestId) return;
      setGithubAutolinks([]);
      setAutolinkError(err instanceof Error ? err.message : "Unable to load GitHub autolinks.");
    } finally {
      if (autolinksRequestIdRef.current === requestId) {
        setAutolinksLoading(false);
      }
    }
  }, []);

  const loadStatus = useCallback(async () => {
    const requestId = invalidateLoadRequests();
    try {
      const status = await getConnection();
      if (!isCurrentLoadRequest(requestId)) return;
      setConnection(status);
      if (status?.connected) {
        if (isCurrentLoadRequest(requestId)) {
          void loadProjects(requestId);
        }
      } else {
        setProjects([]);
      }
    } catch {
      if (!isCurrentLoadRequest(requestId)) return;
      setConnection(null);
      setProjects([]);
    }
  }, [invalidateLoadRequests, isCurrentLoadRequest, loadProjects]);

  /**
   * The plugin's own settings, read through the bridge rather than from a
   * renderer store: `config.get()`/`config.set()` write exactly the keys
   * `plugin.json` declares under `settings` and drop the rest.
   */
  const loadSettings = useCallback(async () => {
    try {
      const next = await requireBridge().config.get();
      setSettings(next && typeof next === "object" ? next : {});
      setSettingsError(null);
    } catch (err) {
      setSettings(null);
      setSettingsError(err instanceof Error ? err.message : "Unable to read this plugin's settings.");
    }
  }, []);

  const writeSetting = useCallback(async (key: string, value: string | boolean) => {
    setSavingSettingKey(key);
    setSettingsError(null);
    // Optimism is bounded: the row moves at once so the control never lags the
    // press, and the answer replaces it, so a refusal snaps back.
    setSettings((current) => ({ ...(current ?? {}), [key]: value }));
    try {
      const next = await requireBridge().config.set(key, value);
      if (next && typeof next === "object") setSettings(next);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Unable to save that preference.");
      void loadSettings();
    } finally {
      setSavingSettingKey(null);
    }
  }, [loadSettings]);

  /* ── Initial load + reload on active-project change ── */
  useEffect(() => {
    void loadStatus();
  }, [loadStatus, projectRoot]);

  useEffect(() => {
    void loadGithubAutolinks();
  }, [loadGithubAutolinks, projectRoot]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  /**
   * The replacement for the compiled section's OAuth POLLING LOOP.
   *
   * There is no session id and no interval. The child settles the sign-in on
   * `auth.completed` and publishes; the host relays that as a `changed` event,
   * and the page refetches the connection once — only while it is actually
   * waiting, so a background publish does not churn the card.
   */
  useCollectionChanges(useCallback(() => {
    if (!oauthStartingRef.current) return;
    void loadStatus();
  }, [loadStatus]));

  /**
   * Give the button back if the sign-in never lands. The compiled section's own
   * five minutes and its own sentence — a reader who closed the Linear tab has
   * no other way out of "Waiting for Linear…".
   */
  useEffect(() => {
    if (!oauthStarting) return;
    const timeout = window.setTimeout(() => {
      if (!oauthStartingRef.current) return;
      setOauthStartingState(false);
      setError("OAuth timed out. Please try again.");
    }, OAUTH_WAIT_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [oauthStarting, setOauthStartingState]);

  /** Once the credential lands, stop waiting. */
  useEffect(() => {
    if (isConnected && oauthStartingRef.current) {
      setOauthStartingState(false);
      setError(null);
    }
  }, [isConnected, setOauthStartingState]);

  /* ── Handlers ── */
  const handleValidate = useCallback(async () => {
    const submittedToken = tokenInput.trim();
    if (!submittedToken || validatingRef.current || oauthStartingRef.current) {
      return;
    }
    const requestId = invalidateLoadRequests();
    setValidatingState(true);
    setError(null);
    try {
      // `saveApiKey` answers `{ok, message, connection}`. The connection it
      // carries is the authority; a build that answers without one is read back
      // with a refetch rather than left showing a stale card.
      const result = await saveApiKey(submittedToken);
      const status = connectionFromResult(result) ?? (await getConnection().catch(() => null));
      if (!validatingRef.current || oauthStartingRef.current || !isCurrentLoadRequest(requestId)) {
        return;
      }
      setConnection(status);
      if (status?.connected) {
        void loadProjects(requestId);
        void loadGithubAutolinks();
        setTokenInput("");
      } else {
        setError(result?.message ?? status?.message ?? "Token validation failed.");
      }
    } catch (err) {
      if (!validatingRef.current || oauthStartingRef.current || !isCurrentLoadRequest(requestId)) {
        return;
      }
      setError(err instanceof Error ? err.message : "Validation failed.");
    } finally {
      if (validatingRef.current) {
        setValidatingState(false);
      }
    }
  }, [
    invalidateLoadRequests,
    isCurrentLoadRequest,
    loadGithubAutolinks,
    loadProjects,
    setValidatingState,
    tokenInput,
  ]);

  const handleStartOAuth = useCallback(async () => {
    // A second press while waiting is the compiled section's cancel: it drops
    // the wait and gives the button back.
    if (oauthStartingRef.current) {
      setOauthStartingState(false);
      return;
    }
    if (validatingRef.current) return;
    if (isRemoteRuntime) {
      setError("Browser sign-in isn't available over a remote connection. Use an API key instead.");
      return;
    }
    invalidateLoadRequests();
    setOauthStartingState(true);
    setError(null);
    try {
      // Host-driven: the bridge acts on `{authSession}` before this resolves.
      // There is nothing to open here and nothing to poll afterwards.
      const result = await connectOAuth(AUTH_ORIGIN_SETTINGS);
      if (!oauthStartingRef.current || validatingRef.current) return;
      if (result && result.ok === false) {
        setOauthStartingState(false);
        setError(result.message ?? "Unable to start OAuth.");
        return;
      }
      await loadStatus();
    } catch (err) {
      if (!oauthStartingRef.current) return;
      setOauthStartingState(false);
      setError(err instanceof Error ? err.message : "Unable to start OAuth.");
    }
  }, [invalidateLoadRequests, isRemoteRuntime, loadStatus, setOauthStartingState]);

  const handleDisconnect = useCallback(async () => {
    invalidateLoadRequests();
    try {
      const result = await disconnect();
      const status = connectionFromResult(result) ?? (await getConnection().catch(() => null));
      setConnection(status);
      setProjects([]);
      setTokenInput("");
      setError(result && result.ok === false ? (result.message ?? null) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect Linear.");
    } finally {
      setValidatingState(false);
      setOauthStartingState(false);
    }
  }, [invalidateLoadRequests, setOauthStartingState, setValidatingState]);

  const handleCreateAutolink = useCallback(async (candidate: GitHubAutolinkCandidate) => {
    if (!githubRepo) return;
    setCreatingAutolinkId(candidate.id);
    setAutolinkError(null);
    try {
      const result = await createAutolink(candidate.teamKey);
      if (result && result.ok === false) {
        setAutolinkError(result.message ?? "Unable to create GitHub autolink.");
        return;
      }
      await loadGithubAutolinks();
    } catch (err) {
      setAutolinkError(err instanceof Error ? err.message : "Unable to create GitHub autolink.");
    } finally {
      setCreatingAutolinkId(null);
    }
  }, [githubRepo, loadGithubAutolinks]);

  const handleCopyWebhookUrl = useCallback(async () => {
    if (!webhookUrl) return;
    const copied = await writeClipboard(webhookUrl);
    setWebhookUrlCopied(copied);
    if (!copied) setWebhookError("Unable to copy the webhook URL.");
  }, [webhookUrl]);

  const handleSaveWebhookSecret = useCallback(async () => {
    const secret = webhookSecretInput.trim();
    if (!secret || savingWebhookSecret) return;
    setSavingWebhookSecret(true);
    setWebhookError(null);
    try {
      const result = await saveWebhookSecret(secret);
      if (result && result.ok === false) {
        setWebhookError(result.message ?? "That signing secret wasn't saved.");
        return;
      }
      setWebhookSecretInput("");
      await loadGithubAutolinks();
    } catch (err) {
      setWebhookError(err instanceof Error ? err.message : "That signing secret wasn't saved.");
    } finally {
      setSavingWebhookSecret(false);
    }
  }, [loadGithubAutolinks, savingWebhookSecret, webhookSecretInput]);

  const moveOnLaunch = settings?.[SETTING_MOVE_ON_LAUNCH] === true;
  // Defaults ON, matching the manifest's `default: true` and the app preference
  // it replaced — so an unset value is on, not off.
  const launchClipboard = settings?.[SETTING_LAUNCH_CLIPBOARD] !== false;
  const moveOnMerge = settings?.[SETTING_MOVE_ON_MERGE] === true;
  const storedTeamKey = typeof settings?.[SETTING_DEFAULT_TEAM] === "string"
    ? String(settings[SETTING_DEFAULT_TEAM])
    : "";
  const teamKeyValue = teamKeyDraft ?? storedTeamKey;
  // The connection an API key made carries no webhook grant, so Linear delivers
  // nothing to it — `webhooksPossible === false`. `undefined` is a data half
  // that cannot answer, and a warning drawn on a guess is worse than silence.
  const webhooksStarved = webhooksPossible === false;

  return (
    <div style={{ display: "flex", maxWidth: embedded ? undefined : 780, flexDirection: "column", gap: 20 }}>

      {/* ── Connected State ── */}
      {isConnected ? (
        <div style={{
          padding: 20,
          background: `linear-gradient(135deg, color-mix(in srgb, var(--color-success) 8%, transparent), color-mix(in srgb, var(--color-success) 4%, transparent))`,
          border: "1px solid color-mix(in srgb, var(--color-success) 25%, transparent)",
          borderRadius: 14,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: `linear-gradient(135deg, ${LINEAR_BRAND}, ${LINEAR_BRAND}CC)`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <CheckCircle size={18} weight="fill" color="#fff" />
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                  Connected to Linear
                </div>
                <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary, marginTop: 2 }}>
                  {connection?.viewerName ? `Signed in as ${connection.viewerName}` : "Signed in"}
                  {authModeLabel ? ` via ${authModeLabel}` : ""}
                  {workspaceLabel ? ` · ${workspaceLabel}` : ""}
                  {connection?.projectCount ? ` · ${connection.projectCount} project${connection.projectCount === 1 ? "" : "s"}` : ""}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}>
              {!isRemoteRuntime ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleStartOAuth()}
                  disabled={oauthStarting || validating || connection?.oauthAvailable === false}
                >
                  {oauthStarting ? <CircleNotch size={12} className="animate-spin" /> : null}
                  {oauthStarting ? "Waiting for Linear..." : "Reconnect current workspace"}
                </Button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={oauthStarting}
                style={{
                  background: "none", border: "none", cursor: oauthStarting ? "default" : "pointer",
                  fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim,
                  padding: "4px 8px", borderRadius: 6,
                  transition: "color 0.15s",
                  opacity: oauthStarting ? 0.55 : 1,
                }}
                onMouseEnter={(e) => { if (!oauthStarting) e.currentTarget.style.color = COLORS.danger; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
              >
                Disconnect
              </button>
            </div>
          </div>

          {workspaceLabel ? (
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 12,
              padding: "10px 12px",
              marginBottom: 14,
              borderRadius: 8,
              background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
              border: `1px solid ${COLORS.border}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <LinearWorkspaceAvatar
                  organizationName={connection?.organizationName}
                  logoUrl={connection?.organizationLogoUrl}
                />
                <div>
                  <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, marginBottom: 2 }}>
                    Workspace
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                    {workspaceLabel}
                  </div>
                </div>
              </div>
              {connection?.organizationUrlKey ? (
                <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                  {connection.organizationUrlKey}
                </div>
              ) : null}
              <div style={{ flexBasis: "100%", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                To connect a different workspace, switch workspaces in Linear first, then reconnect here.
              </div>
            </div>
          ) : null}

          {/*
            The three facts the vocabulary PANEL prints and the compiled design
            had no slot for: how long the credential has left, when this machine
            last read Linear, and what went wrong if anything did.

            The compiled connected card is a header, one bordered row and a chip
            list, and none of the three fit in the header sentence — a token
            three days from expiry is not a footnote to "Signed in as". So they
            get the SAME bordered row the workspace uses: the 10px dim label
            over the 13px value, laid side by side. The design was not extended,
            it was reused.

            `expiresIn` is pre-formatted by the child ("expires in 6 days"), and
            `expired` is what makes it amber. `lastError` is the loudest thing
            here and is drawn full-width beneath, because a sentence from Linear
            does not fit in a value cell.
          */}
          {connection?.expiresIn || connection?.checkedAt || connection?.message ? (
            <div style={{
              display: "flex",
              alignItems: "flex-start",
              flexWrap: "wrap",
              gap: 12,
              padding: "10px 12px",
              marginBottom: 14,
              borderRadius: 8,
              background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
              border: `1px solid ${COLORS.border}`,
            }}>
              {connection?.expiresIn ? (
                <div>
                  <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, marginBottom: 2 }}>
                    Token
                  </div>
                  <div style={{
                    fontSize: 13,
                    fontWeight: 600,
                    fontFamily: SANS_FONT,
                    color: connection.expired ? COLORS.warning : COLORS.textPrimary,
                  }}>
                    {connection.expiresIn}
                  </div>
                </div>
              ) : null}
              {connection?.checkedAt ? (
                <div>
                  <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, marginBottom: 2 }}>
                    Last read
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                    {formatTimestamp(connection.checkedAt)}
                  </div>
                </div>
              ) : null}
              {connection?.message ? (
                <div style={{
                  flexBasis: "100%",
                  fontSize: 11,
                  fontFamily: SANS_FONT,
                  color: COLORS.warning,
                  lineHeight: 1.6,
                }}>
                  {connection.message}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Project list */}
          {projects.length > 0 ? (
            <div>
              <div style={{ ...LABEL_STYLE, fontSize: 10, marginBottom: 8 }}>
                PROJECTS ({projects.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {projects.map((p) => (
                  <span key={p.id} style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 10px", borderRadius: 6,
                    background: "rgba(255,255,255,0.04)", border: `1px solid ${COLORS.border}`,
                    fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary,
                  }}>
                    {p.name}
                    <span style={{ fontSize: 10, color: COLORS.textDim }}>{p.teamName}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* ── Disconnected: Connection Methods ── */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
          }}>
            {/* OAuth — recommended */}
            <div style={{
              padding: 20,
              background: `linear-gradient(180deg, ${LINEAR_BRAND}0A 0%, transparent 100%)`,
              border: `1px solid ${LINEAR_BRAND}25`,
              borderRadius: 14,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              position: "relative",
            }}>
              <div style={{
                position: "absolute", top: 12, right: 12,
                padding: "2px 8px", borderRadius: 4,
                background: `${LINEAR_BRAND}18`, fontSize: 9, fontWeight: 600,
                fontFamily: SANS_FONT, color: LINEAR_BRAND,
                letterSpacing: "0.05em", textTransform: "uppercase",
              }}>
                Recommended
              </div>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: `linear-gradient(135deg, ${LINEAR_BRAND}20, ${LINEAR_BRAND}10)`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Plugs size={20} weight="duotone" style={{ color: LINEAR_BRAND }} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 4 }}>
                  Sign in with Linear
                </div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "17px" }}>
                  Connects the workspace currently selected in Linear.
                </div>
              </div>
              <Button
                size="md"
                variant="primary"
                onClick={() => void handleStartOAuth()}
                disabled={oauthStarting || validating || connection?.oauthAvailable === false || isRemoteRuntime}
                title={isRemoteRuntime ? "Browser sign-in isn't available over a remote connection — use an API key below." : undefined}
                style={{
                  background: LINEAR_BRAND,
                  width: "100%",
                  justifyContent: "center",
                  gap: 6,
                  marginTop: "auto",
                }}
              >
                {oauthStarting ? (
                  <CircleNotch size={13} className="animate-spin" />
                ) : (
                  <ArrowSquareOut size={13} />
                )}
                {oauthStarting ? "Waiting for Linear..." : "Sign in with Linear"}
              </Button>
              {isRemoteRuntime ? (
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                  Browser sign-in isn&rsquo;t available over a remote connection. Use an API key below — it&rsquo;s saved on the remote machine.
                </div>
              ) : connection?.oauthAvailable === false ? (
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                  Browser sign-in is not available in this ADE build.
                </div>
              ) : null}
            </div>

            {/* API Key — manual */}
            <div style={{
              padding: 20,
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: "rgba(255,255,255,0.04)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Key size={20} weight="duotone" style={{ color: COLORS.textMuted }} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 4 }}>
                  API Key
                </div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "17px" }}>
                  Paste a personal API key from your Linear settings. Good if OAuth isn't working.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
                <input
                  type="password"
                  aria-label="Linear API key"
                  placeholder="lin_api_..."
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !validating && !oauthStarting && tokenInput.trim()) {
                      e.preventDefault();
                      void handleValidate();
                    }
                  }}
                  style={{
                    flex: 1, height: 36, borderRadius: 8,
                    background: "rgba(255,255,255,0.03)",
                    border: `1px solid ${COLORS.border}`,
                    padding: "0 12px", fontSize: 12, fontFamily: MONO_FONT,
                    color: COLORS.textPrimary, outline: "none",
                    transition: "border-color 0.15s",
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = `${LINEAR_BRAND}50`; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.border; }}
                />
                <Button
                  size="md"
                  variant="outline"
                  onClick={() => void handleValidate()}
                  disabled={validating || oauthStarting || !tokenInput.trim()}
                >
                  {validating ? <CircleNotch size={12} className="animate-spin" /> : "Connect"}
                </Button>
              </div>
              <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                Get one at{" "}
                <a
                  href={LINEAR_API_SETTINGS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.preventDefault();
                    void openLink(LINEAR_API_SETTINGS_URL);
                  }}
                  style={{ color: COLORS.textMuted }}
                >
                  linear.app/settings/api
                </a>
              </div>
            </div>
          </div>
        </>
      )}

      {/*
        ── Preferences ──
        An ADDITION, not a port: the compiled Linear integration has no
        preferences on any surface. Every field writes a key `plugin.json`
        declares under `settings`, with the labels and help `panels/settings.js`
        already uses, in that panel's order. Committed on change (toggles) and
        on blur (the team key), so there is no Save to hunt for.
      */}
      {isConnected ? (
        <div style={{
          padding: 18,
          background: COLORS.cardBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 14,
        }}>
          <div style={{ ...LABEL_STYLE, fontSize: 10, marginBottom: 12, letterSpacing: "0.06em" }}>
            PREFERENCES
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{
              display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
              padding: "10px 12px", borderRadius: 10,
              border: `1px solid ${COLORS.border}`,
              background: "rgba(255,255,255,0.025)",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 3 }}>
                  Move the issue to In Progress when an agent starts on it
                </div>
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "15px" }}>
                  Uses the team's first started workflow state.
                </div>
              </div>
              <SettingsToggle
                id="ade-linear-move-on-launch"
                checked={moveOnLaunch}
                disabled={settings === null || savingSettingKey === SETTING_MOVE_ON_LAUNCH}
                onChange={(next) => void writeSetting(SETTING_MOVE_ON_LAUNCH, next)}
              />
            </div>

            <div style={{
              display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
              padding: "10px 12px", borderRadius: 10,
              border: `1px solid ${COLORS.border}`,
              background: "rgba(255,255,255,0.025)",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 3 }}>
                  Move the issue to Done when its pull request merges
                </div>
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "15px" }}>
                  Only issues linked to the lane with "close on merge" are moved.
                </div>
              </div>
              <SettingsToggle
                id="ade-linear-move-on-merge"
                checked={moveOnMerge}
                disabled={settings === null || savingSettingKey === SETTING_MOVE_ON_MERGE}
                onChange={(next) => void writeSetting(SETTING_MOVE_ON_MERGE, next)}
              />
            </div>

            <div style={{
              display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
              padding: "10px 12px", borderRadius: 10,
              border: `1px solid ${COLORS.border}`,
              background: "rgba(255,255,255,0.025)",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 3 }}>
                  Copy the launch prompt to the clipboard
                </div>
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "15px" }}>
                  Saves the kickoff prompt before Linear starts an agent on the issue.
                </div>
              </div>
              <SettingsToggle
                id="ade-linear-launch-clipboard"
                checked={launchClipboard}
                disabled={settings === null || savingSettingKey === SETTING_LAUNCH_CLIPBOARD}
                onChange={(next) => void writeSetting(SETTING_LAUNCH_CLIPBOARD, next)}
              />
            </div>

            <div style={{
              display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
              padding: "10px 12px", borderRadius: 10,
              border: `1px solid ${COLORS.border}`,
              background: "rgba(255,255,255,0.025)",
            }}>
              <div style={{ minWidth: 0 }}>
                <label
                  htmlFor="ade-linear-default-team"
                  style={{ display: "block", fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 3 }}
                >
                  Default team key
                </label>
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "15px" }}>
                  Used when a command does not name a team, e.g. ENG.
                </div>
              </div>
              {/*
                A select when the plugin knows the teams, a text field when it
                does not. The manifest declares the key as text either way; a
                select is the same string with the guesswork removed.
              */}
              {teamKeys.length > 0 ? (
                <select
                  id="ade-linear-default-team"
                  value={teamKeyValue}
                  disabled={settings === null || savingSettingKey === SETTING_DEFAULT_TEAM}
                  onChange={(e) => {
                    setTeamKeyDraft(null);
                    void writeSetting(SETTING_DEFAULT_TEAM, e.target.value);
                  }}
                  style={{
                    flex: "0 0 auto", height: 36, borderRadius: 8,
                    background: "rgba(255,255,255,0.03)",
                    border: `1px solid ${COLORS.border}`,
                    padding: "0 10px", fontSize: 12, fontFamily: SANS_FONT,
                    color: COLORS.textPrimary, outline: "none",
                  }}
                >
                  {teamKeyValue && !teamKeys.includes(teamKeyValue) ? (
                    <option value={teamKeyValue}>{teamKeyValue}</option>
                  ) : null}
                  {teamKeys.map((key) => {
                    const name = teamNames.get(key);
                    return <option key={key} value={key}>{name ? `${key} · ${name}` : key}</option>;
                  })}
                </select>
              ) : (
                <input
                  id="ade-linear-default-team"
                  type="text"
                  placeholder="ENG"
                  value={teamKeyValue}
                  disabled={settings === null}
                  onChange={(e) => setTeamKeyDraft(e.target.value)}
                  onBlur={() => {
                    const next = (teamKeyDraft ?? "").trim();
                    setTeamKeyDraft(null);
                    if (teamKeyDraft == null || next === storedTeamKey) return;
                    void writeSetting(SETTING_DEFAULT_TEAM, next);
                  }}
                  style={{
                    flex: "0 0 140px", height: 36, borderRadius: 8,
                    background: "rgba(255,255,255,0.03)",
                    border: `1px solid ${COLORS.border}`,
                    padding: "0 12px", fontSize: 12, fontFamily: MONO_FONT,
                    color: COLORS.textPrimary, outline: "none",
                    transition: "border-color 0.15s",
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = `${LINEAR_BRAND}50`; }}
                />
              )}
            </div>
          </div>
          {settingsError ? (
            <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: "15px", marginTop: 10 }}>
              {settingsError}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{
        padding: 18,
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 14,
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ ...LABEL_STYLE, fontSize: 10, marginBottom: 6, letterSpacing: "0.06em" }}>
              GITHUB REFERENCE LINKS
            </div>
            <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "17px" }}>
              GitHub autolinks make Linear issue keys (like ENG-123) and ADE PR refs clickable wherever they appear in PRs, commits, and comments — no full URLs needed. Applies to the repo below for this project.
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadGithubAutolinks()}
            disabled={autolinksLoading || creatingAutolinkId !== null}
          >
            {autolinksLoading ? <CircleNotch size={12} className="animate-spin" /> : null}
            Refresh
          </Button>
        </div>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "9px 11px",
          borderRadius: 8,
          background: "rgba(255,255,255,0.03)",
          border: `1px solid ${COLORS.border}`,
          marginBottom: 10,
        }}>
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
            Repository
          </div>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, minWidth: 0, overflowWrap: "anywhere" }}>
            {githubRepoSlug ?? "No GitHub origin detected"}
          </div>
        </div>
        <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: "15px", marginBottom: 8 }}>
          Click <strong style={{ color: COLORS.textSecondary, fontWeight: 600 }}>Create</strong> to add a link to this repo automatically, or copy the <code style={{ fontFamily: MONO_FONT }}>gh</code> command below it to run it yourself.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {autolinkCandidates.map((candidate) => {
            const busy = creatingAutolinkId === candidate.id;
            return (
              <div
                key={candidate.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 10,
                  alignItems: "start",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: `1px solid ${candidate.configured ? "color-mix(in srgb, var(--color-success) 22%, transparent)" : COLORS.border}`,
                  background: candidate.configured
                    ? "color-mix(in srgb, var(--color-success) 6%, transparent)"
                    : "rgba(255,255,255,0.025)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                    {candidate.configured ? <CheckCircle size={13} weight="fill" style={{ color: COLORS.success }} /> : null}
                    <div style={{ fontSize: 12, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                      {candidate.title}
                    </div>
                    <code style={{
                      fontSize: 10,
                      fontFamily: MONO_FONT,
                      color: COLORS.textDim,
                      padding: "2px 5px",
                      borderRadius: 5,
                      background: "rgba(255,255,255,0.04)",
                    }}>
                      {candidate.keyPrefix}
                    </code>
                  </div>
                  <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "15px", marginBottom: 6 }}>
                    {candidate.desc}
                  </div>
                  <div style={{
                    fontSize: 10,
                    fontFamily: MONO_FONT,
                    color: COLORS.textDim,
                    lineHeight: "15px",
                    overflowWrap: "anywhere",
                  }}>
                    {candidate.command}
                  </div>
                </div>
                <Button
                  type="button"
                  variant={candidate.configured ? "ghost" : "outline"}
                  size="sm"
                  onClick={() => void handleCreateAutolink(candidate)}
                  disabled={!githubRepo || candidate.configured || autolinksLoading || creatingAutolinkId !== null}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                  {candidate.configured ? "Configured" : "Create"}
                </Button>
              </div>
            );
          })}
        </div>
        {!teamKeys.length ? (
          <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: "15px", marginTop: 10 }}>
            Connect Linear and load projects to add team-key references such as TEAM-123 for this workspace.
          </div>
        ) : null}
        {autolinkError ? (
          <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: "15px", marginTop: 10 }}>
            {autolinkError}
          </div>
        ) : null}
      </div>

      {/*
        ── Automations: the webhook ingress ──
        The plugin's, not the compiled section's. `webhookIngress` in
        `plugin.json` gives this plugin a relay URL and an HMAC-SHA256
        verification against `LINEAR_WEBHOOK_SECRET`, and the host FAILS CLOSED:
        a channel whose secret it cannot find drops every delivery. So the strip
        is three facts — whether Linear can deliver at all, the URL to paste,
        and the signing secret — with `panels/settings.js`'s wording verbatim.
      */}
      {webhookUrl || webhooksStarved ? (
        <div style={{
          padding: 18,
          background: COLORS.cardBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 14,
        }}>
          <div style={{ ...LABEL_STYLE, fontSize: 10, marginBottom: 12, letterSpacing: "0.06em" }}>
            AUTOMATIONS
          </div>

          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "9px 11px",
            borderRadius: 8,
            background: "rgba(255,255,255,0.03)",
            border: `1px solid ${COLORS.border}`,
            marginBottom: 10,
          }}>
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              Verification
            </div>
            <div style={{
              fontSize: 11,
              fontFamily: SANS_FONT,
              color: webhookSecretStored ? COLORS.success : COLORS.warning,
              minWidth: 0,
              overflowWrap: "anywhere",
            }}>
              {webhookSecretStored ? "Signed deliveries only" : "Deliveries dropped until the signing secret is saved"}
            </div>
          </div>

          {/*
            Whether deliveries are ARRIVING, which the endpoint row and the
            verification row between them cannot say. The same three rows the
            vocabulary panel draws, in the same words, using the row shape
            "Verification" above already established: a label on the left, the
            value on the right.

            Each is drawn only when it has something to report. A "Waiting: 0
            unacked" row beside a healthy endpoint is noise, and a "Drain" row
            with no error in it reads as a category the reader has to think
            about.
          */}
          {webhookLedger.lastEvent || webhookLedger.pendingDeliveries > 0 || webhookLedger.drainError ? (
            <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              {([
                webhookLedger.lastEvent
                  ? { key: "Last event", value: webhookLedger.lastEvent, tone: COLORS.textSecondary }
                  : null,
                webhookLedger.pendingDeliveries > 0
                  ? {
                    key: "Waiting",
                    value: `${webhookLedger.pendingDeliveries} unacked`,
                    tone: COLORS.warning,
                  }
                  : null,
                webhookLedger.drainError
                  ? { key: "Drain", value: webhookLedger.drainError, tone: COLORS.danger }
                  : null,
              ].filter(Boolean) as { key: string; value: string; tone: string }[]).map((row) => (
                <div
                  key={row.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "9px 11px",
                    borderRadius: 8,
                    background: "rgba(255,255,255,0.03)",
                    border: `1px solid ${COLORS.border}`,
                  }}
                >
                  <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
                    {row.key}
                  </div>
                  <div style={{
                    fontSize: 11,
                    fontFamily: SANS_FONT,
                    color: row.tone,
                    minWidth: 0,
                    overflowWrap: "anywhere",
                  }}>
                    {row.value}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {webhooksStarved ? (
            <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.warning, lineHeight: "15px", marginBottom: 10 }}>
              This connection has no webhook grant — a personal API key carries none. Setting up the URL and the signing secret below will not change that. Sign in with Linear to receive events.
            </div>
          ) : null}

          {webhookUrl ? (
            <>
              <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "15px", marginBottom: 8 }}>
                Paste this URL into Linear's webhook settings so an issue that changes wakes ADE.
              </div>
              <div style={{
                fontSize: 10,
                fontFamily: MONO_FONT,
                color: COLORS.textDim,
                lineHeight: "15px",
                overflowWrap: "anywhere",
                padding: "9px 11px",
                borderRadius: 8,
                background: "rgba(255,255,255,0.03)",
                border: `1px solid ${COLORS.border}`,
                marginBottom: 8,
              }}>
                {webhookUrl}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleCopyWebhookUrl()}
                style={{ whiteSpace: "nowrap", marginBottom: 12 }}
              >
                <LinkSimple size={12} />
                {webhookUrlCopied ? "Copied" : "Copy the webhook URL"}
              </Button>
            </>
          ) : null}

          <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "15px", marginBottom: 8 }}>
            {webhookSecretStored
              ? "ADE checks every delivery against this secret. Paste a new one here if you re-create the webhook in Linear."
              : "Until you paste the signing secret, ADE drops every delivery from this webhook, so no issue events reach your automations. Linear shows the secret once, when the webhook is created."}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              aria-label="Webhook signing secret"
              placeholder="lin_wh_..."
              value={webhookSecretInput}
              onChange={(e) => setWebhookSecretInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !savingWebhookSecret && webhookSecretInput.trim()) {
                  e.preventDefault();
                  void handleSaveWebhookSecret();
                }
              }}
              style={{
                flex: 1, height: 36, borderRadius: 8,
                background: "rgba(255,255,255,0.03)",
                border: `1px solid ${COLORS.border}`,
                padding: "0 12px", fontSize: 12, fontFamily: MONO_FONT,
                color: COLORS.textPrimary, outline: "none",
                transition: "border-color 0.15s",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = `${LINEAR_BRAND}50`; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.border; }}
            />
            <Button
              size="md"
              variant="outline"
              onClick={() => void handleSaveWebhookSecret()}
              disabled={savingWebhookSecret || !webhookSecretInput.trim()}
              style={{ whiteSpace: "nowrap" }}
            >
              {savingWebhookSecret
                ? <CircleNotch size={12} className="animate-spin" />
                : webhookSecretStored ? "Replace the secret" : "Save the secret"}
            </Button>
          </div>
          <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: "15px", marginTop: 8 }}>
            Stored in this machine's keychain, namespaced to this plugin.
          </div>
          {webhookError ? (
            <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: "15px", marginTop: 10 }}>
              {webhookError}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Error ── */}
      {error ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 14px", borderRadius: 10,
          background: "color-mix(in srgb, var(--color-error) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--color-error) 20%, transparent)",
          fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: "17px",
        }}>
          <XCircle size={14} weight="fill" style={{ flexShrink: 0 }} />
          {error}
        </div>
      ) : null}

      {/* ── Feature Preview ── */}
      <div style={{
        padding: 18,
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 14,
      }}>
        <div style={{ ...LABEL_STYLE, fontSize: 10, marginBottom: 12, letterSpacing: "0.06em" }}>
          WHAT LINEAR INTEGRATION ENABLES
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div key={title} style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "10px 12px",
              background: `${LINEAR_BRAND}06`,
              borderRadius: 10,
              border: `1px solid ${LINEAR_BRAND}12`,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                background: `${LINEAR_BRAND}14`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Icon size={14} weight="duotone" style={{ color: LINEAR_BRAND }} />
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 2 }}>
                  {title}
                </div>
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "15px" }}>
                  {desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
