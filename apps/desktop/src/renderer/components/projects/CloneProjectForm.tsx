import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowsClockwise,
  CircleNotch,
  FolderOpen,
  GithubLogo,
  Key,
  LockSimple,
  MagnifyingGlass,
  Warning,
} from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import { extractError } from "../../lib/format";
import type {
  CloneProjectInput,
  CloneProjectResult,
  GitHubStatus,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  MyGitHubRepoSummary,
  ProjectBrowseInput,
  ProjectBrowseResult,
} from "../../../shared/types";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  inlineBadge,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

export type CloneProjectFormProps = {
  onCancel: () => void;
  onCloned: (result: {
    rootPath: string;
    displayName: string;
    projectId?: string;
  }) => void;
  machineName?: string;
  getDefaultParentDir?: () => Promise<string>;
  browseDirectories?: (
    input: ProjectBrowseInput,
  ) => Promise<ProjectBrowseResult>;
  chooseDirectory?:
    | ((args: {
        title: string;
        defaultPath?: string;
      }) => Promise<string | null>)
    | null;
  cloneProject?: (
    input: CloneProjectInput,
  ) => Promise<CloneProjectResult & { projectId?: string }>;
  listMyRepos?: (
    input?: ListMyGitHubReposInput,
  ) => Promise<ListMyGitHubReposResult>;
  allowTokenSetup?: boolean;
};

type Tab = "url" | "my-repos";

const SLUG_PATTERN = /([^/:]+?)(?:\.git)?$/;

// Mirrors the backend `parseGitHubRepoFromRemoteUrl` accepted shapes so the
// UI surfaces a friendly hint before the IPC call would reject with
// `invalid_github_url`.
function isGitHubRepoUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const sshScp = trimmed.match(/^git@github\.com:(.+)$/i);
  if (sshScp) {
    const slug = sshScp[1]!.replace(/\.git$/i, "").trim();
    const [owner, name] = slug.split("/");
    return Boolean(owner && name);
  }
  if (/^(https?|ssh):\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!/github\.com$/i.test(url.hostname)) return false;
      const parts = url.pathname
        .replace(/^\/+/, "")
        .replace(/\.git$/i, "")
        .split("/");
      return Boolean(parts[0]?.trim() && parts[1]?.trim());
    } catch {
      return false;
    }
  }
  return false;
}

const inputStyle: CSSProperties = {
  height: 36,
  padding: "0 12px",
  fontSize: 13,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

function deriveSlug(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const match = trimmed.match(SLUG_PATTERN);
  return match?.[1]?.replace(/\.git$/i, "") ?? "";
}

function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  const sep = parent.includes("\\") ? "\\" : "/";
  const trimmed =
    parent.endsWith("/") || parent.endsWith("\\")
      ? parent.slice(0, -1)
      : parent;
  if (!name) return trimmed;
  return `${trimmed}${sep}${name}`;
}

function relativeFromNow(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function withRepoListDeadline(
  promise: Promise<ListMyGitHubReposResult>,
): Promise<ListMyGitHubReposResult> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(
        new Error(
          "Timed out loading repositories. Check GitHub auth and network access on the selected machine.",
        ),
      );
    }, 15_000);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type ChooseDirectory =
  | ((args: { title: string; defaultPath?: string }) => Promise<string | null>)
  | null;

