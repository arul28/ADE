import { describe, expect, it } from "vitest";
import {
  devServerChipLabel,
  mergeDevServer,
  normalizeDevServer,
  normalizeDevServers,
} from "./browserDevServers";

describe("dev servers", () => {
  it("reads a full record, a bare port and a bare host alike", () => {
    expect(normalizeDevServer({ url: "http://localhost:5173", command: "npm run dev" }))
      .toEqual({ url: "http://localhost:5173", port: 5_173, source: "npm run dev" });
    expect(normalizeDevServer(3_000)).toEqual({
      url: "http://localhost:3000",
      port: 3_000,
      source: null,
    });
    expect(normalizeDevServer("localhost:8080")).toEqual({
      url: "http://localhost:8080",
      port: 8_080,
      source: null,
    });
    expect(normalizeDevServer({})).toBeNull();
  });

  it("de-duplicates a list and survives a shape it has never seen", () => {
    expect(normalizeDevServers({
      servers: [
        { port: 5_173 },
        { url: "http://localhost:5173" },
        null,
      ] as never,
    })).toEqual([{ url: "http://localhost:5173", port: 5_173, source: null }]);
    expect(normalizeDevServers(undefined)).toEqual([]);
    expect(normalizeDevServers({ servers: [] })).toEqual([]);
  });

  it("adds a newly detected server and enriches one it already knew", () => {
    const known = [{ url: "http://localhost:5173", port: 5_173, source: null }];
    expect(mergeDevServer(known, { url: "http://localhost:3000", port: 3_000, source: null }))
      .toHaveLength(2);
    expect(mergeDevServer(known, { url: "http://localhost:5173", port: 5_173, source: "npm run dev" }))
      .toEqual([{ url: "http://localhost:5173", port: 5_173, source: "npm run dev" }]);
  });

  it("names the command when it knows it, and the port when it does not", () => {
    expect(devServerChipLabel({ url: "http://localhost:5173", port: 5_173, source: "npm run dev" }))
      .toBe("npm run dev · :5173");
    expect(devServerChipLabel({ url: "http://localhost:5173", port: 5_173, source: null }))
      .toBe("localhost:5173");
  });
});
