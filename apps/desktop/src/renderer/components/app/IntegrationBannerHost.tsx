import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { NavigateFunction } from "react-router-dom";
import type {
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubStatus,
  ProviderMode,
} from "../../../shared/types";
import {
  deriveGithubAccountAuthState,
  deriveGithubRealtimeBlock,
  deriveGithubRepoConnectionState,
  describeGithubCliBanner,
  githubAccountIssueCopy,
  githubRepoIssueCopy,
} from "../../lib/githubIntegrationStatus";
import { useBannerDismissals } from "../../lib/bannerDismiss";
import { openExternalUrl } from "../../lib/openExternal";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { Banner, type BannerAction, type BannerModel, type BannerSeverity } from "../shared/Banner";

/**
 * The single host that computes and renders ADE's connection/health banners.
 *
 * This replaces the hand-ordered `? :` banner conditionals that used to live
 * inline in AppShell (each with its own colors and dismiss mechanism). It owns
 * one ordered, severity-ranked, capped list rendered through the shared `Banner`
 * primitive, so the whole family finally reads as one system.
 *
 * The GitHub App signals (account authorization + per-repo installation) are the
 * NEW inputs fetched here directly; the gh-CLI/token, missing-AI-provider, and
 * mock-provider banners are migrated from AppShell.
 */

export type IntegrationBannerHostProps = {
  currentProjectRoot: string | null;
  githubStatus: GitHubStatus | null;
  hasAnyAiProvider: boolean;
  aiStatusLoaded: boolean;
  providerMode: ProviderMode;
  aiMockProvider: boolean;
  navigate: NavigateFunction;
};

const GITHUB_CONNECTION_SETTINGS_ROUTE = "/settings?tab=general#github-connection";
const AI_SETTINGS_ROUTE = "/settings?tab=ai";
const MAX_VISIBLE_BANNERS = 2;
const SEVERITY_RANK: Record<BannerSeverity, number> = { error: 0, warning: 1, info: 2 };

