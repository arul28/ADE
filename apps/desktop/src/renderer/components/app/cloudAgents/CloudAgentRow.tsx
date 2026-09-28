import React, { useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowsLeftRight,
  Archive,
  CircleNotch,
  CloudCheck,
  DotsThree,
  GitBranch,
  GitPullRequest,
  LinkSimple,
  Monitor,
  StopCircle,
  TerminalWindow,
} from "@phosphor-icons/react";
import type { CloudAgent, CloudAgentCapabilities, CloudAgentModelOption } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { Z_LAYERS } from "../../ui/zLayers";
import { STATUS_TONE, modelLabel, relativeAge, type CloudProviderBrand } from "./cloudAgentsModel";

export type CloudAgentRowActions = {
  onOpen: (agent: CloudAgent) => void;
  onStop: (agent: CloudAgent) => void;
  onArchive: (agent: CloudAgent) => void;
  onWeb: (agent: CloudAgent) => void;
  onVmShell: (agent: CloudAgent) => void;
  onForwardPort: (agent: CloudAgent, port: string) => void;
  onCopyLink: (agent: CloudAgent) => void;
};

const CHIP =
  "inline-flex min-w-0 max-w-[220px] shrink items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.035] px-1.5 py-[1px] text-[10.5px] leading-[15px] text-muted-fg/75";

const ICON_BUTTON =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-fg/70 transition-colors hover:bg-white/[0.08] hover:text-fg disabled:opacity-40";

const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg/80 transition-colors hover:bg-white/[0.07] hover:text-fg disabled:opacity-40";

function StatusDot({ agent }: { agent: CloudAgent }) {
  const tone = STATUS_TONE[agent.status];
  const live = agent.status === "working" || agent.status === "starting";
  return (
    <span className="relative mt-[5px] inline-flex h-2.5 w-2.5 shrink-0" aria-hidden>
      {live ? (
        <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", tone.dot)} />
      ) : null}
      <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", tone.dot)} />
    </span>
  );
}

