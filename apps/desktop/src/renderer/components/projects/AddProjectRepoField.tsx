import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CaretDown, CaretUp, CircleNotch, LockSimple } from "@phosphor-icons/react";
import type { ListMyGitHubReposResult, MyGitHubRepoSummary } from "../../../shared/types";
import { extractError, relativeWhen } from "../../lib/format";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, fgTint, outlineButton } from "../lanes/laneDesignTokens";
import { ConnectGithubPrompt } from "./ConnectGithubPrompt";

export const inputStyle: CSSProperties = {
  height: 36,
  padding: "0 12px",
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: fgTint(4),
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

export const sectionLabelStyle: CSSProperties = { ...LABEL_STYLE, letterSpacing: "0.08em", textTransform: "uppercase" };

/** The repository list gives up after 15 s, so a stalled GitHub call shows an error. */
function withRepoListDeadline(promise: Promise<ListMyGitHubReposResult>): Promise<ListMyGitHubReposResult> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error("Timed out loading repositories. Check GitHub auth and network access."));
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

/**
 * The repository: a URL or `owner/repo`, or one picked from the person's
 * GitHub repositories (listed with this computer's GitHub sign-in).
 */
export function RepoField({
  value,
  onChange,
  valid,
}: {
  value: string;
  onChange: (value: string) => void;
  valid: boolean;
}) {
  const [listOpen, setListOpen] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label htmlFor="add-project-repository" style={sectionLabelStyle}>Repository</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id="add-project-repository"
          autoFocus
          type="text"
          value={value}
          placeholder="owner/repo or https://github.com/owner/repo"
          onChange={(event) => onChange(event.target.value)}
          style={inputStyle}
        />
        <button
          type="button"
          style={outlineButton({ minWidth: 44 })}
          aria-label={listOpen ? "Hide your repositories" : "Show your repositories"}
          aria-expanded={listOpen}
          onClick={() => setListOpen((open) => !open)}
        >
          {listOpen ? <CaretUp size={12} weight="bold" /> : <CaretDown size={12} weight="bold" />}
        </button>
      </div>
      {value.trim().length > 0 && !valid ? (
        <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger }}>
          Enter a GitHub repo, like owner/repo or https://github.com/owner/repo
        </span>
      ) : null}
      {listOpen ? (
        <RepoList
          onPick={(repo) => {
            onChange(repo.cloneUrl);
            setListOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function RepoList({ onPick }: { onPick: (repo: MyGitHubRepoSummary) => void }) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [repos, setRepos] = useState<MyGitHubRepoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    const list = window.ade.github?.listMyRepos;
    const request: Promise<ListMyGitHubReposResult> = typeof list === "function"
      ? list({ search: debounced || undefined })
      : Promise.reject(new Error("GitHub is not available here."));
    void withRepoListDeadline(request)
      .then((result) => {
        if (requestRef.current !== requestId) return;
        setRepos([...result.repos].sort((a, b) => Date.parse(b.pushedAt ?? "") - Date.parse(a.pushedAt ?? "") || 0));
      })
      .catch((err) => {
        if (requestRef.current !== requestId) return;
        setError(extractError(err));
        setRepos([]);
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
  }, [debounced, reload]);

  if (error && /github_not_connected|not connected/i.test(error)) {
    return (
      <ConnectGithubPrompt
        statusError={null}
        onConnected={() => setReload((value) => value + 1)}
        onCancel={() => setError(null)}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <input
        type="text"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Filter your repositories…"
        aria-label="Filter your repositories"
        style={{ ...inputStyle, border: "none", borderBottom: `1px solid ${COLORS.border}`, borderRadius: 0, fontFamily: SANS_FONT }}
      />
      <div role="listbox" aria-label="Your repositories" style={{ maxHeight: 220, overflowY: "auto" }}>
        {loading && repos.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px", fontSize: 12, color: COLORS.textMuted }}>
            <CircleNotch size={12} weight="bold" className="animate-spin" />
            Loading your repositories…
          </div>
        ) : error ? (
          <div style={{ padding: "12px", fontSize: 12, color: COLORS.danger }}>{error}</div>
        ) : repos.length === 0 ? (
          <div style={{ padding: "12px", fontSize: 12, color: COLORS.textMuted }}>
            {debounced ? "No repositories match." : "No repositories found."}
          </div>
        ) : (
          repos.map((repo) => (
            <button
              key={repo.fullName}
              type="button"
              role="option"
              aria-selected={false}
              className="kit-row"
              onClick={() => onPick(repo)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 12px",
                background: "transparent",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                color: COLORS.textPrimary,
                fontFamily: MONO_FONT,
                fontSize: 12,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {repo.fullName}
              </span>
              {repo.isPrivate ? <LockSimple size={11} weight="fill" aria-label="Private" /> : null}
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                {repo.pushedAt ? relativeWhen(repo.pushedAt) : ""}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
