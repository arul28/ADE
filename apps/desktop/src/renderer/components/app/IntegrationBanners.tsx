import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloudSlash, GithubLogo, Robot } from "@phosphor-icons/react";
import type { NavigateFunction } from "react-router-dom";
import type {
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubStatus,
  PrEventPayload,
  SyncRouteHealth,
} from "../../../shared/types";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import {
  deriveGithubAccountAuthState,
  deriveGithubRealtimeBlock,
  deriveGithubRepoConnectionState,
  describeGithubCliBanner,
  describeGithubOutage,
  githubStatusHasWriteCredential,
  githubAccountIssueCopy,
  githubRepoIssueCopy,
  isGithubAppUserAuthSupported,
} from "../../lib/githubIntegrationStatus";
import { settingsRouteFor } from "../settings/settingsManifest";
import { useBannerDismissals } from "../../lib/bannerDismiss";
import {
  APP_BANNER_PRIORITY,
  useAppBanners,
  type AppBannerOptions,
  type BannerModel,
  type NoticeAction,
} from "../ui/notice";

/**
 * Computes ADE's connection/health banners and registers them with the app
 * banner host (`AppBannerHost`), which owns order, cap and dismissal.
 *
 * Renders nothing itself. It owns the data: the GitHub App signals (account
 * authorization + per-repo installation) fetched here directly, the gh-CLI/token
 * and missing-AI-provider state passed down from AppShell, and the relay leg of
 * this machine's sync health. It stays mounted only inside an open project, so
 * every banner it raises is project scoped and leaves with the project.
 */

export type RelayRouteHealth = SyncRouteHealth["relay"];

export type IntegrationBannersProps = {
  currentProjectRoot: string | null;
  githubStatus: GitHubStatus | null;
  hasAnyAiProvider: boolean;
  aiStatusLoaded: boolean;
  /**
   * Relay leg of this machine's sync route health, pushed down from AppShell's
   * `sync-status` subscription. `null` until the first snapshot lands — the
   * relay banner stays silent in that window rather than guessing.
   */
  relayHealth: RelayRouteHealth | null;
  navigate: NavigateFunction;
};

// Derived from the settings manifest, never hand-written: these CTAs must land
// on the card that actually owns the setting, wherever the manifest has moved it.
const GITHUB_CONNECTION_SETTINGS_ROUTE = settingsRouteFor("integrations.github");
const AI_SETTINGS_ROUTE = settingsRouteFor("agents.providers");

const GITHUB_ICON = <GithubLogo size={13} weight="fill" />;
const RELAY_ICON = <CloudSlash size={13} weight="fill" />;
const AI_ICON = <Robot size={13} weight="fill" />;

/**
 * How long the relay control has to stay down before we say anything. Relay
 * drops and redials constantly (sleep/wake, Wi-Fi hops, worker deploys); a
 * banner on every blip would be noise. Two minutes of UNINTERRUPTED outage is
 * past every normal reconnect.
 */
const RELAY_OUTAGE_GRACE_MS = 120_000;

export type RelayOutageState = "suppressed" | "down";

/**
 * Decide whether the relay leg is in a state worth telling the user about.
 *
 * `relayControlSuppressed` is immediate: it means this process deliberately
 * stopped redialing because another ADE process on this machine claimed the
 * same machineKey. Nothing recovers that on its own, so a grace period would
 * only delay the fix.
 *
 * Everything else is measured from `relayControlFailingSinceMs` — the start of
 * the CURRENT uninterrupted outage. `lastFailureAt` deliberately isn't used: it
 * restamps on every retry, so it can never measure how long relay has been down.
 */
export function deriveRelayOutageState(
  relay: RelayRouteHealth | null | undefined,
  nowMs: number,
): RelayOutageState | null {
  if (!relay) return null;
  if (relay.enabled !== true) return null;
  if (relay.relayControlConnected === true) return null;
  if (relay.relayControlSuppressed === true) return "suppressed";
  const failingSince = relay.relayControlFailingSinceMs;
  if (failingSince == null) return null;
  return nowMs - failingSince > RELAY_OUTAGE_GRACE_MS ? "down" : null;
}

