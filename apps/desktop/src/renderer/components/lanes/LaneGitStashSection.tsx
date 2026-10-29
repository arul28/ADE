import { X } from "@phosphor-icons/react";
import type { GitStashSummary, OpenProjectBinding } from "../../../shared/types";
import { SmartTooltip } from "../ui/SmartTooltip";
import { WORK_TOOL_SECTION_LABEL_TEXT, WorkToolChromeButton } from "../terminals/workToolChrome";
import { invalidateLaneGitCaches } from "./laneGitListCache";

function formatRelativeTime(ts: string | null): string {
  if (!ts) return "unknown time";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

/**
 * The branch's saved stashes, opened from the Git pane's "More git actions".
 * Every call goes to the pane's machine (`pin`). Actions run through the
 * pane's `runAction`, so they share its busy state, notices and refresh.
 */
export function LaneGitStashSection({
  laneId,
  pin,
  projectKey,
  stashes,
  maxVisible,
  busy,
  changedFileCount,
  hasUncommittedChanges,
  hasUntrackedChanges,
  runAction,
  requestTextInput,
  refreshGitMeta,
  onHide,
}: {
  laneId: string | null;
  /** The lane's machine; null for the tab's own. */
  pin: OpenProjectBinding | null;
  /** The pane's cache scope, dropped before each stash mutation. */
  projectKey: string | null;
  stashes: GitStashSummary[];
  maxVisible: number;
  /** Another git action is running. */
  busy: boolean;
  changedFileCount: number;
  hasUncommittedChanges: boolean;
  hasUntrackedChanges: boolean;
  runAction: (actionName: string, fn: () => Promise<void>) => Promise<void>;
  requestTextInput: (args: {
    title: string;
    message?: string;
    placeholder?: string;
    confirmLabel?: string;
    validate?: (value: string) => string | null;
  }) => Promise<string | null>;
  refreshGitMeta: (laneId: string) => Promise<void>;
  onHide: () => void;
}) {
  return (
    <section className="ade-git-section" data-section="stashes" aria-label="Branch stashes">
      <header className="ade-git-section-head">
        <span className={WORK_TOOL_SECTION_LABEL_TEXT}>Branch stashes</span>
        <span className="ade-git-count">{stashes.length === 0 ? "None saved" : `${stashes.length} saved`}</span>
        <div className="ade-git-section-aside">
          {stashes.length > 0 ? (
            <SmartTooltip content={{
              label: "Clear Branch Stashes",
              description: "Permanently delete this branch's visible stash entries. You'll be asked to confirm by typing the count.",
              gitCommand: "git stash drop <branch stash refs>",
              effect: `Delete ${stashes.length} branch stash${stashes.length === 1 ? "" : "es"}`,
              warning: "This cannot be undone",
            }}>
              <button
                type="button"
                className="kit-btn kit-btn-ghost"
                data-size="sm"
                data-tone="crit"
                disabled={!laneId || busy}
                onClick={() => {
                  if (!laneId) return;
                  void runAction("stash clear", async () => {
                    const confirmation = await requestTextInput({
                      title: "Clear branch stashes?",
                      message: `This will permanently delete ${stashes.length} stash${stashes.length === 1 ? "" : "es"} saved for this branch. Type "${stashes.length}" to confirm.`,
                      placeholder: `Type ${stashes.length} to confirm`,
                      confirmLabel: "Delete all",
                      validate: (v) => v.trim() === String(stashes.length) ? null : "Type the number to confirm",
                    });
                    if (confirmation == null) throw new Error("__ade_cancelled__");
                    invalidateLaneGitCaches(projectKey, laneId);
                    await window.ade.git.stashClear({ laneId }, pin);
                    await refreshGitMeta(laneId);
                  });
                }}
              >
                Clear stashes
              </button>
            </SmartTooltip>
          ) : null}
          <SmartTooltip content={{
            label: "Save Changes",
            description: "Save this branch's current staged and unstaged changes to a stash without committing. You can restore them later.",
            gitCommand: hasUntrackedChanges ? "git stash push -u" : "git stash push",
            effect: hasUncommittedChanges
              ? `Stash ${changedFileCount} changed file${changedFileCount === 1 ? "" : "s"}${hasUntrackedChanges ? ", including untracked files" : ""}`
              : "No changes to save",
          }}>
            <button
              type="button"
              className="kit-btn kit-btn-ghost"
              data-size="sm"
              disabled={!laneId || busy || !hasUncommittedChanges}
              onClick={() => {
                if (!laneId) return;
                void runAction("stash push", async () => {
                  const msg = await requestTextInput({
                    title: "Stash message",
                    placeholder: "Optional note",
                    confirmLabel: "Save stash",
                  });
                  if (msg == null) throw new Error("__ade_cancelled__");
                  invalidateLaneGitCaches(projectKey, laneId);
                  await window.ade.git.stashPush({ laneId, message: msg || undefined, includeUntracked: hasUntrackedChanges }, pin);
                });
              }}
            >
              Save changes
            </button>
          </SmartTooltip>
          <WorkToolChromeButton label="Hide stashes" onClick={onHide} testId="git-pane-stashes-close">
            <X size={14} />
          </WorkToolChromeButton>
        </div>
      </header>
      {stashes.length > 0 ? (
        <div className="ade-git-stash-list">
          {stashes.slice(0, maxVisible).map((stash) => (
            <div key={stash.ref} className="ade-git-stash-row">
              <div className="ade-git-stash-text">
                <div className="ade-git-stash-subject truncate">{stash.subject || stash.ref}</div>
                <div className="ade-git-stash-meta kit-num truncate">
                  {stash.ref} · {formatRelativeTime(stash.createdAt)}
                </div>
              </div>
              <SmartTooltip content={{
                label: "Restore",
                description: "Apply this stash's changes to your working directory and remove the stash entry. One-time use.",
                gitCommand: `git stash pop ${stash.ref}`,
                effect: `Restore "${stash.subject || stash.ref}" and remove it from stashes`,
              }}>
                <button
                  type="button"
                  className="kit-btn kit-btn-ghost"
                  data-size="sm"
                  disabled={!laneId || busy}
                  onClick={() => {
                    if (!laneId) return;
                    void runAction("stash pop", async () => {
                      invalidateLaneGitCaches(projectKey, laneId);
                      await window.ade.git.stashPop({ laneId, stashRef: stash.ref, stashOid: stash.oid }, pin);
                      await refreshGitMeta(laneId);
                    });
                  }}
                >
                  Restore
                </button>
              </SmartTooltip>
              <SmartTooltip content={{
                label: "Copy to Worktree",
                description: "Apply this stash's changes to your working directory but keep the stash entry. Can be reused multiple times.",
                gitCommand: `git stash apply ${stash.ref}`,
                effect: `Apply "${stash.subject || stash.ref}" (stash stays saved)`,
              }}>
                <button
                  type="button"
                  className="kit-btn kit-btn-ghost"
                  data-size="sm"
                  disabled={!laneId || busy}
                  onClick={() => {
                    if (!laneId) return;
                    void runAction("stash apply", async () => {
                      invalidateLaneGitCaches(projectKey, laneId);
                      await window.ade.git.stashApply({ laneId, stashRef: stash.ref, stashOid: stash.oid }, pin);
                    });
                  }}
                >
                  Copy to worktree
                </button>
              </SmartTooltip>
              <SmartTooltip content={{
                label: "Delete Stash",
                description: "Permanently delete this stash entry without restoring any changes.",
                gitCommand: `git stash drop ${stash.ref}`,
                effect: `Delete "${stash.subject || stash.ref}"`,
                warning: "Changes in this stash will be lost permanently",
              }}>
                <button
                  type="button"
                  className="kit-btn kit-btn-ghost"
                  data-size="sm"
                  data-tone="crit"
                  disabled={!laneId || busy}
                  onClick={() => {
                    if (!laneId) return;
                    void runAction("stash drop", async () => {
                      const confirmation = await requestTextInput({
                        title: "Delete stash?",
                        message: `This will permanently delete "${stash.subject || stash.ref}". Type "delete" to confirm.`,
                        placeholder: "Type delete to confirm",
                        confirmLabel: "Delete stash",
                        validate: (v) => v.trim().toLowerCase() === "delete" ? null : "Type delete to confirm",
                      });
                      if (confirmation == null) throw new Error("__ade_cancelled__");
                      invalidateLaneGitCaches(projectKey, laneId);
                      await window.ade.git.stashDrop({ laneId, stashRef: stash.ref, stashOid: stash.oid }, pin);
                      await refreshGitMeta(laneId);
                    });
                  }}
                >
                  Delete
                </button>
              </SmartTooltip>
            </div>
          ))}
          {stashes.length > maxVisible ? (
            <div className="ade-git-stash-more">
              +{stashes.length - maxVisible} more stash entr{stashes.length - maxVisible === 1 ? "y" : "ies"}.
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
