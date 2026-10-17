import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  CaretDown,
  ChatCircleText,
  Check,
  CircleNotch,
  DeviceMobile,
  FileText,
  GitBranch,
  GitCommit,
  GitPullRequest,
  ImageSquare,
  Kanban,
  LinkSimple,
  Pulse,
  Stack,
  Warning,
} from "@phosphor-icons/react";

import {
  CUSTOM_NOTIFICATION_BODY_MAX,
  CUSTOM_NOTIFICATION_HOURLY_LIMIT,
  CUSTOM_NOTIFICATION_TITLE_MAX,
  describeCustomNotificationResult,
} from "../../../../shared/types/attention";
import { WORK_BOARD_COLUMN_LABEL, WORK_BOARD_COLUMNS } from "../../../../shared/types/chat";
import type { LaneSummary, OpenProjectBinding, PrSummary, TerminalSessionSummary } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { cn } from "../../ui/cn";
import { inputCls, labelCls } from "../designTokens";
import type { AdeActionValue } from "../AdeActionEditor";
import {
  buildNotifyLink,
  checkNotifyLink,
  hasVariable,
  NOTIFY_LINK_PHONE_EFFECT,
  readNotifyLink,
  type NotifyLink,
  type NotifyLinkFields,
  type NotifyLinkKind,
} from "../notifyLink";
import { variablesForTrigger } from "../variableCatalog";
import { VariableInput } from "./VariableMenu";
import { explainAutomationActionError } from "../../../../shared/automationFeatureVersions";

/**
 * A test send has no trigger to fill `{{…}}` values from, so each one is shown
 * as its name ("‹PR number›") rather than as braces on the lock screen.
 */
function withVariableNames(text: string, triggerType: string): string {
  const labels = new Map([
    ...variablesForTrigger(triggerType).flatMap((group) => group.variables.map((v) => [v.token, v.label] as const)),
    ...RUN_VALUES.map((entry) => [entry.value, entry.label] as const),
  ]);
  return text.replace(/\{\{[^}]*\}\}/g, (token) => {
    const normalized = token.replace(/\s+/g, "");
    const label = labels.get(normalized) ?? normalized.replace(/[{}]/g, "").split(".").pop() ?? "value";
    return `‹${label}›`;
  });
}

/**
 * Things the run makes before this step, filled in as it goes. A run that
 * never made one (its agent step failed first) sends the notification
 * without the link.
 */
const RUN_CHAT = { label: "The chat this run started", value: "{{run.chatSessionId}}" };
const RUN_LANE = { label: "The lane this run used", value: "{{run.laneId}}" };
const RUN_VALUES = [RUN_CHAT, RUN_LANE];

type Choice = { kind: NotifyLinkKind; label: string; icon: typeof Bell };

const PHONE_CHOICES: Choice[] = [
  { kind: "none", label: "Just open ADE", icon: DeviceMobile },
  { kind: "activity", label: "Activity", icon: Pulse },
  { kind: "chat", label: "A chat", icon: ChatCircleText },
  { kind: "pr", label: "A pull request", icon: GitPullRequest },
  { kind: "linear", label: "A Linear issue", icon: Kanban },
];

const COMPUTER_CHOICES: Choice[] = [
  { kind: "lane", label: "A lane", icon: Stack },
  { kind: "file", label: "A file", icon: FileText },
  { kind: "commit", label: "A commit", icon: GitCommit },
  { kind: "branch", label: "A branch", icon: GitBranch },
  { kind: "proof", label: "Proof", icon: ImageSquare },
];

type PickOption = { value: string; label: string; detail?: string; also?: NotifyLinkFields };

function isSessionTrigger(triggerType: string): boolean {
  return triggerType.startsWith("session.") || triggerType === "session-end";
}

function isPrTrigger(triggerType: string): boolean {
  return /^(github|git)\.pr_/.test(triggerType) || triggerType === "lane.merged";
}

function isLaneTrigger(triggerType: string): boolean {
  return triggerType.startsWith("lane.") || triggerType.startsWith("git.") || triggerType === "file.change"
    || isSessionTrigger(triggerType);
}

