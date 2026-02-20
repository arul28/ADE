import React, { useEffect, useState } from "react";
import type { GitHubStatus } from "../../../shared/types";
import { Button } from "../ui/Button";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function GitHubSection() {
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubTokenDraft, setGithubTokenDraft] = useState("");
  const [githubBusy, setGithubBusy] = useState(false);
  const [prPollingIntervalDraft, setPrPollingIntervalDraft] = useState("25");
  const [prPollingBusy, setPrPollingBusy] = useState(false);
  const [autoRebaseDraft, setAutoRebaseDraft] = useState(false);
  const [autoRebaseBusy, setAutoRebaseBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    window.ade.projectConfig
      .get()
      .then((snapshot) => {
        if (!cancelled) {
          const localSeconds = typeof snapshot.local.github?.prPollingIntervalSeconds === "number" ? snapshot.local.github.prPollingIntervalSeconds : null;
          const effectiveSeconds =
            typeof snapshot.effective.github?.prPollingIntervalSeconds === "number" ? snapshot.effective.github.prPollingIntervalSeconds : null;
          const seconds = localSeconds ?? effectiveSeconds ?? 25;
          setPrPollingIntervalDraft(String(seconds));
          const localAutoRebase = typeof snapshot.local.git?.autoRebaseOnHeadChange === "boolean" ? snapshot.local.git.autoRebaseOnHeadChange : null;
          const effectiveAutoRebase =
            typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean" ? snapshot.effective.git.autoRebaseOnHeadChange : null;
          setAutoRebaseDraft(localAutoRebase ?? effectiveAutoRebase ?? false);
        }
      })
      .catch(() => {});

    window.ade.github
      .getStatus()
      .then((status) => {
        if (!cancelled) setGithubStatus(status);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshConfigState = async () => {
    const snapshot = await window.ade.projectConfig.get();
    const localSeconds = typeof snapshot.local.github?.prPollingIntervalSeconds === "number" ? snapshot.local.github.prPollingIntervalSeconds : null;
    const effectiveSeconds =
      typeof snapshot.effective.github?.prPollingIntervalSeconds === "number" ? snapshot.effective.github.prPollingIntervalSeconds : null;
    setPrPollingIntervalDraft(String(localSeconds ?? effectiveSeconds ?? 25));
    const localAutoRebase = typeof snapshot.local.git?.autoRebaseOnHeadChange === "boolean" ? snapshot.local.git.autoRebaseOnHeadChange : null;
    const effectiveAutoRebase =
      typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean" ? snapshot.effective.git.autoRebaseOnHeadChange : null;
    setAutoRebaseDraft(localAutoRebase ?? effectiveAutoRebase ?? false);
  };

  const savePrPollingSettings = async () => {
    setActionError(null);
    setSaveNotice(null);

    const raw = prPollingIntervalDraft.trim();
    const snapshot = await window.ade.projectConfig.get();
    const currentGithub = isRecord(snapshot.local.github) ? snapshot.local.github : {};
    const nextGithub: Record<string, unknown> = { ...currentGithub };

    if (!raw.length) {
      delete nextGithub.prPollingIntervalSeconds;
    } else {
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        setActionError("PR polling interval must be a positive number of seconds.");
        return;
      }
      if (seconds < 5 || seconds > 300) {
        setActionError("PR polling interval must be between 5 and 300 seconds.");
        return;
      }
      nextGithub.prPollingIntervalSeconds = seconds;
    }

    setPrPollingBusy(true);
    try {
      const nextLocal = {
        ...snapshot.local,
        ...(Object.keys(nextGithub).length ? { github: nextGithub } : {})
      };
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: nextLocal
      });

      await refreshConfigState();
      setSaveNotice("PR polling settings saved to .ade/local.yaml.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPrPollingBusy(false);
    }
  };

  const saveAutoRebaseSettings = async () => {
    setActionError(null);
    setSaveNotice(null);
    setAutoRebaseBusy(true);
    try {
      const snapshot = await window.ade.projectConfig.get();
      const currentGit = isRecord(snapshot.local.git) ? snapshot.local.git : {};
      const nextGit: Record<string, unknown> = {
        ...currentGit,
        autoRebaseOnHeadChange: autoRebaseDraft
      };
      const nextLocal = {
        ...snapshot.local,
        git: nextGit
      };
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: nextLocal
      });
      await refreshConfigState();
      setSaveNotice("Auto-rebase settings saved to .ade/local.yaml.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutoRebaseBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {saveNotice ? (
        <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {saveNotice}
        </div>
      ) : null}
      {actionError ? (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{actionError}</div>
      ) : null}

      <div className="rounded-lg border border-border bg-card/70 p-3">
        <div className="text-xs text-muted-fg">GitHub (Local Token)</div>
        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
          <input
            type="password"
            className="h-9 rounded border border-border bg-bg px-3 text-sm md:col-span-2"
            placeholder="GitHub token (PAT)"
            value={githubTokenDraft}
            onChange={(e) => setGithubTokenDraft(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={githubBusy}
              onClick={() => {
                const token = githubTokenDraft.trim();
                if (!token) {
                  setActionError("GitHub token is empty.");
                  return;
                }
                setGithubBusy(true);
                setActionError(null);
                window.ade.github
                  .setToken(token)
                  .then((status) => {
                    setGithubStatus(status);
                    setGithubTokenDraft("");
                    setSaveNotice("GitHub token saved.");
                  })
                  .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setGithubBusy(false));
              }}
            >
              Save Token
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={githubBusy}
              onClick={() => {
                setGithubBusy(true);
                setActionError(null);
                window.ade.github
                  .clearToken()
                  .then((status) => {
                    setGithubStatus(status);
                    setSaveNotice("GitHub token cleared.");
                  })
                  .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setGithubBusy(false));
              }}
            >
              Clear
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={githubBusy}
              onClick={() => {
                setGithubBusy(true);
                setActionError(null);
                window.ade.github
                  .getStatus()
                  .then((status) => setGithubStatus(status))
                  .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setGithubBusy(false));
              }}
            >
              Refresh
            </Button>
          </div>
        </div>
        <div className="mt-2 rounded border border-border bg-bg/40 px-3 py-2 text-xs text-muted-fg">
          <div>token stored: {githubStatus?.tokenStored ? "yes" : "no"}</div>
          <div>repo: {githubStatus?.repo ? `${githubStatus.repo.owner}/${githubStatus.repo.name}` : "unknown"}</div>
          <div>user: {githubStatus?.userLogin ?? "unknown"}</div>
          <div>scopes: {(githubStatus?.scopes ?? []).join(", ") || "unknown"}</div>
          <div>checked: {githubStatus?.checkedAt ?? "never"}</div>
        </div>
        <div className="mt-2 text-xs text-muted-fg">
          Token is encrypted using OS secure storage and stored locally under `.ade/`.
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card/70 p-3">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">PR Polling</div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={5}
            max={300}
            className="h-8 w-[120px] rounded border border-border bg-bg px-2 text-xs outline-none focus:border-accent"
            value={prPollingIntervalDraft}
            onChange={(e) => setPrPollingIntervalDraft(e.target.value)}
          />
          <span className="text-[11px] text-muted-fg">seconds</span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" disabled={prPollingBusy} onClick={() => void savePrPollingSettings()}>
              {prPollingBusy ? "Saving..." : "Save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={prPollingBusy}
              onClick={() => {
                window.ade.projectConfig
                  .get()
                  .then((snapshot) => {
                    const localSeconds =
                      typeof snapshot.local.github?.prPollingIntervalSeconds === "number" ? snapshot.local.github.prPollingIntervalSeconds : null;
                    const effectiveSeconds =
                      typeof snapshot.effective.github?.prPollingIntervalSeconds === "number"
                        ? snapshot.effective.github.prPollingIntervalSeconds
                        : null;
                    setPrPollingIntervalDraft(String(localSeconds ?? effectiveSeconds ?? 25));
                  })
                  .catch(() => {});
              }}
            >
              Reset
            </Button>
          </div>
        </div>
        <div className="mt-1 text-[11px] text-muted-fg">
          Controls background PR refresh and notifications. Default is 25s; higher values reduce GitHub API usage.
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card/70 p-3">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">Lane Auto-Rebase</div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoRebaseDraft}
            onChange={(e) => setAutoRebaseDraft(e.target.checked)}
          />
          <span className="text-xs">Automatically rebase dependent lanes when a parent/main lane advances.</span>
        </label>
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button size="sm" disabled={autoRebaseBusy} onClick={() => void saveAutoRebaseSettings()}>
            {autoRebaseBusy ? "Saving..." : "Save"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={autoRebaseBusy}
            onClick={() => {
              window.ade.projectConfig
                .get()
                .then((snapshot) => {
                  const localAutoRebase =
                    typeof snapshot.local.git?.autoRebaseOnHeadChange === "boolean"
                      ? snapshot.local.git.autoRebaseOnHeadChange
                      : null;
                  const effectiveAutoRebase =
                    typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean"
                      ? snapshot.effective.git.autoRebaseOnHeadChange
                      : null;
                  setAutoRebaseDraft(localAutoRebase ?? effectiveAutoRebase ?? false);
                })
                .catch(() => {});
            }}
          >
            Reset
          </Button>
        </div>
        <div className="mt-1 text-[11px] text-muted-fg">
          If conflicts are predicted, ADE will not rewrite that lane and will mark it for manual rebase.
        </div>
      </div>
    </div>
  );
}
