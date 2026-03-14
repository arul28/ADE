import { useState, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GitBranch, X, MagnifyingGlass, WarningCircle, Check, Info, TreeStructure } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE, primaryButton, outlineButton } from "./laneDesignTokens";
import type { LaneSummary } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  height: 34,
  padding: "0 10px",
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.border}`,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};

const SELECT_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  cursor: "pointer",
  appearance: "none" as const,
};

const INFO_BOX: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "8px 10px",
  background: `${COLORS.info}08`,
  border: `1px solid ${COLORS.info}20`,
  marginBottom: 14,
};

const DIAGRAM_STYLE: React.CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 10,
  lineHeight: 1.6,
  color: COLORS.textDim,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.border}`,
  padding: "8px 10px",
  whiteSpace: "pre",
  marginTop: 8,
};

export function ImportBranchDialog({
  open,
  onOpenChange,
  branches,
  lanes,
  busy,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: LaneBranchOption[];
  lanes: LaneSummary[];
  busy: boolean;
  error: string | null;
  onSubmit: (args: { branchRef: string; name: string; parentLaneId: string }) => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [laneName, setLaneName] = useState("");
  const [parentLaneId, setParentLaneId] = useState<string>("");

  const primary = lanes.find((l) => l.laneType === "primary");
  const effectiveParentId = parentLaneId || primary?.id || "";
  const selectedParent = lanes.find((l) => l.id === effectiveParentId);

  // Build a set of refs that already have lanes
  const existingRefs = useMemo(() => {
    const set = new Set<string>();
    for (const l of lanes) {
      set.add(l.branchRef);
      if (!l.branchRef.startsWith("origin/")) {
        set.add(`origin/${l.branchRef}`);
      }
    }
    return set;
  }, [lanes]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, search]);

  function handleSelect(name: string) {
    if (existingRefs.has(name)) return;
    setSelected(name);
    setLaneName((prev) => (!prev || prev === selected) ? name : prev);
  }

  function handleSubmit() {
    if (!selected || existingRefs.has(selected) || busy || !effectiveParentId) return;
    onSubmit({ branchRef: selected, name: laneName.trim() || selected, parentLaneId: effectiveParentId });
  }

  function handleClose(v: boolean) {
    if (!v && !busy) {
      setSearch("");
      setSelected("");
      setLaneName("");
      setParentLaneId("");
    }
    onOpenChange(v);
  }

  const canSubmit = !!selected && !existingRefs.has(selected) && !busy && !!effectiveParentId;
  const displayName = laneName.trim() || selected || "imported-branch";

  return (
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)",
          }}
        />
        <Dialog.Content
          style={{
            position: "fixed", left: "50%", top: "10%", zIndex: 51,
            width: "min(520px, calc(100vw - 24px))",
            maxHeight: "80vh",
            overflowY: "auto",
            transform: "translateX(-50%)",
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.border}`,
            borderTop: `2px solid ${COLORS.accent}`,
            outline: "none",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "12px 14px",
            borderBottom: `1px solid ${COLORS.border}`,
          }}>
            <GitBranch size={14} color={COLORS.accent} weight="bold" />
            <Dialog.Title style={{
              flex: 1,
              fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700,
              letterSpacing: "1.2px", textTransform: "uppercase",
              color: COLORS.textPrimary, margin: 0,
            }}>
              Import Existing Branch
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                disabled={busy}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22,
                  background: "transparent", border: "none",
                  color: COLORS.textMuted, cursor: "pointer", padding: 0,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = COLORS.textPrimary; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = COLORS.textMuted; }}
              >
                <X size={13} />
              </button>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div style={{ padding: "14px 14px 0" }}>
            {/* Info box */}
            <div style={INFO_BOX}>
              <Info size={13} color={COLORS.info} style={{ marginTop: 1, flexShrink: 0 }} />
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, lineHeight: 1.6 }}>
                Wrap an existing branch as a lane with its own worktree.
                Pick a parent so ADE can track divergence and suggest rebases.
                Remote-only branches get a local tracking branch automatically.
              </span>
            </div>

            {/* Search */}
            <div style={{ position: "relative", marginBottom: 6 }}>
              <MagnifyingGlass
                size={12} color={COLORS.textDim}
                style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter branches..."
                style={{ ...INPUT_STYLE, paddingLeft: 30 }}
              />
            </div>

            {/* Branch list */}
            <div style={{
              maxHeight: 170,
              overflowY: "auto",
              border: `1px solid ${COLORS.border}`,
              background: COLORS.recessedBg,
              marginBottom: 12,
            }}>
              {filtered.length === 0 ? (
                <div style={{
                  padding: "20px 12px",
                  fontFamily: MONO_FONT, fontSize: 11,
                  color: COLORS.textDim, textAlign: "center",
                }}>
                  {branches.length === 0 ? "Loading branches..." : "No branches match"}
                </div>
              ) : (
                filtered.map((b) => {
                  const isImported = existingRefs.has(b.name);
                  const isSelected = selected === b.name;
                  return (
                    <button
                      key={b.name}
                      type="button"
                      disabled={isImported}
                      onClick={() => handleSelect(b.name)}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        width: "100%", padding: "7px 10px",
                        background: isSelected ? `${COLORS.accent}1A` : "transparent",
                        border: "none",
                        borderLeft: `2px solid ${isSelected ? COLORS.accent : "transparent"}`,
                        color: isImported ? COLORS.textDim : isSelected ? COLORS.textPrimary : COLORS.textSecondary,
                        fontFamily: MONO_FONT, fontSize: 12,
                        textAlign: "left",
                        cursor: isImported ? "default" : "pointer",
                        transition: "background 80ms",
                        boxSizing: "border-box",
                      }}
                      onMouseEnter={(e) => {
                        if (!isImported && !isSelected)
                          (e.currentTarget as HTMLElement).style.background = COLORS.hoverBg;
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected)
                          (e.currentTarget as HTMLElement).style.background = "transparent";
                      }}
                    >
                      {isSelected ? (
                        <Check size={11} color={COLORS.accent} style={{ flexShrink: 0 }} />
                      ) : (
                        <GitBranch size={11} color={isImported ? COLORS.textDim : COLORS.textMuted} style={{ flexShrink: 0 }} />
                      )}
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {b.name}
                      </span>
                      {b.upstream && !isImported && (
                        <span style={{
                          fontFamily: MONO_FONT, fontSize: 9,
                          color: COLORS.textDim,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          maxWidth: 80,
                        }}>
                          {b.upstream}
                        </span>
                      )}
                      {isImported && (
                        <span style={{
                          fontFamily: MONO_FONT, fontSize: 9, letterSpacing: "0.8px",
                          color: COLORS.textDim,
                          background: `${COLORS.textDim}15`,
                          border: `1px solid ${COLORS.textDim}25`,
                          padding: "1px 5px", flexShrink: 0,
                        }}>
                          LANE
                        </span>
                      )}
                      {b.isRemote && !isImported && (
                        <span style={{
                          fontFamily: MONO_FONT, fontSize: 9, letterSpacing: "0.8px",
                          color: COLORS.info,
                          background: `${COLORS.info}15`,
                          border: `1px solid ${COLORS.info}30`,
                          padding: "1px 5px", flexShrink: 0,
                        }}>
                          REMOTE
                        </span>
                      )}
                      {b.isCurrent && !b.isRemote && !isImported && (
                        <span style={{
                          fontFamily: MONO_FONT, fontSize: 9, letterSpacing: "0.8px",
                          color: COLORS.accent,
                          background: `${COLORS.accent}15`,
                          border: `1px solid ${COLORS.accent}30`,
                          padding: "1px 5px", flexShrink: 0,
                        }}>
                          HEAD
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Lane name */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 5 }}>Lane name</div>
              <input
                value={laneName}
                onChange={(e) => setLaneName(e.target.value)}
                placeholder={selected || "Select a branch above"}
                disabled={!selected || busy}
                style={{
                  ...INPUT_STYLE,
                  opacity: (!selected || busy) ? 0.45 : 1,
                }}
              />
            </div>

            {/* Parent lane selector */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 5 }}>Parent lane</div>
              <div style={{ position: "relative" }}>
                <select
                  value={effectiveParentId}
                  onChange={(e) => setParentLaneId(e.target.value)}
                  style={SELECT_STYLE}
                >
                  {lanes.map((lane) => (
                    <option key={lane.id} value={lane.id} style={{ background: COLORS.cardBg }}>
                      {lane.laneType === "primary" ? `${lane.name} (primary)` : lane.name}  [{lane.branchRef}]
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ marginTop: 4, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, lineHeight: 1.5 }}>
                ADE tracks how far this lane diverges from its parent and suggests rebases when the parent moves ahead.
              </div>

              {/* Diagram */}
              {selectedParent && selected && (
                <div style={DIAGRAM_STYLE}>
                  {selectedParent.laneType !== "primary" ? (
                    <>
                      <span style={{ color: COLORS.textDim }}>{"  main"}</span>
                      {"\n"}
                      <span style={{ color: COLORS.textDim }}>{"    \u2502"}</span>
                      {"\n"}
                      <span style={{ color: COLORS.accent }}>{"    \u251C\u2500\u2500 "}{selectedParent.name}</span>
                      <span style={{ color: COLORS.textDim }}>{" (parent)"}</span>
                      {"\n"}
                      <span style={{ color: COLORS.success }}>{"    \u2502   \u2514\u2500\u2500 "}{displayName}</span>
                      <span style={{ color: COLORS.textDim }}>{" (imported)"}</span>
                    </>
                  ) : (
                    <>
                      <span style={{ color: COLORS.accent }}>{"  "}{selectedParent.name}</span>
                      <span style={{ color: COLORS.textDim }}>{" (parent)"}</span>
                      {"\n"}
                      <span style={{ color: COLORS.textDim }}>{"    \u2502"}</span>
                      {"\n"}
                      <span style={{ color: COLORS.success }}>{"    \u2514\u2500\u2500 "}{displayName}</span>
                      <span style={{ color: COLORS.textDim }}>{" (imported)"}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Error */}
            {error ? (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: 8,
                marginBottom: 14, padding: "8px 10px",
                background: `${COLORS.danger}10`,
                border: `1px solid ${COLORS.danger}30`,
                color: COLORS.danger,
                fontFamily: MONO_FONT, fontSize: 11,
              }}>
                <WarningCircle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                <span style={{ lineHeight: 1.5 }}>{error}</span>
              </div>
            ) : null}
          </div>

          {/* Footer */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8,
            padding: "10px 14px",
            borderTop: `1px solid ${COLORS.border}`,
            marginTop: "auto",
          }}>
            <Dialog.Close asChild>
              <button style={outlineButton()} disabled={busy}>Cancel</button>
            </Dialog.Close>
            <button
              style={primaryButton({ opacity: canSubmit ? 1 : 0.4, cursor: canSubmit ? "pointer" : "not-allowed" })}
              disabled={!canSubmit}
              onClick={handleSubmit}
            >
              {busy ? "Importing..." : "Import branch"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