/** A field with a "Choose…" list and one-click trigger values beside it. */
function PickField({
  label,
  hint,
  value,
  placeholder,
  options,
  optionsLoading,
  triggerValues,
  triggerType,
  onChange,
  onPick,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder: string;
  options?: PickOption[];
  optionsLoading?: boolean;
  triggerValues?: Array<{ label: string; value: string }>;
  triggerType: string;
  onChange: (next: string) => void;
  onPick?: (option: PickOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = options ?? [];
    return needle
      ? list.filter((option) => `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(needle))
      : list;
  }, [options, query]);
  const picked = options?.find((option) => option.value === value);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className={labelCls}>{label}</span>
        {hint ? <span className="text-[10px] text-muted-fg/55">{hint}</span> : null}
      </div>
      <div className="flex gap-1.5">
        <div className="min-w-0 flex-1">
          <VariableInput
            value={value}
            onChange={onChange}
            triggerType={triggerType}
            placeholder={placeholder}
            className="font-mono text-[11.5px]"
          />
        </div>
        {options ? (
          <button
            ref={anchorRef}
            type="button"
            onClick={() => setOpen((current) => !current)}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
              open
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-fg/[0.08] bg-fg/[0.03] text-fg/85 hover:border-accent/30",
            )}
          >
            Choose
            <CaretDown size={9} weight="bold" />
          </button>
        ) : null}
      </div>
      {picked ? (
        <div className="text-[10.5px] text-muted-fg/70">
          <Check size={10} weight="bold" className="mr-1 inline text-emerald-400" />
          {picked.label}
          {picked.detail ? <span className="text-muted-fg/50"> · {picked.detail}</span> : null}
        </div>
      ) : null}
      {triggerValues && triggerValues.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-fg/55">From the trigger:</span>
          {triggerValues.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => onChange(entry.value)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10.5px] transition-colors",
                value === entry.value
                  ? "border-accent/45 bg-accent/12 text-accent"
                  : "border-fg/[0.08] text-muted-fg/80 hover:border-accent/30 hover:text-fg",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        className="w-[340px] rounded-lg border border-fg/[0.08] bg-surface-overlay p-1 shadow-float"
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          className={cn(inputCls, "mb-1 h-7")}
        />
        <div className="max-h-[260px] overflow-y-auto">
          {optionsLoading ? (
            <div className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-muted-fg/60">
              <CircleNotch size={11} className="animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-muted-fg/60">Nothing to choose from here.</div>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  onPick?.(option);
                  setOpen(false);
                  setQuery("");
                }}
                className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-fg/[0.05]"
              >
                <span className="w-full truncate text-[11.5px] text-fg">{option.label}</span>
                {option.detail ? (
                  <span className="w-full truncate text-[10px] text-muted-fg/55">{option.detail}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </AnchoredMenu>
    </div>
  );
}

function CountedField({
  label,
  hint,
  value,
  max,
  placeholder,
  triggerType,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  max: number;
  placeholder: string;
  triggerType: string;
  onChange: (next: string) => void;
}) {
  const length = value.trim().length;
  const over = length > max;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className={labelCls}>
          {label}
          {hint ? <span className="ml-1.5 normal-case tracking-normal text-muted-fg/45">{hint}</span> : null}
        </span>
        <span className={cn("font-mono text-[10px]", over ? "text-red-300" : "text-muted-fg/50")}>
          {length}/{max}
          {hasVariable(value) ? " before variables" : ""}
        </span>
      </div>
      <VariableInput
        value={value}
        onChange={onChange}
        triggerType={triggerType}
        placeholder={placeholder}
        className={over ? "border-red-400/50" : undefined}
      />
    </div>
  );
}

function ChoiceGrid({
  title,
  choices,
  selected,
  onSelect,
}: {
  title: string;
  choices: Choice[];
  selected: NotifyLinkKind;
  onSelect: (kind: NotifyLinkKind) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] text-muted-fg/55">{title}</div>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-5">
        {choices.map((choice) => {
          const Icon = choice.icon;
          const active = choice.kind === selected;
          return (
            <button
              key={choice.kind}
              type="button"
              role="radio"
              aria-checked={active}
              data-notify-link-kind={choice.kind}
              onClick={() => onSelect(choice.kind)}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
                active
                  ? "border-accent/45 bg-accent/10 text-fg"
                  : "border-fg/[0.07] bg-fg/[0.02] text-muted-fg/85 hover:border-fg/[0.16] hover:text-fg",
              )}
            >
              <Icon size={12} weight={active ? "fill" : "regular"} className={active ? "text-accent" : undefined} />
              <span className="truncate">{choice.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The chats, pull requests, lanes and branches to choose from, read from the
 * machine the rule runs on. The sender stamps that machine onto a chat or PR
 * link, so a chat chosen from this window's machine while the rule runs on
 * another would open on the wrong one.
 */
function useProjectChoices(kind: NotifyLinkKind, pin: OpenProjectBinding | null) {
  const windowLanes = useAppStore((state) => state.lanes);
  const [pinnedLanes, setPinnedLanes] = useState<LaneSummary[] | null>(null);
  const [sessions, setSessions] = useState<TerminalSessionSummary[] | null>(null);
  const [prs, setPrs] = useState<PrSummary[] | null>(null);
  const wantsSessions = kind === "chat";
  const wantsPrs = kind === "pr" || kind === "branch";
  const wantsLanes = kind === "lane" || kind === "file" || kind === "commit" || kind === "branch";
  const lanes = useMemo(() => (pin ? pinnedLanes ?? [] : windowLanes), [pin, pinnedLanes, windowLanes]);

  // A different machine has different everything: read it again. Keyed on the
  // binding's value, so a rebuilt but equal pin does not refetch.
  const pinKey = pin ? JSON.stringify(pin) : "";
  useEffect(() => {
    setPinnedLanes(null);
    setSessions(null);
    setPrs(null);
  }, [pinKey]);

  useEffect(() => {
    if (!pin || !wantsLanes || pinnedLanes) return;
    let cancelled = false;
    void window.ade.lanes.list({ includeArchived: false, includeStatus: false }, pin)
      .then((rows) => { if (!cancelled) setPinnedLanes(rows); })
      .catch(() => { if (!cancelled) setPinnedLanes([]); });
    return () => { cancelled = true; };
  }, [pin, pinnedLanes, wantsLanes]);

  useEffect(() => {
    if (!wantsSessions || sessions) return;
    let cancelled = false;
    void window.ade.sessions.list({ limit: 60 }, pin)
      .then((rows) => { if (!cancelled) setSessions(rows); })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => { cancelled = true; };
  }, [pin, sessions, wantsSessions]);

  useEffect(() => {
    if (!wantsPrs || prs) return;
    let cancelled = false;
    void window.ade.prs.listAll(pin)
      .then((rows) => { if (!cancelled) setPrs(rows); })
      .catch(() => { if (!cancelled) setPrs([]); });
    return () => { cancelled = true; };
  }, [pin, prs, wantsPrs]);

  const laneOptions: PickOption[] = useMemo(
    () => lanes
      .filter((lane) => !lane.archivedAt)
      .map((lane) => ({ value: lane.id, label: lane.name, detail: lane.branchRef })),
    [lanes],
  );
  const sessionOptions: PickOption[] = useMemo(
    () => (sessions ?? [])
      .filter((session) => session.toolType !== "shell" && session.toolType !== null)
      .map((session) => ({
        value: session.id,
        label: session.title || "Untitled chat",
        detail: session.laneName,
      })),
    [sessions],
  );
  const prOptions: PickOption[] = useMemo(
    () => (prs ?? []).map((pr) => ({
      value: String(pr.githubPrNumber),
      label: `#${pr.githubPrNumber} ${pr.title}`,
      detail: `${pr.repoOwner}/${pr.repoName} · ${pr.state}`,
      also: { repo: `${pr.repoOwner}/${pr.repoName}` },
    })),
    [prs],
  );
  const branchOptions: PickOption[] = useMemo(() => {
    const repo = prs?.[0] ? `${prs[0].repoOwner}/${prs[0].repoName}` : undefined;
    return lanes
      .filter((lane) => !lane.archivedAt && lane.branchRef)
      .map((lane) => ({
        value: lane.branchRef,
        label: lane.branchRef,
        detail: lane.name,
        ...(repo ? { also: { repo } } : {}),
      }));
  }, [lanes, prs]);

  return {
    laneOptions,
    sessionOptions,
    sessionsLoading: wantsSessions && sessions === null,
    prOptions,
    prsLoading: wantsPrs && prs === null,
    branchOptions,
    defaultRepo: prs?.[0] ? `${prs[0].repoOwner}/${prs[0].repoName}` : undefined,
  };
}

