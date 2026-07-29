import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  BellRinging,
  CaretDown,
  Check,
  CheckCircle,
  ClockCounterClockwise,
  DesktopTower,
  FunnelSimple,
  GitPullRequest,
  Lightning,
  ListChecks,
  RadioButton,
  Sparkle,
  Tray,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  X,
  XCircle,
} from "@phosphor-icons/react";

import {
  attentionDestinationDeepLink,
  type AttentionAction,
  type AttentionItem,
  type AttentionMachineRef,
  type AttentionProjectRef,
} from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { openAdeDeeplink } from "../../lib/openExternal";
import {
  acknowledgeAttentionItem,
  selectAttentionCounts,
  selectAttentionItems,
  useAttentionStore,
  type AttentionScope,
  type AttentionView,
} from "../../state/attentionStore";
import { ProviderLogo } from "../shared/ProviderLogos";
import { cn } from "../ui/cn";
import {
  attentionActionTone,
  attentionPhasePresentation,
  attentionViewEmptyCopy,
  type AttentionTone,
} from "./attentionPresentation";
import { AttentionSettingsPopover } from "./AttentionSettingsPopover";
import { refreshAttentionSnapshot } from "./useAttentionSync";
import "./AttentionCenter.css";

type AttentionCenterProps = {
  onAction?: (item: AttentionItem, action: AttentionAction) => void | Promise<void>;
  onOpenItem?: (item: AttentionItem) => void | Promise<void>;
};

type ProjectGroup = {
  project: AttentionProjectRef;
  items: AttentionItem[];
};

type MachineGroup = {
  machine: AttentionMachineRef;
  projects: ProjectGroup[];
  itemCount: number;
};

const VIEW_CONFIG: Array<{
  id: AttentionView;
  label: string;
  icon: React.ElementType;
}> = [
  { id: "live", label: "Live", icon: RadioButton },
  { id: "inbox", label: "Inbox", icon: Tray },
  { id: "recent", label: "Recent", icon: ClockCounterClockwise },
];

function groupItems(items: readonly AttentionItem[]): MachineGroup[] {
  const machines = new Map<string, MachineGroup>();
  for (const item of items) {
    let machine = machines.get(item.machine.machineKey);
    if (!machine) {
      machine = { machine: item.machine, projects: [], itemCount: 0 };
      machines.set(item.machine.machineKey, machine);
    }
    machine.itemCount += 1;
    let project = machine.projects.find(
      (entry) => entry.project.projectId === item.project.projectId,
    );
    if (!project) {
      project = { project: item.project, items: [] };
      machine.projects.push(project);
    }
    project.items.push(item);
  }
  return [...machines.values()].sort((left, right) => {
    if (left.machine.online !== right.machine.online) return left.machine.online ? -1 : 1;
    return left.machine.name.localeCompare(right.machine.name);
  });
}

function toneClass(tone: AttentionTone): string {
  return `attention-tone-${tone}`;
}

function itemIcon(item: AttentionItem, size: number): React.ReactNode {
  if (item.kind === "pull_request") {
    return <GitPullRequest size={size} weight="duotone" />;
  }
  return <ProviderLogo family={item.provider || "agent"} size={size} />;
}

function actionIcon(action: AttentionAction): React.ElementType {
  if (action.kind === "approve") return Check;
  if (action.kind === "deny") return X;
  if (action.kind === "restart" || action.kind === "rerun_checks") return ArrowClockwise;
  if (action.kind === "open") return ArrowSquareOut;
  if (action.kind === "dismiss") return XCircle;
  if (action.kind === "mark_seen") return CheckCircle;
  return Lightning;
}

function itemSupportsActionOffline(action: AttentionAction): boolean {
  return action.kind === "mark_seen" || action.kind === "dismiss";
}

function navigationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t open the exact machine and project for this item.";
}

function scopeLabel(scope: AttentionScope): string {
  return scope.kind === "all" ? "All machines" : scope.label;
}

const ROSTER_PANEL_ID = "attention-roster-panel";

function tabDomId(view: AttentionView): string {
  return `attention-tab-${view}`;
}

/** Moves focus within a group of controls, wrapping at both ends. */
function focusRelative(elements: HTMLElement[], from: Element | null, delta: number): void {
  if (elements.length === 0) return;
  const current = elements.indexOf(from as HTMLElement);
  const next = current < 0
    ? 0
    : (current + delta + elements.length) % elements.length;
  elements[next]?.focus();
}

