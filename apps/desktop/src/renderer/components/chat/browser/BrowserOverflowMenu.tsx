/**
 * The ⋮ menu at the end of the browser toolbar.
 *
 * Its own file because it is the row's overflow in the literal sense: every
 * ability the toolbar drops at a narrow width has to reappear here, so this
 * menu grows whenever the row shrinks and would otherwise dominate the file it
 * shared. The device list is passed in, since the toolbar hosts it too.
 */
import {
  ArrowSquareOut,
  Bug,
  Camera,
  Check,
  CursorClick,
  DeviceMobile,
  DotsThree,
  MagnifyingGlass,
  Monitor,
  Plus,
  Pulse,
  Selection,
  ShieldCheck,
  SignIn,
  X,
} from "@phosphor-icons/react";
import { useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { BrowserLinkOpenMode } from "../../../../shared/types";
import {
  BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS,
  type BuiltInBrowserRecordingFps,
} from "../../../../shared/types/builtInBrowser";
import {
  normalizeRecordingFps,
  zoomPercentLabel,
} from "./browserToolbarLabels";
import { modifierChordLabel } from "../../../lib/platform";
import { cn } from "../../ui/cn";
import {
  CHROME_GHOST,
  CHROME_ICON_SIZE,
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
  MenuSwitch,
  TOOLBAR_FOCUS,
  TOOLBAR_MOTION,
  type BrowserChromeShared,
} from "./browserChrome";

export type BrowserOverflowMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Everything this menu and the toolbar row both need, built once by the panel. */
  shared: BrowserChromeShared;
  zoomFactor: number;
  onZoomStep: (direction: 1 | -1) => void;
  onZoomReset: () => void;
  onAttachScreenshot: () => void;
  onOpenFind: () => void;
  /** The tab strip hides itself at one tab, so `+` lives here as well. */
  onNewTab: () => void;
  /** …and so does closing one. Null when there is no tab to close. */
  onCloseTab: (() => void) | null;
  devToolsOpen: boolean;
  onToggleDevTools: () => void;
  networkLogging: boolean;
  onToggleNetworkLogging: () => void;
  onExportHar: () => void;
  recordingFps: BuiltInBrowserRecordingFps;
  setRecordingFps: (fps: BuiltInBrowserRecordingFps) => void;
  linkMode: BrowserLinkOpenMode;
  onLinkModeChange: (mode: BrowserLinkOpenMode) => void;
  onToggleProfile: () => void;
  onOpenLoginImport: () => void;
  currentUrl: string;
  onOpenExternal: () => void;
  canInsertDraft: boolean;
  onInsertSelectionDraft: () => void;
  onClearSelection: () => void;
  selectionFrame: string | null;
};

