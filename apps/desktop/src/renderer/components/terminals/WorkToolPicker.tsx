import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Broom } from "@phosphor-icons/react";
import { useAppStore, type WorkSidebarTab } from "../../state/appStore";
import { cn } from "../ui/cn";
import { MachinePlatformLogo } from "../remoteTargets/MachineIdentity";
import { WorkToolPickerBackdrop } from "./WorkToolPickerBackdrop";
import { joinNames, railMachineName, type LeftoverMachine } from "./workToolCatalog";
import type { CatalogCardView } from "./useWorkToolCatalog";
import { WorkToolTileMark } from "./workToolTileMarks";

/** Two equal columns, always: ten or eleven tiles read as one block. */
const TILE_COLUMNS = 2;
const TILE_GAP_PX = 8;

export type WorkToolCatalogProps = {
  tiles: CatalogCardView[];
  leftovers: readonly LeftoverMachine[];
  cleaningUp: boolean;
  onCleanUp: (() => void) | null;
};

/**
 * The tools pane's front page: one equal tile per tool this chat can open.
 *
 * The page never scrolls. Tiles sit in a two-column grid whose rows share
 * the pane's height (`repeat(n, minmax(0, 1fr))`), and each tile is a size
 * container that drops its secondary text and tightens as it gets shorter
 * (`.ade-tool-tile` in index.css), so the whole catalogue always fits.
 *
 * A tile is a logo, a name and one status line, plus the machine a device
 * runs on as plain text. Choices (which machine, which device) live in the
 * tool the tile opens. A tool the agent is driving says so with a moving
 * ring in its own colour and "Agent: …" as its line; a live one has a still
 * ring. Nothing changes size.
 */
