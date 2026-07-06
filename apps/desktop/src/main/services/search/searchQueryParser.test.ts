import { describe, expect, it } from "vitest";
import {
  buildFtsMatchExpression,
  isMatchAllQuery,
  parseSearchQuery
} from "./searchQueryParser";

const NOW = new Date("2026-07-06T12:00:00.000Z");

describe("parseSearchQuery", () => {
  it("splits bare terms", () => {
    const parsed = parseSearchQuery("universal search palette");
    expect(parsed.terms).toEqual(["universal", "search", "palette"]);
    expect(parsed.phrases).toEqual([]);
    expect(parsed.kinds).toEqual([]);
  });

  it("extracts quoted phrases", () => {
    const parsed = parseSearchQuery('fix "null service" crash');
    expect(parsed.terms).toEqual(["fix", "crash"]);
    expect(parsed.phrases).toEqual(["null service"]);
  });

  it("treats an unterminated quote as running to the end", () => {
    const parsed = parseSearchQuery('deploy "remote runtime');
    expect(parsed.terms).toEqual(["deploy"]);
    expect(parsed.phrases).toEqual(["remote runtime"]);
  });

  it("parses kind filters with comma and pipe separators", () => {
    expect(parseSearchQuery("kind:chat,terminal x").kinds).toEqual(["chat", "terminal"]);
    expect(parseSearchQuery("kind:pr|lane x").kinds).toEqual(["pr", "lane"]);
  });

  it("dedupes repeated kind filters and maps the issue alias", () => {
    const parsed = parseSearchQuery("kind:chat kind:chat kind:issue");
    expect(parsed.kinds).toEqual(["chat", "linear"]);
  });

  it("records unknown kinds as invalid filters", () => {
    const parsed = parseSearchQuery("kind:bogus hello");
    expect(parsed.kinds).toEqual([]);
    expect(parsed.invalidFilters).toEqual(["kind:bogus"]);
    expect(parsed.terms).toEqual(["hello"]);
  });

  it("parses lane and session filters", () => {
    const parsed = parseSearchQuery("lane:my-lane session:abc123 boom");
    expect(parsed.lane).toBe("my-lane");
    expect(parsed.sessionId).toBe("abc123");
    expect(parsed.terms).toEqual(["boom"]);
  });

  it("supports quoted filter values", () => {
    const parsed = parseSearchQuery('lane:"universal search"');
    expect(parsed.lane).toBe("universal search");
  });

  it("resolves since: durations against the provided now", () => {
    const parsed = parseSearchQuery("since:7d x", { now: NOW });
    expect(parsed.sinceIso).toBe("2026-06-29T12:00:00.000Z");
  });

  it("resolves since: hours and weeks", () => {
    expect(parseSearchQuery("since:6h", { now: NOW }).sinceIso).toBe("2026-07-06T06:00:00.000Z");
    expect(parseSearchQuery("since:2w", { now: NOW }).sinceIso).toBe("2026-06-22T12:00:00.000Z");
  });

  it("accepts ISO dates for since:", () => {
    const parsed = parseSearchQuery("since:2026-01-02", { now: NOW });
    expect(parsed.sinceIso).toBe("2026-01-02T00:00:00.000Z");
  });

  it("flags unparseable since values", () => {
    const parsed = parseSearchQuery("since:whenever x", { now: NOW });
    expect(parsed.sinceIso).toBeNull();
    expect(parsed.invalidFilters).toEqual(["since:whenever"]);
  });

  it("keeps colon-bearing non-filter tokens as terms", () => {
    const parsed = parseSearchQuery("http://localhost:5173 error");
    expect(parsed.terms).toEqual(["http://localhost:5173", "error"]);
  });

  it("flags empty filter values", () => {
    const parsed = parseSearchQuery("kind: hello");
    expect(parsed.invalidFilters).toEqual(["kind:"]);
    expect(parsed.terms).toEqual(["hello"]);
  });
});

describe("isMatchAllQuery", () => {
  it("is true for filter-only queries", () => {
    expect(isMatchAllQuery(parseSearchQuery("kind:chat since:7d"))).toBe(true);
    expect(isMatchAllQuery(parseSearchQuery(""))).toBe(true);
    expect(isMatchAllQuery(parseSearchQuery("kind:chat hello"))).toBe(false);
  });
});

describe("buildFtsMatchExpression", () => {
  it("builds AND-ed prefix tokens and exact phrases", () => {
    const parsed = parseSearchQuery('fix "null service" crash');
    expect(buildFtsMatchExpression(parsed)).toBe('"fix"* AND "crash"* AND "null service"');
  });

  it("escapes embedded quotes", () => {
    const parsed = parseSearchQuery('say"hi');
    expect(buildFtsMatchExpression(parsed)).toBe('"say""hi"*');
  });

  it("returns null for match-all queries", () => {
    expect(buildFtsMatchExpression(parseSearchQuery("kind:chat"))).toBeNull();
  });
});