export function BrowserOverflowMenu({
  open,
  onOpenChange,
  shared,
  zoomFactor,
  onZoomStep,
  onZoomReset,
  onAttachScreenshot,
  onOpenFind,
  onNewTab,
  onCloseTab,
  devToolsOpen,
  onToggleDevTools,
  networkLogging,
  onToggleNetworkLogging,
  onExportHar,
  recordingFps,
  setRecordingFps,
  linkMode,
  onLinkModeChange,
  onToggleProfile,
  onOpenLoginImport,
  currentUrl,
  onOpenExternal,
  canInsertDraft,
  onInsertSelectionDraft,
  onClearSelection,
  selectionFrame,
}: BrowserOverflowMenuProps) {
  const {
    toolbar,
    busy,
    apiAvailable,
    canAttachContext,
    inspecting,
    onInspectToggle,
    emulation,
    deviceLabel,
    deviceMenuItems,
    selection,
  } = shared;
  // The row hides a control when it runs out of width; this menu is where it
  // reappears. But a control the HOST cannot support never appears in either —
  // Inspect and the region capture both end in an insert, and a shell session
  // has nothing to insert into.
  const inspectItem = canAttachContext && !toolbar.showInspect;
  const captureItem = canAttachContext && !toolbar.showCamera;
  /*
    Find is the one row that hands the keyboard somewhere else.

    Radix returns focus to the trigger when a menu closes, which landed the
    caret back on the ⋯ button *after* the find bar had focused its input — so
    the bar was open, looked ready, and every letter you typed went to a button
    instead. The row that opens the bar waives the restore for exactly that
    close; every other row still gets it, because for them the trigger is where
    the keyboard belongs.
  */
  const restoreFocusRef = useRef(true);
  const handOffFocus = (run: () => void) => () => {
    restoreFocusRef.current = false;
    run();
  };
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={!apiAvailable}
          title="More browser options"
          aria-label="More browser options"
          className={cn(
            CHROME_GHOST,
            TOOLBAR_MOTION,
            TOOLBAR_FOCUS,
            // Idle is a bare glyph, exactly like every other control on this
            // row: the fill is hover, plus the one moment the menu it owns is
            // actually open. App Control's ⋯ already paints its open state
            // this way, and a permanently boxed ⋯ next to five borderless
            // glyphs reads as the only control that is somehow switched on.
            "data-[state=open]:bg-white/[0.06] data-[state=open]:text-fg",
          )}
        >
          <DotsThree size={CHROME_ICON_SIZE} weight="bold" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={MENU_CONTENT_CLASS}
          onCloseAutoFocus={(event) => {
            if (restoreFocusRef.current) return;
            restoreFocusRef.current = true;
            event.preventDefault();
          }}
        >
          {/*
            The order is the order every premium browser's ⋯ menu uses: the
            two things you came for (a new tab, find), then the page's own
            settings, then the standing preferences, then the ways out.
          */}
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onNewTab}>
            <Plus size={12} className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">New tab</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={handOffFocus(onOpenFind)}>
            <MagnifyingGlass size={12} className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">Find on page</span>
            <span className="shrink-0 font-mono text-[9.5px] text-muted-fg/70">{modifierChordLabel("F")}</span>
          </DropdownMenu.Item>
          {/*
            The strip hides itself at one tab and took its × with it, so the
            last tab could not be closed from anywhere. Closing it leaves the
            pane on the launchpad — which is what a browser with no page is.
          */}
          {onCloseTab ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={handOffFocus(onCloseTab)}>
              <X size={12} className="shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">Close tab</span>
              <span className="shrink-0 font-mono text-[9.5px] text-muted-fg/70">{modifierChordLabel("W")}</span>
            </DropdownMenu.Item>
          ) : null}

          {/*
            Everything the toolbar had to drop at this width lives here,
            so a 300px pane loses the buttons but never the abilities.
          */}
          {inspectItem ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onInspectToggle}>
              <CursorClick size={12} className="shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">
                {inspecting ? "Stop inspecting" : "Inspect an element"}
              </span>
            </DropdownMenu.Item>
          ) : null}
          {captureItem ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onAttachScreenshot}>
              <Camera size={12} className="shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">Screenshot a region</span>
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenu.Label className={MENU_LABEL_CLASS}>Zoom</DropdownMenu.Label>
          <div className="flex items-center gap-1 px-2 pb-1.5">
            <button
              type="button"
              onClick={() => onZoomStep(-1)}
              aria-label="Zoom out"
              className="ade-shell-control inline-flex h-6 w-6 items-center justify-center text-[12px] font-medium"
            >
              −
            </button>
            <span className="min-w-[46px] text-center font-mono text-[10.5px] text-fg/80">
              {zoomPercentLabel(zoomFactor)}
            </span>
            <button
              type="button"
              onClick={() => onZoomStep(1)}
              aria-label="Zoom in"
              className="ade-shell-control inline-flex h-6 w-6 items-center justify-center text-[12px] font-medium"
            >
              +
            </button>
            <button
              type="button"
              onClick={onZoomReset}
              className="ade-shell-control ml-auto inline-flex h-6 items-center px-2 text-[10px] font-medium"
              data-variant="ghost"
            >
              Reset
            </button>
          </div>

          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS}>
              {emulation?.mobile ? (
                <DeviceMobile size={12} className="shrink-0 opacity-70" />
              ) : (
                <Monitor size={12} className="shrink-0 opacity-70" />
              )}
              <span className="min-w-0 flex-1 truncate">Device…</span>
              <span className="shrink-0 text-[9.5px] text-muted-fg/70">{deviceLabel}</span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={4}
                collisionPadding={8}
                className={MENU_CONTENT_CLASS}
              >
                {deviceMenuItems}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          {/*
            DevTools and the network log are states, not commands, so they
            read as switches — an "Off" label on a row you click is a
            question about what the click will do.
          */}
          <DropdownMenu.CheckboxItem
            className={MENU_ITEM_CLASS}
            checked={devToolsOpen}
            onCheckedChange={onToggleDevTools}
            onSelect={(event) => event.preventDefault()}
          >
            <Bug size={12} className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">DevTools</span>
            <MenuSwitch checked={devToolsOpen} />
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            className={MENU_ITEM_CLASS}
            checked={networkLogging}
            onCheckedChange={onToggleNetworkLogging}
            onSelect={(event) => event.preventDefault()}
          >
            <Pulse size={12} className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">Network log</span>
            <MenuSwitch checked={networkLogging} />
          </DropdownMenu.CheckboxItem>
          {networkLogging ? (
            <DropdownMenu.Item className={cn(MENU_ITEM_CLASS, "pl-7")} onSelect={onExportHar}>
              <span className="min-w-0 flex-1 truncate">Export HAR</span>
            </DropdownMenu.Item>
          ) : null}

          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenu.Label className={MENU_LABEL_CLASS}>Recording</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={String(recordingFps)}
            onValueChange={(value) => setRecordingFps(normalizeRecordingFps(Number(value)))}
          >
            {BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS.map((fps) => (
              <DropdownMenu.RadioItem
                key={fps}
                value={String(fps)}
                className={MENU_ITEM_CLASS}
                onSelect={(event) => event.preventDefault()}
              >
                <Check
                  size={11}
                  weight="bold"
                  aria-hidden="true"
                  className={cn(
                    "shrink-0 text-[var(--color-accent)]",
                    recordingFps === fps ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{`${fps} fps`}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          {/*
            "Links open in:" is a standing preference; "Open this page in
            system browser" is a thing you do once. They used to sit next
            to each other reading as two spellings of the same row, so the
            preference keeps the heading and the action moves to the end.
          */}
          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenu.Label className={MENU_LABEL_CLASS}>Links open in</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={linkMode}
            onValueChange={(value) => onLinkModeChange(value === "external" ? "external" : "in-app")}
          >
            <DropdownMenu.RadioItem value="in-app" className={MENU_ITEM_CLASS}>
              <Check
                size={11}
                weight="bold"
                aria-hidden="true"
                className={cn(
                  "shrink-0 text-[var(--color-accent)]",
                  linkMode === "in-app" ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="min-w-0 flex-1 truncate">In ADE</span>
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="external" className={MENU_ITEM_CLASS}>
              <Check
                size={11}
                weight="bold"
                aria-hidden="true"
                className={cn(
                  "shrink-0 text-[var(--color-accent)]",
                  linkMode === "external" ? "opacity-100" : "opacity-0",
                )}
              />
              {/* "In system browser", to pair with "In ADE" above it and to
                  match the same choice in Settings → General → Links. */}
              <span className="min-w-0 flex-1 truncate">In system browser</span>
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onOpenLoginImport()}>
            <SignIn size={12} className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">Import logins…</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onToggleProfile}>
            <ShieldCheck size={12} className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">Profile…</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            disabled={!currentUrl}
            onSelect={onOpenExternal}
          >
            <ArrowSquareOut size={12} className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">Open in system browser</span>
          </DropdownMenu.Item>
          {selection.has ? (
            <>
              <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
              <DropdownMenu.Label className={MENU_LABEL_CLASS}>Selection</DropdownMenu.Label>
              {/*
                Re-attaching an already-attached selection is the one
                Selection ability with no other entry point — the toolbar
                button is the first thing the row sheds — so below ~630px
                it used to disappear entirely. The row loses buttons here,
                never abilities.
              */}
              {canAttachContext && !toolbar.showAttach ? (
                <DropdownMenu.Item
                  className={MENU_ITEM_CLASS}
                  disabled={Boolean(busy) || !apiAvailable}
                  onSelect={selection.onAttach}
                >
                  <Selection size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">Attach selection</span>
                </DropdownMenu.Item>
              ) : null}
              {canInsertDraft ? (
                <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onInsertSelectionDraft}>
                  <span className="min-w-0 flex-1 truncate">Insert into the message</span>
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onClearSelection}>
                <span className="min-w-0 flex-1 truncate">Clear selection</span>
                {selectionFrame ? (
                  <span className="shrink-0 font-mono text-[9px] text-muted-fg/60">{selectionFrame}</span>
                ) : null}
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
