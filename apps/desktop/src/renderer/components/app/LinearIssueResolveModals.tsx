import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowSquareOut, CircleNotch, GitBranch, Plus, Sparkle } from "@phosphor-icons/react";
import type { LaneLinearIssue, LaneSummary } from "../../../shared/types";
import { linearIssueBranchName, linearIssueLaneName } from "../../../shared/linearIssueBranch";
import { LaneDialogShell } from "../lanes/LaneDialogShell";
import { LinearMark, LinearPriorityIcon, LinearStateIcon, LINEAR_BRAND } from "../lanes/linearBrand";
import { issueProjectLabel } from "../lanes/LinearIssuePicker";
import { LaneCombobox } from "../terminals/LaneCombobox";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { useModelRecents } from "../shared/ModelPicker/useModelRecents";
import { Button } from "../ui/Button";
import { BranchIcon } from "../ui/vcsIcons";

function LinearIssueConfirmCard({ issue }: { issue: LaneLinearIssue }) {
  const branchName = linearIssueBranchName(issue);
  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: LINEAR_BRAND.borderSubtle, background: LINEAR_BRAND.surface }}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
        >
          <LinearMark size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <LinearPriorityIcon priority={issue.priority} size={12} />
            <LinearStateIcon stateType={issue.stateType} size={12} />
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/85">
              {issue.identifier}
            </span>
          </div>
          <div className="mt-1.5 text-[13px] font-semibold leading-snug text-fg">{issue.title}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-fg/65">
            <span>{issueProjectLabel(issue)}</span>
            <span className="opacity-35">·</span>
            <span>{issue.stateName}</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] text-muted-fg/75">
            <BranchIcon size={11} />
            {branchName}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModalFooter({
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  busy?: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 flex items-center justify-end gap-2 border-t border-white/[0.06] pt-4">
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      <Button type="button" variant="primary" disabled={busy} onClick={onConfirm}>
        {busy ? <CircleNotch size={14} className="animate-spin" /> : null}
        {confirmLabel}
      </Button>
    </div>
  );
}

function ModelPickerField({
  modelId,
  onModelChange,
}: {
  modelId: string;
  onModelChange: (modelId: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-muted-fg/70">Model</div>
      <ModelPicker
        value={modelId}
        onChange={onModelChange}
        surfaceKey="linear-issue-resolve"
        compact
        className="w-full"
        triggerClassName="w-full justify-between"
      />
      <p className="text-[11px] leading-relaxed text-muted-fg/55">
        The new chat opens in Work with this model selected.
      </p>
    </div>
  );
}

export function CreateLaneAttachedModal({
  open,
  issue,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  issue: LaneLinearIssue | null;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  if (!issue) return null;
  const laneName = linearIssueLaneName(issue);
  const branchName = linearIssueBranchName(issue);

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Create lane attached to issue"
      description="Creates a new lane with this Linear issue linked as the primary lane attachment."
      icon={Plus}
      widthClassName="w-[min(520px,calc(100vw-24px))]"
      busy={busy}
    >
      <LinearIssueConfirmCard issue={issue} />
      <div className="mt-4 space-y-2 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2.5 text-[11px] text-muted-fg/70">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-fg/50">Lane name</span>
          <span className="truncate text-right text-fg/85">{laneName}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-fg/50">Branch</span>
          <span className="truncate font-mono text-right text-[10.5px] text-fg/80">{branchName}</span>
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-fg/55">
        Opens the new lane in Lanes after creation. Start a chat from Work whenever you are ready.
      </p>
      <ModalFooter
        busy={busy}
        confirmLabel="Create lane"
        onCancel={() => onOpenChange(false)}
        onConfirm={() => void onConfirm()}
      />
    </LaneDialogShell>
  );
}

export function ResolveInNewLaneModal({
  open,
  issue,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  issue: LaneLinearIssue | null;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (modelId: string) => void | Promise<void>;
}) {
  const { recents } = useModelRecents();
  const [modelId, setModelId] = useState("");

  useEffect(() => {
    if (!open) return;
    setModelId((current) => current || recents[0] || "");
  }, [open, recents]);

  if (!issue) return null;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Resolve issue in new chat in new lane"
      description="Creates a lane attached to this issue, then opens Work with a new chat and the issue linked to that chat."
      icon={Sparkle}
      widthClassName="w-[min(520px,calc(100vw-24px))]"
      busy={busy}
    >
      <LinearIssueConfirmCard issue={issue} />
      <div className="mt-4">
        <ModelPickerField modelId={modelId} onModelChange={setModelId} />
      </div>
      <ModalFooter
        busy={busy}
        confirmLabel="Create lane and open chat"
        onCancel={() => onOpenChange(false)}
        onConfirm={() => {
          if (!modelId.trim()) return;
          void onConfirm(modelId.trim());
        }}
      />
    </LaneDialogShell>
  );
}

