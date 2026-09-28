import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  CloudArrowUp,
  MagnifyingGlass,
  PaperPlaneRight,
  X,
} from "@phosphor-icons/react";
import { Cursor } from "@lobehub/icons";
import type {
  CloudAgent,
  CloudAgentList,
  CloudAgentOpenResult,
  CloudAgentProvider,
} from "../../../../shared/types";
import { DEVIN_CLOUD_PLATFORMS, laneCloudProvider } from "../../../../shared/cloudLanes";
import { useAppStore } from "../../../state/appStore";
import { invalidateAgentChatSessionListCache } from "../../../lib/agentChatSessionListCache";
import { invalidateSessionListCache } from "../../../lib/sessionListCache";
import { navigateUrlInAdeBrowser, openExternalUrl } from "../../../lib/openExternal";
import { revealTerminalSessionInWork } from "../../work/ClaudeLoginPromptButton";
import { settingsRouteFor } from "../../settings/settingsManifest";
import { DevinMark } from "../../shared/ProviderLogos";
import { cn } from "../../ui/cn";
import { Dialog } from "../../ui/dialog";
import { showToast } from "../toast/toastStore";
import { CloudAgentRow, type CloudAgentRowActions } from "./CloudAgentRow";
import {
  CLOUD_PROVIDER_BRANDS,
  filterCounts,
  fleetSummary,
  matchesFilter,
  matchesSearch,
  relativeAge,
  sectionAgents,
  type CloudAgentFilter,
  type CloudAgentScope,
} from "./cloudAgentsModel";

const REFRESH_MS = 12_000;

const FILTERS: Array<{ id: CloudAgentFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs_you", label: "Needs you" },
  { id: "active", label: "Working" },
  { id: "done", label: "Done" },
];

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function ProviderTile({ provider, size = 34 }: { provider: CloudAgentProvider; size?: number }) {
  const brand = CLOUD_PROVIDER_BRANDS[provider];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] text-white"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(145deg, color-mix(in srgb, ${brand.accent} 42%, #111) 0%, color-mix(in srgb, ${brand.accent} 18%, #0c0b11) 100%)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${brand.accent} 45%, transparent), 0 6px 18px -8px ${brand.accent}`,
      }}
    >
      {provider === "devin" ? <DevinMark size={Math.round(size * 0.66)} /> : <Cursor size={Math.round(size * 0.5)} />}
    </span>
  );
}

