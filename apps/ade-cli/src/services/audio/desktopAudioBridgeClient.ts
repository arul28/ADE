import fs from "node:fs";
import path from "node:path";

import { JsonRpcClient } from "../../tuiClient/jsonRpcClient";
import { PluginSdkError, type PluginAudioClip } from "../../../../desktop/src/shared/plugins/sdk";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM } from "../builtInBrowser/desktopBridgeMethods";
import {
  decodeDesktopAudioCaptureError,
  desktopAudioCaptureTimeoutMs,
  DESKTOP_AUDIO_BRIDGE_METHOD,
  type DesktopAudioCaptureResponse,
} from "./desktopAudioBridge";

/**
 * The daemon's half of `ade.audio.captureClip`.
 *
 * A plugin child asks the daemon's plugin host, the host asks this, and this
 * asks the desktop over the same side-channel socket `built_in_browser` uses.
 * The desktop puts an attributed pill in front of the user, records, and
 * answers with a path on this machine.
 *
 * Unlike the browser bridge this opens a CONNECTION PER CAPTURE and closes it
 * when the capture settles. A capture runs for minutes, so the alternative — a
 * cached socket — buys nothing (there is no rapid-fire second call to amortise)
 * and costs two things that matter here: a socket the desktop closed while idle
 * would fail the first capture a user asked for, and the browser client's
 * reconnect-and-retry answer to that is unusable for audio, where a retry would
 * silently start a SECOND recording the user did not ask for.
 */

const CONNECT_TIMEOUT_MS = 3_000;

export type DesktopAudioCaptureBridge = {
  captureClip(args: { label: string; maxDurationMs?: number }): Promise<PluginAudioClip>;
};

/**
 * Every way of discovering there is no desktop says the same sentence: no
 * credential, no socket file, a refused connection. They are one fact to the
 * plugin, and naming the fix is more use to it than naming which check caught it.
 */
function noDesktopAttached(): PluginSdkError {
  return new PluginSdkError(
    "audio_capture_mic_unavailable",
    "ADE Desktop is not running on this machine, so there is no microphone to record from.",
  );
}

function connectTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new PluginSdkError("audio_capture_mic_unavailable", "ADE Desktop did not answer in time.")),
      CONNECT_TIMEOUT_MS,
    ).unref?.();
  });
}

/**
 * Turn whatever came back into something the plugin can branch on.
 *
 * A refusal the desktop named keeps its code — cancelled stays cancelled, busy
 * stays busy. Anything else is the hop itself failing (the socket dropped, the
 * desktop quit mid-recording) and reads as `audio_capture_failed`: the plugin's
 * recording is gone either way, and inventing a more specific code would be a
 * guess about a process that is no longer there to ask.
 */
function asCaptureError(error: unknown): PluginSdkError {
  if (error instanceof PluginSdkError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const decoded = decodeDesktopAudioCaptureError(message);
  if (decoded) return new PluginSdkError(decoded.code, decoded.message);
  // A socket that is not there to connect to is the same fact as one whose file
  // is missing — the desktop quit between the two checks — and the plugin should
  // not get a different answer for losing that race.
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (errno === "ENOENT" || errno === "ECONNREFUSED") return noDesktopAttached();
  return new PluginSdkError("audio_capture_failed", `The recording could not be completed: ${message}`);
}

function readClip(result: unknown): PluginAudioClip {
  const record = result && typeof result === "object" ? result as Partial<DesktopAudioCaptureResponse> : null;
  const audioPath = typeof record?.audioPath === "string" ? record.audioPath.trim() : "";
  if (!audioPath) {
    throw new PluginSdkError("audio_capture_failed", "ADE Desktop answered without a recording.");
  }
  return {
    audioPath,
    durationMs: typeof record?.durationMs === "number" && Number.isFinite(record.durationMs)
      ? record.durationMs
      : 0,
  };
}

export function createDesktopAudioCaptureBridge(args: {
  socketPath: string;
  getAuthToken: () => string | null;
  logger: Logger;
}): DesktopAudioCaptureBridge {
  const { socketPath, logger } = args;
  const isNamedPipe = socketPath.startsWith("\\\\");

  return {
    async captureClip({ label, maxDurationMs }) {
      const authToken = args.getAuthToken()?.trim() ?? "";
      // The daemon holds this credential only while a desktop has handed it
      // over, so an absent one means nothing that owns a microphone is attached.
      if (!authToken) throw noDesktopAttached();
      if (!isNamedPipe && !fs.existsSync(socketPath)) throw noDesktopAttached();

      let client: JsonRpcClient | null = null;
      try {
        client = await Promise.race([JsonRpcClient.connect(socketPath), connectTimeout()]);
        const timeoutMs = desktopAudioCaptureTimeoutMs(maxDurationMs);
        logger.info("audio_bridge.capture_requested", {
          socket: path.basename(socketPath),
          label,
          timeoutMs,
        });
        // The budget is per request, and it is the only clock on this call: the
        // desktop deliberately does not time a recording out (a person speaking
        // decides when it ends), so the daemon must be willing to wait as long
        // as a recording can legitimately last.
        const result = await client.request(
          DESKTOP_AUDIO_BRIDGE_METHOD,
          {
            ...(maxDurationMs != null ? { maxDurationMs } : {}),
            requesterLabel: label,
            [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: authToken,
          },
          { timeoutMs },
        );
        return readClip(result);
      } catch (error) {
        const captureError = asCaptureError(error);
        logger.warn("audio_bridge.capture_failed", { label, code: captureError.code, message: captureError.message });
        throw captureError;
      } finally {
        // Closing rejects anything still pending on this socket, so a capture
        // that already settled can never leave the daemon holding a request the
        // desktop will not answer.
        client?.close();
      }
    },
  };
}