export function ResolveInExistingLaneModal({
  open,
  issue,
  lanes,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  issue: LaneLinearIssue | null;
  lanes: LaneSummary[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (laneId: string, modelId: string) => void | Promise<void>;
}) {
  const { recents } = useModelRecents();
  const selectableLanes = useMemo(
    () => lanes.filter((lane) => lane.laneType !== "primary"),
    [lanes],
  );
  const [laneId, setLaneId] = useState("");
  const [modelId, setModelId] = useState("");

  useEffect(() => {
    if (!open) return;
    setLaneId((current) => (
      current && selectableLanes.some((lane) => lane.id === current)
        ? current
        : selectableLanes[0]?.id ?? ""
    ));
    setModelId((current) => current || recents[0] || "");
  }, [open, recents, selectableLanes]);

  if (!issue) return null;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Resolve issue in new chat in existing lane"
      description="Opens Work with a new chat in the lane you choose. The issue links to that chat only, not the lane itself."
      icon={GitBranch}
      widthClassName="w-[min(520px,calc(100vw-24px))]"
      busy={busy}
    >
      <LinearIssueConfirmCard issue={issue} />
      <div className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-fg/70">Lane</div>
          {selectableLanes.length > 0 ? (
            <LaneCombobox
              lanes={selectableLanes}
              value={laneId}
              onChange={setLaneId}
              fullWidth
              aria-label="Select lane"
            />
          ) : (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-100/90">
              No lanes available yet. Create a lane first or use the new-lane option.
            </div>
          )}
        </div>
        <ModelPickerField modelId={modelId} onModelChange={setModelId} />
      </div>
      <ModalFooter
        busy={busy}
        confirmLabel="Open chat in lane"
        onCancel={() => onOpenChange(false)}
        onConfirm={() => {
          if (!laneId.trim() || !modelId.trim() || !selectableLanes.length) return;
          void onConfirm(laneId.trim(), modelId.trim());
        }}
      />
    </LaneDialogShell>
  );
}

function BatchIssueList({ issues }: { issues: LaneLinearIssue[] }) {
  return (
    <div className="max-h-48 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/20">
      {issues.map((issue) => (
        <div key={issue.id} className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-1.5 last:border-b-0">
          <LinearPriorityIcon priority={issue.priority} size={11} />
          <LinearStateIcon stateType={issue.stateType} size={11} />
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">{issue.identifier}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg/85">{issue.title}</span>
        </div>
      ))}
    </div>
  );
}

