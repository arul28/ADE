import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudPhoneViewDeviceFamily,
  CloudPhoneViewFrame,
  CloudPhoneViewInputPhase,
  CloudPhoneViewState,
} from "../../../shared/types/cloudPhoneView";

/**
 * The ADE Cloud iPhone's picture, for the 3D device view.
 *
 * Main paints NoMac's control page in an offscreen window and sends each
 * changed frame as a JPEG. This hook decodes those frames into ONE persistent
 * canvas and tells `frames` subscribers, which is the same shape the Apple H.264
 * stream gives `Device3DView` (`AppleFrameFeed`): the view re-uploads the canvas
 * as its texture and does not re-render React per frame.
 *
 * A browser (ADE Web) has no `cloudPhoneView` API. `available` is false there,
 * and the caller keeps its flat iframe instead.
 */

/** Each drawn frame. `subscribe` returns its unsubscribe. */
export type CloudPhoneFrameFeed = { subscribe: (listener: () => void) => () => void };

export type CloudPhoneViewStateName = CloudPhoneViewState | "idle";

export type UseCloudPhoneFramesArgs = {
  /** The control-view link (NoMac's page or ADE's viewer page). Null closes the view. */
  url: string | null;
  family: CloudPhoneViewDeviceFamily;
  /** The phone's screen in points: what `input` and `scroll` coordinates are in. */
  pointSize?: { width: number; height: number };
  /** The surface is mounted but not visible: main stops painting the page. */
  hidden: boolean;
};

export type CloudPhoneFrames = {
  /** The one canvas every frame is drawn into. Null until the first frame. */
  canvas: HTMLCanvasElement | null;
  frames: CloudPhoneFrameFeed;
  /** The canvas's size in PIXELS, which is the texture's own aspect. */
  pixelSize: { width: number; height: number } | null;
  state: CloudPhoneViewStateName;
  /** Why the view is not live, for the strip. Null unless `state` is `error`. */
  message: string | null;
  /** Device points, exactly what `Device3DView`'s `onDeviceInput` gives. */
  input: (phase: CloudPhoneViewInputPhase, x: number, y: number) => void;
  scroll: (x: number, y: number, deltaX: number, deltaY: number) => void;
  key: (key: string) => void;
  home: () => void;
};