export function IntegrationBannerHost({
  currentProjectRoot,
  githubStatus,
  hasAnyAiProvider,
  aiStatusLoaded,
  providerMode,
  aiMockProvider,
  navigate,
}: IntegrationBannerHostProps): JSX.Element | null {
  const dismissals = useBannerDismissals();
  const [expanded, setExpanded] = useState(false);

  const [appInstall, setAppInstall] = useState<GitHubAppInstallationStatus | null>(null);
  const [appAuth, setAppAuth] = useState<GitHubAppUserAuthStatus | null>(null);
  const [appStatusLoaded, setAppStatusLoaded] = useState(false);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);

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
    if (isCurrent()) setAppStatusLoaded(true);
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
  useEffect(() => {
    const disposers: Array<() => void> = [];
    const refresh = () => {
      void loadAppStatus(true);
    };
    const offPrs = window.ade?.prs?.onEvent?.(refresh);
    if (offPrs) disposers.push(offPrs);
    const offGithub = window.ade?.github?.onStatusChanged?.(() => refresh());
    if (offGithub) disposers.push(offGithub);
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [loadAppStatus]);

  const models = useMemo<BannerModel[]>(() => {
    const list: BannerModel[] = [];

    // 1) GitHub App real-time block (NEW). Only once a real read has landed, so an
    // unloaded/absent API never masquerades as "not authorized".
    if (appStatusLoaded && currentProjectRoot) {
      const account = deriveGithubAccountAuthState(appAuth);
      const repo = deriveGithubRepoConnectionState(appInstall);
      const block = deriveGithubRealtimeBlock(account, repo);
      if (block?.kind === "account") {
        const copy = githubAccountIssueCopy(block.account);
        list.push({
          id: "github-app-account",
          severity: "warning",
          title: copy.title,
          detail: copy.detail,
          actions: [
            {
              label: copy.action,
              variant: "primary",
              onClick: () => navigate(GITHUB_CONNECTION_SETTINGS_ROUTE),
            },
          ],
          dismiss: { key: `github-app-account:${currentProjectRoot}`, fingerprint: block.account },
        });
      } else if (block?.kind === "repo") {
        const repoLabel = appInstall?.repo ? `${appInstall.repo.owner}/${appInstall.repo.name}` : null;
        const copy = githubRepoIssueCopy(block.repo, repoLabel);
        const actions: BannerAction[] = [];
        const installUrl = appInstall?.installUrl;
        const manageUrl = appInstall?.manageUrl;
        if (installUrl) {
          actions.push({ label: "Install", variant: "primary", onClick: () => openExternalUrl(installUrl) });
        }
        if (manageUrl) {
          actions.push({ label: "Manage", variant: "secondary", onClick: () => openExternalUrl(manageUrl) });
        }
        const repoKey = repoLabel ?? currentProjectRoot;
        list.push({
          id: "github-app-repo",
          severity: "warning",
          title: copy.title,
          detail: copy.detail,
          actions,
          dismiss: { key: `github-app-repo:${repoKey}`, fingerprint: block.repo },
        });
      }
    }

    // 2) gh CLI / PAT not connected (MIGRATED). A DISTINCT concern from the App
    // block: this is the token ADE uses for git & PR operations, not webhooks.
    if (currentProjectRoot && githubStatus && !githubStatus.connected) {
      const cli = describeGithubCliBanner(githubStatus);
      list.push({
        id: "github-cli",
        severity: "warning",
        title: cli.title,
        detail: cli.detail,
        actions: [
          {
            label: cli.action,
            variant: "primary",
            onClick: () => navigate(GITHUB_CONNECTION_SETTINGS_ROUTE),
          },
        ],
        dismiss: { key: `github-cli:${currentProjectRoot}`, fingerprint: cli.subState },
      });
    }

    // 3) No AI provider configured (MIGRATED).
    if (currentProjectRoot && aiStatusLoaded && !hasAnyAiProvider) {
      list.push({
        id: "ai-provider",
        severity: "warning",
        title: "No AI provider configured",
        detail: "Set up an AI provider so ADE can run agents in this project.",
        actions: [{ label: "Set up AI", variant: "primary", onClick: () => navigate(AI_SETTINGS_ROUTE) }],
        dismiss: { key: `ai-provider:${currentProjectRoot}`, fingerprint: "missing" },
      });
    }

    // 4) Mock LLM provider (MIGRATED). Guarded on currentProjectRoot like the
    // sibling banners — the host only mounts under a project, so this is always
    // truthy here and the dismiss key is unconditionally project-scoped.
    if (currentProjectRoot && providerMode === "subscription" && aiMockProvider) {
      list.push({
        id: "mock-provider",
        severity: "warning",
        title: "Using a mock LLM provider",
        detail: "AI responses are placeholder content. Switch to a real provider in AI settings.",
        actions: [{ label: "Open AI settings", variant: "primary", onClick: () => navigate(AI_SETTINGS_ROUTE) }],
        dismiss: { key: `mock-provider:${currentProjectRoot}`, fingerprint: "mock" },
      });
    }

    return list;
  }, [
    appStatusLoaded,
    appAuth,
    appInstall,
    currentProjectRoot,
    githubStatus,
    aiStatusLoaded,
    hasAnyAiProvider,
    providerMode,
    aiMockProvider,
    navigate,
  ]);

  const active = useMemo(() => {
    return models
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => !(model.dismiss && dismissals.isDismissed(model.dismiss.key, model.dismiss.fingerprint)))
      .sort((a, b) => SEVERITY_RANK[a.model.severity] - SEVERITY_RANK[b.model.severity] || a.index - b.index)
      .map(({ model }) => model);
  }, [models, dismissals]);

  const handleDismiss = useCallback(
    (d: { key: string; fingerprint: string }) => {
      dismissals.dismiss(d.key, d.fingerprint);
    },
    [dismissals],
  );

  if (active.length === 0) return null;

  const visible = active.slice(0, MAX_VISIBLE_BANNERS);
  const overflow = active.slice(MAX_VISIBLE_BANNERS);

  return (
    <div className="shrink-0 mx-2 mt-1 flex flex-col gap-1.5">
      {visible.map((model) => (
        <Banner key={model.id} model={model} onDismiss={handleDismiss} />
      ))}
      {overflow.length > 0 ? (
        <>
          <button
            type="button"
            style={moreToggleStyle}
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
          >
            <CaretRight
              size={11}
              weight="bold"
              style={{ transition: "transform 120ms ease", transform: expanded ? "rotate(90deg)" : "none" }}
            />
            {expanded
              ? "Hide extra integration issues"
              : `${overflow.length} more integration issue${overflow.length === 1 ? "" : "s"}`}
          </button>
          {expanded
            ? overflow.map((model) => <Banner key={model.id} model={model} onDismiss={handleDismiss} />)
            : null}
        </>
      ) : null}
    </div>
  );
}

const moreToggleStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  alignSelf: "flex-start",
  padding: "2px 4px",
  border: "none",
  background: "transparent",
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 11.5,
  fontWeight: 500,
  cursor: "pointer",
};
