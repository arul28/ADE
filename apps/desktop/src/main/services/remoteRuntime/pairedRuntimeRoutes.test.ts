import { describe, expect, it } from "vitest";
import {
  buildPairedEndpointCandidates,
  classifyPairedRuntimeEndpoint,
} from "./pairedRuntimeRoutes";
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
});