export function CloneProjectForm({
  onCancel,
  onCloned,
  machineName,
  getDefaultParentDir,
  browseDirectories,
  chooseDirectory,
  cloneProject,
  listMyRepos,
  allowTokenSetup = true,
}: CloneProjectFormProps) {
  const [tab, setTab] = useState<Tab>("url");
  const [defaultParentDir, setDefaultParentDir] = useState<string>("");
  const loadDefaultParentDir =
    getDefaultParentDir ?? window.ade.project.getDefaultParentDir;
  const browse = browseDirectories ?? window.ade.project.browseDirectories;
  const pickDirectory: ChooseDirectory =
    chooseDirectory === undefined
      ? window.ade.project.chooseDirectory
      : chooseDirectory;
  const clone = cloneProject ?? window.ade.project.clone;
  const loadRepos = listMyRepos ?? window.ade.github.listMyRepos;

  useEffect(() => {
    let cancelled = false;
    void loadDefaultParentDir()
      .then((value) => {
        if (cancelled) return;
        setDefaultParentDir(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loadDefaultParentDir]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        width: "100%",
      }}
    >
      <TabBar tab={tab} onChange={setTab} />
      {machineName ? (
        <InlineHint tone="muted">Target: {machineName}</InlineHint>
      ) : null}
      {tab === "url" ? (
        <UrlTab
          defaultParentDir={defaultParentDir}
          browseDirectories={browse}
          chooseDirectory={pickDirectory}
          cloneProject={clone}
          onCancel={onCancel}
          onCloned={onCloned}
        />
      ) : (
        <MyReposTab
          defaultParentDir={defaultParentDir}
          browseDirectories={browse}
          chooseDirectory={pickDirectory}
          cloneProject={clone}
          listMyRepos={loadRepos}
          allowTokenSetup={allowTokenSetup}
          onCancel={onCancel}
          onCloned={onCloned}
        />
      )}
    </div>
  );
}

function TabBar({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 4,
        padding: 4,
        background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        alignSelf: "flex-start",
      }}
    >
      <TabButton active={tab === "url"} onClick={() => onChange("url")}>
        URL
      </TabButton>
      <TabButton
        active={tab === "my-repos"}
        onClick={() => onChange("my-repos")}
      >
        My repos
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 28,
        padding: "0 14px",
        fontSize: 11,
        fontFamily: MONO_FONT,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        background: active ? COLORS.accent : "transparent",
        color: active ? "var(--color-bg)" : COLORS.textSecondary,
        border: "none",
        borderRadius: 6,
        cursor: "pointer",
        transition: "background 140ms ease, color 140ms ease",
      }}
    >
      {children}
    </button>
  );
}