export function useCloudPhoneFrames({ url, family, pointSize, hidden }: UseCloudPhoneFramesArgs): CloudPhoneFrames {
  const pointWidth = pointSize?.width ?? null;
  const pointHeight = pointSize?.height ?? null;
  const available = typeof window !== "undefined" && Boolean(window.ade?.cloudPhoneView);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pixelSize, setPixelSize] = useState<{ width: number; height: number } | null>(null);
  const [state, setState] = useState<CloudPhoneViewStateName>("idle");
  const [message, setMessage] = useState<string | null>(null);
  /** The view this hook owns, or null while it opens, after it closes, or in a browser. */
  const viewIdRef = useRef<string | null>(null);
  /** Read by the open call, which resolves after a later `hidden` change. */
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const frameListenersRef = useRef(new Set<() => void>());
  /** One decode at a time: a slow JPEG drops the next frame instead of queueing it. */
  const decodingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const frames = useMemo<CloudPhoneFrameFeed>(() => ({
    subscribe(listener) {
      frameListenersRef.current.add(listener);
      return () => {
        frameListenersRef.current.delete(listener);
      };
    },
  }), []);

  const handleFrame = useCallback((frame: CloudPhoneViewFrame) => {
    // Frames for a view this hook no longer owns are dropped before decoding.
    if (frame.viewId !== viewIdRef.current || decodingRef.current) return;
    decodingRef.current = true;
    void (async () => {
      try {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(frame.jpeg)], { type: "image/jpeg" }));
        try {
          // The link can change while a frame decodes; a stale bitmap must not
          // land on the new view's canvas.
          if (!mountedRef.current || frame.viewId !== viewIdRef.current) return;
          let target = canvasRef.current;
          if (!target) {
            target = document.createElement("canvas");
            canvasRef.current = target;
            setCanvas(target);
          }
          if (target.width !== bitmap.width || target.height !== bitmap.height) {
            target.width = bitmap.width;
            target.height = bitmap.height;
            setPixelSize({ width: bitmap.width, height: bitmap.height });
          }
          target.getContext("2d")?.drawImage(bitmap, 0, 0);
          for (const listener of [...frameListenersRef.current]) {
            // Isolate subscribers: one throwing listener must not stop the others.
            try {
              listener();
            } catch {
              // Nothing to say here; the other subscribers still get the frame.
            }
          }
        } finally {
          bitmap.close();
        }
      } catch {
        // A frame the decoder rejects is skipped; the next paint is under a second away.
      } finally {
        decodingRef.current = false;
      }
    })();
  }, []);

  // One state listener for the hook's whole life; it filters by the view this
  // hook owns, which changes when the link changes.
  useEffect(() => {
    if (!available) return undefined;
    return window.ade.cloudPhoneView.onState((event) => {
      if (event.viewId !== viewIdRef.current) return;
      setState(event.state);
      setMessage(event.state === "error" ? (event.message ?? "The phone's view stopped.") : null);
    });
  }, [available]);

  useEffect(() => {
    if (!available) return undefined;
    return window.ade.cloudPhoneView.onFrame(handleFrame);
  }, [available, handleFrame]);

  // Open when the link changes, close on unmount or when it goes away. Keyed on
  // the url string: a rebuilt prop object must not restart the view.
  useEffect(() => {
    if (!available || !url) {
      setState("idle");
      setMessage(null);
      setPixelSize(null);
      return undefined;
    }
    const api = window.ade.cloudPhoneView;
    let cancelled = false;
    let opened: string | null = null;
    viewIdRef.current = null;
    setState("loading");
    setMessage(null);
    setPixelSize(null);
    void api
      .open({ url, deviceFamily: family, ...(pointWidth && pointHeight ? { pointSize: { width: pointWidth, height: pointHeight } } : {}) })
      .then((result) => {
        if (cancelled) {
          // The link changed while this view opened: it is nobody's now.
          void api.close({ viewId: result.viewId }).catch(() => {});
          return;
        }
        opened = result.viewId;
        viewIdRef.current = result.viewId;
        // The open may have beaten a hidden change: apply the current answer.
        if (hiddenRef.current) {
          void api.setHidden({ viewId: result.viewId, hidden: true }).catch(() => {});
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState("error");
        setMessage(error instanceof Error ? error.message : "The phone's view didn't open.");
      });
    return () => {
      cancelled = true;
      viewIdRef.current = null;
      if (opened) void api.close({ viewId: opened }).catch(() => {});
    };
  }, [available, family, pointHeight, pointWidth, url]);

  useEffect(() => {
    if (!available) return;
    const viewId = viewIdRef.current;
    if (!viewId) return;
    void window.ade.cloudPhoneView.setHidden({ viewId, hidden }).catch(() => {});
  }, [available, hidden]);

  const input = useCallback((phase: CloudPhoneViewInputPhase, x: number, y: number) => {
    const viewId = viewIdRef.current;
    if (!viewId) return;
    void window.ade.cloudPhoneView.input({ viewId, phase, x, y }).catch(() => {});
  }, []);

  const scroll = useCallback((x: number, y: number, deltaX: number, deltaY: number) => {
    const viewId = viewIdRef.current;
    if (!viewId) return;
    void window.ade.cloudPhoneView.scroll({ viewId, x, y, deltaX, deltaY }).catch(() => {});
  }, []);

  const key = useCallback((pressed: string) => {
    const viewId = viewIdRef.current;
    if (!viewId || !pressed) return;
    void window.ade.cloudPhoneView.key({ viewId, key: pressed }).catch(() => {});
  }, []);

  const home = useCallback(() => {
    const viewId = viewIdRef.current;
    if (!viewId) return;
    void window.ade.cloudPhoneView.home({ viewId }).catch(() => {});
  }, []);

  return {
    canvas,
    frames,
    pixelSize,
    state,
    message,
    input,
    scroll,
    key,
    home,
  };
}
