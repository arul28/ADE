import React from "react";
import { ArrowSquareOut, Link as LinkIcon, X } from "@phosphor-icons/react";

import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import type {
  AppNavigationRequest,
  RecentProjectSummary,
} from "../../../shared/types";

type Candidate = {
  repoOwner: string;
  repoName: string;
  prNumber: number | null;
};

/**
 * Watches inbound PR navigation requests. When the requested PR's repo
 * (owner/name) doesn't match the currently active project's GitHub remote,
 * surfaces a banner offering to switch to a matching recent project.
 *
 * The PRs page itself still renders normally — this banner is purely a
 * convenience nudge for the cross-machine PR deeplink case.
 */
export function CrossRepoPrBanner(): React.ReactElement | null {
  const [candidate, setCandidate] = React.useState<Candidate | null>(null);
  const [activeRepo, setActiveRepo] = React.useState<{
    owner: string;
    name: string;
  } | null>(null);
  const [matchingProject, setMatchingProject] = React.useState<
    RecentProjectSummary | null
  >(null);

  // Subscribe to navigation events, filtering for cross-repo PR targets.
  React.useEffect(() => {
    const onNavigate = window.ade?.app?.onNavigate;
    if (!onNavigate) return;
    return onNavigate((request: AppNavigationRequest) => {
      const target = request.target;
      if (target.kind !== "pr") return;
      if (!target.repoOwner || !target.repoName) return;
      setCandidate({
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        prNumber: target.prNumber ?? null,
      });
    });
  }, []);

  // Resolve the active project's GitHub repo lazily when a candidate arrives.
  React.useEffect(() => {
    if (!candidate) return;
    let cancelled = false;
    const getStatus = window.ade?.github?.getRemoteStatus;
    if (typeof getStatus !== "function") return;
    void getStatus()
      .then((status) => {
        if (cancelled) return;
        setActiveRepo(status.repo ? { owner: status.repo.owner, name: status.repo.name } : null);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveRepo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [candidate]);

  // When we know both the candidate and the active repo, decide whether to
  // show the banner and find a matching recent project to offer.
  React.useEffect(() => {
    if (!candidate) {
      setMatchingProject(null);
      return;
    }
    if (
      activeRepo &&
      activeRepo.owner.toLowerCase() === candidate.repoOwner.toLowerCase() &&
      activeRepo.name.toLowerCase() === candidate.repoName.toLowerCase()
    ) {
      // Same repo — no banner needed, the PRs page renders normally.
      setCandidate(null);
      return;
    }
    // Reset stale matching-project from a previous candidate while the new
    // listRecent lookup is in flight — avoids briefly rendering
    // "Switch to <old project>" alongside the new repo label.
    setMatchingProject(null);
    let cancelled = false;
    const listRecent = window.ade?.project?.listRecent;
    if (typeof listRecent !== "function") return;
    const wantedOwner = candidate.repoOwner.toLowerCase();
    const wantedName = candidate.repoName.toLowerCase();
    const wanted = `${wantedOwner}/${wantedName}`;
    void listRecent()
      .then((recents) => {
        if (cancelled) return;
        const match = recents.find((entry) => {
          if (!entry.exists) return false;
          const root = entry.rootPath.toLowerCase();
          const display = entry.displayName.toLowerCase();
          return (
            root.endsWith(`/${wanted}`) ||
            root.endsWith(`\\${wanted}`) ||
            root.endsWith(`/${wantedName}`) ||
            root.endsWith(`\\${wantedName}`) ||
            display === wantedName ||
            display === wanted
          );
        }) ?? null;
        setMatchingProject(match);
      })
      .catch(() => {
        if (cancelled) return;
        setMatchingProject(null);
      });
    return () => {
      cancelled = true;
    };
  }, [candidate, activeRepo]);

  if (!candidate) return null;

  const dismiss = () => {
    setCandidate(null);
    setMatchingProject(null);
  };

  const switchProject = async () => {
    if (!matchingProject) {
      dismiss();
      return;
    }
    const openRepo = window.ade?.project?.openRepo;
    if (typeof openRepo === "function") {
      try {
        await openRepo({ rootPath: matchingProject.rootPath });
      } catch {
        // ignore; user can retry from the recent-projects UI
      }
    }
    dismiss();
  };

  const repoLabel = `${candidate.repoOwner}/${candidate.repoName}`;
  const prLabel = candidate.prNumber ? `PR #${candidate.prNumber}` : "PR";

  return (
    <div
      style={{
        position: "fixed",
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 140,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderRadius: 999,
        background: COLORS.cardBgSolid,
        border: `1px solid ${COLORS.border}`,
        boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
        fontFamily: SANS_FONT,
        fontSize: 12,
        color: COLORS.textPrimary,
        maxWidth: "min(640px, calc(100vw - 28px))",
      }}
    >
      <LinkIcon size={14} weight="bold" />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {prLabel} is in <strong>{repoLabel}</strong>
        {activeRepo ? `, not ${activeRepo.owner}/${activeRepo.name}` : ""}.
      </span>
      {matchingProject ? (
        <button
          type="button"
          onClick={() => void switchProject()}
          style={{
            padding: "4px 10px",
            borderRadius: 999,
            border: "none",
            background: "var(--color-accent, #6ee7b7)",
            color: "var(--color-bg, #0a0a0a)",
            fontWeight: 600,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <ArrowSquareOut size={11} /> Switch to {matchingProject.displayName}
        </button>
      ) : (
        <span style={{ color: COLORS.textSecondary, fontSize: 11 }}>
          No matching recent project — open it from Recent Projects first.
        </span>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          padding: 4,
          borderRadius: 999,
          border: "none",
          background: "transparent",
          color: COLORS.textSecondary,
          cursor: "pointer",
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