function UrlTab({
  defaultParentDir,
  browseDirectories,
  chooseDirectory,
  cloneProject,
  onCancel,
  onCloned,
}: {
  defaultParentDir: string;
  browseDirectories: (
    input: ProjectBrowseInput,
  ) => Promise<ProjectBrowseResult>;
  chooseDirectory: ChooseDirectory;
  cloneProject: (
    input: CloneProjectInput,
  ) => Promise<CloneProjectResult & { projectId?: string }>;
  onCancel: () => void;
  onCloned: (result: {
    rootPath: string;
    displayName: string;
    projectId?: string;
  }) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [parentDir, setParentDir] = useState("");
  const [pickerPending, setPickerPending] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathExists, setPathExists] = useState(false);

  useEffect(() => {
    if (!parentDir && defaultParentDir) setParentDir(defaultParentDir);
  }, [defaultParentDir, parentDir]);

  const checkRequestRef = useRef(0);

  const trimmedUrl = url.trim();
  const trimmedName = name.trim();
  const urlValid = isGitHubRepoUrl(trimmedUrl);
  const previewPath = useMemo(
    () => (parentDir && trimmedName ? joinPath(parentDir, trimmedName) : ""),
    [parentDir, trimmedName],
  );

  useEffect(() => {
    if (!previewPath) {
      setPathExists(false);
      return;
    }
    const requestId = ++checkRequestRef.current;
    const timeout = window.setTimeout(() => {
      void browseDirectories({ partialPath: previewPath })
        .then((result) => {
          if (checkRequestRef.current !== requestId) return;
          setPathExists(result.exactDirectoryPath === previewPath);
        })
        .catch(() => {
          if (checkRequestRef.current !== requestId) return;
          setPathExists(false);
        });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [browseDirectories, previewPath]);

  const handleUrlBlur = useCallback(() => {
    if (nameTouched) return;
    const slug = deriveSlug(trimmedUrl);
    if (slug) setName(slug);
  }, [nameTouched, trimmedUrl]);

  const handleChooseParent = useCallback(async () => {
    if (!chooseDirectory) return;
    setPickerPending(true);
    setError(null);
    try {
      const selected = await chooseDirectory({
        title: "Choose parent directory",
        defaultPath: parentDir || undefined,
      });
      if (selected) setParentDir(selected);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setPickerPending(false);
    }
  }, [chooseDirectory, parentDir]);

  const canSubmit =
    urlValid &&
    trimmedName.length > 0 &&
    parentDir.length > 0 &&
    !pathExists &&
    !pending;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      const result = await cloneProject({
        url: trimmedUrl,
        parentDir,
        name: trimmedName,
      });
      onCloned({
        rootPath: result.rootPath,
        displayName: trimmedName,
        projectId: result.projectId,
      });
    } catch (err) {
      setError(extractError(err));
    } finally {
      setPending(false);
    }
  }, [canSubmit, cloneProject, onCloned, parentDir, trimmedName, trimmedUrl]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label="REPOSITORY URL">
        <input
          autoFocus
          type="text"
          value={url}
          placeholder="https://github.com/owner/repo"
          onChange={(event) => setUrl(event.target.value)}
          onBlur={handleUrlBlur}
          style={{ ...inputStyle, fontFamily: MONO_FONT, fontSize: 12 }}
          disabled={pending}
        />
        {url.length > 0 && !urlValid ? (
          <InlineHint tone="danger">
            Enter a GitHub URL like https://github.com/owner/repo or
            git@github.com:owner/repo.git
          </InlineHint>
        ) : null}
      </Field>

      <Field label="FOLDER NAME">
        <input
          type="text"
          value={name}
          placeholder="repo"
          onChange={(event) => {
            setName(event.target.value);
            setNameTouched(true);
          }}
          style={inputStyle}
          disabled={pending}
        />
      </Field>

      <Field label="PARENT DIRECTORY">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            value={parentDir}
            onChange={(event) => setParentDir(event.target.value)}
            placeholder="Parent directory"
            style={{
              ...inputStyle,
              fontFamily: MONO_FONT,
              fontSize: 12,
              color: parentDir ? COLORS.textPrimary : COLORS.textMuted,
              flex: 1,
            }}
            title={parentDir}
            disabled={pending}
          />
          {chooseDirectory ? (
            <button
              type="button"
              style={outlineButton({ minWidth: 44 })}
              disabled={pickerPending || pending}
              onClick={() => {
                void handleChooseParent();
              }}
              aria-label="Choose parent directory"
            >
              {pickerPending ? (
                <CircleNotch size={12} weight="bold" className="animate-spin" />
              ) : (
                <FolderOpen size={12} weight="regular" />
              )}
            </button>
          ) : null}
        </div>
      </Field>

      <PathPreview path={previewPath} exists={pathExists} />

      {error ? <InlineHint tone="danger">{error}</InlineHint> : null}

      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 4,
        }}
      >
        <button
          type="button"
          style={outlineButton()}
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="button"
          style={primaryButton({
            opacity: canSubmit ? 1 : 0.55,
            cursor: canSubmit ? "pointer" : "not-allowed",
            minWidth: 110,
          })}
          onClick={() => {
            void handleSubmit();
          }}
          disabled={!canSubmit}
        >
          {pending ? (
            <>
              <CircleNotch size={12} weight="bold" className="animate-spin" />
              Cloning…
            </>
          ) : (
            "Clone"
          )}
        </button>
      </div>
    </div>
  );
}