/**
 * Milliseconds until an ongoing outage becomes reportable, or null when no
 * deadline is pending. Shares the predicate above so the timer and the banner
 * can never disagree about what counts as an outage.
 */
export function relayGraceRemainingMs(
  relay: RelayRouteHealth | null | undefined,
  nowMs: number,
): number | null {
  if (deriveRelayOutageState(relay, nowMs) != null) return null;
  const failingSince = relay?.relayControlFailingSinceMs;
  if (relay?.enabled !== true || relay.relayControlConnected === true || failingSince == null) {
    return null;
  }
  const remaining = RELAY_OUTAGE_GRACE_MS - (nowMs - failingSince);
  return remaining > 0 ? remaining : null;
}

export function IntegrationBanners({
  currentProjectRoot,
  githubStatus,
  hasAnyAiProvider,
  aiStatusLoaded,
  relayHealth,
  navigate,
}: IntegrationBannersProps): null {
  const dismissals = useBannerDismissals();

  const [appInstall, setAppInstall] = useState<GitHubAppInstallationStatus | null>(null);
  const [appAuth, setAppAuth] = useState<GitHubAppUserAuthStatus | null>(null);
  const [appStatusLoaded, setAppStatusLoaded] = useState(false);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  // Bind a completed App-status read to the project it was for. On a direct
  // project switch the reset effect runs after React has already painted with
  // the new `currentProjectRoot` but the previous project's appInstall/appAuth;
  // gating on loadedRoot === currentProjectRoot prevents that stale one-frame flash.
  const currentRootRef = useRef<string | null>(currentProjectRoot);
  currentRootRef.current = currentProjectRoot;
  const [loadedRoot, setLoadedRoot] = useState<string | null>(null);

  // Fetch the two independent GitHub App axes (per-repo install + account token).
  // Mirrors GitHubAppInstallPanel.loadStatus: read auth AFTER the install check,
  // since an expired token can be cleared during that check.
  const loadAppStatus = useCallback(async (forceRefresh = false) => {
    const api = window.ade?.github;
    if (!api?.getAppInstallationStatus) return;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    const isCurrent = () => mountedRef.current && seqRef.current === seq;
    try {
      const install = await api.getAppInstallationStatus({ forceRefresh });
      if (!isCurrent()) return;
      setAppInstall(install);
    } catch {
      if (!isCurrent()) return;
      setAppInstall(null);
    }
    try {
      const auth = (await api.getAppUserAuthStatus?.()) ?? null;
      if (!isCurrent()) return;
      setAppAuth(auth);
    } catch {
      if (!isCurrent()) return;
      setAppAuth(null);
    }
    if (isCurrent()) {
      setLoadedRoot(currentRootRef.current);
      setAppStatusLoaded(true);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  // Reload when the project changes; hide the App block until the fresh read lands
  // so a previous repo's state can't leak across a switch.
  useEffect(() => {
    setAppStatusLoaded(false);
    void loadAppStatus(false);
  }, [currentProjectRoot, loadAppStatus]);

  // Coalesced refresh on PR/GitHub activity — cheap, and seq-guarded against stale
  // responses. Both subscriptions are optional (browser-mock / tests may omit them).
  //
  // PR events barely ever change App install/auth status, and each focus reconcile
  // emits a running+idle `pr-reconcile` pair (plus prs-updated bursts), so a forced
  // refetch per event hammered the relay. We now ignore `pr-reconcile` entirely and
  // debounce the rest into a single NON-forced (cache-served) read. `onStatusChanged`
  // stays an immediate forced refresh — that's the real GitHub-state trigger.
  const prRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const disposers: Array<() => void> = [];
    const onPrEvent = (event: PrEventPayload) => {
      // Reconcile progress pings never carry App install/auth changes — skip them
      // so a focus reconcile doesn't trigger two forced status calls.
      if (event?.type === "pr-reconcile") return;
      if (prRefreshTimerRef.current != null) clearTimeout(prRefreshTimerRef.current);
      prRefreshTimerRef.current = setTimeout(() => {
        prRefreshTimerRef.current = null;
        void loadAppStatus(false);
      }, 1_500);
    };
    const offPrs = window.ade?.prs?.onEvent?.(onPrEvent);
    if (offPrs) disposers.push(offPrs);
    const offGithub = window.ade?.github?.onStatusChanged?.(() => void loadAppStatus(true));
    if (offGithub) disposers.push(offGithub);
    return () => {
      if (prRefreshTimerRef.current != null) {
        clearTimeout(prRefreshTimerRef.current);
        prRefreshTimerRef.current = null;
      }
      for (const dispose of disposers) dispose();
    };
  }, [loadAppStatus]);

  // Relay outage crosses its grace threshold on wall-clock time, not on an
  // incoming event, so nothing would re-render us at the two-minute mark. Arm a
  // SINGLE timer for exactly the remaining grace and let it fire once. No
  // polling: while relay is healthy, suppressed, or already past the threshold,
  // no timer exists at all.
  const [relayGraceTick, setRelayGraceTick] = useState(0);
  useEffect(() => {
    const remaining = relayGraceRemainingMs(relayHealth, Date.now());
    if (remaining == null) return;
    const timer = setTimeout(() => setRelayGraceTick((tick) => tick + 1), remaining + 250);
    return () => clearTimeout(timer);
  }, [relayHealth, relayGraceTick]);

  // Not a memo: the input is the wall clock. `relayGraceTick` exists only to
  // force the re-render when the grace timer fires. The result is a string or
  // null, so downstream dep lists stay stable.
  const relayOutage = deriveRelayOutageState(relayHealth, Date.now());

  // Clear-on-recovery: when a banner's underlying condition is HEALTHY, drop any
  // dismissal recorded for it so a later regression to the SAME state resurfaces a
  // fresh banner instead of staying suppressed under the stale fingerprint for the
  // rest of the grace window. Only ever touches keys for the CURRENT context.
  const { clear: clearDismissal } = dismissals;
  useEffect(() => {
    if (!currentProjectRoot) return;
    if (appStatusLoaded && loadedRoot === currentProjectRoot) {
      const account = deriveGithubAccountAuthState(appAuth);
      const repo = deriveGithubRepoConnectionState(appInstall, account);
      if (account === "valid") clearDismissal("github-app-account");
      if (repo === "connected") {
        const repoKey = appInstall?.repo ? `${appInstall.repo.owner}/${appInstall.repo.name}` : currentProjectRoot;
        clearDismissal(`github-app-repo:${repoKey}`);
      }
    }
    if (githubStatus?.connected && githubStatusHasWriteCredential(githubStatus)) {
      clearDismissal(`github-cli:${currentProjectRoot}`);
    }
    if (hasAnyAiProvider) clearDismissal(`ai-provider:${currentProjectRoot}`);
    if (relayOutage == null) clearDismissal("relay-offline");
    if (!describeGithubOutage(githubStatus)) clearDismissal("github-outage");
  }, [
    currentProjectRoot,
    relayOutage,
    appStatusLoaded,
    appAuth,
    appInstall,
    githubStatus,
    hasAnyAiProvider,
    clearDismissal,
    loadedRoot,
  ]);

  const models = useMemo<BannerModel[]>(() => {
    const list: BannerModel[] = [];

    // 0) GitHub outage (NEW). When GitHub's own status page confirms an
    // incident on a surface ADE uses, every GitHub banner below is a symptom of
    // the SAME cause and would read as three separate accusations against the
    // user's setup. Collapse them into one honest notice and stop offering
    // fixes that cannot work — re-authorizing during a GitHub outage is how a
    // user destroys a credential that was never broken.
    const outage = describeGithubOutage(githubStatus);
    if (currentProjectRoot && outage) {
      list.push({
        id: "github-outage",
        // Informational: nothing here is the user's to fix, and it clears on
        // its own. An error/warning tone would imply an action they don't have.
        tone: "info",
        icon: GITHUB_ICON,
        title: outage.title,
        detail: outage.detail,
        actions: [
          {
            label: outage.action,
            variant: "primary",
            href: outage.actionUrl,
          },
        ],
        // Outages are machine-wide, not per-project. Fingerprinted on the
        // affected surfaces so a widening incident resurfaces a dismissed banner.
        dismiss: { key: "github-outage", fingerprint: outage.fingerprint },
      });
    }
    // Suppresses ONLY the GitHub-derived banners below. The AI-provider, mock-
    // provider, and relay banners have nothing to do with GitHub and stay.
    // Gated on the same condition that renders the outage banner, so the GitHub
    // family can never be silenced without its replacement being shown.
    const githubSuppressed = currentProjectRoot != null && outage != null;

    // 1) GitHub App real-time block (NEW). Only once a real read has landed FOR
    // the current project (loadedRoot === currentProjectRoot), so an unloaded/
    // absent API never masquerades as "not authorized" and a project switch
    // can't paint the previous repo's state. Also require the runtime App-status
    // DTOs: the standalone web-client adapter returns stubs, and treating a stub
    // as loaded would flash a false "not authorized" banner on every hosted-web
    // project. The auth stub says so itself (`isGithubAppUserAuthSupported`);
    // the install stub is still detected by the fields it omits.
    const rawInstall = appInstall as Record<string, unknown> | null;
    // A real status from a host that implements the call. `null` is neither.
    const authDtoIsReal = appAuth != null && isGithubAppUserAuthSupported(appAuth);
    const githubAppStatusSupported =
      !!rawInstall
      && typeof rawInstall.appName === "string"
      && typeof rawInstall.relayConfigured === "boolean"
      && authDtoIsReal;
    if (!githubSuppressed && appStatusLoaded && currentProjectRoot && loadedRoot === currentProjectRoot && githubAppStatusSupported) {
      const account = deriveGithubAccountAuthState(appAuth);
      const repo = deriveGithubRepoConnectionState(appInstall, account);
      const block = deriveGithubRealtimeBlock(account, repo);
      if (block?.kind === "account") {
        const copy = githubAccountIssueCopy(block.account);
        list.push({
          id: "github-app-account",
          tone: "warning",
          icon: GITHUB_ICON,
          title: copy.title,
          detail: copy.detail,
          actions: [
            {
              label: copy.action,
              variant: "primary",
              onClick: () => navigate(GITHUB_CONNECTION_SETTINGS_ROUTE),
            },
          ],
          // Account (App user-token) auth is machine/account-wide, so its dismiss
          // key is global — a per-project key would leave a stale dismissal in one
          // project suppressing the same account warning after a cross-project regress.
          dismiss: { key: "github-app-account", fingerprint: block.account },
        });
      } else if (block?.kind === "repo") {
        const repoLabel = appInstall?.repo ? `${appInstall.repo.owner}/${appInstall.repo.name}` : null;
        const copy = githubRepoIssueCopy(block.repo, repoLabel);
        const actions: NoticeAction[] = [];
        if (block.repo === "access_pending") {
          // Matches the Settings panel: access is still propagating from GitHub,
          // so the action is to re-check status, not Install/Manage.
          actions.push({ label: copy.action, variant: "primary", onClick: () => void loadAppStatus(true) });
        } else if (block.repo === "webhook_off") {
          // App is installed but webhook delivery isn't wired — send the user to
          // Manage (to reconnect the webhook) and let them Recheck afterward.
          const manageUrl = appInstall?.manageUrl;
          if (manageUrl) {
            actions.push({ label: "Manage", variant: "primary", href: manageUrl });
          }
          actions.push({ label: "Recheck", variant: "secondary", onClick: () => void loadAppStatus(true) });
        } else {
          const installUrl = appInstall?.installUrl;
          const manageUrl = appInstall?.manageUrl;
          if (installUrl) {
            actions.push({ label: "Install", variant: "primary", href: installUrl });
          }
          if (manageUrl) {
            actions.push({ label: "Manage", variant: "secondary", href: manageUrl });
          }
        }
        const repoKey = repoLabel ?? currentProjectRoot;
        list.push({
          id: "github-app-repo",
          tone: "warning",
          icon: GITHUB_ICON,
          title: copy.title,
          detail: copy.detail,
          actions,
          dismiss: { key: `github-app-repo:${repoKey}`, fingerprint: block.repo },
        });
      }
    }

    // 2) gh CLI / PAT not connected (MIGRATED). A DISTINCT concern from the App
    // block: this is the token ADE uses for git & PR operations, not webhooks.
    // An unreadable credential store pierces the outage suppression: it is a
    // local, repairable fact that outlives any GitHub incident, and this banner
    // is the discovery surface for the Repair path — an outage must not hide
    // the one thing the user can actually fix.
    if (
      (!githubSuppressed || githubStatus?.credentialStoreUnreadable === true)
      && currentProjectRoot
      && githubStatus
      && (!githubStatus.connected || !githubStatusHasWriteCredential(githubStatus))
    ) {
      const cli = describeGithubCliBanner(githubStatus);
      list.push({
        id: "github-cli",
        tone: "warning",
        icon: GITHUB_ICON,
        title: cli.title,
        detail: cli.detail,
        actions: [
          {
            label: cli.action,
            variant: "primary",
            // The banner states its own destination: an unreadable credential
            // store is not fixed on the GitHub card, and its Repair control
            // lives in the Connections panel — the same one the relay banner
            // opens.
            onClick: cli.target === "connections"
              ? () => openConnectionsPanel("machines")
              : () => navigate(GITHUB_CONNECTION_SETTINGS_ROUTE),
          },
        ],
        dismiss: { key: `github-cli:${currentProjectRoot}`, fingerprint: cli.subState },
      });
    }

    // 3) No AI provider configured (MIGRATED).
    if (currentProjectRoot && aiStatusLoaded && !hasAnyAiProvider) {
      list.push({
        id: "ai-provider",
        tone: "warning",
        icon: AI_ICON,
        title: "No AI provider configured",
        detail: "Set up an AI provider so ADE can run agents in this project.",
        actions: [{ label: "Set up AI", variant: "primary", onClick: () => navigate(AI_SETTINGS_ROUTE) }],
        dismiss: { key: `ai-provider:${currentProjectRoot}`, fingerprint: "missing" },
      });
    }

    // 4) ADE Relay control is down (NEW). Total relay failure used to be visible
    // only to `ade doctor`: phones and remote clients silently lost their
    // off-LAN path while the UI looked fine. Relay identity is machine-wide, so
    // the dismiss key is global (like github-app-account) rather than
    // project-scoped, and the fingerprint separates the two states so dismissing
    // a plain outage can't hide a later process-conflict.
    if (relayOutage) {
      const reason =
        relayHealth?.relayControlSuppressedReason
        ?? relayHealth?.skipReason
        ?? relayHealth?.lastControlError
        ?? null;
      const suppressed = relayOutage === "suppressed";
      list.push({
        id: "relay-offline",
        tone: "warning",
        icon: RELAY_ICON,
        title: suppressed
          ? "Another ADE process owns this machine's relay connection"
          : "ADE Relay is not connected",
        detail: suppressed
          ? "ADE stopped reconnecting so the two processes don't evict each other. Quit the other ADE app or brain on this machine to get the relay back."
          : (reason
            ?? "Phones and remote machines can't reach this computer over the relay. Local network connections still work."),
        actions: [
          {
            label: "Open connections",
            variant: "primary",
            onClick: () => openConnectionsPanel("machines"),
          },
        ],
        dismiss: { key: "relay-offline", fingerprint: relayOutage },
      });
    }

    return list;
  }, [
    relayOutage,
    relayHealth,
    appStatusLoaded,
    appAuth,
    appInstall,
    currentProjectRoot,
    githubStatus,
    aiStatusLoaded,
    hasAnyAiProvider,
    navigate,
    loadAppStatus,
    loadedRoot,
  ]);

  // The outage notice is deliberately `info` (nothing here is the user's to
  // fix), so tone ordering alone would rank it last and the host's two-slot cap
  // could push it into overflow — while it is still suppressing the GitHub
  // banners, whose complaints would vanish with their explanation hidden behind
  // a toggle. The outage band sorts it ahead of every integration banner. The
  // rest keep the order they are built in: a hair of priority per position
  // stays inside the integration band.
  const registrations = useMemo(
    () =>
      models.map((model, index): { model: BannerModel; options: AppBannerOptions } => ({
        model,
        options: {
          placement: "docked",
          priority: model.id === "github-outage"
            ? APP_BANNER_PRIORITY.outage
            : APP_BANNER_PRIORITY.integration + index / 100,
        },
      })),
    [models],
  );
  useAppBanners(registrations);

  return null;
}
