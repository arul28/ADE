import { describe, expect, it } from "vitest";
import {
  buildPairedEndpointCandidates,
  classifyPairedRuntimeEndpoint,
  classifyPairedRuntimeFailure,
  createRouteAttemptRecorder,
  dominantPairedRuntimeFailure,
  orderPairedCandidates,
  pairedRuntimeFailureMessage,
} from "./pairedRuntimeRoutes";
import {
  PairedRuntimeHelloRejectedError,
  PairedRuntimeRelayAuthRequiredError,
} from "./pairedRuntimeErrors";
import { isTailnetHostname } from "../../../shared/tailnet";

describe("paired runtime endpoint routes", () => {
  it("orders LAN before tailnet before relay and prefers recent success within a route kind", () => {
    const candidates = buildPairedEndpointCandidates({
      endpoints: [
        "wss://relay.example/connect/machine",
        "ws://100.64.20.3:8787",
        "ws://studio.local:8787",
        "ws://192.168.1.8:8787",
        "ws://studio.example.ts.net:8787",
      ],
      relayUrl: "wss://relay.example/connect/machine",
      endpointStates: [
        { endpoint: "ws://192.168.1.8:8787", lastSucceededAt: 200 },
        { endpoint: "ws://studio.local:8787", lastSucceededAt: 100 },
        { endpoint: "ws://studio.example.ts.net:8787", lastSucceededAt: 300 },
      ],
    });

    expect(
      candidates.map(({ endpoint, kind }) => ({ endpoint, kind })),
    ).toEqual([
      { endpoint: "ws://192.168.1.8:8787/", kind: "lan" },
      { endpoint: "ws://studio.local:8787/", kind: "lan" },
      { endpoint: "ws://studio.example.ts.net:8787/", kind: "tailnet" },
      { endpoint: "ws://100.64.20.3:8787/", kind: "tailnet" },
      { endpoint: "wss://relay.example/connect/machine", kind: "relay" },
    ]);
  });

  it("prefers a freshly discovered bound port within its route kind without jumping ahead of LAN", () => {
    const candidates = buildPairedEndpointCandidates({
      endpoints: [
        "ws://studio.local:8787",
        "ws://studio.local:8805",
        "ws://studio.example.ts.net:8805",
      ],
      endpointStates: [
        {
          endpoint: "ws://studio.local:8787",
          lastSucceededAt: 300,
          lastDiscoveredAt: 100,
        },
        {
          endpoint: "ws://studio.local:8805",
          lastSucceededAt: null,
          lastDiscoveredAt: 400,
        },
        {
          endpoint: "ws://studio.example.ts.net:8805",
          lastSucceededAt: null,
          lastDiscoveredAt: 500,
        },
      ],
    });

    expect(candidates.map((candidate) => candidate.endpoint)).toEqual([
      "ws://studio.local:8805/",
      "ws://studio.local:8787/",
      "ws://studio.example.ts.net:8805/",
    ]);
  });

  it("demotes a route after two recent failures, keeps it eligible, and expires the demotion", () => {
    const endpoints = [
      "ws://studio.local:8787",
      "ws://studio.example.ts.net:8787",
      "wss://relay.example/connect/machine",
    ];
    const endpointStates = [{
      endpoint: "ws://studio.local:8787",
      lastSucceededAt: 900,
      lastFailedAt: 1_000,
      consecutiveFailures: 2,
    }];

    const demoted = buildPairedEndpointCandidates({
      endpoints,
      relayUrl: endpoints[2],
      endpointStates,
      nowMs: 1_001,
    });
    expect(orderPairedCandidates(demoted).map((candidate) => candidate.endpoint))
      .toEqual([
        "ws://studio.example.ts.net:8787/",
        "wss://relay.example/connect/machine",
        "ws://studio.local:8787/",
      ]);

    const expired = buildPairedEndpointCandidates({
      endpoints,
      relayUrl: endpoints[2],
      endpointStates,
      nowMs: 121_001,
    });
    expect(orderPairedCandidates(expired).map((candidate) => candidate.endpoint))
      .toEqual([
        "ws://studio.local:8787/",
        "ws://studio.example.ts.net:8787/",
        "wss://relay.example/connect/machine",
      ]);
  });

  it("classifies normalized CGNAT and ts.net hostnames as tailnet", () => {
    expect(classifyPairedRuntimeEndpoint("ws://100.127.255.254:8787")).toBe(
      "tailnet",
    );
    expect(classifyPairedRuntimeEndpoint("ws://100.128.0.1:8787")).toBe("lan");
    expect(
      classifyPairedRuntimeEndpoint("ws://studio.example.ts.net:8787"),
    ).toBe("tailnet");
    expect(classifyPairedRuntimeEndpoint("ws://192.168.1.2:8787")).toBe("lan");
    expect(
      classifyPairedRuntimeEndpoint("wss://relay.example/connect/id"),
    ).toBe("relay");
    expect(isTailnetHostname("  STUDIO.EXAMPLE.TS.NET. ")).toBe(true);
    expect(isTailnetHostname(" [100.64.0.1]. ")).toBe(true);
    expect(isTailnetHostname("100.128.0.1")).toBe(false);
  });

  it("classifies a host rejection from its code, never from the message it wrote", () => {
    // The exact rejection a host sends for a stale pairing. Its text mentions
    // no word any transport regex matches, which is how it used to surface as
    // "unknown" and hide the one instruction that helps.
    const repairRequired = "This device is not paired with this machine, or its saved"
      + " pairing is no longer valid. Pair it again.";
    expect(classifyPairedRuntimeFailure(
      new PairedRuntimeHelloRejectedError(repairRequired, "repair_required", {
        deviceId: "host-1",
        name: "Arul's Mac Studio",
      }),
    )).toBe("pairing");
    // Same message, host too old to send the specific code.
    expect(classifyPairedRuntimeFailure(
      new PairedRuntimeHelloRejectedError(repairRequired, "auth_failed"),
    )).toBe("pairing");
    // And with no code at all it is still a rejection, not a dead route.
    expect(classifyPairedRuntimeFailure(
      new PairedRuntimeHelloRejectedError(repairRequired, null),
    )).toBe("pairing");
    expect(classifyPairedRuntimeFailure(
      new PairedRuntimeHelloRejectedError("Sign in.", "relay_account_required"),
    )).toBe("authentication");
    expect(classifyPairedRuntimeFailure(
      new PairedRuntimeRelayAuthRequiredError("Sign in to ADE."),
    )).toBe("authentication");
    expect(classifyPairedRuntimeFailure(
      new PairedRuntimeHelloRejectedError(
        "A newer connection route already won this connection attempt.",
        "connection_attempt_superseded",
      ),
    )).toBe("superseded");
    expect(classifyPairedRuntimeFailure(
      new PairedRuntimeHelloRejectedError("Update ADE.", "protocol_version_mismatch"),
    )).toBe("protocol");
    // Neither of these is a pairing problem, and "pair it again" is the wrong
    // instruction for both: one machine needs an update, the other needs its
    // account session repaired. Both used to arrive as `auth_failed`.
    expect(classifyPairedRuntimeFailure(
      new PairedRuntimeHelloRejectedError(
        "This machine cannot verify ADE accounts. Update ADE on this computer, then try again.",
        "host_update_required",
      ),
    )).toBe("protocol");
    expect(classifyPairedRuntimeFailure(
      new PairedRuntimeHelloRejectedError(
        "The ADE account session on this machine changed while connecting. Try again.",
        "account_session_changed",
      ),
    )).toBe("authentication");
  });

  it("diagnoses one dominant cause and says it without routes or ports", () => {
    const attempts = [
      { kind: "lan", host: "192.168.1.240:8788", startedAt: 1, durationMs: 5, outcome: "failed", failure: "unreachable" },
      { kind: "tailnet", host: "studio.example.ts.net:8788", startedAt: 2, durationMs: 5, outcome: "failed", failure: "timeout" },
      { kind: "relay", host: "relay.example", startedAt: 3, durationMs: 5, outcome: "failed", failure: "pairing" },
    ] as const;
    // A single actionable rejection outranks a pile of dead routes.
    expect(dominantPairedRuntimeFailure([...attempts])).toBe("pairing");
    const message = pairedRuntimeFailureMessage("pairing", "Arul's Mac Studio");
    expect(message).toBe(
      "Arul's Mac Studio says this device's pairing is out of date — pair it again.",
    );
    for (const forbidden of ["192.168", "8788", "ts.net", "relay", "lan", "unknown"]) {
      expect(message.toLowerCase()).not.toContain(forbidden);
    }
    expect(dominantPairedRuntimeFailure([
      { kind: "lan", host: "a", startedAt: 1, durationMs: 1, outcome: "failed", failure: "unreachable" },
      { kind: "relay", host: "b", startedAt: 2, durationMs: 1, outcome: "failed", failure: "timeout" },
    ])).toBe("timeout");
    expect(pairedRuntimeFailureMessage("timeout", "Mac Studio")).toBe(
      "Can't reach Mac Studio — it may be asleep or ADE may be stopped there.",
    );
    expect(pairedRuntimeFailureMessage("authentication", "Mac Studio")).toBe(
      "Sign in to ADE to connect through the relay.",
    );
    // No attempts recorded at all still produces a sentence, not an empty one.
    expect(dominantPairedRuntimeFailure([])).toBe("unknown");
    expect(pairedRuntimeFailureMessage("unknown", null)).toContain("that computer");
  });

  it("keeps transport failures meaningful when their sanitized text mentions a token", () => {
    expect(classifyPairedRuntimeFailure(
      new Error("socket failed with secret diagnostic-token"),
    )).toBe("unreachable");
    expect(classifyPairedRuntimeFailure(
      new Error("relay token rejected"),
    )).toBe("authentication");
    expect(classifyPairedRuntimeFailure(
      new Error("WebSocket closed: unauthorized"),
    )).toBe("authentication");
  });

  it("shares direct-before-relay ordering and preserves failures in bounded attempts", () => {
    const candidates = buildPairedEndpointCandidates({
      endpoints: [
        "wss://relay.example/connect/one",
        "ws://studio.local:8787",
      ],
      relayUrl: "wss://relay.example/connect/one",
    });
    expect(orderPairedCandidates([...candidates].reverse()).map((candidate) => candidate.kind))
      .toEqual(["lan", "relay"]);

    const recorder = createRouteAttemptRecorder(2);
    recorder.record({
      kind: "relay",
      host: "relay-one.example",
      startedAt: 1,
      durationMs: 1,
      outcome: "skipped",
      failure: "authentication",
    });
    recorder.record({
      kind: "relay",
      host: "relay-two.example",
      startedAt: 2,
      durationMs: 1,
      outcome: "skipped",
      failure: "authentication",
    });
    recorder.record({
      kind: "lan",
      host: "studio.local:8787",
      startedAt: 3,
      durationMs: 1,
      outcome: "failed",
      failure: "unreachable",
    });

    expect(recorder.attempts).toEqual([
      expect.objectContaining({ host: "relay-two.example", outcome: "skipped" }),
      expect.objectContaining({ host: "studio.local:8787", outcome: "failed" }),
    ]);
    expect(recorder.omittedAttemptCount).toBe(1);
  });
});