function MyReposTab({
  defaultParentDir,
  browseDirectories,
  chooseDirectory,
  cloneProject,
  listMyRepos,
  allowTokenSetup,
  onCancel,
  onCloned,
}: {
  defaultParentDir: string;
  browseDirectories: (
    input: ProjectBrowseInput,
  ) => Promise<ProjectBrowseResult>;
  chooseDirectory: ChooseDirectory;
  cloneProject: (
    input: CloneProjectInput,
  ) => Promise<CloneProjectResult & { projectId?: string }>;
  listMyRepos: (
    input?: ListMyGitHubReposInput,
  ) => Promise<ListMyGitHubReposResult>;
  allowTokenSetup: boolean;
  onCancel: () => void;
  onCloned: (result: {
    rootPath: string;
    displayName: string;
    projectId?: string;
  }) => void;
}) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const next = await window.ade.github.getStatus({ forceRefresh: true });
      setStatus(next);
    } catch (err) {
      setStatusError(extractError(err));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowTokenSetup) {
      setStatusLoading(false);
      return;
    }
    void loadStatus();
  }, [allowTokenSetup, loadStatus]);

  if (!allowTokenSetup) {
    return (
      <ConnectedRepoBrowser
        defaultParentDir={defaultParentDir}
        browseDirectories={browseDirectories}
        chooseDirectory={chooseDirectory}
        cloneProject={cloneProject}
        listMyRepos={listMyRepos}
        onCancel={onCancel}
        onCloned={onCloned}
      />
    );
  }

  const isConnected = Boolean(
    status?.connected && !status?.tokenDecryptionFailed,
  );

  if (statusLoading && !status) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "20px 0",
          color: COLORS.textMuted,
          fontSize: 12,
          fontFamily: SANS_FONT,
        }}
      >
        <CircleNotch size={14} weight="bold" className="animate-spin" />
        Checking GitHub connection…
      </div>
    );
  }

  if (!isConnected) {
    return (
      <ConnectGithubPrompt
        statusError={statusError}
        onConnected={() => {
          void loadStatus();
        }}
        onCancel={onCancel}
      />
    );
  }

  return (
    <ConnectedRepoBrowser
      defaultParentDir={defaultParentDir}
      browseDirectories={browseDirectories}
      chooseDirectory={chooseDirectory}
      cloneProject={cloneProject}
      listMyRepos={listMyRepos}
      onCancel={onCancel}
      onCloned={onCloned}
    />
  );
}