export function WorkToolPicker({
  activeTool,
  loading,
  onPick,
  cardActions,
  playing = true,
  catalog,
}: {
  activeTool: WorkSidebarTab | null;
  loading: boolean;
  onPick: (tool: WorkSidebarTab) => void;
  /** Per-tool corner action (the Apple and Android device menus), revealed on hover or focus. */
  cardActions?: Partial<Record<WorkSidebarTab, ReactNode>>;
  /** False pauses the mesh loop without dropping the last frame. */
  playing?: boolean;
  catalog: WorkToolCatalogProps;
}) {
  const theme = useAppStore((s) => s.theme);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const tiles = catalog.tiles;
  const rows = Math.max(1, Math.ceil(tiles.length / TILE_COLUMNS));

  const focusableTiles = useCallback(
    () => rootRef.current?.querySelectorAll<HTMLButtonElement>("button[data-tool-id]:not(:disabled)") ?? null,
    [],
  );

  // Arrows walk the tiles and take focus with them, so Enter is the
  // browser's own activation.
  useEffect(() => {
    if (!playing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const step = event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
      if (step === 0) return;
      const target = event.target;
      const node = target instanceof Node ? target : null;
      const mine = target === document.body || (node != null && rootRef.current?.contains(node) === true);
      if (!mine) return;
      const buttons = focusableTiles();
      const count = buttons?.length ?? 0;
      if (!count) return;
      event.preventDefault();
      setHighlight((current) => {
        const next = current < 0 ? (step > 0 ? 0 : count - 1) : (current + step + count) % count;
        buttons?.[next]?.focus();
        return next;
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusableTiles, playing]);

  let openableIndex = -1;
  return (
    <div ref={rootRef} className="ade-pane-chrome relative h-full min-h-0">
      <WorkToolPickerBackdrop theme={theme} playing={playing} />
      <div
        data-tool-picker-scroll=""
        className="relative flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3"
        onPointerMove={() => setHighlight((current) => (current === -1 ? current : -1))}
      >
        <div
          role="group"
          aria-label="Work tools"
          className="grid min-h-0 flex-1"
          style={{
            gap: TILE_GAP_PX,
            gridTemplateColumns: `repeat(${TILE_COLUMNS}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {tiles.map((tile) => {
            if (tile.available) openableIndex += 1;
            return (
              <ToolTile
                key={tile.id}
                tile={tile}
                isActive={activeTool === tile.tool}
                highlighted={tile.available && highlight === openableIndex}
                skeleton={loading && tile.available && tile.line == null}
                onOpen={() => onPick(tile.tool)}
                action={cardActions?.[tile.tool] ?? null}
              />
            );
          })}
        </div>
        {catalog.leftovers.length ? (
          <CleanupLine leftovers={catalog.leftovers} busy={catalog.cleaningUp} onCleanUp={catalog.onCleanUp} />
        ) : null}
      </div>
    </div>
  );
}

function ToolTile({
  tile,
  isActive,
  highlighted,
  skeleton,
  onOpen,
  action,
}: {
  tile: CatalogCardView;
  isActive: boolean;
  highlighted: boolean;
  skeleton: boolean;
  onOpen: () => void;
  action: ReactNode;
}) {
  const style = { ["--tool-color" as string]: tile.color } as CSSProperties;
  const machine = tile.kind && tile.machine ? tile.machine : null;
  return (
    <div
      className={cn("ade-tool-card ade-tool-tile group/card", !tile.available && "ade-tool-tile-off")}
      style={style}
      data-tool-card={tile.id}
      data-live={tile.live ? "true" : undefined}
      data-agent={tile.agentNow ? "true" : undefined}
      data-highlighted={highlighted ? "true" : undefined}
    >
      {tile.agentNow ? <span aria-hidden="true" className="ade-tool-tile-ring"><span /></span> : null}
      <div className="ade-tool-tile-body">
        <div className="ade-tool-tile-top">
          <span className="ade-tool-tile-mark" style={{ color: tile.markColor }} aria-hidden="true">
            <WorkToolTileMark card={tile.id} machine={tile.machine} size="100%" />
          </span>
          {machine ? (
            <span className="ade-tool-tile-machine" title={`Runs on ${machine.name}`}>
              <MachinePlatformLogo platform={machine.platform} size={11} weight="fill" fallback />
              <span className="truncate">{railMachineName(machine)}</span>
            </span>
          ) : null}
          <TileStateMark tile={tile} />
        </div>
        <div className="ade-tool-tile-text">
          {/* The tile's one open control; its `::after` covers the tile. */}
          <button
            type="button"
            data-tool-id={tile.tool}
            disabled={!tile.available}
            aria-current={isActive ? "true" : undefined}
            aria-describedby={`tool-tile-line-${tile.id}`}
            onClick={onOpen}
            className="ade-tool-tile-name"
          >
            {tile.label}
          </button>
          {skeleton ? (
            <span aria-hidden="true" className="ade-tool-skeleton ade-tool-tile-line mt-1 h-[10px] w-3/5 rounded-full" />
          ) : tile.line ? (
            <span
              id={`tool-tile-line-${tile.id}`}
              className={cn("ade-tool-tile-line", tile.agentNow && "ade-tool-tile-line-agent", tile.stale && "opacity-50")}
              title={tile.line}
              data-tool-activity={tile.agentNow ? tile.id : undefined}
            >
              {tile.line}
            </span>
          ) : null}
        </div>
      </div>
      {action ? (
        <div className="pointer-events-none absolute bottom-1.5 right-1.5 z-[2] opacity-0 transition-opacity duration-[120ms] ease-out group-hover/card:pointer-events-auto group-hover/card:opacity-100 group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100">
          {action}
        </div>
      ) : null}
    </div>
  );
}

/** Broken is red, waiting-on-you is amber, live is a still dot in the tool's colour. The agent's ring says the rest. */
function TileStateMark({ tile }: { tile: CatalogCardView }) {
  if (tile.error) {
    return <span role="img" aria-label={`${tile.label} · errors`} data-tool-error-dot={tile.id} className="ade-tool-tile-dot bg-[var(--color-error)]" />;
  }
  if (tile.attention) {
    return <span role="img" aria-label={`${tile.label} · needs you`} className="ade-tool-tile-dot bg-[#fbbf24]" />;
  }
  if (tile.live) {
    return <span role="img" aria-label={tile.agentNow ? `${tile.label} · agent using it` : `${tile.label} · live`} className="ade-tool-tile-dot" style={{ background: "var(--tool-color)" }} />;
  }
  return null;
}

function CleanupLine({
  leftovers,
  busy,
  onCleanUp,
}: {
  leftovers: readonly LeftoverMachine[];
  busy: boolean;
  onCleanUp: (() => void) | null;
}) {
  const names = leftovers.map((entry) => entry.use.machineName);
  const things = [...new Set(leftovers.flatMap((entry) => entry.things))];
  const sentence = `Left on ${joinNames(names)}: ${joinNames(things)}`;
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-2 rounded-[9px] px-2.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-[color-mix(in_srgb,var(--color-card)_70%,transparent)]"
      data-testid="work-tools-cleanup"
    >
      <Broom size={14} aria-hidden="true" className="shrink-0 text-muted-fg" />
      <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-fg/75" title={sentence}>{sentence}</span>
      {onCleanUp ? (
        <button
          type="button"
          onClick={onCleanUp}
          disabled={busy}
          title="Deletes this chat's code there and the devices and app it started. The machine stays."
          className="shrink-0 rounded-[7px] px-2 py-0.5 font-sans text-[12px] font-medium text-fg/85 hover:bg-fg/[0.06] hover:text-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {busy ? "Cleaning up…" : "Clean up"}
        </button>
      ) : null}
    </div>
  );
}
