import React from "react";
import type { ReviewerRequest, SearchPrMentionablesResult } from "../../../../shared/types/prs";
import { isImeComposing } from "../../../lib/imeComposition";
import { COLORS, MONO_FONT } from "../../lanes/laneDesignTokens";
import { PrWritingScopeContext } from "./prMarkdownContext";

const REVIEWER_SEARCH_DEBOUNCE_MS = 200;

/**
 * Finds people and teams to ask for a review. The search runs on GitHub with
 * the typed text, so it reaches past the first page of a large organization.
 */
export function PrReviewerPicker({
  entries,
  authorLogin,
  onRequestReviewers,
}: {
  entries: readonly { login: string }[];
  /** GitHub refuses a review request to the PR's own author. */
  authorLogin: string | null;
  onRequestReviewers: (request: ReviewerRequest) => void;
}) {
  const scope = React.useContext(PrWritingScopeContext);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchPrMentionablesResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pickedUsers, setPickedUsers] = React.useState<string[]>([]);
  const [pickedTeams, setPickedTeams] = React.useState<string[]>([]);
  const pinKey = scope?.pin?.key ?? null;
  const repoOwner = scope?.repoOwner ?? null;
  const repoName = scope?.repoName ?? null;
  const known = React.useMemo(() => {
    const logins = new Set(entries.map((entry) => entry.login.toLowerCase()));
    if (authorLogin) logins.add(authorLogin.toLowerCase());
    return logins;
  }, [authorLogin, entries]);

  React.useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.ade.prs.searchMentionables({ repoOwner, repoName, query, includeTeams: true }, scope?.pin ?? null)
        .then((next) => {
          if (cancelled) return;
          setResults(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setResults(null);
          setError(err instanceof Error ? err.message : String(err));
        });
    }, REVIEWER_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `scope.pin` is keyed by its identity string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, query, repoName, repoOwner]);

  const toggleUser = (login: string) => setPickedUsers((current) => (
    current.includes(login) ? current.filter((value) => value !== login) : [...current, login]
  ));
  const toggleTeam = (slug: string) => setPickedTeams((current) => (
    current.includes(slug) ? current.filter((value) => value !== slug) : [...current, slug]
  ));
  const users = (results?.users ?? []).filter((user) => !known.has(user.login.toLowerCase()));
  const teams = results?.teams ?? [];
  const submit = () => {
    if (pickedUsers.length === 0 && pickedTeams.length === 0) return;
    onRequestReviewers({ reviewers: pickedUsers, teamReviewers: pickedTeams });
    setPickedUsers([]);
    setPickedTeams([]);
    setQuery("");
  };
  const pickerRow = (args: { key: string; picked: boolean; onPick: () => void; label: string; detail?: string | null; avatarUrl?: string | null }) => (
    <button
      key={args.key}
      type="button"
      role="checkbox"
      aria-checked={args.picked}
      onClick={args.onPick}
      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11.5px] hover:brightness-125"
      style={{ background: args.picked ? COLORS.hoverBg : "transparent", border: "none", cursor: "pointer", color: COLORS.textPrimary }}
    >
      {args.avatarUrl ? <img src={args.avatarUrl} alt="" width={14} height={14} className="rounded-full" /> : null}
      <span className="truncate" style={{ fontFamily: MONO_FONT }}>{args.label}</span>
      {args.detail ? <span className="truncate" style={{ color: COLORS.textMuted }}>{args.detail}</span> : null}
      {args.picked ? <span className="ml-auto" style={{ color: COLORS.accent }}>Selected</span> : null}
    </button>
  );
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="pr-reviewer-picker">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !isImeComposing(event)) submit(); }}
        placeholder="Search people and teams"
        aria-label="Search people and teams to request a review from"
        className="h-7 w-full rounded-md px-2 text-[11px] outline-none"
        style={{ fontFamily: MONO_FONT, color: COLORS.textPrimary, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}
      />
      {error ? <div className="text-[11px]" style={{ color: COLORS.danger }}>{error}</div> : null}
      <div className="max-h-40 overflow-y-auto">
        {teams.map((team) => pickerRow({ key: `t:${team.slug}`, picked: pickedTeams.includes(team.slug), onPick: () => toggleTeam(team.slug), label: `team:${team.slug}`, detail: team.name }))}
        {users.map((user) => pickerRow({ key: `u:${user.login}`, picked: pickedUsers.includes(user.login), onPick: () => toggleUser(user.login), label: user.login, detail: user.name, avatarUrl: user.avatarUrl }))}
        {results && users.length === 0 && teams.length === 0 ? (
          <div className="px-1.5 py-1 text-[11px]" style={{ color: COLORS.textMuted }}>No one found.</div>
        ) : null}
      </div>
      {pickedUsers.length > 0 || pickedTeams.length > 0 ? (
        <button type="button" onClick={submit} className="self-end rounded-md px-2 py-1 text-[11px]" style={{ background: COLORS.accent, color: "var(--color-accent-fg, #0b0b0b)", border: "none", cursor: "pointer", fontWeight: 600 }}>
          Request {pickedUsers.length + pickedTeams.length} {pickedUsers.length + pickedTeams.length === 1 ? "reviewer" : "reviewers"}
        </button>
      ) : null}
    </div>
  );
}
