import React from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  CheckCircle,
  Circle,
  GitPullRequest,
  Plus,
  Stack,
  Warning,
} from "@phosphor-icons/react";
import type { GitHubPrListItem, GitHubPrStack } from "../../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../../lanes/laneDesignTokens";

function parsePullRequests(value: string): number[] | null {
  const values = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part));
  if (
    values.length === 0
    || values.some((part) => !Number.isInteger(part) || part <= 0)
    || new Set(values).size !== values.length
  ) {
    return null;
  }
  return values;
}

export function GitHubStackInspector({
  stack,
  items,
  selectedPrNumber,
  syncing,
  onSelectPr,
  onOpenGitHub,
  onSync,
  onAddPullRequests,
  onUnstack,
}: {
  stack: GitHubPrStack;
  items: GitHubPrListItem[];
  selectedPrNumber: number;
  syncing: boolean;
  onSelectPr: (item: GitHubPrListItem) => void;
  onOpenGitHub: () => void;
  onSync: () => void;
  onAddPullRequests: (pullRequests: number[]) => Promise<void>;
  onUnstack: () => Promise<void>;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(true);
  const [manageOpen, setManageOpen] = React.useState(false);
  const [pullInput, setPullInput] = React.useState("");
  const [busyAction, setBusyAction] = React.useState<"add" | "unstack" | null>(null);
  const [confirmUnstack, setConfirmUnstack] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const itemByPr = React.useMemo(
    () => new Map(items.map((item) => [item.githubPrNumber, item] as const)),
    [items],
  );
  const selectedPosition = stack.entries.find(
    (entry) => entry.githubPrNumber === selectedPrNumber,
  )?.position;

  const addPullRequests = async () => {
    const pullRequests = parsePullRequests(pullInput);
    if (!pullRequests) {
      setError("Enter one or more pull request numbers separated by commas.");
      return;
    }
    setBusyAction("add");
    setError(null);
    try {
      await onAddPullRequests(pullRequests);
      setPullInput("");
      setManageOpen(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "GitHub could not add those pull requests.");
    } finally {
      setBusyAction(null);
    }
  };

  const unstack = async () => {
    if (!confirmUnstack) {
      setConfirmUnstack(true);
      return;
    }
    setBusyAction("unstack");
    setError(null);
    try {
      await onUnstack();
      setConfirmUnstack(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "GitHub could not update this stack.");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div style={{ padding: "10px 12px 0", flexShrink: 0 }}>
      <div style={{
        ...cardStyle({ padding: 0, overflow: "hidden" }),
        borderColor: "rgba(167,139,250,0.22)",
        background: "linear-gradient(135deg, rgba(139,92,246,0.08), rgba(255,255,255,0.015))",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
          <span style={{
            display: "inline-flex",
            width: 28,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
            color: "#C4B5FD",
            background: "rgba(139,92,246,0.14)",
            border: "1px solid rgba(167,139,250,0.22)",
          }}>
            <Stack size={16} weight="fill" />
          </span>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            style={{ display: "grid", gap: 2, flex: 1, minWidth: 0, textAlign: "left", border: 0, background: "transparent", cursor: "pointer" }}
            aria-expanded={expanded}
          >
            <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700, color: COLORS.textPrimary }}>
              GitHub Stack #{stack.number}
            </span>
            <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
              {selectedPosition ? `This is PR ${selectedPosition} of ${stack.entries.length}` : `${stack.entries.length} pull requests`}
              {" · "}base {stack.baseBranch}
            </span>
          </button>
          <button type="button" onClick={onOpenGitHub} style={outlineButton({ height: 28, padding: "0 9px", fontSize: 11 })}>
            <ArrowSquareOut size={12} /> Review on GitHub
          </button>
          <button
            type="button"
            onClick={onSync}
            disabled={syncing}
            title="Refresh this stack from GitHub"
            aria-label="Refresh GitHub stack"
            style={outlineButton({ width: 28, height: 28, padding: 0, opacity: syncing ? 0.6 : 1 })}
          >
            <ArrowsClockwise size={13} className={syncing ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? "Collapse GitHub stack" : "Expand GitHub stack"}
            style={outlineButton({ width: 28, height: 28, padding: 0 })}
          >
            {expanded ? <CaretUp size={12} /> : <CaretDown size={12} />}
          </button>
        </div>

        {expanded ? (
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "10px 12px 12px" }}>
            {stack.lastError ? (
              <div style={{ display: "flex", gap: 7, marginBottom: 10, color: COLORS.warning, fontFamily: SANS_FONT, fontSize: 11 }}>
                <Warning size={13} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />
                <span>Showing the last saved stack state. {stack.lastError}</span>
              </div>
            ) : null}
            <div style={{ display: "grid", gap: 0 }}>
              {[...stack.entries].reverse().map((entry, index, reversed) => {
                const item = itemByPr.get(entry.githubPrNumber);
                const selected = entry.githubPrNumber === selectedPrNumber;
                const merged = Boolean(entry.mergedAt);
                const stateLabel = merged ? "Merged" : entry.isDraft ? "Draft" : entry.state === "closed" ? "Closed" : "Open";
                return (
                  <div key={entry.githubPrNumber} style={{ position: "relative", display: "grid", gridTemplateColumns: "22px minmax(0, 1fr) auto", alignItems: "center", minHeight: 34 }}>
                    {index < reversed.length - 1 ? (
                      <span style={{ position: "absolute", left: 7, top: 20, bottom: -15, width: 1, background: "rgba(167,139,250,0.24)" }} />
                    ) : null}
                    <span style={{ zIndex: 1, color: merged ? COLORS.success : selected ? "#C4B5FD" : COLORS.textDim }}>
                      {merged ? <CheckCircle size={15} weight="fill" /> : <Circle size={15} weight={selected ? "fill" : "regular"} />}
                    </span>
                    <button
                      type="button"
                      disabled={!item}
                      onClick={() => item && onSelectPr(item)}
                      style={{
                        display: "grid",
                        minWidth: 0,
                        padding: "5px 8px",
                        textAlign: "left",
                        border: selected ? "1px solid rgba(167,139,250,0.22)" : "1px solid transparent",
                        borderRadius: 7,
                        background: selected ? "rgba(139,92,246,0.08)" : "transparent",
                        cursor: item ? "pointer" : "default",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: SANS_FONT, fontSize: 11, fontWeight: selected ? 650 : 500, color: COLORS.textPrimary }}>
                        {item?.title ?? entry.headBranch}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                        #{entry.githubPrNumber} · {entry.headBranch}
                      </span>
                    </button>
                    <span style={{ paddingLeft: 8, fontFamily: SANS_FONT, fontSize: 10, color: merged ? COLORS.success : COLORS.textMuted }}>
                      {stateLabel}
                    </span>
                  </div>
                );
              })}
              <div style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr)", alignItems: "center", minHeight: 28 }}>
                <span style={{ color: COLORS.textDim }}><GitPullRequest size={14} /></span>
                <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>{stack.baseBranch}</span>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
              <button
                type="button"
                onClick={() => {
                  setManageOpen((value) => !value);
                  setConfirmUnstack(false);
                  setError(null);
                }}
                style={outlineButton({ height: 28, padding: "0 9px", fontSize: 11 })}
              >
                <Plus size={12} /> Manage stack
              </button>
              <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim }}>
                GitHub manages rebases, review requirements, and merging.
              </span>
            </div>

            {manageOpen ? (
              <div style={{ display: "grid", gap: 8, marginTop: 10, padding: 10, borderRadius: 8, background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <label style={{ display: "grid", gap: 5 }}>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, color: COLORS.textSecondary }}>
                    Add pull requests above the current top
                  </span>
                  <div style={{ display: "flex", gap: 7 }}>
                    <input
                      value={pullInput}
                      onChange={(event) => setPullInput(event.target.value)}
                      placeholder="971, 972"
                      aria-label="Pull request numbers to add"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        height: 30,
                        padding: "0 9px",
                        borderRadius: 7,
                        border: "1px solid rgba(255,255,255,0.09)",
                        background: "rgba(0,0,0,0.18)",
                        color: COLORS.textPrimary,
                        fontFamily: MONO_FONT,
                        fontSize: 11,
                        outline: "none",
                      }}
                    />
                    <button
                      type="button"
                      disabled={busyAction != null}
                      onClick={() => { void addPullRequests(); }}
                      style={primaryButton({ height: 30, padding: "0 10px", fontSize: 11, opacity: busyAction ? 0.6 : 1 })}
                    >
                      {busyAction === "add" ? "Adding..." : "Add PRs"}
                    </button>
                  </div>
                </label>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim }}>
                    Remove PRs from this stack when GitHub allows it.
                  </span>
                  <button
                    type="button"
                    disabled={busyAction != null}
                    onClick={() => { void unstack(); }}
                    style={outlineButton({
                      height: 28,
                      padding: "0 9px",
                      fontSize: 11,
                      color: COLORS.warning,
                      borderColor: "rgba(245,158,11,0.25)",
                      opacity: busyAction ? 0.6 : 1,
                    })}
                  >
                    {busyAction === "unstack" ? "Updating..." : confirmUnstack ? "Confirm unstack" : "Unstack"}
                  </button>
                </div>
              </div>
            ) : null}

            {error ? (
              <div role="alert" style={{ marginTop: 8, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.danger }}>
                {error}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
