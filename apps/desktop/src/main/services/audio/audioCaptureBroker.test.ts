import { describe, expect, it, vi } from "vitest";

import { createAudioCaptureBroker, type AudioCaptureRequestSender } from "./audioCaptureBroker";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof createAudioCaptureBroker>[0]["logger"];

function fakeSender(): AudioCaptureRequestSender & { sent: unknown[]; destroyed: boolean } {
  const sender = {
    sent: [] as unknown[],
    destroyed: false,
    isDestroyed() {
      return sender.destroyed;
    },
    send(_channel: string, payload: unknown) {
      sender.sent.push(payload);
    },
  };
  return sender;
}

function brokerWith(sender: AudioCaptureRequestSender | null) {
  return createAudioCaptureBroker({
    logger: silentLogger,
    resolveSender: () => sender,
    requestChannel: "ade.audio.captureRequest",
  });
}

const sentRequestId = (sender: { sent: unknown[] }): string =>
  (sender.sent[0] as { requestId: string }).requestId;

/**
 * The piece that turns two one-way messages back into a promise.
 *
 * Everything here is about a request that must not hang: a plugin awaiting a
 * clip has no timeout of its own and no UI of its own, so a request this broker
 * fails to settle is a plugin stuck forever with nothing on screen to explain
 * it.
 */
describe("audio capture broker", () => {
  it("routes a request to the window and resolves with its clip", async () => {
    const sender = fakeSender();
    const broker = brokerWith(sender);

    const pending = broker.requestCapture({ label: "Voice", maxDurationMs: 30_000 });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({ label: "Voice", maxDurationMs: 30_000 });

    broker.settle({
      requestId: sentRequestId(sender),
      ok: true,
      clip: { audioPath: "/tmp/clip.wav", durationMs: 1234 },
    });

    await expect(pending).resolves.toEqual({ audioPath: "/tmp/clip.wav", durationMs: 1234 });
  });

  it("omits maxDurationMs when the caller did not ask for one", async () => {
    const sender = fakeSender();
    const broker = brokerWith(sender);
    const pending = broker.requestCapture({ label: "Voice" });

    expect(sender.sent[0]).not.toHaveProperty("maxDurationMs");

    broker.settle({
      requestId: sentRequestId(sender),
      ok: true,
      clip: { audioPath: "/tmp/clip.wav", durationMs: 10 },
    });
    await pending;
  });

  it("relays a cancellation as the typed code the plugin catches", async () => {
    const sender = fakeSender();
    const broker = brokerWith(sender);
    const pending = broker.requestCapture({ label: "Voice" });

    broker.settle({
      requestId: sentRequestId(sender),
      ok: false,
      code: "audio_capture_cancelled",
      message: "The recording was cancelled.",
    });

    await expect(pending).rejects.toMatchObject({ code: "audio_capture_cancelled" });
  });

  it("refuses a second capture while one is in flight", async () => {
    const sender = fakeSender();
    const broker = brokerWith(sender);
    const first = broker.requestCapture({ label: "Voice" });

    await expect(broker.requestCapture({ label: "Notes" })).rejects.toMatchObject({
      code: "audio_capture_busy",
    });
    // The refusal must not have reached the window: a second request that
    // raised a prompt would put two pills' worth of intent on one microphone.
    expect(sender.sent).toHaveLength(1);

    broker.settle({
      requestId: sentRequestId(sender),
      ok: true,
      clip: { audioPath: "/tmp/clip.wav", durationMs: 5 },
    });
    await first;

    // …and the slot frees up once the first one settles.
    const second = broker.requestCapture({ label: "Notes" });
    expect(sender.sent).toHaveLength(2);
    broker.settle({
      requestId: (sender.sent[1] as { requestId: string }).requestId,
      ok: true,
      clip: { audioPath: "/tmp/second.wav", durationMs: 5 },
    });
    await expect(second).resolves.toMatchObject({ audioPath: "/tmp/second.wav" });
  });

  it("refuses immediately when there is no window to record from", async () => {
    await expect(brokerWith(null).requestCapture({ label: "Voice" })).rejects.toMatchObject({
      code: "audio_capture_mic_unavailable",
    });
  });

  it("refuses when the only window is already destroyed", async () => {
    const sender = fakeSender();
    sender.destroyed = true;
    await expect(brokerWith(sender).requestCapture({ label: "Voice" })).rejects.toMatchObject({
      code: "audio_capture_mic_unavailable",
    });
  });

  it("fails the request when the serving window goes away mid-recording", async () => {
    const sender = fakeSender();
    const broker = brokerWith(sender);
    const pending = broker.requestCapture({ label: "Voice" });

    broker.abandonIfServedBy(sender);

    await expect(pending).rejects.toMatchObject({ code: "audio_capture_failed" });
  });

  it("ignores an unrelated window closing", async () => {
    const sender = fakeSender();
    const broker = brokerWith(sender);
    const pending = broker.requestCapture({ label: "Voice" });

    broker.abandonIfServedBy(fakeSender());
    broker.settle({
      requestId: sentRequestId(sender),
      ok: true,
      clip: { audioPath: "/tmp/clip.wav", durationMs: 7 },
    });

    await expect(pending).resolves.toMatchObject({ audioPath: "/tmp/clip.wav" });
  });

  it("ignores a reply for a request it is not waiting on", async () => {
    const sender = fakeSender();
    const broker = brokerWith(sender);
    const pending = broker.requestCapture({ label: "Voice" });
    const settled = vi.fn();
    void pending.then(settled, settled);

    // A duplicated or late reply from a window that already answered.
    broker.settle({ requestId: "some-other-id", ok: false, code: "x", message: "y" });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    broker.settle({
      requestId: sentRequestId(sender),
      ok: true,
      clip: { audioPath: "/tmp/clip.wav", durationMs: 1 },
    });
    await pending;
  });

  it("fails an in-flight request on shutdown rather than leaving it hanging", async () => {
    const sender = fakeSender();
    const broker = brokerWith(sender);
    const pending = broker.requestCapture({ label: "Voice" });

    broker.dispose();

    await expect(pending).rejects.toMatchObject({ code: "audio_capture_failed" });
  });
});