export function BatchCreateLanesModal({
  open,
  issues,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  issues: LaneLinearIssue[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  if (!issues.length) return null;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={`Create ${issues.length} lanes`}
      description="Creates a new lane for each selected issue with the issue linked as the primary lane attachment."
      icon={Plus}
      widthClassName="w-[min(560px,calc(100vw-24px))]"
      busy={busy}
    >
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-muted-fg/70">{issues.length} issues selected</div>
        <BatchIssueList issues={issues} />
      </div>
      <ModalFooter
        busy={busy}
        confirmLabel={`Create ${issues.length} lanes`}
        onCancel={() => onOpenChange(false)}
        onConfirm={onConfirm}
      />
    </LaneDialogShell>
  );
}

export function BatchResolveInNewLanesModal({
  open,
  issues,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  issues: LaneLinearIssue[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (modelId: string) => void;
}) {
  const { recents } = useModelRecents();
  const [modelId, setModelId] = useState("");

  useEffect(() => {
    if (!open) return;
    setModelId((current) => current || recents[0] || "");
  }, [open, recents]);

  if (!issues.length) return null;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={`Create ${issues.length} lanes and open chats`}
      description="Creates a lane for each selected issue, then opens Work with a new chat for each."
      icon={Sparkle}
      widthClassName="w-[min(560px,calc(100vw-24px))]"
      busy={busy}
    >
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-muted-fg/70">{issues.length} issues selected</div>
        <BatchIssueList issues={issues} />
      </div>
      <div className="mt-4">
        <ModelPickerField modelId={modelId} onModelChange={setModelId} />
      </div>
      <ModalFooter
        busy={busy}
        confirmLabel="Create lanes and open chats"
        onCancel={() => onOpenChange(false)}
        onConfirm={() => {
          if (!modelId.trim()) return;
          void onConfirm(modelId.trim());
        }}
      />
    </LaneDialogShell>
  );
}

export function BatchResolveInExistingLaneModal({
  open,
  issues,
  lanes,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  issues: LaneLinearIssue[];
  lanes: LaneSummary[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (laneId: string, modelId: string) => void;
}) {
  const { recents } = useModelRecents();
  const selectableLanes = useMemo(
    () => lanes.filter((lane) => lane.laneType !== "primary"),
    [lanes],
  );
  const [laneId, setLaneId] = useState("");
  const [modelId, setModelId] = useState("");

  useEffect(() => {
    if (!open) return;
    setLaneId((current) => (
      current && selectableLanes.some((lane) => lane.id === current)
        ? current
        : selectableLanes[0]?.id ?? ""
    ));
    setModelId((current) => current || recents[0] || "");
  }, [open, recents, selectableLanes]);

  if (!issues.length) return null;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={`Open ${issues.length} chats in existing lane`}
      description="Opens Work with a new chat for each selected issue in the lane you choose."
      icon={GitBranch}
      widthClassName="w-[min(560px,calc(100vw-24px))]"
      busy={busy}
    >
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-muted-fg/70">{issues.length} issues selected</div>
        <BatchIssueList issues={issues} />
      </div>
      <div className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-fg/70">Lane</div>
          {selectableLanes.length > 0 ? (
            <LaneCombobox
              lanes={selectableLanes}
              value={laneId}
              onChange={setLaneId}
              fullWidth
              aria-label="Select lane"
            />
          ) : (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-100/90">
              No lanes available yet. Create a lane first or use the new-lane option.
            </div>
          )}
        </div>
        <ModelPickerField modelId={modelId} onModelChange={setModelId} />
      </div>
      <ModalFooter
        busy={busy}
        confirmLabel="Open chats in lane"
        onCancel={() => onOpenChange(false)}
        onConfirm={() => {
          if (!laneId.trim() || !modelId.trim() || !selectableLanes.length) return;
          void onConfirm(laneId.trim(), modelId.trim());
        }}
      />
    </LaneDialogShell>
  );
}

export function openLinearIssueExternalUrl(url: string | null | undefined): void {
  if (!url) return;
  void window.ade.app.openExternal(url);
}

export function LinearIssueOpenLink({
  url,
}: {
  url: string | null | undefined;
}) {
  if (!url) return null;
  return (
    <button
      type="button"
      className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-white/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-muted-fg/70 transition-colors hover:border-white/[0.12] hover:bg-white/[0.03] hover:text-fg/85"
      onClick={() => openLinearIssueExternalUrl(url)}
    >
      <ArrowSquareOut size={13} />
      Open in Linear
    </button>
  );
}

export type LinearIssueResolveModalKind =
  | "create-lane"
  | "resolve-new-lane"
  | "resolve-existing-lane";

export function useLinearIssueResolveModalState() {
  const [activeModal, setActiveModal] = useState<LinearIssueResolveModalKind | null>(null);
  const [activeIssue, setActiveIssue] = useState<LaneLinearIssue | null>(null);

  const openModal = useCallback((kind: LinearIssueResolveModalKind, issue: LaneLinearIssue) => {
    setActiveIssue(issue);
    setActiveModal(kind);
  }, []);

  const closeModal = useCallback(() => {
    setActiveModal(null);
  }, []);

  return {
    activeModal,
    activeIssue,
    openModal,
    closeModal,
  };
}
