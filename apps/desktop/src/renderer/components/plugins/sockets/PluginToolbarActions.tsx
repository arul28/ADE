import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown, DotsSixVertical } from "@phosphor-icons/react";

import type { PluginContribution, PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import { useAccountStatus } from "../../../lib/account";
import { contributionKey } from "./contributionModel";
import { usePluginDeclaredWebviewPress } from "./usePluginDeclaredWebview";
import { usePluginSocketInvoke, useSurfaceContributions } from "./useSurfaceContributions";
import { brandIconsProp, usePluginBrandIcons } from "./usePluginBrandIcons";
import { SocketBoundary } from "./SocketBoundary";
import {
  SOCKET_SHELL_CHEVRON_CLASS,
  SocketButton,
  SocketMenuRow,
  SocketMenuSubRows,
  SocketOverflow,
  SocketSplitGroup,
  SocketSplitMenu,
  socketTintStyle,
  type SocketButtonChrome,
} from "./socketUi";
import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import {
  applyPluginToolbarOrder,
  movePluginToolbarItem,
  readPluginToolbarOrder,
  visiblePluginToolbarCount,
  writePluginToolbarOrder,
  type PluginToolbarOrderItem,
} from "./pluginToolbarOrder";

/** Plugin buttons never crowd out the surface's own; beyond this they fold away. */
const VISIBLE_LIMIT = 2;
const HEADER_GAP = 6;
const HEADER_CHEVRON_WIDTH = 20;

/**
 * The chevron, wearing `SocketButton`'s chrome minus its left edge.
 *
 * Butted against the button rather than spaced from it, so the pair reads as one
 * control with two halves — which is what a split button is, and what the user
 * who asked for "a small arrow on the drink button" was describing.
 */
const SPLIT_CHEVRON_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 28,
  width: 18,
  color: COLORS.textSecondary,
  background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
  border: `1px solid ${COLORS.borderMuted}`,
  borderLeft: "none",
  borderRadius: `0 ${RADII.sm} ${RADII.sm} 0`,
  cursor: "pointer",
};

/** The button half loses its right radius when a chevron is butted against it. */
const SPLIT_BUTTON_STYLE: React.CSSProperties = {
  borderRadius: `${RADII.sm} 0 0 ${RADII.sm}`,
};

/**
 * The same joint in the window header's chrome.
 *
 * `ade-shell-control` owns the radius and the border there, so the seam is made
 * by removing the chevron's left edge rather than by drawing a second box —
 * which is the whole reason the cluster gets a chrome of its own.
 */
const SHELL_SPLIT_CHEVRON_STYLE: React.CSSProperties = {
  borderLeft: "none",
  borderTopLeftRadius: 0,
  borderBottomLeftRadius: 0,
};

type ToolbarContribution = PluginContribution<"toolbar-action">;

