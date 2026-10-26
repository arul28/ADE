import React from "react";
import { UserCircle, X } from "@phosphor-icons/react";
import type { PrDetail, PrUser, SetPrAssigneesResult } from "../../../../shared/types/prs";
import { normalizeGitHubLogin } from "../../../../shared/githubPrSearch";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { isImeComposing } from "../../../lib/imeComposition";
import { showToast } from "../../app/toast/toastStore";
import { PrAgentAvatar } from "./PrAgentAvatar";
import { CardHeader } from "./PrFloatingDock";
import { useGitHubFilterOptions, type GitHubFilterOptionsLoader } from "./useGitHubFilterOptions";

export type PrAssigneeChange = { add: string[]; remove: string[] };

/**
 * Who is assigned, and (when the host can and a write-capable account exists)
 * a search for people GitHub will accept. Changes show at once and roll back
 * with a toast if GitHub refuses; clicks are applied one after another.
 */
export function PrAssigneesCard({
  detail,
  onClose,
  onSetAssignees,
  searchAssignableUsers,
}: {
  detail: PrDetail | null;
  onClose: () => void;
  /** Absent: read-only (older host, or no account that can write). */
  onSetAssignees?: (change: PrAssigneeChange) => Promise<SetPrAssigneesResult>;
  searchAssignableUsers?: GitHubFilterOptionsLoader | null;
}) {
  const serverAssignees = detail?.assignees;
  // The last list GitHub confirmed, and the list shown while changes are in flight.
  const [confirmed, setConfirmed] = React.useState<PrUser[]>(() => serverAssignees ?? []);
  const [optimistic, setOptimistic] = React.useState<PrUser[] | null>(null);
  const pendingRef = React.useRef(0);
  const chainRef = React.useRef<Promise<unknown>>(Promise.resolve());
  React.useEffect(() => {
    // A fresh detail read replaces what we knew, unless a change is still out.
    if (serverAssignees && pendingRef.current === 0) setConfirmed(serverAssignees);
  }, [serverAssignees]);
  const assignees = optimistic ?? confirmed;
  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const editable = Boolean(onSetAssignees);
  const remote = useGitHubFilterOptions({
    enabled: editable && searching,
    kind: "assignee",
    query,
    load: searchAssignableUsers ?? null,
  });
  const assignedKeys = new Set(assignees.map((user) => user.login.toLowerCase()));
  const candidates = remote.options.filter((option) => !assignedKeys.has(option.value.toLowerCase())).slice(0, 8);

  const change = (next: PrUser[], delta: PrAssigneeChange) => {
    if (!onSetAssignees) return;
    setOptimistic(next);
    pendingRef.current += 1;
    const run = chainRef.current.catch(() => undefined).then(() => onSetAssignees(delta));
    chainRef.current = run;
    run
      .then((result) => {
        setConfirmed(result.assignees);
        // The last change in flight settles to GitHub's answer; earlier ones
        // leave the optimistic list, which already holds the later clicks.
        if (pendingRef.current === 1) setOptimistic(null);
        if (result.notAssigned.length > 0) {
          showToast({
            tone: "warning",
            title: "Not assigned",
            message: `GitHub did not assign ${result.notAssigned.join(", ")}. They may not have access to this repository.`,
          });
        }
      })
      .catch((error: unknown) => {
        // Roll back to what GitHub last confirmed once nothing else is out.
        if (pendingRef.current === 1) setOptimistic(null);
        showToast({
          tone: "error",
          title: "Assignees not changed",
          message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, "") : String(error),
        });
      })
      .finally(() => {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
      });
  };
  const add = (login: string, avatarUrl: string | null) => {
    if (assignedKeys.has(login.toLowerCase())) return;
    change([...assignees, { login, avatarUrl }], { add: [login], remove: [] });
    setQuery("");
  };
  const remove = (login: string) => {
    change(assignees.filter((user) => user.login.toLowerCase() !== login.toLowerCase()), { add: [], remove: [login] });
  };

  return (
    <div data-testid="pr-assignees-card">
      <CardHeader icon={UserCircle} title="Assignees" onClose={onClose} />
      {assignees.length === 0 ? (
        <div className="mb-2 text-[12px]" style={{ color: COLORS.textMuted }}>Nobody is assigned.</div>
      ) : (
        <div className="mb-2">
          {assignees.map((assignee) => (
            <div key={assignee.login} className="group flex items-center gap-2 py-1" data-testid="pr-assignee-row">
              <PrAgentAvatar login={assignee.login} isBot={assignee.isBot} avatarUrl={assignee.avatarUrl} size={20} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>{assignee.login}</span>
              {editable ? (
                <button
                  type="button"
                  onClick={() => remove(assignee.login)}
                  aria-label={`Unassign ${assignee.login}`}
                  className="inline-flex rounded p-0.5 opacity-50 hover:opacity-100"
                  style={{ color: COLORS.textMuted, background: "none", border: "none", cursor: "pointer" }}
                >
                  <X size={10} weight="bold" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {editable ? (
        <>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setSearching(true)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || isImeComposing(event)) return;
              const first = candidates[0];
              if (first) add(first.value, first.avatarUrl ?? null);
              else {
                const login = normalizeGitHubLogin(query);
                if (login) add(login, null);
              }
            }}
            placeholder="Assign someone"
            aria-label="Find a person to assign"
            className="h-7 w-full rounded-md px-2 text-[11px] outline-none"
            style={{ fontFamily: SANS_FONT, color: COLORS.textPrimary, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}
          />
          {searching && (candidates.length > 0 || remote.loading) ? (
            <div className="mt-1" role="listbox" aria-label="People you can assign">
              {candidates.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => add(option.value, option.avatarUrl ?? null)}
                  className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-fg/[0.07]"
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                >
                  <PrAgentAvatar login={option.value} avatarUrl={option.avatarUrl ?? null} size={18} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: COLORS.textPrimary }}>{option.value}</span>
                  {option.name ? <span className="max-w-[100px] truncate text-[10px]" style={{ color: COLORS.textDim }}>{option.name}</span> : null}
                </button>
              ))}
              {remote.loading && candidates.length === 0 ? (
                <div className="px-1 py-1 text-[10.5px]" style={{ color: COLORS.textDim }}>Searching GitHub…</div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
