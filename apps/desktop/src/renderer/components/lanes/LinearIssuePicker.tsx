import React from "react";
import { ArrowSquareOut, CaretDown, Check, CircleNotch, MagnifyingGlass, X } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type {
  CtoGetLinearIssuePickerDataResult,
  LaneLinearIssue,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { linearIssueBranchName } from "../../../shared/linearIssueBranch";
import { formatRelativeTime } from "./branchPickerSearch";
import type { LaneBranchOption } from "./laneUtils";
import { LABEL_CLASS_NAME } from "./laneDialogTokens";
import { LinearMark, LinearPriorityIcon, LinearStateIcon, LINEAR_BRAND } from "./linearBrand";

const ACTIVE_LINEAR_STATE_TYPES = ["backlog", "unstarted", "started"] as const;

// Re-exported so existing callers (ChatAttachmentTray, AgentChatComposer)
// keep working without updating their imports.
export { LinearMark } from "./linearBrand";

const PRIORITY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Any priority" },
  { value: "1", label: "Urgent" },
  { value: "2", label: "High" },
  { value: "3", label: "Medium" },
  { value: "4", label: "Low" },
  { value: "0", label: "No priority" },
];

const STATE_PRESET_LABELS: Record<string, string> = {
  active: "Active",
  all: "All states",
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In progress",
  completed: "Done",
  canceled: "Canceled",
  triage: "Triage",
};

export function linearPriorityLabel(issue: Pick<NormalizedLinearIssue | LaneLinearIssue, "priorityLabel" | "priority">): string {
  if (issue.priorityLabel === "none" || !issue.priorityLabel) return "No priority";
  return issue.priorityLabel[0]!.toUpperCase() + issue.priorityLabel.slice(1);
}

export function issueProjectLabel(issue: Pick<NormalizedLinearIssue | LaneLinearIssue, "projectName" | "projectSlug" | "teamKey">): string {
  return issue.projectName?.trim() || issue.projectSlug || issue.teamKey;
}

export function issueUpdatedLabel(issue: Pick<NormalizedLinearIssue | LaneLinearIssue, "updatedAt">): string {
  return formatRelativeTime(issue.updatedAt) || "Updated recently";
}