/** A compact select that reads as a chip. */
function ChipSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  title,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  title?: string;
}) {
  return (
    <label
      className="relative inline-flex h-7 max-w-[210px] items-center gap-1 rounded-full border border-white/[0.09] bg-white/[0.04] pl-2.5 pr-6 text-[11.5px] text-fg/80 transition-colors hover:border-white/20"
      title={title}
    >
      <span className="text-muted-fg/55">{label}</span>
      <span className="truncate">{options.find((option) => option.value === value)?.label ?? value}</span>
      <CaretDown size={10} weight="bold" className="pointer-events-none absolute right-2 text-muted-fg/55" />
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function CloudAgentsPanel({
  provider,
  projectName,
  onClose,
}: {
  provider: CloudAgentProvider;
  projectName: string | null;
  onClose: () => void;
}) {
  const brand = CLOUD_PROVIDER_BRANDS[provider];
  const navigate = useNavigate();
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const [list, setList] = useState<CloudAgentList | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CloudAgentFilter>("all");
  const [scope, setScope] = useState<CloudAgentScope>("project");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [, setTick] = useState(0);

  // Launch bar.
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("");
  const [platform, setPlatform] = useState<string>("linux");
  const [targetLaneId, setTargetLaneId] = useState<string>("");
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async (force: boolean) => {
    const id = ++generation.current;
    if (force) setRefreshing(true);
    try {
      const next = await window.ade.cloudAgents.list({ provider, force });
      if (id !== generation.current) return;
      setList(next);
      setLoadError(null);
    } catch (error) {
      if (id !== generation.current) return;
      setLoadError(errorText(error));
    } finally {
      if (id === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [provider]);

  useEffect(() => {
    void refresh(false);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(false);
      setTick((tick) => tick + 1);
    }, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!model && list?.models[0]) setModel(list.models[0].value);
  }, [list, model]);

  const cloudLanes = useMemo(
    () => lanes.filter((lane) => laneCloudProvider(lane) === provider && !lane.archivedAt),
    [lanes, provider],
  );

  const agents = list?.items ?? [];
  const scoped = useMemo(
    () => agents.filter((agent) => scope === "everywhere" || agent.inThisProject || agent.link !== null),
    [agents, scope],
  );
  const counts = useMemo(() => filterCounts(scoped), [scoped]);
  const visible = useMemo(
    () => scoped.filter((agent) => matchesFilter(agent, filter) && matchesSearch(agent, query)),
    [scoped, filter, query],
  );
  const sections = useMemo(() => sectionAgents(visible), [visible]);
  const hiddenElsewhere = agents.filter((agent) => !agent.inThisProject && agent.link === null && agent.status !== "archived").length;

  const revealChat = useCallback((result: CloudAgentOpenResult) => {
    if (projectRoot) {
      invalidateSessionListCache({ projectRoot });
      invalidateAgentChatSessionListCache({ projectRoot, laneId: result.laneId });
    }
    // Opening can create or tag a lane in the brain; pull it so the lane and
    // its cloud mark show without waiting for the next lane poll.
    void refreshLanes().catch(() => undefined);
    revealTerminalSessionInWork(navigate, { terminalId: result.chatSessionId, laneId: result.laneId }, 160);
    onClose();
  }, [navigate, onClose, projectRoot, refreshLanes]);

  const runRowAction = useCallback(async (agent: CloudAgent, work: () => Promise<void>) => {
    setBusyId(agent.id);
    setRowError(null);
    try {
      await work();
    } catch (error) {
      setRowError({ id: agent.id, message: errorText(error) });
    } finally {
      setBusyId(null);
    }
  }, []);

  const vmTerminal = useCallback(async (agent: CloudAgent, args: string[], title: string) => {
    const laneId = agent.link?.laneId
      ?? lanes.find((lane) => lane.laneType === "primary")?.id
      ?? null;
    if (!laneId) throw new Error("No lane to host the terminal.");
    const created = await window.ade.pty.create({
      laneId,
      cols: 110,
      rows: 32,
      title,
      tracked: true,
      toolType: "devin",
      command: "devin",
      args,
    });
    revealTerminalSessionInWork(navigate, { terminalId: created.sessionId, laneId });
    onClose();
  }, [lanes, navigate, onClose]);

  const actions: CloudAgentRowActions = useMemo(() => ({
    onOpen: (agent) => void runRowAction(agent, async () => {
      revealChat(await window.ade.cloudAgents.open({ provider, id: agent.id }));
    }),
    onStop: (agent) => void runRowAction(agent, async () => {
      await window.ade.cloudAgents.stop({ provider, id: agent.id });
      showToast({ title: `Stopped “${agent.title}”`, tone: "success", durationMs: 3500 });
      await refresh(true);
    }),
    onArchive: (agent) => void runRowAction(agent, async () => {
      await window.ade.cloudAgents.archive({ provider, id: agent.id, archived: true });
      showToast({ title: `Archived “${agent.title}”`, tone: "success", durationMs: 3500 });
      await refresh(true);
    }),
    onWeb: (agent) => {
      if (agent.webUrl) navigateUrlInAdeBrowser(agent.webUrl, { newTab: true });
      onClose();
    },
    onVmShell: (agent) => void runRowAction(agent, () =>
      vmTerminal(
        agent,
        ["ssh", agent.id, "-o", "StrictHostKeyChecking=accept-new"],
        `Devin VM · ${agent.title.slice(0, 40)}`,
      )),
    onForwardPort: (agent, port) => void runRowAction(agent, () =>
      vmTerminal(agent, ["forward", agent.id, port], `Devin VM :${port} · ${agent.title.slice(0, 32)}`)),
    onCopyLink: (agent) => {
      if (!agent.webUrl) return;
      void navigator.clipboard.writeText(agent.webUrl).then(
        () => showToast({ title: "Link copied", tone: "success", durationMs: 2500 }),
        () => showToast({ title: "Could not copy the link", tone: "error" }),
      );
    },
  }), [onClose, provider, refresh, revealChat, runRowAction, vmTerminal]);

  const launch = useCallback(async () => {
    const text = prompt.trim();
    if (!text || launching) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const result = await window.ade.cloudAgents.launch({
        provider,
        prompt: text,
        model: model || null,
        ...(provider === "devin" ? { platform } : {}),
        laneId: targetLaneId || null,
      });
      setPrompt("");
      showToast({
        title: `${brand.name} is on it`,
        message: result.createdLane ? `New cloud lane “${result.laneName ?? "Cloud agent"}”` : undefined,
        tone: "success",
        durationMs: 4000,
      });
      revealChat(result);
    } catch (error) {
      setLaunchError(errorText(error));
    } finally {
      setLaunching(false);
    }
  }, [brand.name, launching, model, platform, prompt, provider, revealChat, targetLaneId]);

  const unavailable = list?.unavailableReason ?? null;
  const fetchedAge = relativeAge(list?.fetchedAt);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={brand.name}
      hideHeader
      width={940}
      height="min(800px, calc(100dvh - 28px))"
      maxHeight="calc(100dvh - 28px)"
      bodyPadding={false}
      scrollBody={false}
      bodyStyle={{ display: "flex", flexDirection: "column" }}
      preventAutoFocus
      panelStyle={{
        background: "var(--ade-shell-surface, #121019)",
        borderRadius: 16,
        borderColor: `color-mix(in srgb, ${brand.accent} 26%, rgba(255,255,255,0.08))`,
        boxShadow: `0 30px 90px rgba(0,0,0,0.6), 0 0 0 1px color-mix(in srgb, ${brand.accent} 12%, transparent)`,
      }}
    >
      {/* Header */}
      <div
        className="flex shrink-0 items-center gap-3 px-5 pb-3 pt-4"
        style={{ background: `radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, ${brand.accent} 13%, transparent) 0%, transparent 60%)` }}
      >
        <ProviderTile provider={provider} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-2">
            <span className="text-[15.5px] font-semibold tracking-[-0.01em] text-fg">{brand.name}</span>
            {refreshing ? <span className="h-1.5 w-1.5 rounded-full bg-sky-400 motion-safe:animate-pulse" aria-hidden /> : null}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-muted-fg/60">
            {loading && !list ? "Loading…" : fleetSummary(scoped, brand.noun)}
            {projectName ? ` · ${projectName}` : ""}
          </div>
        </div>
        <button
          type="button"
          aria-label="Refresh"
          title="Refresh"
          onClick={() => void refresh(true)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-fg/70 transition-colors hover:bg-white/[0.07] hover:text-fg"
        >
          <ArrowsClockwise size={15} weight="bold" className={refreshing ? "animate-spin" : undefined} />
        </button>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-fg/70 transition-colors hover:bg-white/[0.07] hover:text-fg"
        >
          <X size={15} weight="bold" />
        </button>
      </div>

      {/* Launch bar */}
      {!unavailable ? (
        <div className="mx-5 shrink-0 rounded-2xl border border-white/[0.09] bg-black/20 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus-within:border-white/[0.18]">
          <textarea
            ref={promptRef}
            value={prompt}
            rows={2}
            placeholder={`Give ${brand.name} a task — it runs on its own VM in a new cloud lane…`}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void launch();
              }
            }}
            className="block max-h-40 min-h-[44px] w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-relaxed text-fg placeholder:text-muted-fg/40 focus:outline-none"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {list && list.models.length ? (
              <ChipSelect
                label="Model"
                value={model}
                options={list.models.map((option) => ({
                  value: option.value,
                  label: option.badge ? `${option.label} · ${option.badge}` : option.label,
                }))}
                onChange={setModel}
              />
            ) : null}
            {provider === "devin" ? (
              <ChipSelect
                label="VM"
                value={platform}
                options={DEVIN_CLOUD_PLATFORMS.map((option) => ({ value: option.value, label: option.label }))}
                onChange={setPlatform}
              />
            ) : null}
            <ChipSelect
              label="Lane"
              value={targetLaneId}
              title="Where the work lands. A new cloud lane gets its own branch."
              options={[
                { value: "", label: "New cloud lane" },
                ...cloudLanes.map((lane) => ({ value: lane.id, label: lane.name })),
              ]}
              onChange={setTargetLaneId}
            />
            <span className="flex-1" />
            <span className="hidden text-[10.5px] text-muted-fg/40 sm:inline">⌘↵</span>
            <button
              type="button"
              disabled={!prompt.trim() || launching}
              onClick={() => void launch()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-white shadow-sm transition-[filter,opacity] hover:brightness-110 disabled:opacity-40"
              style={{ background: brand.accent }}
            >
              {launching ? <ArrowsClockwise size={13} weight="bold" className="animate-spin" /> : <PaperPlaneRight size={13} weight="fill" />}
              {launching ? "Starting…" : "Start"}
            </button>
          </div>
          {launchError ? <div className="mt-2 px-1 text-[11.5px] text-red-300/90">{launchError}</div> : null}
        </div>
      ) : null}

      {/* Toolbar */}
      {!unavailable ? (
        <div className="mx-5 mt-3 flex shrink-0 flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-full border border-white/[0.07] bg-white/[0.025] p-0.5">
            {FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11.5px] transition-colors",
                  filter === option.id ? "bg-white/[0.1] text-fg" : "text-muted-fg/65 hover:text-fg/90",
                  option.id === "needs_you" && counts.needs_you > 0 && filter !== option.id && "text-amber-200/90",
                )}
              >
                {option.label}
                {counts[option.id] > 0 ? <span className="tabular-nums text-muted-fg/50">{counts[option.id]}</span> : null}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setScope((current) => (current === "project" ? "everywhere" : "project"))}
            className="inline-flex h-7 items-center rounded-full border border-white/[0.07] px-2.5 text-[11.5px] text-muted-fg/70 transition-colors hover:border-white/15 hover:text-fg/90"
            title={scope === "project" ? "Showing this project's repo. Click to include every repo." : "Showing every repo. Click for this project only."}
          >
            {scope === "project" ? "This project" : "All repos"}
          </button>
          <span className="flex-1" />
          <label className="inline-flex h-7 w-[220px] items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.025] px-2.5 focus-within:border-white/20">
            <MagnifyingGlass size={12} className="text-muted-fg/50" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${brand.noun}s`}
              aria-label={`Search ${brand.noun}s`}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-fg placeholder:text-muted-fg/40 focus:outline-none"
            />
          </label>
        </div>
      ) : null}

      {/* List */}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && !list ? (
          <div className="space-y-2 px-3 pt-3" aria-label="Loading">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-[70px] animate-pulse rounded-xl bg-white/[0.03]" />
            ))}
          </div>
        ) : unavailable || loadError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-10 text-center">
            <ProviderTile provider={provider} size={44} />
            <div className="text-[14px] font-medium text-fg/90">
              {provider === "devin" ? "Connect the Devin CLI" : "Connect Cursor"}
            </div>
            <div className="max-w-[440px] text-[12px] leading-relaxed text-muted-fg/60">
              {unavailable ?? loadError}
            </div>
            {provider === "devin" ? (
              <code className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-[12px] text-fg/85">devin auth login</code>
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refresh(true)}
                className="inline-flex h-8 items-center rounded-lg border border-white/10 px-3 text-[12px] text-fg/80 hover:border-white/20"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => {
                  navigate(`${settingsRouteFor("agents.providers").split("#")[0]}&provider=${provider}`);
                  onClose();
                }}
                className="inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-medium text-white"
                style={{ background: brand.accent }}
              >
                Open {provider === "devin" ? "Devin" : "Cursor"} settings
              </button>
            </div>
          </div>
        ) : sections.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-10 text-center">
            <CloudArrowUp size={30} weight="duotone" className="text-muted-fg/40" />
            <div className="text-[13.5px] font-medium text-fg/85">
              {query || filter !== "all" ? `No ${brand.noun}s match` : `No ${brand.name} ${brand.noun}s for this project yet`}
            </div>
            <div className="max-w-[420px] text-[12px] leading-relaxed text-muted-fg/55">
              {query || filter !== "all"
                ? "Try another filter or clear the search."
                : `Start one above. It gets its own VM and its own lane here, and you can chat with it from ADE while it works.`}
            </div>
            {scope === "project" && hiddenElsewhere > 0 ? (
              <button type="button" onClick={() => setScope("everywhere")} className="mt-1 text-[12px] text-sky-300/90 hover:underline">
                Show {hiddenElsewhere} from other repos
              </button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            {sections.map((section) => (
              <section key={section.id}>
                <div className="flex items-center gap-2 px-3 pb-1 pt-1.5">
                  <span
                    className={cn(
                      "text-[10.5px] font-semibold uppercase tracking-[0.07em]",
                      section.id === "needs_you" ? "text-amber-200/80" : section.id === "working" ? "text-sky-200/80" : "text-muted-fg/45",
                    )}
                  >
                    {section.label}
                  </span>
                  <span className="text-[10.5px] tabular-nums text-muted-fg/35">{section.agents.length}</span>
                  <span className="h-px flex-1 bg-white/[0.05]" />
                </div>
                <div className="space-y-0.5">
                  {section.agents.map((agent) => (
                    <CloudAgentRow
                      key={agent.id}
                      agent={agent}
                      brand={brand}
                      capabilities={list!.capabilities}
                      models={list!.models}
                      busy={busyId === agent.id}
                      error={rowError?.id === agent.id ? rowError.message : null}
                      actions={actions}
                    />
                  ))}
                </div>
              </section>
            ))}
            {scope === "project" && hiddenElsewhere > 0 ? (
              <div className="pb-2 pt-1 text-center">
                <button type="button" onClick={() => setScope("everywhere")} className="text-[11.5px] text-muted-fg/50 hover:text-fg/80">
                  {hiddenElsewhere} more in other repos
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-2 text-[11px] text-muted-fg/45">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" aria-hidden />
          Live{fetchedAge ? ` · updated ${fetchedAge === "now" ? "just now" : `${fetchedAge} ago`}` : ""}
        </span>
        <button
          type="button"
          onClick={() => openExternalUrl(brand.webHome)}
          className="inline-flex items-center gap-1 transition-colors hover:text-fg/80"
        >
          {brand.webHomeLabel}
          <ArrowSquareOut size={10} weight="bold" />
        </button>
      </div>
    </Dialog>
  );
}