function ConnectGithubPrompt({
  statusError,
  onConnected,
  onCancel,
}: {
  statusError: string | null;
  onConnected: () => void;
  onCancel: () => void;
}) {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Enter a token");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await window.ade.github.setToken(trimmed);
      onConnected();
    } catch (err) {
      setError(extractError(err));
    } finally {
      setPending(false);
    }
  }, [onConnected, token]);

  return (
    <div
      style={cardStyle({
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      })}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            borderRadius: 8,
            background:
              "color-mix(in srgb, var(--color-accent) 15%, transparent)",
            color: COLORS.accent,
          }}
        >
          <GithubLogo size={18} weight="fill" />
        </span>
        <div>
          <div
            style={{
              fontFamily: SANS_FONT,
              fontSize: 14,
              fontWeight: 600,
              color: COLORS.textPrimary,
            }}
          >
            Connect GitHub to browse your repos
          </div>
          <div
            style={{
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textMuted,
              marginTop: 2,
            }}
          >
            Run gh auth login, then retry. You can also paste a personal access token.
          </div>
        </div>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ ...LABEL_STYLE, letterSpacing: "0.08em" }}>
          PERSONAL ACCESS TOKEN
        </span>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="ghp_... or github_pat_..."
          style={{ ...inputStyle, fontFamily: MONO_FONT, fontSize: 12 }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !pending) {
              event.preventDefault();
              void handleSave();
            }
          }}
          disabled={pending}
        />
      </label>

      {error || statusError ? (
        <InlineHint tone="danger">{error ?? statusError}</InlineHint>
      ) : null}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          style={outlineButton()}
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="button"
          style={primaryButton({ minWidth: 130 })}
          onClick={() => {
            void handleSave();
          }}
          disabled={pending || token.trim().length === 0}
        >
          {pending ? (
            <>
              <CircleNotch size={12} weight="bold" className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Key size={12} weight="bold" />
              Save token
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function ConnectedRepoBrowser({
  defaultParentDir,
  browseDirectories,
  chooseDirectory,
  cloneProject,
  listMyRepos,
  onCancel,
  onCloned,
}: {
  defaultParentDir: string;
  browseDirectories: (
    input: ProjectBrowseInput,
  ) => Promise<ProjectBrowseResult>;
  chooseDirectory: ChooseDirectory;
  cloneProject: (
    input: CloneProjectInput,
  ) => Promise<CloneProjectResult & { projectId?: string }>;
  listMyRepos: (
    input?: ListMyGitHubReposInput,
  ) => Promise<ListMyGitHubReposResult>;
  onCancel: () => void;
  onCloned: (result: {
    rootPath: string;
    displayName: string;
    projectId?: string;
  }) => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [repos, setRepos] = useState<MyGitHubRepoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFullName, setExpandedFullName] = useState<string | null>(null);

  const requestRef = useRef(0);
  const listMyReposRef = useRef(listMyRepos);

  useEffect(() => {
    listMyReposRef.current = listMyRepos;
  }, [listMyRepos]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    void withRepoListDeadline(
      listMyReposRef.current({ search: debouncedSearch || undefined }),
    )
      .then((result) => {
        if (requestRef.current !== requestId) return;
        const sorted = [...result.repos].sort((a, b) => {
          const aTime = a.pushedAt ? new Date(a.pushedAt).getTime() : 0;
          const bTime = b.pushedAt ? new Date(b.pushedAt).getTime() : 0;
          return bTime - aTime;
        });
        setRepos(sorted);
      })
      .catch((err) => {
        if (requestRef.current !== requestId) return;
        // Surface the raw error to console so the user can diagnose
        // (e.g., scope problems, network failures) when the list is empty.
        console.error("[CloneProjectForm] listMyRepos failed", err);
        setError(extractError(err));
        setRepos([]);
      })
      .finally(() => {
        if (requestRef.current !== requestId) return;
        setLoading(false);
      });
  }, [debouncedSearch]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          height: 36,
          background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
          border: `1px solid ${COLORS.border}`,
          borderRadius: 8,
        }}
      >
        <MagnifyingGlass size={14} weight="regular" color={COLORS.textMuted} />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter your repositories…"
          autoFocus
          style={{
            flex: 1,
            height: "100%",
            background: "transparent",
            border: "none",
            outline: "none",
            color: COLORS.textPrimary,
            fontFamily: SANS_FONT,
            fontSize: 13,
          }}
        />
        {loading ? (
          <CircleNotch size={12} weight="bold" className="animate-spin" />
        ) : null}
      </div>

      {error ? <InlineHint tone="danger">{error}</InlineHint> : null}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          maxHeight: 360,
          overflowY: "auto",
          paddingRight: 2,
        }}
      >
        {loading && repos.length === 0 ? (
          <RepoSkeleton />
        ) : repos.length === 0 ? (
          <div
            style={{
              padding: "24px 12px",
              fontSize: 12,
              fontFamily: SANS_FONT,
              color: COLORS.textMuted,
              textAlign: "center",
            }}
          >
            {debouncedSearch
              ? "No repositories match."
              : "No repositories found."}
          </div>
        ) : (
          repos.map((repo) => (
            <RepoRow
              key={repo.fullName}
              repo={repo}
              expanded={expandedFullName === repo.fullName}
              onToggle={() =>
                setExpandedFullName((prev) =>
                  prev === repo.fullName ? null : repo.fullName,
                )
              }
              defaultParentDir={defaultParentDir}
              browseDirectories={browseDirectories}
              chooseDirectory={chooseDirectory}
              cloneProject={cloneProject}
              onCloned={onCloned}
            />
          ))
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 2,
        }}
      >
        <button type="button" style={outlineButton()} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RepoRow({
  repo,
  expanded,
  onToggle,
  defaultParentDir,
  browseDirectories,
  chooseDirectory,
  cloneProject,
  onCloned,
}: {
  repo: MyGitHubRepoSummary;
  expanded: boolean;
  onToggle: () => void;
  defaultParentDir: string;
  browseDirectories: (
    input: ProjectBrowseInput,
  ) => Promise<ProjectBrowseResult>;
  chooseDirectory: ChooseDirectory;
  cloneProject: (
    input: CloneProjectInput,
  ) => Promise<CloneProjectResult & { projectId?: string }>;
  onCloned: (result: {
    rootPath: string;
    displayName: string;
    projectId?: string;
  }) => void;
}) {
  const [parentDir, setParentDir] = useState(defaultParentDir);
  const [name, setName] = useState(repo.name);
  const [pickerPending, setPickerPending] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathExists, setPathExists] = useState(false);

  useEffect(() => {
    setParentDir(defaultParentDir);
  }, [defaultParentDir]);

  const checkRequestRef = useRef(0);
  const trimmedName = name.trim();
  const previewPath =
    parentDir && trimmedName ? joinPath(parentDir, trimmedName) : "";

  useEffect(() => {
    if (!expanded || !previewPath) {
      setPathExists(false);
      return;
    }
    const requestId = ++checkRequestRef.current;
    const timeout = window.setTimeout(() => {
      void browseDirectories({ partialPath: previewPath })
        .then((result) => {
          if (checkRequestRef.current !== requestId) return;
          setPathExists(result.exactDirectoryPath === previewPath);
        })
        .catch(() => {
          if (checkRequestRef.current !== requestId) return;
          setPathExists(false);
        });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [browseDirectories, expanded, previewPath]);

  const handleChooseParent = useCallback(async () => {
    if (!chooseDirectory) return;
    setPickerPending(true);
    setError(null);
    try {
      const selected = await chooseDirectory({
        title: "Choose parent directory",
        defaultPath: parentDir || undefined,
      });
      if (selected) setParentDir(selected);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setPickerPending(false);
    }
  }, [chooseDirectory, parentDir]);

  const canClone =
    trimmedName.length > 0 && parentDir.length > 0 && !pathExists && !pending;

  const handleClone = useCallback(async () => {
    if (!canClone) return;
    setPending(true);
    setError(null);
    try {
      const result = await cloneProject({
        url: repo.cloneUrl,
        parentDir,
        name: trimmedName,
      });
      onCloned({
        rootPath: result.rootPath,
        displayName: trimmedName,
        projectId: result.projectId,
      });
    } catch (err) {
      setError(extractError(err));
    } finally {
      setPending(false);
    }
  }, [canClone, cloneProject, onCloned, parentDir, repo.cloneUrl, trimmedName]);

  const visibilityChip: CSSProperties = repo.isPrivate
    ? inlineBadge(COLORS.accent, { padding: "2px 6px", fontSize: 10 })
    : inlineBadge(COLORS.success, { padding: "2px 6px", fontSize: 10 });

  const relPushed = relativeFromNow(repo.pushedAt);

  return (
    <div
      style={{
        border: `1px solid ${expanded ? "color-mix(in srgb, var(--color-accent) 55%, var(--color-border))" : COLORS.border}`,
        borderRadius: 10,
        background: expanded
          ? "color-mix(in srgb, var(--color-accent) 4%, var(--color-card))"
          : "color-mix(in srgb, var(--color-fg) 2%, transparent)",
        overflow: "hidden",
        transition: "border-color 160ms ease, background 160ms ease",
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          color: COLORS.textPrimary,
          font: "inherit",
          textAlign: "left",
          cursor: "pointer",
          width: "100%",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 12px",
          minHeight: 56,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            style={{
              fontFamily: MONO_FONT,
              fontSize: 13,
              color: COLORS.textPrimary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {repo.fullName}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 11,
              fontFamily: SANS_FONT,
              color: COLORS.textMuted,
            }}
          >
            <span style={visibilityChip}>
              {repo.isPrivate ? (
                <>
                  <LockSimple
                    size={9}
                    weight="fill"
                    style={{ marginRight: 3 }}
                  />
                  Private
                </>
              ) : (
                "Public"
              )}
            </span>
            {relPushed ? <span>pushed {relPushed}</span> : null}
          </div>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="expanded"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "10px 12px 12px",
                borderTop: `1px solid ${COLORS.border}`,
                background:
                  "color-mix(in srgb, var(--color-bg) 40%, transparent)",
              }}
            >
              <Field label="FOLDER NAME">
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  style={inputStyle}
                  disabled={pending}
                />
              </Field>

              <Field label="PARENT DIRECTORY">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="text"
                    value={parentDir}
                    onChange={(event) => setParentDir(event.target.value)}
                    placeholder="Parent directory"
                    style={{
                      ...inputStyle,
                      fontFamily: MONO_FONT,
                      fontSize: 12,
                      color: parentDir ? COLORS.textPrimary : COLORS.textMuted,
                      flex: 1,
                    }}
                    title={parentDir}
                    disabled={pending}
                  />
                  {chooseDirectory ? (
                    <button
                      type="button"
                      style={outlineButton({ minWidth: 44 })}
                      disabled={pickerPending || pending}
                      onClick={() => {
                        void handleChooseParent();
                      }}
                      aria-label="Choose parent directory"
                    >
                      {pickerPending ? (
                        <CircleNotch
                          size={12}
                          weight="bold"
                          className="animate-spin"
                        />
                      ) : (
                        <FolderOpen size={12} weight="regular" />
                      )}
                    </button>
                  ) : null}
                </div>
              </Field>

              <PathPreview path={previewPath} exists={pathExists} />

              {error ? <InlineHint tone="danger">{error}</InlineHint> : null}

              <div
                style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
              >
                <button
                  type="button"
                  style={outlineButton()}
                  onClick={onToggle}
                  disabled={pending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  style={primaryButton({
                    opacity: canClone ? 1 : 0.55,
                    cursor: canClone ? "pointer" : "not-allowed",
                    minWidth: 110,
                  })}
                  onClick={() => {
                    void handleClone();
                  }}
                  disabled={!canClone}
                >
                  {pending ? (
                    <>
                      <CircleNotch
                        size={12}
                        weight="bold"
                        className="animate-spin"
                      />
                      Cloning…
                    </>
                  ) : (
                    <>
                      <ArrowsClockwise size={12} weight="bold" />
                      Clone
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function RepoSkeleton() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: "40px 12px",
        color: COLORS.textMuted,
      }}
      aria-live="polite"
    >
      <CircleNotch size={22} weight="bold" className="animate-spin" />
      <div style={{ fontFamily: SANS_FONT, fontSize: 12 }}>
        Loading your repositories…
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        style={{
          ...LABEL_STYLE,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function PathPreview({ path, exists }: { path: string; exists: boolean }) {
  if (!path) return null;
  return (
    <div
      style={{
        padding: "8px 12px",
        borderRadius: 8,
        background: exists
          ? "color-mix(in srgb, var(--color-error) 8%, transparent)"
          : "color-mix(in srgb, var(--color-fg) 3%, transparent)",
        border: `1px solid ${
          exists
            ? "color-mix(in srgb, var(--color-error) 40%, var(--color-border))"
            : COLORS.border
        }`,
      }}
    >
      <div style={{ ...LABEL_STYLE, marginBottom: 3 }}>WILL BE CLONED TO</div>
      <div
        style={{
          fontFamily: MONO_FONT,
          fontSize: 12,
          color: exists ? COLORS.danger : COLORS.textPrimary,
          wordBreak: "break-all",
        }}
      >
        {path}
      </div>
      {exists ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            fontSize: 11,
            fontFamily: SANS_FONT,
            color: COLORS.danger,
          }}
        >
          <Warning size={12} weight="fill" />
          Path already exists
        </div>
      ) : null}
    </div>
  );
}

function InlineHint({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "danger" | "muted";
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontFamily: SANS_FONT,
        color: tone === "danger" ? COLORS.danger : COLORS.textMuted,
      }}
    >
      {tone === "danger" ? <Warning size={12} weight="fill" /> : null}
      {children}
    </span>
  );
}