function LinkFields({
  link,
  triggerType,
  runtimePin,
  onChange,
}: {
  link: NotifyLink;
  triggerType: string;
  runtimePin: OpenProjectBinding | null;
  onChange: (next: NotifyLinkFields) => void;
}) {
  const f = link.fields;
  const set = (patch: NotifyLinkFields) => onChange({ ...f, ...patch });
  const choices = useProjectChoices(link.kind, runtimePin);
  const laneTrigger = [
    ...(isLaneTrigger(triggerType) ? [{ label: "The trigger's lane", value: "{{trigger.lane.id}}" }] : []),
    RUN_LANE,
  ];
  const laneField = (label: string, hint?: string) => (
    <PickField
      label={label}
      hint={hint}
      value={f.laneId ?? ""}
      placeholder="Lane id"
      options={choices.laneOptions}
      triggerValues={laneTrigger}
      triggerType={triggerType}
      onChange={(laneId) => set({ laneId })}
    />
  );

  switch (link.kind) {
    case "none":
      return null;
    case "activity":
      return (
        <div className="space-y-1">
          <span className={labelCls}>Show</span>
          <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label="Activity column">
            {(["", ...WORK_BOARD_COLUMNS] as const).map((column) => (
              <button
                key={column || "all"}
                type="button"
                role="radio"
                aria-checked={(f.column ?? "") === column}
                onClick={() => set({ column })}
              >
                {column ? WORK_BOARD_COLUMN_LABEL[column] : "Everything"}
              </button>
            ))}
          </div>
        </div>
      );
    case "chat":
      return (
        <PickField
          label="Chat"
          value={f.sessionId ?? ""}
          placeholder="Chat id"
          options={choices.sessionOptions}
          optionsLoading={choices.sessionsLoading}
          triggerValues={[
            ...(isSessionTrigger(triggerType)
              ? [{ label: "The chat that triggered this run", value: "{{trigger.session.sessionId}}" }]
              : []),
            RUN_CHAT,
          ]}
          triggerType={triggerType}
          onChange={(sessionId) => set({ sessionId })}
        />
      );
    case "pr":
      return (
        <div className="space-y-2">
          <PickField
            label="Pull request number"
            value={f.prNumber ?? ""}
            placeholder="1514"
            options={choices.prOptions}
            optionsLoading={choices.prsLoading}
            triggerValues={isPrTrigger(triggerType)
              ? [{ label: "The PR from the trigger", value: "{{trigger.pr.number}}" }]
              : []}
            triggerType={triggerType}
            onChange={(prNumber) => set({ prNumber })}
            onPick={(option) => set({ prNumber: option.value, ...option.also })}
          />
          <PickField
            label="Repository"
            hint="optional"
            value={f.repo ?? ""}
            placeholder={choices.defaultRepo ?? "owner/name"}
            triggerType={triggerType}
            onChange={(repo) => set({ repo })}
          />
        </div>
      );
    case "linear":
      return (
        <PickField
          label="Linear issue"
          value={f.linearIssue ?? ""}
          placeholder="ADE-123"
          triggerType={triggerType}
          onChange={(linearIssue) => set({ linearIssue })}
        />
      );
    case "lane":
      return laneField("Lane");
    case "file":
      return (
        <div className="space-y-2">
          {laneField("Lane", "where the file is")}
          <div className="grid gap-2 sm:grid-cols-[1fr_96px]">
            <PickField
              label="File path"
              value={f.path ?? ""}
              placeholder="apps/desktop/src/main.ts"
              triggerType={triggerType}
              onChange={(path) => set({ path })}
            />
            <PickField
              label="Line"
              hint="optional"
              value={f.line ?? ""}
              placeholder="42"
              triggerType={triggerType}
              onChange={(line) => set({ line })}
            />
          </div>
        </div>
      );
    case "commit":
      return (
        <div className="space-y-2">
          <PickField
            label="Commit"
            value={f.sha ?? ""}
            placeholder="708b303ee"
            triggerType={triggerType}
            onChange={(sha) => set({ sha })}
          />
          {laneField("Lane", "optional")}
        </div>
      );
    case "branch":
      return (
        <div className="space-y-2">
          <PickField
            label="Repository"
            value={f.repo ?? ""}
            placeholder={choices.defaultRepo ?? "owner/name"}
            triggerType={triggerType}
            onChange={(repo) => set({ repo })}
          />
          <PickField
            label="Branch"
            value={f.branch ?? ""}
            placeholder="main"
            options={choices.branchOptions}
            triggerValues={isLaneTrigger(triggerType) || isPrTrigger(triggerType)
              ? [{ label: "The trigger's branch", value: "{{trigger.branch}}" }]
              : []}
            triggerType={triggerType}
            onChange={(branch) => set({ branch })}
            onPick={(option) => set({ branch: option.value, ...(f.repo ? {} : option.also) })}
          />
        </div>
      );
    case "proof":
      return (
        <PickField
          label="Proof id"
          hint="from `ade proof list`"
          value={f.artifactId ?? ""}
          placeholder="34b93299-…"
          triggerType={triggerType}
          onChange={(artifactId) => set({ artifactId })}
        />
      );
    case "custom":
      return (
        <div className="space-y-1">
          <PickField
            label="ADE link"
            value={f.custom ?? ""}
            placeholder="ade://… or https://ade-app.dev/open?…"
            triggerType={triggerType}
            onChange={(custom) => set({ custom })}
          />
          <p className="text-[10.5px] leading-relaxed text-muted-fg/60">
            Paste any ADE link: right-click a lane and choose Copy → Copy ADE Lane Link, use a Copy link button in ADE,
            or run <span className="font-mono">ade link lane|session|pr|file|commit|branch</span> in a terminal.
          </p>
        </div>
      );
  }
}

