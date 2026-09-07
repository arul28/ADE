import { useCallback, useEffect, useRef, useState } from "react";
import {
  WORK_TOOLS_CONTROL_HINT,
  WORK_TOOLS_NO_DESKTOP_MESSAGE,
  type WorkToolsLaneState,
  type WorkToolsObservation,
} from "../../../shared/types/workTools";

/**
 * The browser and App Control panes, as seen from a surface that cannot run
 * them.
 *
 * The hosted web client renders the same `WorkSidebar` as the desktop, but its
 * `builtInBrowser` / `appControl` namespaces are stubs — there is no
 * `WebContentsView` in a browser tab and no CDP socket to a local app. The old
 * answer was "Desktop app only", which is true and useless: the thing the user
 * wanted to know is what their desktop is *doing*. This shows exactly that and
 * offers no controls, so nothing here can lie about being interactive.
 */

/**
 * Poll interval. There is no generic runtime-event channel to a browser tab —
 * the web client's only push is cr-sqlite changesets, and none of this state is
 * table-backed — so a visible pane polls. Four seconds is slow enough to be
 * free and fast enough that a tab switch on the desktop reads as live.
 */
export const WORK_TOOL_READ_ONLY_POLL_MS = 4_000;

export type WorkToolReadOnlyViewProps = {
  tool: "browser" | "app-control";
  laneId: string | null;
};

type PreviewState = {
  path: string;
  dataUrl: string | null;
};

export function WorkToolReadOnlyView({ tool, laneId }: WorkToolReadOnlyViewProps): JSX.Element {
  const [state, setState] = useState<WorkToolsLaneState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Guards against a slow refresh landing after the pane moved to another lane.
  const requestedLaneId = useRef(laneId);
  requestedLaneId.current = laneId;

  const refresh = useCallback(async (): Promise<void> => {
    if (!laneId) {
      setState(null);
      setLoaded(true);
      return;
    }
    const read = window.ade?.workTools?.getLaneState;
    if (!read) {
      setLoaded(true);
      return;
    }
    try {
      const next = await read(laneId);
      if (requestedLaneId.current !== laneId) return;
      setState(next);
    } catch {
      if (requestedLaneId.current !== laneId) return;
      setState(null);
    } finally {
      if (requestedLaneId.current === laneId) setLoaded(true);
    }
  }, [laneId]);

  useEffect(() => {
    setLoaded(false);
    setState(null);
    setPreview(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), WORK_TOOL_READ_ONLY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const observation = tool === "browser"
    ? state?.browser?.latestObservation ?? null
    : state?.appControl?.latestObservation ?? null;
  const observationPath = observation?.path ?? null;

  useEffect(() => {
    if (!observationPath) {
      setPreview(null);
      return;
    }
    // Frames are fetched by path, one at a time, never pushed: a state poll
    // that carried image bytes would multiply every refresh by a megabyte.
    let cancelled = false;
    setPreview((current) => (current?.path === observationPath ? current : { path: observationPath, dataUrl: null }));
    void (async () => {
      const read = window.ade?.workTools?.readObservationPreview;
      if (!read) return;
      try {
        const result = await read(observationPath);
        if (cancelled) return;
        setPreview({ path: observationPath, dataUrl: result?.dataUrl ?? null });
      } catch {
        if (!cancelled) setPreview({ path: observationPath, dataUrl: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [observationPath]);

  if (!loaded) {
    return <ReadOnlyMessage message="Loading…" />;
  }
  if (!laneId) {
    return <ReadOnlyMessage message="Select a lane to see what its tools are doing." />;
  }
  if (!state) {
    return <ReadOnlyMessage message={WORK_TOOLS_NO_DESKTOP_MESSAGE} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto px-3 py-3">
      {tool === "browser"
        ? <BrowserSummary state={state} />
        : <AppControlSummary state={state} />}
      <ObservationFrame
        observation={observation}
        dataUrl={preview?.path === observationPath ? preview?.dataUrl ?? null : null}
      />
      <p className="text-[11px] text-muted-fg">{WORK_TOOLS_CONTROL_HINT}</p>
    </div>
  );
}

function ReadOnlyMessage({ message }: { message: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-fg">
      {message}
    </div>
  );
}

function BrowserSummary({ state }: { state: WorkToolsLaneState }): JSX.Element {
  const browser = state.browser;
  if (!browser) {
    return <ReadOnlyMessage message={WORK_TOOLS_NO_DESKTOP_MESSAGE} />;
  }
  if (!browser.tabs.length) {
    return (
      <p className="text-[12px] text-muted-fg">No browser tabs are open in this lane.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {browser.tabs.map((tab) => (
        <li
          key={tab.id}
          className="rounded-md border border-border/60 px-2.5 py-2 text-[12px]"
        >
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{tab.title ?? "Untitled tab"}</span>
            {tab.active ? <Badge label="Active" /> : null}
            {tab.recording ? <Badge label="Recording" /> : null}
          </div>
          {tab.url ? (
            <div className="truncate text-[11px] text-muted-fg">{tab.url}</div>
          ) : null}
          {tab.ownerChatSessionId ? (
            <div className="truncate text-[11px] text-muted-fg">
              Claimed by chat {tab.ownerChatSessionId}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AppControlSummary({ state }: { state: WorkToolsLaneState }): JSX.Element {
  const appControl = state.appControl;
  if (!appControl) {
    return <p className="text-[12px] text-muted-fg">App Control is not driving an app in this lane.</p>;
  }
  return (
    <div className="rounded-md border border-border/60 px-2.5 py-2 text-[12px]">
      <div className="truncate font-medium">{appControl.appName}</div>
      <div className="text-[11px] text-muted-fg">
        {appControl.status} · {appControl.driver}
      </div>
    </div>
  );
}

function ObservationFrame({
  observation,
  dataUrl,
}: {
  observation: WorkToolsObservation | null;
  dataUrl: string | null;
}): JSX.Element | null {
  if (!observation) return null;
  return (
    <figure className="m-0 flex flex-col gap-1">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={observation.caption ?? "Latest captured frame"}
          className="w-full rounded-md border border-border/60"
        />
      ) : (
        <div className="flex h-24 items-center justify-center rounded-md border border-border/60 text-[11px] text-muted-fg">
          Loading frame…
        </div>
      )}
      <figcaption className="truncate text-[11px] text-muted-fg">
        {observation.caption ?? "Latest frame"}
      </figcaption>
    </figure>
  );
}

function Badge({ label }: { label: string }): JSX.Element {
  return (
    <span className="shrink-0 rounded-sm border border-border/60 px-1 text-[10px] uppercase tracking-wide text-muted-fg">
      {label}
    </span>
  );
}
