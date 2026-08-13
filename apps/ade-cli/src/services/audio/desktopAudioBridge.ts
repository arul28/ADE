import {
  isPluginAudioCaptureErrorCode,
  type PluginAudioCaptureErrorCode,
} from "../../../../desktop/src/shared/plugins/sdk";

/**
 * The `audio.captureClip` hop between the runtime daemon and the desktop.
 *
 * A plugin child runs in the daemon, and the daemon has no microphone: the
 * device belongs to a renderer, reached only from the desktop's Electron main
 * process. So `ade.audio.captureClip` travels the same side-channel socket
 * `built_in_browser` uses (`<adeHome>/sock/desktop-bridge.sock`) — see
 * `desktopBridgeServer.ts` for the server that hosts both.
 *
 * This module is the shared half: the method name, the two payload shapes and
 * the error encoding, imported by BOTH ends so a rename cannot land on one side
 * only.
 */

/** Addressed as its own namespace: the browser methods carry an actor capability this one has no use for. */
export const DESKTOP_AUDIO_BRIDGE_METHOD = "audio.captureClip";

export type DesktopAudioCaptureRequest = {
  /** Stop and return what was captured after this long. */
  maxDurationMs?: number;
  /** Who the pill names as the requester. Absent reads as "a plugin". */
  requesterLabel?: string;
};

export type DesktopAudioCaptureResponse = {
  /** Absolute path to a WAV on this machine — both ends are the same machine. */
  audioPath: string;
  durationMs: number;
};

/**
 * How much of a requester's name the pill is given.
 *
 * The label is a plugin's own `displayName`, which the manifest parser accepts
 * at any length — so this is the one place between a third party's JSON file
 * and a string rendered in ADE's chrome where that is bounded. A name longer
 * than this is a plugin trying to own the pill, not a plugin with a long name.
 */
export const DESKTOP_AUDIO_REQUESTER_LABEL_MAX_CHARS = 64;

/**
 * The longest a capture can run before the bridge stops waiting for it.
 *
 * A capture with no `maxDurationMs` ends when the person speaking decides it
 * does, so the bridge cannot derive a deadline from the request alone. This is
 * the renderer's own ceiling (`MAX_AUDIO_SECONDS` in `registerIpc.ts`): past it
 * the clip is refused at the WAV-encoding step anyway, so waiting longer only
 * turns a typed refusal into a hung plugin.
 */
export const DESKTOP_AUDIO_CAPTURE_MAX_DURATION_MS = 15 * 60 * 1_000;

/**
 * Slack between "the recording should have stopped" and "the desktop is not
 * answering". Encoding a long clip and writing it to disk happens AFTER the
 * recorder stops, and expiring during that window would abandon a capture the
 * user already made.
 */
export const DESKTOP_AUDIO_CAPTURE_GRACE_MS = 30 * 1_000;

/**
 * How long one `audio.captureClip` request may take.
 *
 * Deliberately a per-method budget rather than a bump to the bridge's shared
 * one: every other bridge call is an interaction that should answer in
 * milliseconds, and a 15-minute ceiling on those would turn a wedged desktop
 * into a wedged CLI.
 */
export function desktopAudioCaptureTimeoutMs(maxDurationMs?: number | null): number {
  const requested = typeof maxDurationMs === "number" && Number.isFinite(maxDurationMs) && maxDurationMs > 0
    ? Math.trunc(maxDurationMs)
    : DESKTOP_AUDIO_CAPTURE_MAX_DURATION_MS;
  return Math.min(requested, DESKTOP_AUDIO_CAPTURE_MAX_DURATION_MS) + DESKTOP_AUDIO_CAPTURE_GRACE_MS;
}

/**
 * Carry the SDK's error code in the message.
 *
 * JSON-RPC errors have a `data` field, but `JsonRpcClient.handleResponse`
 * rebuilds a rejection as `new Error(response.error.message)` and drops
 * everything else — so a code put anywhere but the message does not survive the
 * hop, and the plugin that branches on `audio_capture_cancelled` would see a
 * generic bridge failure instead. The prefix is the same convention the audio
 * IPC handlers already use.
 */
export function encodeDesktopAudioCaptureError(code: PluginAudioCaptureErrorCode, message: string): string {
  return `${code}: ${message}`;
}

export function decodeDesktopAudioCaptureError(
  raw: string,
): { code: PluginAudioCaptureErrorCode; message: string } | null {
  const separator = raw.indexOf(": ");
  if (separator <= 0) return null;
  const code = raw.slice(0, separator);
  if (!isPluginAudioCaptureErrorCode(code)) return null;
  return { code, message: raw.slice(separator + 2) };
}