export function CloudAgentRow({
  agent,
  brand,
  capabilities,
  models,
  busy,
  error,
  actions,
}: {
  agent: CloudAgent;
  brand: CloudProviderBrand;
  capabilities: CloudAgentCapabilities;
  models: CloudAgentModelOption[];
  busy: boolean;
  error: string | null;
  actions: CloudAgentRowActions;
}) {
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const tone = STATUS_TONE[agent.status];
  const age = relativeAge(agent.updatedAt ?? agent.createdAt);
  const canStop = capabilities.stop && (agent.status === "working" || agent.status === "starting" || agent.status === "needs_you");
  const model = modelLabel(agent.model, models);
  const pr = agent.pullRequest;
  const openLabel = agent.link ? "Open" : "Open in ADE";
  const openHint = agent.link
    ? `Open this ${brand.noun}'s chat in ${agent.link.laneName ? `“${agent.link.laneName}”` : "its lane"}`
    : agent.branch
      ? `Makes a ${brand.name} lane on ${agent.branch} and opens the chat there`
      : `Makes a ${brand.name} lane for this ${brand.noun} and opens the chat there`;
  const subtitle = [agent.statusText && agent.status !== "archived" ? agent.statusText : null, agent.excerpt]
    .filter(Boolean)
    .join(" — ");

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${agent.title}, ${tone.label}`}
      data-cloud-agent-row={agent.id}
      onClick={() => {
        if (!busy) actions.onOpen(agent);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!busy) actions.onOpen(agent);
        }
      }}
      className={cn(
        "group/cloud-row relative flex w-full cursor-pointer select-none gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors duration-100",
        "hover:bg-white/[0.045] focus-visible:bg-white/[0.06]",
        agent.status === "needs_you" && "bg-amber-400/[0.04] hover:bg-amber-400/[0.07]",
      )}
    >
      <StatusDot agent={agent} />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[13.5px] font-medium text-fg/92">{agent.title}</span>
          {agent.unread ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" title="New activity" aria-label="New activity" />
          ) : null}
          <span className="flex-1" />
          <span className={cn("shrink-0 text-[11px] font-medium transition-opacity group-hover/cloud-row:opacity-0", tone.text)}>
            {tone.label}
          </span>
          {age ? (
            <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-fg/45 transition-opacity group-hover/cloud-row:opacity-0">
              {age}
            </span>
          ) : null}
        </div>

        {subtitle ? (
          <div className="mt-0.5 truncate text-[12px] italic text-muted-fg/60">{subtitle}</div>
        ) : null}

        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {agent.link ? (
            <span
              className={cn(CHIP, agent.link.laneIsCloud ? "border-sky-400/20 bg-sky-400/[0.07] text-sky-100/85" : "")}
              title={agent.link.laneIsCloud ? `Cloud lane on ${brand.name}` : "Lane on this computer"}
            >
              {agent.link.laneIsCloud ? <CloudCheck size={11} weight="fill" /> : <GitBranch size={11} />}
              <span className="truncate">{agent.link.laneName ?? "Lane"}</span>
            </span>
          ) : null}
          {agent.branch && (!agent.link || agent.link.laneName !== agent.branch) ? (
            <span className={cn(CHIP, "font-mono text-[10px]")} title={agent.branch}>
              <GitBranch size={11} />
              <span className="truncate">{agent.branch}</span>
            </span>
          ) : null}
          {pr ? (
            <button
              type="button"
              className={cn(CHIP, "hover:border-white/20 hover:text-fg/90")}
              title={pr.title ?? pr.url}
              onClick={(event) => {
                event.stopPropagation();
                actions.onWeb({ ...agent, webUrl: pr.url });
              }}
            >
              <GitPullRequest
                size={11}
                className={pr.state === "merged" ? "text-violet-300" : pr.state === "closed" ? "text-red-300/80" : "text-emerald-300"}
              />
              <span className="tabular-nums">{pr.number ? `#${pr.number}` : "PR"}</span>
              {pr.additions != null || pr.deletions != null ? (
                <span className="font-mono text-[10px]">
                  <span className="text-emerald-400/90">+{pr.additions ?? 0}</span>{" "}
                  <span className="text-red-400/90">−{pr.deletions ?? 0}</span>
                </span>
              ) : null}
            </button>
          ) : null}
          {model ? <span className={CHIP}>{model}</span> : null}
          {agent.platform && agent.platform !== "linux" ? (
            <span className={CHIP}>{agent.platform === "macos" ? "macOS" : agent.platform}</span>
          ) : null}
          {agent.link ? null : agent.origin ? <span className={cn(CHIP, "text-muted-fg/55")}>via {agent.origin}</span> : null}
          {!agent.inThisProject && agent.repos[0] ? (
            <span className={cn(CHIP, "text-muted-fg/55")} title="Another repository">{agent.repos[0]}</span>
          ) : null}
        </div>

        {error ? <div className="mt-1.5 text-[11.5px] text-red-300/90">{error}</div> : null}
      </div>

      {/* Actions: over the status/age slot on hover, always on keyboard focus. */}
      <div
        className={cn(
          "absolute right-2.5 top-2 flex items-center gap-0.5 rounded-lg bg-[color:var(--ade-shell-surface,#15131d)]/95 pl-1 opacity-0 shadow-[0_0_0_1px_rgba(255,255,255,0.06)] transition-opacity",
          "group-hover/cloud-row:opacity-100 group-focus-within/cloud-row:opacity-100",
          (busy || menuOpen) && "opacity-100",
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {busy ? (
          <span className="inline-flex h-7 w-7 items-center justify-center text-muted-fg/70">
            <CircleNotch size={14} className="animate-spin" />
          </span>
        ) : null}
        {canStop ? (
          <button type="button" className={ICON_BUTTON} title="Stop" aria-label="Stop" disabled={busy} onClick={() => actions.onStop(agent)}>
            <StopCircle size={15} weight="bold" />
          </button>
        ) : null}
        {capabilities.web && agent.webUrl ? (
          <button
            type="button"
            className={ICON_BUTTON}
            title={`Open on ${brand.webHomeLabel}`}
            aria-label={`Open on ${brand.webHomeLabel}`}
            onClick={() => actions.onWeb(agent)}
          >
            <ArrowSquareOut size={15} weight="bold" />
          </button>
        ) : null}
        <button
          ref={moreRef}
          type="button"
          className={ICON_BUTTON}
          title="More"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <DotsThree size={16} weight="bold" />
        </button>
        <button
          type="button"
          disabled={busy}
          title={openHint}
          onClick={() => actions.onOpen(agent)}
          className="ml-1 inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-white shadow-sm transition-[filter] hover:brightness-110 disabled:opacity-50"
          style={{ background: brand.accent }}
        >
          {openLabel}
        </button>
      </div>

      <AnchoredMenu
        open={menuOpen}
        anchorRef={moreRef}
        onClose={() => {
          setMenuOpen(false);
          setPortDraft(null);
        }}
        placement="bottom-end"
        zIndex={Z_LAYERS.nestedDialog}
        className="w-[230px] rounded-xl border border-white/10 bg-[#17151f] p-1 shadow-xl shadow-black/50"
        role="menu"
      >
        <div onClick={(event) => event.stopPropagation()}>
          {capabilities.vmShell && agent.status !== "archived" ? (
            <>
              <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-fg/45">
                On the VM
              </div>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  setMenuOpen(false);
                  actions.onVmShell(agent);
                }}
              >
                <TerminalWindow size={14} /> Shell on the VM
              </button>
              {portDraft === null ? (
                <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => setPortDraft("")}>
                  <ArrowsLeftRight size={14} /> Forward a port…
                </button>
              ) : (
                <form
                  className="flex items-center gap-1 px-1 py-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!portDraft.trim()) return;
                    setMenuOpen(false);
                    actions.onForwardPort(agent, portDraft.trim());
                    setPortDraft(null);
                  }}
                >
                  <input
                    autoFocus
                    value={portDraft}
                    inputMode="numeric"
                    placeholder="3000 or 8080:3000"
                    aria-label="VM port to forward"
                    onChange={(event) => setPortDraft(event.target.value.replace(/[^0-9:]/g, ""))}
                    className="h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.04] px-2 font-mono text-[11px] text-fg/85 outline-none placeholder:text-muted-fg/35 focus:border-sky-400/40"
                  />
                  <button type="submit" disabled={!portDraft.trim()} className="h-7 rounded-md bg-sky-500/80 px-2 text-[11px] font-medium text-white disabled:opacity-40">
                    Go
                  </button>
                </form>
              )}
              <div className="my-1 h-px bg-white/[0.06]" />
            </>
          ) : null}
          {agent.provider === "cursor" && agent.webUrl && agent.status !== "archived" ? (
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                setMenuOpen(false);
                actions.onWeb(agent);
              }}
            >
              <Monitor size={14} /> Take over its desktop
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              setMenuOpen(false);
              actions.onCopyLink(agent);
            }}
          >
            <LinkSimple size={14} /> Copy link
          </button>
          {capabilities.archive && agent.status !== "archived" ? (
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                actions.onArchive(agent);
              }}
            >
              <Archive size={14} /> Archive
            </button>
          ) : null}
        </div>
      </AnchoredMenu>
    </div>
  );
}
