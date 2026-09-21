import { describe, expect, it, vi } from "vitest";

import {
  ctoVoiceFrameDurationMs,
  describeCtoVoiceServerError,
  describeCtoVoiceSocketFailure,
  forwardUnexpectedResponse,
} from "./ctoVoiceFailures";
import {
  createCtoVoiceCallService,
  type CtoVoiceSocket,
} from "./ctoVoiceCallService";
import type { CtoVoiceState } from "../../../shared/types/ctoVoice";
import { createService, openCall, tick } from "./ctoVoiceCallHarness";

/**
 * What a voice call's failures MEAN.
 *
 * Two halves of one question. The pure mappings are the sentences a user is
 * shown — a rejected key, an expired one, an account with no credit, a machine
 * that is offline — and each has a different fix, so telling them apart is the
 * whole value. The suites that drive a real socket are here for the same
 * reason: what the HUD ends up saying is decided by which reason wins the race
 * between a failure and the teardown it causes.
 */

/** The length half of the gate, measured off the audio rather than a clock. */
describe("ctoVoiceFrameDurationMs", () => {
  it("reads a frame's length out of its bytes", () => {
    // 2048 samples of PCM16 at 24 kHz is the renderer's frame: ~85.3 ms.
    expect(ctoVoiceFrameDurationMs(Buffer.alloc(2048 * 2).toString("base64")))
      .toBeCloseTo(85.333, 2);
    expect(ctoVoiceFrameDurationMs(Buffer.alloc(24_000 * 2).toString("base64")))
      .toBeCloseTo(1_000, 3);
    expect(ctoVoiceFrameDurationMs("")).toBe(0);
  });
});

describe("a session that answers with an error", () => {
  it("names an expired key, because 'rejected' sends the user to the wrong fix", async () => {
    const warn = vi.fn();
    const harness = createService({ logger: { info: () => {}, warn } });
    await openCall(harness);

    harness.fake.receive({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "invalid_api_key",
        message: "Your API key has expired. Create a new API key to continue.",
      },
    });
    await tick();

    expect(harness.service.getState().error).toBe(
      "Your OpenAI key has expired. Create a new key at platform.openai.com"
      + " and paste it under CTO settings, Voice.",
    );
    expect(harness.states.some((state) => state.phase === "failed")).toBe(true);
    // A refused key does not recover, so the call ends rather than sitting there.
    expect(harness.states.at(-1)?.phase).toBe("ended");
    expect(harness.service.getConnectionFailureKind()).toBe("rejected_key");
    // The raw error, with its code and type, is in the trace.
    expect(warn).toHaveBeenCalledWith("cto_voice.session_error", expect.objectContaining({
      code: "invalid_api_key",
      type: "invalid_request_error",
      message: "Your API key has expired. Create a new API key to continue.",
    }));
  });

  it("surfaces an error it cannot classify in OpenAI's own words", async () => {
    const harness = createService();
    await openCall(harness);

    harness.fake.receive({
      type: "error",
      error: { type: "invalid_request_error", message: "Unknown parameter: 'session.wobble'." },
    });

    // Verbatim, not "The voice connection failed." — a sentence someone wrote
    // to be read is better than a guess, whatever we do with it.
    expect(harness.service.getState().error).toBe("Unknown parameter: 'session.wobble'.");
    // Not fatal: the session is still there and the call keeps going.
    expect(harness.service.getState().phase).toBe("listening");
  });

  it("says nothing about a response it cancelled a beat too late", async () => {
    const harness = createService();
    await openCall(harness);
    harness.fake.receive({
      type: "error",
      error: { type: "invalid_request_error", message: "Cancellation failed: no active response found" },
    });
    expect(harness.service.getState().error).toBeNull();
    expect(harness.service.getState().phase).toBe("listening");
  });
});

describe("describeCtoVoiceSocketFailure", () => {
  it("names a rejected key, because that is the one the user can fix", () => {
    for (const status of [401, 403]) {
      expect(describeCtoVoiceSocketFailure({ status })).toEqual({
        message: "OpenAI rejected this key. Check it under CTO settings, Voice.",
        status,
        code: null,
      });
    }
  });

  it("recovers the status ws buries in its own message", () => {
    // With no `unexpected-response` listener this is all that survives, and it
    // is what a build that forgot one would have to work from.
    expect(describeCtoVoiceSocketFailure({ message: "Unexpected server response: 401" }).message)
      .toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    expect(describeCtoVoiceSocketFailure({ message: "Unexpected server response: 429" }).status)
      .toBe(429);
  });

  it("separates throttling from rejection, because waiting fixes one and not the other", () => {
    expect(describeCtoVoiceSocketFailure({ status: 429 }).message)
      .toBe("OpenAI is rate limiting this key. Try again in a minute.");
  });

  it("blames the network only when there was no response at all", () => {
    expect(describeCtoVoiceSocketFailure({ code: "ENOTFOUND" }).message)
      .toBe("ADE could not reach OpenAI. Check your internet connection.");
    expect(describeCtoVoiceSocketFailure({ code: "ECONNREFUSED" }).message)
      .toBe("ADE could not reach OpenAI. Check your internet connection.");
    // Read out of the text when the code rides there instead of on the error.
    expect(describeCtoVoiceSocketFailure({ message: "getaddrinfo ENOTFOUND api.openai.com" }).message)
      .toBe("ADE could not reach OpenAI. Check your internet connection.");
    // A 500 is OpenAI answering. Telling the user to check their wifi would
    // send them to fix something that is not broken.
    expect(describeCtoVoiceSocketFailure({ status: 500, code: "ECONNRESET" }).message)
      .toBe("The voice connection failed.");
  });

  it("keeps the old sentence for a failure it cannot explain", () => {
    expect(describeCtoVoiceSocketFailure()).toEqual({
      message: "The voice connection failed.",
      status: null,
      code: null,
    });
    expect(describeCtoVoiceSocketFailure({ message: "socket hang up" }).message)
      .toBe("The voice connection failed.");
    expect(describeCtoVoiceSocketFailure({ status: 503 }).message)
      .toBe("The voice connection failed.");
  });
});

