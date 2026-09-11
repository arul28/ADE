/**
 * A shared, refcounted simulator MediaStream for surfaces that only want to
 * *watch* — the Work tab's floating corner card, today.
 *
 * The iOS panel captures the Simulator window through `getUserMedia` and holds
 * a **parking hold** on the host while it does, so the window stays put and
 * on-screen. That hold is refcounted in Electron main across every ADE surface
 * in the window, which is what makes a second watcher safe: this module takes
 * its own hold and gives back exactly that one, so the panel's hold — and any
 * other drawer's — is untouched.
 *
 * The one thing a watcher must NOT do is stop a host stream somebody else
 * started. So the sequence is deliberately asymmetric:
 *
 * - If `getStreamStatus()` already reports a running stream, this module
 *   attaches to it and, on release, stops only its own local tracks. The panel
 *   keeps its stream.
 * - Only if no stream is running does it call `startStream`, and only then does
 *   release call `stopStream`.
 *
 * Within this module the stream is shared: two cards watching the same device
 * get one `getUserMedia` and one hold.
 */

import type { IosSimulatorWindowSource } from "../../../shared/types";

const PREVIEW_FPS = 12;

export type IosSimulatorPreviewLease = {
  stream: MediaStream;
  release: () => void;
};

type ActiveLease = {
  deviceUdid: string;
  stream: MediaStream;
  subscribers: number;
  /** True when this module called `startStream` and therefore owns `stopStream`. */
  ownsHostStream: boolean;
  /** True when this module's `retainWindowParking()` was actually counted. */
  ownsParkingHold: boolean;
};

let active: ActiveLease | null = null;
/**
 * The open in flight, tagged with the device it is opening.
 *
 * Untagged, a device switch during an open would await the PREVIOUS device's
 * lease and attach to it — the card labelled B streaming A, indefinitely.
 */
let pending: { udid: string; promise: Promise<ActiveLease | null> } | null = null;

function desktopCaptureConstraints(sourceId: string): MediaStreamConstraints {
  // Same shape the iOS panel uses; Chromium's desktop capture goes through the
  // legacy `mandatory` dictionary, which the DOM types do not model.
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxFrameRate: PREVIEW_FPS,
      },
    },
  } as unknown as MediaStreamConstraints;
}

function pickSource(
  sources: readonly IosSimulatorWindowSource[],
  device: { udid: string; name?: string | null },
): IosSimulatorWindowSource | null {
  if (sources.length === 0) return null;
  const name = device.name?.trim().toLowerCase();
  if (name) {
    // A named device that matches nothing gets NOTHING. The old `sources[0]`
    // tail captured whichever simulator window happened to be first, which is
    // how the card ended up showing device A's screen under device B's name.
    return sources.find((source) => source.name?.toLowerCase().includes(name)) ?? null;
  }
  return sources[0] ?? null;
}

async function openLease(device: { udid: string; name?: string | null }): Promise<ActiveLease | null> {
  const iosSimulator = window.ade?.iosSimulator;
  if (!iosSimulator?.listSimulatorWindowSources || !navigator.mediaDevices?.getUserMedia) return null;

  let ownsHostStream = false;
  let ownsParkingHold = false;
  try {
    const streamStatus = await iosSimulator.getStreamStatus().catch(() => null);
    // Only start a host stream nobody else is running. Starting a second one
    // would make our release responsible for stopping a stream the panel is
    // painting from.
    // `running` alone is not enough: a stream running for a DIFFERENT device is
    // not a stream of the device being asked for, and skipping the start there
    // is what left the card capturing the other simulator's window.
    if (!streamStatus?.running || streamStatus.deviceUdid !== device.udid) {
      await iosSimulator.startStream(
        { deviceUdid: device.udid, backend: "simulator-window-capture", fps: PREVIEW_FPS },
      );
      ownsHostStream = true;
    }
    ownsParkingHold = await iosSimulator.retainWindowParking();
    const result = await iosSimulator.listSimulatorWindowSources({
      session: { deviceUdid: device.udid, deviceName: device.name ?? null },
    });
    const source = pickSource(result.sources, device);
    if (!source) throw new Error(result.message ?? "No simulator window to preview.");
    const stream = await navigator.mediaDevices.getUserMedia(desktopCaptureConstraints(source.id));
    return { deviceUdid: device.udid, stream, subscribers: 0, ownsHostStream, ownsParkingHold };
  } catch {
    // A failed acquire must not leave a hold or a host stream behind — the card
    // that asked for it is about to render nothing and will never call release.
    if (ownsParkingHold) await iosSimulator.releaseWindowParking().catch(() => {});
    if (ownsHostStream) await iosSimulator.stopStream().catch(() => {});
    return null;
  }
}

function teardown(lease: ActiveLease): void {
  lease.stream.getTracks().forEach((track) => track.stop());
  const iosSimulator = window.ade?.iosSimulator;
  if (lease.ownsParkingHold) void iosSimulator?.releaseWindowParking().catch(() => {});
  if (lease.ownsHostStream) void iosSimulator?.stopStream().catch(() => {});
}

/**
 * Acquires a preview stream for a booted device. Resolves null when the
 * simulator cannot be captured — a missing window, a denied screen-recording
 * grant — in which case the caller simply shows no thumbnail.
 */
export async function acquireIosSimulatorPreviewStream(
  device: { udid: string; name?: string | null },
): Promise<IosSimulatorPreviewLease | null> {
  // A device switch invalidates the shared lease: capturing device A's window
  // while somebody asks for B would silently show the wrong simulator.
  if (active && active.deviceUdid !== device.udid && active.subscribers === 0) {
    teardown(active);
    active = null;
  }
  if (active && active.deviceUdid === device.udid) {
    return attach(active);
  }
  if (pending && pending.udid !== device.udid) {
    // Somebody else's open; ours has to be its own.
    pending = null;
  }
  if (!pending) {
    const udid = device.udid;
    const promise = openLease(device).finally(() => {
      if (pending?.udid === udid) pending = null;
    });
    pending = { udid, promise };
  }
  const lease = await pending.promise;
  if (!lease) return null;
  // Two callers racing the same open share the one lease that landed.
  if (active && active !== lease && active.deviceUdid === lease.deviceUdid) {
    teardown(lease);
    return attach(active);
  }
  active = lease;
  return attach(lease);
}

function attach(lease: ActiveLease): IosSimulatorPreviewLease {
  lease.subscribers += 1;
  let released = false;
  return {
    stream: lease.stream,
    release: () => {
      // Idempotent: a component's cleanup can run twice under StrictMode, and a
      // double decrement would tear the stream out from under another watcher.
      if (released) return;
      released = true;
      lease.subscribers = Math.max(0, lease.subscribers - 1);
      if (lease.subscribers > 0) return;
      teardown(lease);
      if (active === lease) active = null;
    },
  };
}

/** Test seam: drops module state so one test cannot leak into the next. */
export function resetIosSimulatorPreviewStreamForTests(): void {
  active = null;
  pending = null;
}