function ToolbarActionControl({
  contribution,
  dataTour,
  chrome,
  press,
  invoke,
  resolvedContext,
  brandIconsFor,
}: {
  contribution: ToolbarContribution;
  dataTour: string;
  chrome: SocketButtonChrome;
  press: (contribution: ToolbarContribution) => void;
  invoke: ReturnType<typeof usePluginSocketInvoke>;
  resolvedContext: PluginSurfaceContext;
  brandIconsFor: ReturnType<typeof usePluginBrandIcons>;
}) {
  const menu = contribution.payload.menu ?? [];
  const tint = socketTintStyle(contribution.payload.color);
  const brandIcons = brandIconsFor(contribution.pluginId);
  const button = (
    <SocketButton
      dataTour={dataTour}
      label={contribution.payload.label}
      {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
      {...brandIconsProp(brandIcons)}
      {...(contribution.payload.disabled ? { disabled: true } : {})}
      {...(chrome === "shell" ? { chrome } : {})}
      style={{ ...(menu.length > 0 && chrome !== "shell" ? SPLIT_BUTTON_STYLE : {}), ...tint }}
      onClick={() => press(contribution)}
    />
  );
  if (menu.length === 0) return button;
  return (
    <SocketSplitGroup>
      {button}
      <SocketSplitMenu
        items={menu}
        label={contribution.payload.label}
        {...brandIconsProp(brandIcons)}
        dataTour={`${dataTour}-menu`}
        {...(chrome === "shell"
          ? { className: SOCKET_SHELL_CHEVRON_CLASS, style: { ...SHELL_SPLIT_CHEVRON_STYLE, ...tint } }
          : { style: { ...SPLIT_CHEVRON_STYLE, ...tint } })}
        onSelect={(item) => invoke(contribution.pluginId, item.actionId, resolvedContext)}
      />
    </SocketSplitGroup>
  );
}

function HeaderToolbarCluster({
  contributions,
  dataTour,
  chrome,
  press,
  invoke,
  resolvedContext,
  brandIconsFor,
  style,
}: {
  contributions: ToolbarContribution[];
  dataTour: string;
  chrome: SocketButtonChrome;
  press: (contribution: ToolbarContribution) => void;
  invoke: ReturnType<typeof usePluginSocketInvoke>;
  resolvedContext: PluginSurfaceContext;
  brandIconsFor: ReturnType<typeof usePluginBrandIcons>;
  style?: React.CSSProperties;
}) {
  const { status } = useAccountStatus();
  const userId = status.signedIn ? status.userId : null;
  const [order, setOrder] = useState<PluginToolbarOrderItem[]>(() => readPluginToolbarOrder(userId));
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(contributions.length);
  const clusterRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    setOrder(readPluginToolbarOrder(userId));
  }, [userId]);

  const ordered = useMemo(
    () => applyPluginToolbarOrder(contributions, order),
    [contributions, order],
  );

  const persist = useCallback((next: ToolbarContribution[]) => {
    const saved = next.map((item) => ({ pluginId: item.pluginId, id: item.id }));
    setOrder(saved);
    writePluginToolbarOrder(userId, saved);
  }, [userId]);

  useLayoutEffect(() => {
    const cluster = clusterRef.current;
    const measure = measureRef.current;
    if (!cluster || !measure) return;
    const update = () => {
      const nodes = Array.from(measure.querySelectorAll("[data-plugin-toolbar-measure]")) as HTMLElement[];
      const widths = nodes.map((node) => node.offsetWidth);
      setVisibleCount(visiblePluginToolbarCount(
        widths,
        cluster.clientWidth,
        HEADER_CHEVRON_WIDTH,
        HEADER_GAP,
      ));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(cluster);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [ordered]);

  const visible = ordered.slice(0, visibleCount);
  const hidden = ordered.slice(visibleCount);
  const showOverflow = hidden.length > 0;

  const onDropAt = useCallback((targetKey: string) => {
    if (!draggingKey || draggingKey === targetKey) {
      setDraggingKey(null);
      return;
    }
    const from = ordered.findIndex((item) => contributionKey(item) === draggingKey);
    const to = ordered.findIndex((item) => contributionKey(item) === targetKey);
    persist(movePluginToolbarItem(ordered, from, to));
    setDraggingKey(null);
  }, [draggingKey, ordered, persist]);

  const renderItem = (contribution: ToolbarContribution, opts?: { handle?: boolean }) => {
    const key = contributionKey(contribution);
    return (
      <SocketBoundary key={key}>
        <span
          data-plugin-toolbar-item={key}
          className="group relative inline-flex items-center"
          onDragOver={(event) => {
            if (!draggingKey) return;
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            onDropAt(key);
          }}
        >
          {opts?.handle ? (
            <span
              draggable
              aria-label={`Reorder ${contribution.payload.label}`}
              title="Drag to reorder"
              onDragStart={() => setDraggingKey(key)}
              onDragEnd={() => setDraggingKey(null)}
              className="absolute -left-2 top-1/2 z-[1] -translate-y-1/2 cursor-grab opacity-0 group-hover:opacity-100"
              style={{ color: COLORS.textMuted }}
            >
              <DotsSixVertical size={12} weight="bold" />
            </span>
          ) : null}
          <ToolbarActionControl
            contribution={contribution}
            dataTour={dataTour}
            chrome={chrome}
            press={press}
            invoke={invoke}
            resolvedContext={resolvedContext}
            brandIconsFor={brandIconsFor}
          />
        </span>
      </SocketBoundary>
    );
  };

  return (
    <span
      ref={clusterRef}
      data-plugin-toolbar-layout="header"
      style={{
        position: "relative",
        display: "inline-flex",
        minWidth: 0,
        maxWidth: "min(40%, 360px)",
        alignItems: "center",
        gap: HEADER_GAP,
        ...style,
      }}
    >
      <span
        ref={measureRef}
        aria-hidden
        style={{
          position: "absolute",
          visibility: "hidden",
          pointerEvents: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: HEADER_GAP,
        }}
      >
        {ordered.map((contribution) => (
          <span key={contributionKey(contribution)} data-plugin-toolbar-measure>
            <ToolbarActionControl
              contribution={contribution}
              dataTour={dataTour}
              chrome={chrome}
              press={() => undefined}
              invoke={invoke}
              resolvedContext={resolvedContext}
              brandIconsFor={brandIconsFor}
            />
          </span>
        ))}
      </span>
      {visible.map((contribution) => renderItem(contribution, { handle: true }))}
      {showOverflow ? (
        <Popover.Root
          open={overflowOpen}
          onOpenChange={(open) => {
            setOverflowOpen(open);
            if (!open) setReordering(false);
          }}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              data-plugin-toolbar-overflow
              aria-label="More plugin actions"
              className="ade-shell-control inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center"
              data-variant="ghost"
            >
              <CaretDown size={11} weight="bold" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              side="bottom"
              align="end"
              sideOffset={6}
              style={{
                zIndex: 80,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                minWidth: 180,
                maxWidth: 280,
                padding: 8,
                background: COLORS.panelCard,
                border: `1px solid ${COLORS.border}`,
                borderRadius: RADII.md,
                boxShadow: "var(--shadow-panel)",
                fontFamily: SANS_FONT,
              }}
            >
              {reordering ? (
                ordered.map((contribution) => (
                  <span
                    key={contributionKey(contribution)}
                    className="inline-flex items-center gap-1"
                    draggable
                    onDragStart={() => setDraggingKey(contributionKey(contribution))}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      onDropAt(contributionKey(contribution));
                    }}
                    onDragEnd={() => setDraggingKey(null)}
                  >
                    <DotsSixVertical size={12} weight="bold" />
                    <span style={{ fontSize: 12 }}>{contribution.payload.label}</span>
                  </span>
                ))
              ) : (
                <>
                  {hidden.map((contribution) => (
                    <SocketBoundary key={contributionKey(contribution)}>
                      <SocketMenuRow
                        label={contribution.payload.label}
                        {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
                        {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                        onClick={() => {
                          press(contribution);
                          setOverflowOpen(false);
                        }}
                      />
                      <SocketMenuSubRows
                        items={contribution.payload.menu ?? []}
                        {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                        onSelect={(item) => invoke(contribution.pluginId, item.actionId, resolvedContext)}
                      />
                    </SocketBoundary>
                  ))}
                  <button
                    type="button"
                    onClick={() => setReordering(true)}
                    style={{
                      marginTop: 4,
                      border: 0,
                      background: "transparent",
                      color: COLORS.textSecondary,
                      fontSize: 12,
                      textAlign: "left",
                      cursor: "pointer",
                      padding: "4px 6px",
                    }}
                  >
                    Reorder
                  </button>
                </>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </span>
  );
}

/**
 * Contributed toolbar actions, grouped after the surface's own.
 *
 * On ordinary surfaces: two visible, the rest in an overflow menu — the same
 * restraint as row badges. On the window header (`layout="header"`): the user's
 * order, a hover handle to drag, and a chevron only when something is hidden.
 *
 * The context defaults to the surface itself, so a toolbar action on Lanes
 * receives `{kind: "surface", surface: "lanes"}` and one invoked from a detail
 * pane receives that pane's entity.
 */
export function PluginToolbarActions({
  surface,
  context,
  active = true,
  style,
  chrome = "default",
  layout = "default",
}: {
  surface: PluginSurfaceId;
  /** Defaults to the surface-only context. */
  context?: PluginSurfaceContext;
  active?: boolean;
  style?: React.CSSProperties;
  /**
   * The button chrome for this host. `shell` is the window top bar's, where the
   * generic socket pill read as a taller control with a doubled edge beside the
   * 20px shell buttons it sits between — see {@link SOCKET_SHELL_BUTTON_CLASS}.
   */
  chrome?: SocketButtonChrome;
  /**
   * `header` is the window top bar's flexible cluster: user order, measured
   * overflow behind a chevron, drag to reorder. Every other surface keeps the
   * two-visible cap.
   */
  layout?: "default" | "header";
}) {
  const resolvedContext = React.useMemo<PluginSurfaceContext>(
    () => context ?? { kind: "surface", surface },
    [context, surface],
  );
  // The OTHER side of the rule on `useSurfaceContributions`, and the reason that
  // rule needs stating: this kind's default context is surface-only, so it takes
  // the surface fallback and reads `{entityKind: "surface"}` rows — filed
  // against the tab. The chat-header and composer kinds make the same-shaped
  // call with an ENTITY context and are filed against the chat instead. Copying
  // this call for one of those files the contribution in the wrong place.
  const contributions = useSurfaceContributions(surface, "toolbar-action", {
    active,
    context: resolvedContext,
  });
  const invoke = usePluginSocketInvoke();
  // A toolbar button that DECLARED a page opens it under itself instead of
  // invoking — see `usePluginDeclaredWebviewPress`. One that declared none
  // invokes exactly as it always did.
  const openDeclaredPage = usePluginDeclaredWebviewPress();
  const press = React.useCallback((contribution: {
    pluginId: string;
    payload: { actionId: string; webviewSurfaceId?: string };
  }) => {
    if (openDeclaredPage({
      socket: "toolbar-action",
      pluginId: contribution.pluginId,
      ...(contribution.payload.webviewSurfaceId
        ? { surfaceId: contribution.payload.webviewSurfaceId }
        : {}),
      subject: resolvedContext,
    })) return;
    void invoke(contribution.pluginId, contribution.payload.actionId, resolvedContext);
  }, [invoke, openDeclaredPage, resolvedContext]);
  // The declaring plugin's own artwork. Without it `brand:linear` resolved to
  // the puzzle piece here while the tab rail beside it drew Linear's mark.
  const brandIconsFor = usePluginBrandIcons();

  if (contributions.length === 0) return null;

  const dataTour = `plugin:${surface}.toolbar-action`;

  if (layout === "header") {
    return (
      <HeaderToolbarCluster
        contributions={contributions}
        dataTour={dataTour}
        chrome={chrome}
        press={press}
        invoke={invoke}
        resolvedContext={resolvedContext}
        brandIconsFor={brandIconsFor}
        style={style}
      />
    );
  }

  const visible = contributions.slice(0, VISIBLE_LIMIT);
  const hidden = contributions.slice(VISIBLE_LIMIT);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...style }}>
      {visible.map((contribution) => (
        <SocketBoundary key={contributionKey(contribution)}>
          <ToolbarActionControl
            contribution={contribution}
            dataTour={dataTour}
            chrome={chrome}
            press={press}
            invoke={invoke}
            resolvedContext={resolvedContext}
            brandIconsFor={brandIconsFor}
          />
        </SocketBoundary>
      ))}
      {hidden.length > 0 ? (
        <SocketOverflow
          count={hidden.length}
          label={`${hidden.length} more plugin actions`}
          dataTour={`${dataTour}-overflow`}
        >
          {hidden.map((contribution) => (
            <SocketBoundary key={contributionKey(contribution)}>
              <SocketMenuRow
                label={contribution.payload.label}
                {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
                {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                onClick={() => press(contribution)}
              />
              <SocketMenuSubRows
                items={contribution.payload.menu ?? []}
                {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                onSelect={(item) => invoke(contribution.pluginId, item.actionId, resolvedContext)}
              />
            </SocketBoundary>
          ))}
        </SocketOverflow>
      ) : null}
    </span>
  );
}
