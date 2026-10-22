import React, { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { OpenProjectBinding } from "../../../shared/types";
import { useAppStoreApi } from "../../state/appStore";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { isWebClientMode } from "../../lib/webClientMode";
import type { AppleRenderJob } from "./AppleRenderHostJob";

/**
 * The job (a stream, the 3D view and three.js) is loaded with the first
 * request: the listener is mounted in every project surface and must not pull
 * the device viewer into the app's first bundle.
 */
const AppleRenderHostJob = React.lazy(() => import("./AppleRenderHostJob"));

/**
 * `ade apple render` with no Apple pane open.
 *
 * A render needs a 3D view with the device's live screen on it, and before
 * this only a mounted pane had one, so an agent's render failed unless a
 * person happened to have the pane open. Every project surface mounts this
 * host instead. It costs nothing while idle: one callback on the simulator
 * event fanout the window already holds, and no stream, WebGL context or
 * timer until a request is taken.
 *
 * Panes keep priority. A live pane acks a request the moment it hears it;
 * this host waits `APPLE_RENDER_HOST_CLAIM_DELAY_MS` before it tries, and the
 * service hands the request to the first ack only, so a pane anywhere (this
 * window, another window, another machine pinned to the device's) wins, and
 * two windows with no pane settle on whichever acks first.
 *
 * Taken, the request mounts a 3D view of the lane's device far off screen
 * (fixed, outside the viewport, no pointer events, not focusable), streams the
 * device into it, renders through the pane's own `renderAppleDeviceToProof`,
 * reports, and unmounts, which hands the stream lease back.
 */

/** How long a live pane gets to take a request before this host claims it. */
const APPLE_RENDER_HOST_CLAIM_DELAY_MS = 1_500;
/**
 * Out of the viewport rather than hidden: WebGL and the decoder must keep
 * drawing, which `display: none` (no layout box) or a parked surface's
 * `content-visibility` would stop. Portalled to `body` for the same reason.
 * Square, so the view lays out the way a pane would.
 */
const OFF_SCREEN_STYLE: CSSProperties = {
  position: "fixed",
  left: -10_000,
  top: 0,
  width: 480,
  height: 480,
  overflow: "hidden",
  pointerEvents: "none",
  contain: "strict",
};

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * One per project surface, for that project's lanes.
 *
 * `binding` is the surface's own binding, used as the pin for every call. A
 * project surface stays mounted (parked) while another project tab is in
 * front, and an unpinned call goes to the tab in FRONT, so a job that a parked
 * surface took, or one running while the person switches tabs, would send its
 * folds and proof to the wrong project. For the surface in front the preload
 * treats this pin exactly like an unpinned call.
 */
export function AppleRenderHost({ binding }: { binding: OpenProjectBinding }) {
  const store = useAppStoreApi();
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const [jobs, setJobs] = useState<AppleRenderJob[]>([]);
  const enabled = !isWebClientMode();

  useEffect(() => {
    const api = window.ade?.iosSimulator;
    if (!enabled || typeof api?.onEvent !== "function" || typeof api.renderAck !== "function") return undefined;
    let alive = true;
    const claims = new Set<number>();
    // Unpinned: the shared fanout this window already holds (this machine's
    // service, and the bound machine's event stream). A pinned subscription
    // here would poll another machine for as long as the surface lives.
    const unsubscribe = api.onEvent((event) => {
      if (event.type !== "apple.render.request" || !event.laneId) return;
      const laneId = event.laneId;
      // The window hears every open project's requests; this surface takes
      // its own lanes'. Before the lane list has loaded, the ack decides.
      const lanes = store.getState().lanes;
      if (lanes.length > 0 && !lanes.some((lane) => lane.id === laneId)) return;
      const pin = bindingRef.current;
      const timer = window.setTimeout(() => {
        claims.delete(timer);
        void api.renderAck({ requestId: event.requestId }, pin).then((ack) => {
          // A pane or another window took it first, or the request is not
          // this machine's (the ack only succeeds where it was made).
          if (!ack?.ok) return;
          const job: AppleRenderJob = {
            requestId: event.requestId,
            laneId,
            chatSessionId: event.chatSessionId ?? null,
            request: event.request,
            pin,
          };
          if (!alive) {
            void api.renderComplete(
              { requestId: job.requestId, filed: 0, error: "The ADE window closed before the render started." },
              pin,
            ).catch(() => undefined);
            return;
          }
          setJobs((current) => [...current, job]);
        }, (cause: unknown) => {
          logRendererDebugEvent("apple.render_host_ack_failed", { error: messageOf(cause) });
        });
      }, APPLE_RENDER_HOST_CLAIM_DELAY_MS);
      claims.add(timer);
    });
    return () => {
      alive = false;
      unsubscribe();
      for (const timer of claims) window.clearTimeout(timer);
    };
  }, [binding.key, enabled, store]);

  const onDone = useCallback((requestId: string) => {
    setJobs((current) => current.filter((job) => job.requestId !== requestId));
  }, []);
  const answeringRef = useRef(new Set<string>());
  const onAnswering = useCallback((requestId: string) => {
    answeringRef.current.add(requestId);
  }, []);

  // Taken but never answered (the surface went away mid-job, or with jobs
  // still queued): say so, or the CLI waits out its 4 minutes.
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => () => {
    const api = window.ade?.iosSimulator;
    for (const job of jobsRef.current) {
      if (answeringRef.current.has(job.requestId)) continue;
      void api?.renderComplete(
        { requestId: job.requestId, filed: 0, error: "The ADE window closed before the render finished." },
        job.pin,
      ).catch(() => undefined);
    }
  }, []);

  // A job that throws (its chunk would not load, the view crashed) answers
  // with the error and goes, instead of taking the project surface with it.
  const onJobCrash = useCallback((job: AppleRenderJob, cause: unknown) => {
    if (!answeringRef.current.has(job.requestId)) {
      answeringRef.current.add(job.requestId);
      void window.ade?.iosSimulator?.renderComplete(
        { requestId: job.requestId, filed: 0, error: `The render failed: ${messageOf(cause)}` },
        job.pin,
      ).catch(() => undefined);
    }
    onDone(job.requestId);
  }, [onDone]);

  // One at a time: each job is a WebGL context and a stream. The rest wait,
  // already acked, inside the service's 4 minutes.
  const job = jobs[0];
  if (!job || typeof document === "undefined") return null;
  return createPortal(
    <div aria-hidden="true" data-apple-render-host="" style={OFF_SCREEN_STYLE}>
      <AppleRenderJobBoundary key={job.requestId} onError={(cause) => onJobCrash(job, cause)}>
        <Suspense fallback={null}>
          <AppleRenderHostJob job={job} onAnswering={onAnswering} onDone={onDone} />
        </Suspense>
      </AppleRenderJobBoundary>
    </div>,
    document.body,
  );
}

class AppleRenderJobBoundary extends React.Component<
  { onError: (cause: unknown) => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(cause: unknown): void {
    this.props.onError(cause);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
