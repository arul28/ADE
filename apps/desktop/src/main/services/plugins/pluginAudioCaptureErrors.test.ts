import { describe, expect, it } from "vitest";

import { PluginSdkError, isPluginAudioCaptureErrorCode } from "../../../shared/plugins/sdk";
import {
  asPluginAudioCaptureError,
  pluginAudioCaptureUnavailable,
} from "./pluginSdkServer";
import { AudioCaptureRefused } from "../audio/audioCaptureBroker";

/**
 * `code` is the only field that survives the trip to a plugin child.
 *
 * `pluginChildSupervisor` rebuilds a rejection from `PluginSdkError`'s code and
 * flattens everything else to `internal_error`. Every layer between the
 * microphone and the child throws its own error class — the renderer's
 * `AudioCaptureFailure`, the broker's `AudioCaptureRefused`, the daemon
 * bridge's own — so without a conversion at the SDK boundary a cancelled
 * capture reaches the plugin indistinguishable from a crash.
 *
 * That matters most for the case that happens most: cancel fires every time
 * somebody dismisses the pill, and a plugin reading it as a failure would show
 * an error for something the user did on purpose.
 */
describe("audio capture error codes across the child boundary", () => {
  it("promotes a broker refusal to a typed PluginSdkError", () => {
    const refusal = new AudioCaptureRefused(
      "audio_capture_cancelled",
      "The recording was cancelled.",
    );
    const converted = asPluginAudioCaptureError(refusal);

    expect(converted).toBeInstanceOf(PluginSdkError);
    expect((converted as PluginSdkError).code).toBe("audio_capture_cancelled");
    expect((converted as PluginSdkError).message).toBe("The recording was cancelled.");
  });

  it("carries every capture code, not just the one that prompted the fix", () => {
    for (const code of [
      "audio_capture_cancelled",
      "audio_capture_busy",
      "audio_capture_mic_unavailable",
      "audio_capture_empty",
      "audio_capture_failed",
    ] as const) {
      const converted = asPluginAudioCaptureError(new AudioCaptureRefused(code, "why"));
      expect((converted as PluginSdkError).code, code).toBe(code);
    }
  });

  it("accepts any thrower with a known code, not just one error class", () => {
    // The layers below deliberately do not import a plugin type they have no
    // other use for; the codes are the shared vocabulary.
    const anonymous = Object.assign(new Error("no mic"), {
      code: "audio_capture_mic_unavailable",
    });
    expect((asPluginAudioCaptureError(anonymous) as PluginSdkError).code)
      .toBe("audio_capture_mic_unavailable");
  });

  it("passes a genuine crash through untouched", () => {
    // A real bug must reach the plugin as `internal_error`, not dressed up as a
    // capture outcome the user never caused.
    const crash = new TypeError("cannot read properties of undefined");
    expect(asPluginAudioCaptureError(crash)).toBe(crash);

    const unrelated = Object.assign(new Error("nope"), { code: "ENOENT" });
    expect(asPluginAudioCaptureError(unrelated)).toBe(unrelated);
  });

  it("leaves an already-typed refusal alone", () => {
    const typed = pluginAudioCaptureUnavailable();
    expect(asPluginAudioCaptureError(typed)).toBe(typed);
    expect(typed.code).toBe("audio_capture_mic_unavailable");
  });

  it("keeps the code vocabulary and the error union in step", () => {
    // `PluginSdkErrorCode` includes `PluginAudioCaptureErrorCode`, so a code
    // added to one side has to be accepted by the other or the promotion above
    // silently stops happening for it.
    expect(isPluginAudioCaptureErrorCode("audio_capture_cancelled")).toBe(true);
    expect(isPluginAudioCaptureErrorCode("internal_error")).toBe(false);
  });
});