function AttentionTabs({
  view,
  counts,
  onChange,
}: {
  view: AttentionView;
  counts: Record<AttentionView, number>;
  onChange: (view: AttentionView) => void;
}) {
  // A tablist is a single tab stop: arrows move between tabs, Tab leaves the group.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    if (delta !== 0) {
      event.preventDefault();
      focusRelative(tabs, document.activeElement, delta);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? tabs[0] : tabs[tabs.length - 1])?.focus();
    }
  };

  return (
    <div
      className="attention-tabs"
      role="tablist"
      aria-label="Attention views"
      onKeyDown={onKeyDown}
    >
      {VIEW_CONFIG.map((entry) => {
        const active = view === entry.id;
        const count = counts[entry.id];
        return (
          <button
            key={entry.id}
            id={tabDomId(entry.id)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={ROSTER_PANEL_ID}
            tabIndex={active ? 0 : -1}
            className="attention-tab"
            data-active={active || undefined}
            onClick={() => onChange(entry.id)}
            onFocus={() => onChange(entry.id)}
          >
            <entry.icon size={14} weight={active ? "fill" : "regular"} />
            <span>{entry.label}</span>
            {count > 0 ? <span className="attention-tab-count">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function ScopePicker({
  scope,
  allItems,
  onChange,
}: {
  scope: AttentionScope;
  allItems: AttentionItem[];
  onChange: (scope: AttentionScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const options = useMemo(() => groupItems(allItems), [allItems]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  // Opening a menu should land focus inside it, and closing it should hand
  // focus back to the trigger rather than dropping the user at the document.
  useEffect(() => {
    if (!open) return;
    const menu = ref.current?.querySelector<HTMLElement>('[role="menu"]');
    if (!menu) return;
    const checked = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (checked ?? menu.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
  }, [open]);

  const closeMenu = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    );
    if (delta !== 0) {
      event.preventDefault();
      focusRelative(items, document.activeElement, delta);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? items[0] : items[items.length - 1])?.focus();
    }
  };

  return (
    <div ref={ref} className="attention-scope-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="attention-scope-button"
        data-scoped={scope.kind !== "all" || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <FunnelSimple size={14} weight={scope.kind === "all" ? "regular" : "fill"} />
        <span className="truncate">{scopeLabel(scope)}</span>
        <CaretDown size={12} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="attention-scope-menu"
            role="menu"
            aria-label="Filter by machine or project"
            onKeyDown={onMenuKeyDown}
            initial={{ opacity: 0, y: -5, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={scope.kind === "all"}
              className="attention-scope-option"
              onClick={() => {
                onChange({ kind: "all" });
                closeMenu(true);
              }}
            >
              <span className="attention-scope-option-icon"><Sparkle size={14} /></span>
              <span className="min-w-0 flex-1">
                <strong>All machines</strong>
                <small>Every active ADE project</small>
              </span>
              {scope.kind === "all" ? <Check size={13} weight="bold" /> : null}
            </button>
            {options.map((machine) => (
              <div key={machine.machine.machineKey} className="attention-scope-group">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={
                    scope.kind === "machine" && scope.machineKey === machine.machine.machineKey
                  }
                  className="attention-scope-option"
                  onClick={() => {
                    onChange({
                      kind: "machine",
                      machineKey: machine.machine.machineKey,
                      label: machine.machine.name,
                    });
                    closeMenu(true);
                  }}
                >
                  <span className="attention-scope-option-icon">
                    <DesktopTower size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong>{machine.machine.name}</strong>
                    <small>{machine.machine.online ? "Online" : "Last-known activity"}</small>
                  </span>
                  {scope.kind === "machine" && scope.machineKey === machine.machine.machineKey ? (
                    <Check size={13} weight="bold" />
                  ) : null}
                </button>
                {machine.projects.map((project) => (
                  <button
                    key={`${machine.machine.machineKey}:${project.project.projectId}`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={
                      scope.kind === "project"
                      && scope.projectId === project.project.projectId
                      && scope.machineKey === machine.machine.machineKey
                    }
                    className="attention-scope-option attention-scope-project"
                    aria-label={project.project.name}
                    onClick={() => {
                      onChange({
                        kind: "project",
                        projectId: project.project.projectId,
                        machineKey: machine.machine.machineKey,
                        label: project.project.name,
                      });
                      closeMenu(true);
                    }}
                  >
                    <span className="attention-project-glyph" aria-hidden>
                      {project.project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{project.project.name}</span>
                    {scope.kind === "project"
                    && scope.projectId === project.project.projectId
                    && scope.machineKey === machine.machine.machineKey ? (
                      <Check size={13} weight="bold" />
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function PhasePill({ item }: { item: AttentionItem }) {
  const phase = attentionPhasePresentation(item.phase);
  return (
    <span className={cn("attention-phase-pill", toneClass(phase.tone))}>
      <span
        className={cn(
          "attention-phase-dot",
          phase.active && item.machine.online && "attention-phase-dot-active",
        )}
      />
      {phase.label}
    </span>
  );
}

function AttentionItemRow({
  item,
  selected,
  tabbable,
  reducedMotion,
  onSelect,
}: {
  item: AttentionItem;
  selected: boolean;
  tabbable: boolean;
  reducedMotion: boolean;
  onSelect: () => void;
}) {
  const phase = attentionPhasePresentation(item.phase);
  return (
    <motion.button
      type="button"
      layout="position"
      data-attention-item={item.id}
      tabIndex={tabbable ? 0 : -1}
      className={cn("attention-item-row", toneClass(phase.tone))}
      data-selected={selected || undefined}
      onClick={onSelect}
      whileTap={reducedMotion ? undefined : { scale: 0.992 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
      aria-pressed={selected}
    >
      {selected ? (
        <motion.span
          layoutId="attention-selected-rail"
          className="attention-selected-rail"
          transition={{ type: "spring", stiffness: 470, damping: 37 }}
        />
      ) : null}
      <span className="attention-item-icon" aria-hidden>
        {itemIcon(item, 17)}
      </span>
      <span className="attention-item-copy">
        <span className="attention-item-title-line">
          <strong>{item.title}</strong>
          <time dateTime={item.updatedAt}>{relativeWhen(item.updatedAt)}</time>
        </span>
        <span className="attention-item-preview">{item.preview}</span>
        <span className="attention-item-meta">
          <PhasePill item={item} />
          {item.laneName ? <span>{item.laneName}</span> : null}
          {item.model ? <span>{item.model}</span> : null}
        </span>
      </span>
      {!item.seenAt ? <span className="attention-unseen-dot" aria-label="Unseen" /> : null}
    </motion.button>
  );
}

function AttentionRoster({
  items,
  selectedId,
  focusId,
  reducedMotion,
  onSelect,
}: {
  items: AttentionItem[];
  selectedId: string | null;
  focusId: string | null;
  reducedMotion: boolean;
  onSelect: (item: AttentionItem) => void;
}) {
  const groups = useMemo(() => groupItems(items), [items]);

  // The roster is one tab stop; arrows walk the rows across machine and project
  // groups, and Enter/Space (native button behaviour) opens the focused row.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-attention-item]"),
    );
    if (delta !== 0) {
      event.preventDefault();
      focusRelative(rows, document.activeElement, delta);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? rows[0] : rows[rows.length - 1])?.focus();
    }
  };

  return (
    <div className="attention-roster-scroll" onKeyDown={onKeyDown}>
      <LayoutGroup id="attention-roster">
        {groups.map((machine) => (
          <motion.section
            layout="position"
            key={machine.machine.machineKey}
            className="attention-machine-group"
          >
            <div className="attention-machine-heading">
              <span className="attention-machine-icon">
                <DesktopTower size={14} weight="duotone" />
              </span>
              <span className="min-w-0 flex-1">
                <strong>{machine.machine.name}</strong>
                <small>
                  {machine.machine.online
                    ? "Online now"
                    : machine.machine.lastSeenAt
                      ? `Offline · ${relativeWhen(machine.machine.lastSeenAt)}`
                      : "Offline"}
                </small>
              </span>
              <span
                className={cn(
                  "attention-online-dot",
                  machine.machine.online ? "is-online" : "is-offline",
                )}
              />
              <span className="attention-machine-count">{machine.itemCount}</span>
            </div>
            {machine.projects.map((project) => (
              <div
                key={`${machine.machine.machineKey}:${project.project.projectId}`}
                className="attention-project-group"
              >
                <div className="attention-project-heading">
                  <span className="attention-project-glyph" aria-hidden>
                    {project.project.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate">{project.project.name}</span>
                  <span>{project.items.length}</span>
                </div>
                <div className="attention-project-items">
                  {project.items.map((item) => (
                    <AttentionItemRow
                      key={item.id}
                      item={item}
                      selected={selectedId === item.id}
                      tabbable={focusId === item.id}
                      reducedMotion={reducedMotion}
                      onSelect={() => onSelect(item)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </motion.section>
        ))}
      </LayoutGroup>
    </div>
  );
}

function EmptyAttention({
  view,
  scoped,
  syncError,
  onClearScope,
  onRetry,
}: {
  view: AttentionView;
  scoped: boolean;
  syncError: string | null;
  onClearScope: () => void;
  onRetry: () => void;
}) {
  const copy = attentionViewEmptyCopy(view);
  const Icon = view === "inbox" ? CheckCircle : view === "recent" ? ClockCounterClockwise : Sparkle;
  if (syncError) {
    return (
      <motion.div
        className="attention-empty"
        initial={{ opacity: 0, y: 7 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <span className="attention-empty-icon attention-empty-icon-error">
          <WifiSlash size={25} weight="duotone" />
        </span>
        <strong>Couldn’t sync Attention</strong>
        <p>{syncError}</p>
        <button type="button" className="attention-subtle-button" onClick={onRetry}>
          <ArrowClockwise size={12} />
          Try again
        </button>
      </motion.div>
    );
  }
  return (
    <motion.div
      className="attention-empty"
      initial={{ opacity: 0, y: 7 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <span className="attention-empty-icon"><Icon size={25} weight="duotone" /></span>
      <strong>{scoped ? "Nothing in this filter" : copy.title}</strong>
      <p>{scoped ? "Clear it to see every machine and project." : copy.body}</p>
      {scoped ? (
        <button type="button" className="attention-subtle-button" onClick={onClearScope}>
          Clear filter
        </button>
      ) : null}
    </motion.div>
  );
}

function DetailAction({
  item,
  action,
  pending,
  opensDestination,
  onRun,
}: {
  item: AttentionItem;
  action: AttentionAction;
  pending: boolean;
  opensDestination: boolean;
  onRun: () => void;
}) {
  const Icon = actionIcon(action);
  const disabled = pending || (!item.machine.online && !itemSupportsActionOffline(action));
  const label = opensDestination
    && action.kind !== "open"
    && action.kind !== "mark_seen"
    && action.kind !== "dismiss"
    ? `Open to ${action.label.toLocaleLowerCase()}`
    : action.label;
  return (
    <motion.button
      type="button"
      className="attention-action"
      data-tone={attentionActionTone(action.kind)}
      disabled={disabled}
      title={
        !item.machine.online && !itemSupportsActionOffline(action)
          ? `${item.machine.name} is offline`
          : label
      }
      onClick={onRun}
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
    >
      <Icon size={14} weight={action.kind === "approve" ? "bold" : "regular"} />
      <span>{pending ? "Working…" : label}</span>
    </motion.button>
  );
}

function AttentionDetail({
  item,
  pendingActionId,
  acknowledgementError,
  navigationError,
  opensDestinationForActions,
  onAction,
}: {
  item: AttentionItem;
  pendingActionId: string | null;
  acknowledgementError: string | null;
  navigationError: string | null;
  opensDestinationForActions: boolean;
  onAction: (action: AttentionAction) => void;
}) {
  const phase = attentionPhasePresentation(item.phase);
  const actions = item.actions.some((action) => action.kind === "open")
    ? item.actions
    : [
        ...item.actions,
        { id: `open:${item.id}`, kind: "open" as const, label: "Open" },
      ];
  const primaryActions = actions.filter(
    (action) => action.kind !== "mark_seen" && action.kind !== "dismiss",
  );
  const planTotal = Math.max(0, item.planProgress?.total ?? 0);
  const planCompleted = Math.min(planTotal, Math.max(0, item.planProgress?.completed ?? 0));
  const planPercent = planTotal > 0 ? Math.round((planCompleted / planTotal) * 100) : 0;

  return (
    <motion.article
      key={item.id}
      className={cn("attention-detail-card", toneClass(phase.tone))}
      initial={{ opacity: 0, y: 7, scale: 0.995 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -5, scale: 0.995 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <div className="attention-detail-accent" />
      <header className="attention-detail-header">
        <div className="attention-detail-breadcrumb">
          <span className={cn("attention-breadcrumb-status", item.machine.online && "is-online")}>
            {item.machine.online ? <WifiHigh size={13} /> : <WifiSlash size={13} />}
          </span>
          <span>{item.machine.name}</span>
          <span className="attention-breadcrumb-separator">/</span>
          <span>{item.project.name}</span>
          {item.laneName ? (
            <>
              <span className="attention-breadcrumb-separator">/</span>
              <span className="truncate">{item.laneName}</span>
            </>
          ) : null}
        </div>
        <div className="attention-detail-tools">
          {item.seenAt ? (
            <span className="attention-seen-label"><Check size={11} /> Seen</span>
          ) : (
            <button
              type="button"
              className="attention-icon-button"
              title="Mark as seen"
              onClick={() => onAction({
                id: `seen:${item.id}`,
                kind: "mark_seen",
                label: "Mark seen",
              })}
            >
              <CheckCircle size={16} />
            </button>
          )}
          <button
            type="button"
            className="attention-icon-button"
            title="Dismiss"
            onClick={() => onAction({
              id: `dismiss:${item.id}`,
              kind: "dismiss",
              label: "Dismiss",
            })}
          >
            <X size={15} />
          </button>
        </div>
      </header>

      <div className="attention-detail-hero">
        <span className="attention-detail-provider" aria-hidden>{itemIcon(item, 24)}</span>
        <div className="min-w-0 flex-1">
          <div className="attention-detail-kicker">
            <PhasePill item={item} />
            <time dateTime={item.updatedAt}>{relativeWhen(item.updatedAt)}</time>
          </div>
          <h2>{item.title}</h2>
          <p>{item.preview}</p>
        </div>
      </div>

      {!item.machine.online ? (
        <div className="attention-offline-banner">
          <WarningCircle size={17} weight="fill" />
          <span>
            <strong>{item.machine.name} is offline.</strong>
            This is its last-known state. Remote actions unlock when it reconnects.
          </span>
        </div>
      ) : null}

      {acknowledgementError ? (
        <div className="attention-ack-error" role="alert">
          <XCircle size={16} weight="fill" />
          <span>
            <strong>That update didn’t stick.</strong>
            {acknowledgementError}
          </span>
        </div>
      ) : null}

      {navigationError ? (
        <div className="attention-ack-error" role="alert">
          <XCircle size={16} weight="fill" />
          <span>
            <strong>Couldn’t open this work.</strong>
            {navigationError}
          </span>
        </div>
      ) : null}

      {primaryActions.length > 0 ? (
        <div className="attention-detail-actions">
          {primaryActions.map((action) => (
            <DetailAction
              key={action.id}
              item={item}
              action={action}
              pending={pendingActionId === action.id}
              opensDestination={opensDestinationForActions}
              onRun={() => onAction(action)}
            />
          ))}
        </div>
      ) : null}

      <div className="attention-detail-body">
        {item.detail ? (
          <section className="attention-detail-section attention-detail-note">
            <div className="attention-section-heading">
              <Lightning size={14} weight="duotone" />
              <h3>What’s happening</h3>
            </div>
            <p>{item.detail}</p>
          </section>
        ) : null}

        {item.planProgress ? (
          <section className="attention-detail-section">
            <div className="attention-section-heading">
              <ListChecks size={14} weight="duotone" />
              <h3>Plan progress</h3>
              <span>{planCompleted} of {planTotal}</span>
            </div>
            <div
              className="attention-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={planTotal}
              aria-valuenow={planCompleted}
            >
              <motion.div
                className="attention-progress-fill"
                initial={{ width: 0 }}
                animate={{ width: `${planPercent}%` }}
                transition={{ type: "spring", stiffness: 160, damping: 24 }}
              />
            </div>
            {item.planProgress.current ? (
              <p className="attention-plan-current">
                <RadioButton size={11} weight="fill" />
                {item.planProgress.current}
              </p>
            ) : null}
          </section>
        ) : null}

        {item.recentActivity?.length ? (
          <section className="attention-detail-section">
            <div className="attention-section-heading">
              <ClockCounterClockwise size={14} weight="duotone" />
              <h3>Recent activity</h3>
            </div>
            <ol className="attention-activity-list">
              {item.recentActivity.slice(0, 8).map((activity, index) => (
                <li key={`${activity}:${index}`}>
                  <span className="attention-activity-node" />
                  <span>{activity}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {!item.detail && !item.planProgress && !item.recentActivity?.length ? (
          <section className="attention-detail-section attention-detail-calm">
            <Sparkle size={18} weight="duotone" />
            <div>
              <h3>Ready when you are</h3>
              <p>Open it to pick up in the exact session it came from.</p>
            </div>
          </section>
        ) : null}
      </div>

      <footer className="attention-detail-footer">
        <span>{item.kind === "agent" ? item.provider || "Agent" : "Pull request"}</span>
        {item.model ? <span>{item.model}</span> : null}
        <span className="ml-auto">Updated {relativeWhen(item.updatedAt)}</span>
      </footer>
    </motion.article>
  );
}

function DetailPlaceholder() {
  return (
    <div className="attention-detail-placeholder">
      <span className="attention-detail-placeholder-icon"><BellRinging size={28} weight="duotone" /></span>
      <strong>Nothing selected</strong>
      <p>Pick an item to see its activity and act on it.</p>
    </div>
  );
}

export function AttentionCenter({ onAction, onOpenItem }: AttentionCenterProps = {}) {
  const state = useAttentionStore((value) => value);
  const {
    itemsById,
    view,
    scope,
    selectedItemId,
    generatedAt,
    syncStatus,
    syncError,
    acknowledgementErrors,
    setView,
    setScope,
    selectItem,
    markSeen,
    dismiss,
  } = state;
  const reducedMotion = useReducedMotion() ?? false;
  const [now, setNow] = useState(() => Date.now());
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [navigationFailure, setNavigationFailure] = useState<{
    itemId: string;
    message: string;
  } | null>(null);
  const allItems = useMemo(() => Object.values(itemsById), [itemsById]);
  const visibleItems = useMemo(
    () => selectAttentionItems(state, now),
    [now, state],
  );
  const counts = useMemo(
    () => selectAttentionCounts(state, now),
    [now, state],
  );
  const selectedItem = (selectedItemId ? itemsById[selectedItemId] : null)
    ?? visibleItems[0]
    ?? null;
  // Exactly one row carries tabIndex 0. The selected item can be filtered out
  // of the current view, so fall back to the first visible row rather than
  // leaving the whole roster unreachable by keyboard.
  const rosterFocusId = useMemo(() => {
    if (selectedItem && visibleItems.some((entry) => entry.id === selectedItem.id)) {
      return selectedItem.id;
    }
    return visibleItems[0]?.id ?? null;
  }, [selectedItem, visibleItems]);
  const machineCount = new Set(allItems.map((item) => item.machine.machineKey)).size;
  const liveMachineCount = new Set(
    allItems.filter((item) => item.machine.online).map((item) => item.machine.machineKey),
  ).size;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedItem && selectedItemId) selectItem(null);
  }, [selectItem, selectedItem, selectedItemId]);

  const openItem = async (item: AttentionItem): Promise<boolean> => {
    setNavigationFailure((current) => current?.itemId === item.id ? null : current);
    try {
      if (onOpenItem) {
        await onOpenItem(item);
      } else {
        openAdeDeeplink(attentionDestinationDeepLink(item.destination, item));
      }
    } catch (error) {
      setNavigationFailure({
        itemId: item.id,
        message: navigationErrorMessage(error),
      });
      return false;
    }
    // Opening is the user-visible proof that the exact destination resolved.
    // Only then may the ambient item leave the unseen state.
    await acknowledgeAttentionItem(item.id, "seen").catch(() => {});
    return true;
  };

  const runAction = async (item: AttentionItem, action: AttentionAction) => {
    if (pendingActionId) return;
    if (action.kind === "open") {
      await openItem(item);
      return;
    }
    setPendingActionId(action.id);
    try {
      if (action.kind === "mark_seen" || action.kind === "dismiss") {
        if (onAction) {
          if (action.kind === "mark_seen") markSeen(item.id);
          else dismiss(item.id);
          await onAction(item, action);
        } else {
          await acknowledgeAttentionItem(
            item.id,
            action.kind === "dismiss" ? "dismiss" : "seen",
          );
        }
      } else if (onAction) {
        await onAction(item, action);
      } else {
        await openItem(item);
      }
    } catch {
      // Account acknowledgement helpers already roll back optimistic state and
      // expose their bounded error in the detail panel. Keep the click promise
      // contained so React event dispatch never produces an unhandled rejection.
    } finally {
      setPendingActionId(null);
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="attention-center" data-route="attention">
      <div className="attention-ambient attention-ambient-one" />
      <div className="attention-ambient attention-ambient-two" />

      <header className="attention-header">
        <div className="attention-title-lockup">
          <span className="attention-title-icon">
            <BellRinging size={19} weight="duotone" />
            {counts.inbox > 0 ? <span>{Math.min(99, counts.inbox)}</span> : null}
          </span>
          <div>
            <h1>Attention</h1>
            <p>
              {machineCount > 0
                ? `${liveMachineCount} of ${machineCount} machine${machineCount === 1 ? "" : "s"} online`
                : "Across every machine on your account"}
            </p>
          </div>
        </div>
        <div className="attention-header-controls">
          <AttentionSettingsPopover />
          {syncStatus === "error" ? (
            <button
              type="button"
              className="attention-freshness attention-freshness-error"
              onClick={() => void refreshAttentionSnapshot()}
              title={syncError ?? "Retry Attention sync"}
            >
              <WifiSlash size={12} />
              Sync failed · Retry
            </button>
          ) : syncStatus === "syncing" ? (
            <span className="attention-freshness">
              <ArrowClockwise size={12} className="animate-spin" />
              Syncing
            </span>
          ) : generatedAt ? (
            <span className="attention-freshness">
              <WifiHigh size={12} />
              Synced {relativeWhen(generatedAt)}
            </span>
          ) : null}
          <ScopePicker scope={scope} allItems={allItems} onChange={setScope} />
        </div>
      </header>

      <div className="attention-toolbar">
        <AttentionTabs view={view} counts={counts} onChange={setView} />
        {scope.kind !== "all" ? (
          <button
            type="button"
            className="attention-filter-chip"
            onClick={() => setScope({ kind: "all" })}
            title="Clear scope"
          >
            <FunnelSimple size={12} weight="fill" />
            <span>{scope.label}</span>
            <X size={11} />
          </button>
        ) : (
          <span className="attention-toolbar-hint">
            <Lightning size={12} weight="fill" />
            Highest priority first
          </span>
        )}
      </div>

      <div className="attention-layout">
        <section
          className="attention-roster-panel"
          id={ROSTER_PANEL_ID}
          role="tabpanel"
          aria-labelledby={tabDomId(view)}
        >
          <div className="attention-panel-heading">
            <div>
              <strong>
                {view === "live" ? "In motion" : view === "inbox" ? "Needs review" : "Latest outcomes"}
              </strong>
              <span>{visibleItems.length} item{visibleItems.length === 1 ? "" : "s"}</span>
            </div>
            {counts.inbox > 0 && view !== "inbox" ? (
              <button type="button" onClick={() => setView("inbox")}>
                {counts.inbox} need{counts.inbox === 1 ? "s" : ""} you
              </button>
            ) : null}
          </div>
          {visibleItems.length > 0 ? (
            <AttentionRoster
              items={visibleItems}
              selectedId={selectedItem?.id ?? null}
              focusId={rosterFocusId}
              reducedMotion={reducedMotion}
              onSelect={(item) => {
                selectItem(item.id);
                void acknowledgeAttentionItem(item.id, "seen").catch(() => {});
              }}
            />
          ) : (
            <EmptyAttention
              view={view}
              scoped={scope.kind !== "all"}
              syncError={syncError}
              onClearScope={() => setScope({ kind: "all" })}
              onRetry={() => void refreshAttentionSnapshot()}
            />
          )}
        </section>

        <section className="attention-detail-panel" aria-label="Attention detail">
          <AnimatePresence mode="wait" initial={false}>
            {selectedItem ? (
              <AttentionDetail
                key={selectedItem.id}
                item={selectedItem}
                pendingActionId={pendingActionId}
                acknowledgementError={acknowledgementErrors[selectedItem.id] ?? null}
                navigationError={
                  navigationFailure?.itemId === selectedItem.id
                    ? navigationFailure.message
                    : null
                }
                opensDestinationForActions={!onAction}
                onAction={(action) => void runAction(selectedItem, action)}
              />
            ) : (
              <motion.div key="placeholder" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <DetailPlaceholder />
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </div>
      </div>
    </MotionConfig>
  );
}

export default AttentionCenter;