export function toLaneLinearIssue(issue: NormalizedLinearIssue): LaneLinearIssue {
  const branchName = linearIssueBranchName(issue);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    projectId: issue.projectId,
    projectSlug: issue.projectSlug,
    projectName: issue.projectName ?? null,
    teamId: issue.teamId,
    teamKey: issue.teamKey,
    teamName: issue.teamName ?? null,
    stateId: issue.stateId,
    stateName: issue.stateName,
    stateType: issue.stateType,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    labels: issue.labels,
    assigneeId: issue.assigneeId,
    assigneeName: issue.assigneeName,
    creatorId: issue.creatorId ?? null,
    creatorName: issue.creatorName ?? null,
    dueDate: issue.dueDate ?? null,
    estimate: issue.estimate ?? null,
    branchName,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function isLaneLinearIssue(issue: NormalizedLinearIssue | LaneLinearIssue): issue is LaneLinearIssue {
  return !("raw" in issue);
}

export function branchExistsForLinearIssue(branchName: string, branches: LaneBranchOption[]): boolean {
  const normalized = branchName.trim().toLowerCase();
  if (!normalized) return false;
  return branches.some((branch) => {
    const candidate = branch.name.trim().toLowerCase();
    const withoutRemote = candidate.replace(/^[^/]+\//, "");
    return candidate === normalized || withoutRemote === normalized;
  });
}

function LinearIdentifierTag({ identifier, size = "sm" }: { identifier: string; size?: "xs" | "sm" }) {
  const fontSize = size === "xs" ? 9.5 : 10.5;
  return (
    <span
      className="shrink-0 rounded font-mono font-semibold"
      style={{
        fontSize,
        color: LINEAR_BRAND.text,
        background: LINEAR_BRAND.surface,
        padding: size === "xs" ? "1px 4px" : "1.5px 5px",
        letterSpacing: "0.02em",
      }}
    >
      {identifier}
    </span>
  );
}

export function LinearIssueSummaryCard({
  issue,
  branchName,
  branchConflict,
  onClear,
}: {
  issue: LaneLinearIssue;
  branchName: string;
  branchConflict: boolean;
  onClear: () => void;
}) {
  return (
    <div
      className="mt-2 rounded-lg border p-3"
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
          <div className="flex items-center gap-2">
            <LinearPriorityIcon priority={issue.priority} size={12} />
            <LinearStateIcon stateType={issue.stateType} size={12} />
            <LinearIdentifierTag identifier={issue.identifier} />
            <span className="truncate text-sm font-semibold text-fg">{issue.title}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-fg/65">
            <span>{issueProjectLabel(issue)}</span>
            <span className="opacity-40">·</span>
            <span>{issue.stateName}</span>
            {issue.assigneeName ? (
              <>
                <span className="opacity-40">·</span>
                <span>{issue.assigneeName}</span>
              </>
            ) : null}
          </div>
          <div
            className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px]"
            style={{ color: branchConflict ? "#FBBF24" : "rgba(148, 163, 184, 0.85)" }}
          >
            <span className="opacity-60">branch</span>
            <span className="text-fg/85">{branchName}</span>
            {branchConflict ? <span className="opacity-80">already exists</span> : null}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-muted-fg/60 transition-colors hover:bg-white/[0.06] hover:text-fg"
          onClick={onClear}
          aria-label="Disconnect Linear issue"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function LinearIssueRow({
  issue,
  active,
  eyebrow,
  busy,
  onClick,
}: {
  issue: NormalizedLinearIssue | LaneLinearIssue;
  active: boolean;
  eyebrow?: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2.5 border-b border-white/[0.04] px-3 py-2 text-left transition-colors last:border-b-0 disabled:opacity-50"
      style={active ? { background: LINEAR_BRAND.surface } : undefined}
      onMouseEnter={(event) => {
        if (!active) (event.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(event) => {
        if (!active) (event.currentTarget as HTMLButtonElement).style.background = "";
      }}
      onClick={onClick}
      disabled={busy}
    >
      <span className="flex w-3.5 shrink-0 justify-center">
        <LinearPriorityIcon priority={issue.priority} size={13} />
      </span>
      <span className="flex w-3.5 shrink-0 justify-center">
        <LinearStateIcon stateType={issue.stateType} size={13} />
      </span>
      <LinearIdentifierTag identifier={issue.identifier} />
      <span className="min-w-0 flex-1">
        {eyebrow ? (
          <span
            className="mb-0.5 block font-mono text-[9px] font-bold uppercase tracking-[0.14em]"
            style={{ color: LINEAR_BRAND.textMuted }}
          >
            {eyebrow}
          </span>
        ) : null}
        <span className="block truncate text-[13px] text-fg">{issue.title}</span>
      </span>
      <span className="hidden shrink-0 items-center gap-2 text-[10.5px] text-muted-fg/55 sm:flex">
        {issue.assigneeName ? (
          <span
            className="grid h-5 w-5 place-items-center rounded-full bg-white/[0.07] text-[9px] font-semibold uppercase text-muted-fg/85"
            title={issue.assigneeName}
          >
            {issue.assigneeName.slice(0, 1)}
          </span>
        ) : null}
        <span className="tabular-nums">{issueUpdatedLabel(issue)}</span>
      </span>
    </button>
  );
}

function FilterPill({
  label,
  value,
  options,
  onChange,
  busy,
  width = "8.5rem",
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  busy?: boolean;
  width?: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <span className="relative inline-flex">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={busy}
        className="appearance-none rounded-full border bg-transparent pr-7 text-[11px] text-fg outline-none transition-colors disabled:opacity-60"
        aria-label={label}
        style={{
          height: 28,
          paddingLeft: 12,
          minWidth: width,
          borderColor: "rgba(255,255,255,0.08)",
          backgroundColor: "rgba(255,255,255,0.03)",
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <CaretDown
        size={9}
        weight="bold"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-fg/60"
      />
      {/* Visually-hidden label for screen readers */}
      <span className="sr-only">
        {label}: {selected?.label ?? value}
      </span>
    </span>
  );
}

export function LinearIssuePickerView({
  selectedIssue,
  pinnedIssue,
  pinnedIssueLabel = "Linked to this lane",
  onSelect,
  onBack,
  busy,
  selectOnIssueClick = false,
  submitLabel = "Connect issue",
}: {
  selectedIssue: LaneLinearIssue | null;
  pinnedIssue?: LaneLinearIssue | null;
  pinnedIssueLabel?: string;
  onSelect: (issue: LaneLinearIssue) => void;
  onBack: () => void;
  busy?: boolean;
  selectOnIssueClick?: boolean;
  submitLabel?: string;
}) {
  const [catalog, setCatalog] = React.useState<CtoGetLinearIssuePickerDataResult>({
    projects: [],
    users: [],
    states: [],
  });
  const [projectId, setProjectId] = React.useState("");
  const [statePreset, setStatePreset] = React.useState<"active" | "all" | string>("active");
  const [assigneeId, setAssigneeId] = React.useState("");
  const [priority, setPriority] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [issues, setIssues] = React.useState<NormalizedLinearIssue[]>([]);
  const [pendingIssue, setPendingIssue] = React.useState<NormalizedLinearIssue | LaneLinearIssue | null>(pinnedIssue ?? null);
  const [pageInfo, setPageInfo] = React.useState<{ hasNextPage: boolean; endCursor: string | null }>({
    hasNextPage: false,
    endCursor: null,
  });
  const pageInfoRef = React.useRef(pageInfo);
  const [loadingCatalog, setLoadingCatalog] = React.useState(false);
  const [loadingIssues, setLoadingIssues] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestIdRef = React.useRef(0);

  React.useEffect(() => {
    pageInfoRef.current = pageInfo;
  }, [pageInfo]);

  React.useEffect(() => {
    setPendingIssue((current) => current ?? pinnedIssue ?? null);
  }, [pinnedIssue]);

  React.useEffect(() => {
    let cancelled = false;
    const cto = window.ade.cto;
    if (!cto) {
      setError("Linear controls are not available in this ADE surface.");
      return () => {
        cancelled = true;
      };
    }
    setLoadingCatalog(true);
    setError(null);
    cto.getLinearIssuePickerData()
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        if (data.projects.length === 1) setProjectId(data.projects[0].id);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load Linear issue filters.");
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stateTypes = React.useMemo(() => {
    if (statePreset === "all") return [];
    if (statePreset === "active") return [...ACTIVE_LINEAR_STATE_TYPES];
    return [statePreset];
  }, [statePreset]);

  const searchIssues = React.useCallback(async (append: boolean) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoadingIssues(true);
    setError(null);
    try {
      const cto = window.ade.cto;
      if (!cto) throw new Error("Linear controls are not available in this ADE surface.");
      const result = await cto.searchLinearIssues({
        projectId: projectId || null,
        stateTypes,
        assigneeId: assigneeId || null,
        priority: priority ? Number(priority) : null,
        query: query.trim() || null,
        first: 50,
        after: append ? pageInfoRef.current.endCursor : null,
      });
      if (requestIdRef.current !== requestId) return;
      setIssues((current) => append ? [...current, ...result.issues] : result.issues);
      setPageInfo(result.pageInfo);
      setPendingIssue((current) => {
        if (append && current) {
          return current;
        }
        if (current && result.issues.some((issue) => issue.id === current.id)) {
          return current;
        }
        const selectedMatch = selectedIssue
          ? result.issues.find((issue) => issue.id === selectedIssue.id) ?? null
          : null;
        return pinnedIssue ?? selectedMatch ?? result.issues[0] ?? null;
      });
    } catch (err) {
      if (requestIdRef.current === requestId) {
        setError(err instanceof Error ? err.message : "Unable to search Linear issues.");
      }
    } finally {
      if (requestIdRef.current === requestId) setLoadingIssues(false);
    }
  }, [assigneeId, priority, projectId, query, selectedIssue, stateTypes, pinnedIssue]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void searchIssues(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [searchIssues]);

  const selectedProject = catalog.projects.find((project) => project.id === projectId) ?? null;
  const issueForDetails = pendingIssue ?? selectedIssue;

  const projectOptions = React.useMemo(
    () => [
      { value: "", label: "All projects" },
      ...catalog.projects.map((project) => ({
        value: project.id,
        label: project.teamName ? `${project.name} · ${project.teamName}` : project.name,
      })),
    ],
    [catalog.projects],
  );

  const assigneeOptions = React.useMemo(
    () => [
      { value: "", label: "Anyone" },
      ...catalog.users.map((user) => ({
        value: user.id,
        label: user.displayName ?? user.name,
      })),
    ],
    [catalog.users],
  );

  const stateOptions = React.useMemo(() => {
    const seen = new Set<string>();
    const presetEntries = [
      { value: "active", label: STATE_PRESET_LABELS.active! },
      { value: "all", label: STATE_PRESET_LABELS.all! },
    ];
    const dynamic = catalog.states
      .filter((state) => {
        if (seen.has(state.type)) return false;
        seen.add(state.type);
        return true;
      })
      .sort((left, right) => left.type.localeCompare(right.type))
      .map((state) => ({
        value: state.type,
        label: STATE_PRESET_LABELS[state.type] ?? state.type,
      }));
    return [...presetEntries, ...dynamic];
  }, [catalog.states]);

  const handleChooseIssue = React.useCallback((issue: NormalizedLinearIssue | LaneLinearIssue) => {
    if (selectOnIssueClick) {
      onSelect(isLaneLinearIssue(issue) ? issue : toLaneLinearIssue(issue));
      onBack();
      return;
    }
    setPendingIssue(issue);
  }, [onBack, onSelect, selectOnIssueClick]);

  return (
    <div className="flex min-h-[560px] flex-col">
      {/* Linear-branded header banner — establishes context */}
      <div
        className="mb-3 flex items-center gap-2.5 rounded-lg border px-3 py-2"
        style={{ borderColor: LINEAR_BRAND.borderSubtle, background: LINEAR_BRAND.surface }}
      >
        <span
          className="flex h-6 w-6 items-center justify-center rounded-md"
          style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
        >
          <LinearMark size={13} />
        </span>
        <span className="text-[12px] font-medium" style={{ color: LINEAR_BRAND.text }}>
          Linear
        </span>
        <span className="text-[11px] text-muted-fg/55">Connect this lane to an issue and we'll auto-name the branch.</span>
      </div>

      {pinnedIssue ? (
        <div
          className="mb-3 overflow-hidden rounded-lg border"
          style={{ borderColor: LINEAR_BRAND.borderSubtle }}
        >
          <LinearIssueRow
            issue={pinnedIssue}
            active={issueForDetails?.id === pinnedIssue.id}
            eyebrow={pinnedIssueLabel}
            busy={busy}
            onClick={() => handleChooseIssue(pinnedIssue)}
          />
        </div>
      ) : null}

      {/* Search row — single dominant input, loader inline */}
      <div className="relative">
        <MagnifyingGlass size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-fg/55" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-10 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] pl-9 pr-9 text-sm text-fg outline-none transition-colors placeholder:text-muted-fg/55 focus:border-white/15"
          placeholder="Search issues by title, description, or identifier"
          disabled={busy}
        />
        {loadingCatalog || loadingIssues ? (
          <CircleNotch size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-fg/60" />
        ) : null}
      </div>

      {/* Linear-style filter pill row */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <FilterPill
          label="State"
          value={statePreset}
          options={stateOptions}
          onChange={setStatePreset}
          busy={busy}
          width="7rem"
        />
        <FilterPill
          label="Priority"
          value={priority}
          options={PRIORITY_OPTIONS}
          onChange={setPriority}
          busy={busy}
          width="8rem"
        />
        <FilterPill
          label="Project"
          value={projectId}
          options={projectOptions}
          onChange={setProjectId}
          busy={busy || loadingCatalog}
          width="10rem"
        />
        <FilterPill
          label="Assignee"
          value={assigneeId}
          options={assigneeOptions}
          onChange={setAssigneeId}
          busy={busy || loadingCatalog}
          width="8rem"
        />
      </div>

      {error ? (
        <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {/* List + detail */}
      <div className="mt-3 grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-h-0 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/20">
          {issues.length === 0 && !loadingIssues ? (
            <div className="px-4 py-12 text-center text-sm text-muted-fg/55">
              No Linear issues match these filters.
            </div>
          ) : null}
          {issues.map((issue) => {
            const active = pendingIssue?.id === issue.id || (!pendingIssue && selectedIssue?.id === issue.id);
            return (
              <LinearIssueRow
                key={issue.id}
                issue={issue}
                active={active}
                busy={busy}
                onClick={() => handleChooseIssue(issue)}
              />
            );
          })}
          {pageInfo.hasNextPage ? (
            <div className="px-3 py-2.5">
              <Button
                variant="outline"
                disabled={busy || loadingIssues}
                onClick={() => void searchIssues(true)}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </div>

        <aside className="overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]">
          {issueForDetails ? (
            <div className="flex h-full flex-col">
              <div className="border-b border-white/[0.05] p-3">
                <div className="flex items-center gap-2">
                  <LinearPriorityIcon priority={issueForDetails.priority} size={12} />
                  <LinearStateIcon stateType={issueForDetails.stateType} size={12} />
                  <LinearIdentifierTag identifier={issueForDetails.identifier} />
                </div>
                <div className="mt-2 text-[13px] font-semibold leading-snug text-fg">{issueForDetails.title}</div>
              </div>
              <div className="space-y-2 px-3 py-3 text-[11.5px]">
                <DetailRow label="Project" value={selectedProject?.name ?? issueProjectLabel(issueForDetails)} />
                <DetailRow label="Team" value={issueForDetails.teamName ?? issueForDetails.teamKey} />
                <DetailRow label="Status" value={issueForDetails.stateName} />
                <DetailRow label="Priority" value={linearPriorityLabel(issueForDetails)} />
                <DetailRow label="Assignee" value={issueForDetails.assigneeName ?? "Unassigned"} />
                {issueForDetails.estimate != null ? (
                  <DetailRow label="Estimate" value={String(issueForDetails.estimate)} />
                ) : null}
                {issueForDetails.dueDate ? <DetailRow label="Due" value={issueForDetails.dueDate} /> : null}
                <DetailRow label="Updated" value={issueUpdatedLabel(issueForDetails)} />
              </div>
              {issueForDetails.labels.length > 0 ? (
                <div className="border-t border-white/[0.05] px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {issueForDetails.labels.slice(0, 6).map((label) => (
                      <span
                        key={label}
                        className="rounded-full px-2 py-0.5 text-[10px] text-muted-fg/80"
                        style={{ background: "rgba(255,255,255,0.04)" }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="mt-auto border-t border-white/[0.05] px-3 py-2.5">
                <div className={LABEL_CLASS_NAME}>Branch</div>
                <div
                  className="mt-1 truncate rounded font-mono text-[10.5px] text-fg/85"
                  style={{ background: "rgba(0,0,0,0.30)", padding: "5px 7px" }}
                  title={linearIssueBranchName(issueForDetails)}
                >
                  {linearIssueBranchName(issueForDetails)}
                </div>
                {issueForDetails.url ? (
                  <button
                    type="button"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium transition-colors hover:opacity-80"
                    style={{ color: LINEAR_BRAND.primaryBright }}
                    onClick={() => window.ade.app.openExternal(issueForDetails.url!)}
                  >
                    <ArrowSquareOut size={11} weight="bold" /> Open in Linear
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center px-4 py-10 text-center text-[12px] text-muted-fg/55">
              Select an issue to preview
            </div>
          )}
        </aside>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
        <Button variant="outline" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          disabled={busy || !pendingIssue}
          onClick={() => {
            if (!pendingIssue) return;
            onSelect(isLaneLinearIssue(pendingIssue) ? pendingIssue : toLaneLinearIssue(pendingIssue));
            onBack();
          }}
        >
          <Check size={14} /> {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10.5px] uppercase tracking-[0.10em] text-muted-fg/45">{label}</span>
      <span className="truncate text-right text-fg/85" title={value}>{value}</span>
    </div>
  );
}