describe("forwardUnexpectedResponse", () => {
  it("reports the status before it releases the request", () => {
    // Releasing first makes `ws` emit "closed before the connection was
    // established" synchronously, and that error knows nothing about the 401
    // that caused it — so it won the race and the user was told the generic
    // sentence for a key OpenAI had plainly refused.
    const order: string[] = [];
    forwardUnexpectedResponse(
      () => order.push("handler"),
      { destroy: () => order.push("destroy") },
      { statusCode: 401 },
    );
    expect(order).toEqual(["handler", "destroy"]);
  });

  it("still releases the request when the handler throws", () => {
    const destroy = vi.fn();
    expect(() => forwardUnexpectedResponse(
      () => { throw new Error("boom"); },
      { destroy },
      { statusCode: 401 },
    )).toThrow("boom");
    expect(destroy).toHaveBeenCalled();
  });

  it("survives a response and a request that carry nothing", () => {
    const handler = vi.fn();
    forwardUnexpectedResponse(handler, null, null);
    expect(handler).toHaveBeenCalledWith({ statusCode: null });
  });
});

describe("a call that never connects", () => {
  it("surfaces a rejected key in the state the HUD reads, and logs the status", async () => {
    const warn = vi.fn();
    const { service, fake, states } = createService({
      logger: { info: () => {}, warn },
    });
    await service.start();

    fake.rejectUpgrade(401);

    const failed = states.find((state) => state.phase === "failed");
    expect(failed?.error).toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    expect(warn).toHaveBeenCalledWith(
      "cto_voice.socket_rejected",
      expect.objectContaining({ status: 401 }),
    );
  });

  it("keeps the rejected-key sentence when tearing the socket down emits its own error", async () => {
    // The real shape of the regression: closing a CONNECTING socket makes `ws`
    // emit "WebSocket was closed before the connection was established" inside
    // the same tick, and that generic error must not win.
    const warn = vi.fn();
    const handlers: Record<string, Array<(payload?: unknown) => void>> = {};
    const emitError = () => handlers.error?.forEach((h) => h(
      new Error("WebSocket was closed before the connection was established"),
    ));
    const socket: CtoVoiceSocket = {
      send: () => {},
      // Both doors: an explicit close and a destroy behave the same way.
      close: () => emitError(),
      on: (event, handler) => { (handlers[event] = handlers[event] ?? []).push(handler); },
    };
    const states: CtoVoiceState[] = [];
    const service = createCtoVoiceCallService({
      getApiKey: async () => "sk-test",
      ctoName: () => "CTO",
      projectName: () => "ADE",
      backchannelsEnabled: () => true,
      runBackendTurn: async () => ({ spoken: "" }),
      persistCall: async () => {},
      onState: (state) => states.push(state),
      logger: { info: () => {}, warn },
      createWebSocket: () => socket,
    });
    await service.start();

    handlers["unexpected-response"]?.forEach((h) => h({ statusCode: 401 }));
    await Promise.resolve();

    const failed = states.find((state) => state.phase === "failed");
    expect(failed?.error).toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    expect(service.getState().error).toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
    // The trace still names the status, which is what the log is for.
    expect(warn).toHaveBeenCalledWith(
      "cto_voice.socket_rejected",
      expect.objectContaining({ status: 401 }),
    );
    // The teardown's own error is recorded, and marked as the follow-on it is.
    expect(warn).toHaveBeenCalledWith(
      "cto_voice.socket_error",
      expect.objectContaining({ suppressed: true }),
    );
  });

  it("does not let a late generic error overwrite the reason it already found", async () => {
    // `ws` can follow a rejected upgrade with an error that knows nothing.
    const { service, fake } = createService();
    await service.start();

    fake.rejectUpgrade(401);
    fake.fail(new Error("socket hang up"));

    expect(service.getState().error)
      .toBe("OpenAI rejected this key. Check it under CTO settings, Voice.");
  });

  it("does not blame OpenAI for a hang-up ADE asked for", async () => {
    // The production symptom: something ends the call ~150 ms in, while the
    // socket is still CONNECTING. `ws` reports that close as "WebSocket was
    // closed before the connection was established" — indistinguishable, from
    // the error alone, from a connection that failed on its own. Describing it
    // as one is how a call hung up by ADE came back as
    // "The voice connection failed." and buried the real cause.
    const warn = vi.fn();
    const info = vi.fn();
    const handlers: Record<string, Array<(payload?: unknown) => void>> = {};
    const socket: CtoVoiceSocket = {
      send: () => {},
      close: () => handlers.error?.forEach((h) => h(
        new Error("WebSocket was closed before the connection was established"),
      )),
      on: (event, handler) => { (handlers[event] = handlers[event] ?? []).push(handler); },
    };
    const states: CtoVoiceState[] = [];
    const service = createCtoVoiceCallService({
      getApiKey: async () => "sk-test",
      ctoName: () => "CTO",
      projectName: () => "ADE",
      backchannelsEnabled: () => true,
      runBackendTurn: async () => ({ spoken: "" }),
      persistCall: async () => {},
      onState: (state) => states.push(state),
      logger: { info, warn },
      createWebSocket: () => socket,
    });
    await service.start();
    // Never opened: exactly the window the real hang-up lands in.
    expect(states.at(-1)?.phase).toBe("connecting");

    await service.end("owner_end");

    expect(states.some((state) => state.phase === "failed")).toBe(false);
    expect(states.at(-1)?.phase).toBe("ended");
    expect(states.at(-1)?.error).toBeNull();
    // And the trace says who ended it, which is the whole point.
    expect(info).toHaveBeenCalledWith(
      "cto_voice.call_end",
      expect.objectContaining({ reason: "owner_end", socketOpen: false }),
    );
    expect(warn).toHaveBeenCalledWith(
      "cto_voice.socket_error",
      expect.objectContaining({ deliberate: true }),
    );
  });

  it("names the teardown path on every call end", async () => {
    const info = vi.fn();
    const { service, fake } = createService({ logger: { info, warn: () => {} } });
    await service.start();

    fake.rejectUpgrade(401);
    await Promise.resolve();

    expect(info).toHaveBeenCalledWith(
      "cto_voice.call_end",
      expect.objectContaining({ reason: "socket_rejected" }),
    );
  });

  it("tells an offline machine it is offline", async () => {
    const { service, fake, states } = createService();
    await service.start();

    fake.fail(Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" }));

    const failed = states.find((state) => state.phase === "failed");
    expect(failed?.error).toBe("ADE could not reach OpenAI. Check your internet connection.");
  });
});

describe("describeCtoVoiceServerError", () => {
  const EXPIRED = "Your OpenAI key has expired. Create a new key at platform.openai.com"
    + " and paste it under CTO settings, Voice.";
  const REJECTED = "OpenAI rejected this key. Check it under CTO settings, Voice.";
  const NO_CREDIT = "Your OpenAI account has no credit for voice calls."
    + " Add billing at platform.openai.com.";

  it("names an expired key, which is a different fix from a wrong one", () => {
    expect(describeCtoVoiceServerError({
      message: "Your API key has expired. Create a new API key to continue.",
    })).toEqual({ message: EXPIRED, kind: "expired_key", fatal: true });
  });

  it("keeps the rejected-key sentence for a key OpenAI does not recognise", () => {
    for (const message of [
      "Incorrect API key provided: sk-abc***. You can find your API key at …",
      "Invalid API key",
    ]) {
      expect(describeCtoVoiceServerError({ message }))
        .toEqual({ message: REJECTED, kind: "rejected_key", fatal: true });
    }
    expect(describeCtoVoiceServerError({ code: "invalid_api_key", message: "" }).kind)
      .toBe("rejected_key");
  });

  it("sends an account with no credit to billing, not back to the key field", () => {
    expect(describeCtoVoiceServerError({
      code: "insufficient_quota",
      message: "You exceeded your current quota, please check your plan and billing details.",
    })).toEqual({ message: NO_CREDIT, kind: "no_credit", fatal: true });
  });

  it("does not blame the key for a parameter it did not like", () => {
    // The trap in a bare /invalid/: this is about a field, not a credential,
    // and "check your key" would send the user to the one place nothing is wrong.
    const reason = describeCtoVoiceServerError({
      type: "invalid_request_error",
      message: "Invalid value: 'chirp' for session.audio.output.voice.",
    });
    expect(reason.kind).toBe("other");
    expect(reason.message).toBe("Invalid value: 'chirp' for session.audio.output.voice.");
    expect(reason.fatal).toBe(false);
  });

  it("passes an unrecognised message through, trimmed to one line", () => {
    expect(describeCtoVoiceServerError({
      message: "  The server had a problem.  \nStack: at foo (bar.js:1)\n",
    })).toEqual({ message: "The server had a problem.", kind: "other", fatal: false });
  });

  it("still says something when the error carried no message at all", () => {
    expect(describeCtoVoiceServerError()).toEqual({
      message: "The voice session reported an error.",
      kind: "other",
      fatal: false,
    });
  });
});