type TestState =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "done"; message: string; tone: "ok" | "warn" | "error" };

/**
 * The "Send notification to mobile app" step: what the push says, what a tap
 * opens, a preview, and a real test send. It stores an ordinary
 * `attention.sendNotification` ADE-action step — `title`, `body`, `open` — so
 * nothing about how rules are saved or run is special to it.
 */
export function NotifyStepEditor({
  value,
  triggerType,
  runtimePin = null,
  onChange,
}: {
  value: AdeActionValue;
  triggerType: string;
  /** The machine the rule runs on; null is this window's. */
  runtimePin?: OpenProjectBinding | null;
  onChange: (next: AdeActionValue) => void;
}) {
  const args = (value.args && !Array.isArray(value.args) ? value.args : {}) as Record<string, unknown>;
  const title = typeof args.title === "string" ? args.title : "";
  const body = typeof args.body === "string" ? args.body : "";
  const open = typeof args.open === "string" ? args.open : "";

  // The choice is kept in state so picking "A chat" before filling it in does
  // not snap back to "Just open ADE" while the link is still empty.
  const [link, setLink] = useState<NotifyLink>(() => readNotifyLink(open));
  const lastWritten = useRef(open);
  useEffect(() => {
    if (open !== lastWritten.current) {
      lastWritten.current = open;
      setLink(readNotifyLink(open));
    }
  }, [open]);

  const writeArgs = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...args, ...patch };
    for (const key of ["body", "open"]) {
      if (typeof next[key] === "string" && !(next[key] as string).trim()) delete next[key];
    }
    onChange({ ...value, args: next });
  };
  const updateLink = (next: NotifyLink) => {
    setLink(next);
    const built = buildNotifyLink(next);
    lastWritten.current = built;
    writeArgs({ open: built });
  };

  const selectKind = (kind: NotifyLinkKind) =>
    updateLink({ kind, fields: kind === link.kind ? link.fields : {} });

  const builtLink = buildNotifyLink(link);
  const check = checkNotifyLink(builtLink);
  const needsInput = link.kind !== "none" && check.state === "empty";

  const [test, setTest] = useState<TestState>({ state: "idle" });
  // A result describes the notification that was sent; once it is edited,
  // the line would describe something else.
  useEffect(() => {
    setTest((current) => (current.state === "done" ? { state: "idle" } : current));
  }, [title, body, open]);
  const canTest = typeof window.ade?.attention?.sendNotification === "function";
  const titleProblem = !title.trim()
    ? "Add a title."
    : title.trim().length > CUSTOM_NOTIFICATION_TITLE_MAX
      ? `Shorten the title to ${CUSTOM_NOTIFICATION_TITLE_MAX} characters.`
      : body.trim().length > CUSTOM_NOTIFICATION_BODY_MAX
        ? `Shorten the message to ${CUSTOM_NOTIFICATION_BODY_MAX} characters.`
        : null;

  const sendTest = async () => {
    const send = window.ade?.attention?.sendNotification;
    if (!send || titleProblem) return;
    setTest({ state: "sending" });
    try {
      // A link with trigger values has nothing to fill them with yet, so the
      // test goes without it rather than with a link that cannot open.
      const testLink = check.state === "ok" && !check.checkedWithSamples ? builtLink : null;
      // Sent from the rule's machine, so a chat or PR link is stamped with
      // the machine it will be stamped with when the rule runs.
      const result = await send({
        title: withVariableNames(title.trim(), triggerType).slice(0, CUSTOM_NOTIFICATION_TITLE_MAX),
        body: withVariableNames(body.trim(), triggerType).slice(0, CUSTOM_NOTIFICATION_BODY_MAX) || null,
        open: testLink,
      }, runtimePin);
      const described = describeCustomNotificationResult(result);
      setTest({
        state: "done",
        tone: described.tone,
        message: builtLink && !testLink
          ? `${described.message} The test went without its link, because the link uses trigger values.`
          : described.message,
      });
    } catch (error) {
      setTest({
        state: "done",
        tone: "error",
        message: (() => {
          const raw = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);
          // An older ADE on the rule's machine has no notification action yet.
          return explainAutomationActionError(raw) ?? raw;
        })(),
      });
    }
  };

  return (
    <div className="space-y-3" data-testid="notify-step-editor">
      <p className="text-[11px] leading-relaxed text-muted-fg/70">
        Sends a push to the ADE app on every phone signed in to your account. Phones with notifications off, in quiet
        hours, or that muted this computer stay quiet. Up to {CUSTOM_NOTIFICATION_HOURLY_LIMIT} an hour.
      </p>

      <CountedField
        label="Title"
        value={title}
        max={CUSTOM_NOTIFICATION_TITLE_MAX}
        placeholder={isPrTrigger(triggerType) ? "PR {{trigger.pr.number}} is ready" : "Deploy finished"}
        triggerType={triggerType}
        onChange={(next) => writeArgs({ title: next })}
      />
      <CountedField
        label="Message"
        hint="optional"
        value={body}
        max={CUSTOM_NOTIFICATION_BODY_MAX}
        placeholder={isPrTrigger(triggerType) ? "{{trigger.pr.title}}" : "What happened, in one line"}
        triggerType={triggerType}
        onChange={(next) => writeArgs({ body: next })}
      />

      <div className="space-y-2 rounded-lg border border-fg/[0.07] bg-fg/[0.02] p-2.5">
        <div className="flex items-center gap-1.5">
          <LinkSimple size={12} className="text-muted-fg/70" />
          <span className={labelCls}>When tapped, open</span>
        </div>
        <div className="space-y-2" role="radiogroup" aria-label="When tapped, open">
          <ChoiceGrid
            title="On the phone"
            choices={PHONE_CHOICES}
            selected={link.kind}
            onSelect={selectKind}
          />
          <ChoiceGrid
            title="On your computer (the phone offers to open it there)"
            choices={COMPUTER_CHOICES}
            selected={link.kind}
            onSelect={selectKind}
          />
          <button
            type="button"
            role="radio"
            aria-checked={link.kind === "custom"}
            data-notify-link-kind="custom"
            onClick={() => updateLink({ kind: "custom", fields: { custom: builtLink } })}
            className={cn(
              "text-[11px] underline-offset-2 hover:underline",
              link.kind === "custom" ? "text-accent" : "text-muted-fg/70",
            )}
          >
            Paste a link instead
          </button>
        </div>
        <LinkFields
          link={link}
          triggerType={triggerType}
          runtimePin={runtimePin}
          onChange={(fields) => updateLink({ kind: link.kind, fields })}
        />
      </div>

      <div className="rounded-lg border border-fg/[0.07] bg-black/[0.14] p-2.5">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-fg/55">Preview</div>
        <div className="flex items-start gap-2.5 rounded-xl border border-fg/[0.08] bg-fg/[0.05] px-3 py-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/20 text-accent">
            <Bell size={14} weight="fill" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[12px] font-semibold text-fg">{title.trim() || "Title"}</span>
              <span className="shrink-0 text-[10px] text-muted-fg/50">now</span>
            </span>
            {body.trim() ? <span className="block truncate text-[11.5px] text-fg/80">{body.trim()}</span> : null}
          </span>
        </div>
        <div className="mt-2 flex items-start gap-1.5 text-[11px]" data-testid="notify-link-status">
          {needsInput ? (
            <>
              <Warning size={12} className="mt-0.5 shrink-0 text-amber-300" />
              <span className="text-amber-200/90">Fill in what to open, or choose Just open ADE.</span>
            </>
          ) : check.state === "problem" ? (
            <>
              <Warning size={12} className="mt-0.5 shrink-0 text-red-300" />
              <span className="text-red-200/90">{check.problem}</span>
            </>
          ) : (
            <>
              <Check size={12} weight="bold" className="mt-0.5 shrink-0 text-emerald-400" />
              <span className="min-w-0 text-muted-fg/80">
                Tap: {link.kind === "custom" && check.state === "ok" ? `Opens ${check.opens}.` : NOTIFY_LINK_PHONE_EFFECT[link.kind]}
                {check.state === "ok" && check.checkedWithSamples ? " Trigger values are filled in when it runs." : ""}
              </span>
            </>
          )}
        </div>
        {builtLink ? (
          <div className="mt-1 truncate font-mono text-[10px] text-muted-fg/50" title={builtLink}>{builtLink}</div>
        ) : null}
      </div>

      {canTest ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={test.state === "sending" || Boolean(titleProblem)}
            title={titleProblem ?? "Sends this notification to your phones now"}
            className="flex h-7 items-center gap-1.5 rounded-md border border-fg/[0.1] bg-fg/[0.04] px-2.5 text-[11px] font-medium text-fg transition-colors hover:border-accent/35 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {test.state === "sending" ? <CircleNotch size={11} className="animate-spin" /> : <DeviceMobile size={12} />}
            Send a test to my phone
          </button>
          {test.state === "done" ? (
            <span
              role="status"
              className={cn(
                "text-[11px]",
                test.tone === "ok" ? "text-emerald-300" : test.tone === "warn" ? "text-amber-200" : "text-red-300",
              )}
            >
              {test.message}
            </span>
          ) : titleProblem ? (
            <span className="text-[11px] text-muted-fg/55">{titleProblem}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

