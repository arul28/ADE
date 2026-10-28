/**
 * Graders for the ADE MCP eval: pure checks on what a model did — the tool
 * calls that reached the fake server, and its final reply. No model calls.
 */

export type Matcher = string | number | boolean | { re: string };

export type ExpectedCall = {
  tool: string;
  /** Each named argument must match: a string compares case-insensitively, `{ re }` tests JSON of the value. */
  args?: Record<string, Matcher>;
  /** At least this many matching calls. Default 1. */
  count?: number;
};

export type Grading = {
  expect?: ExpectedCall[];
  /** Tools that must not be called. */
  forbid?: string[];
  /** Most calls allowed per tool (catches polling loops). */
  maxCalls?: Record<string, number>;
  /** Tools that must first appear in this order. */
  order?: string[];
  /** A regex (case-insensitive) the final reply must match. */
  answer?: string;
};

export type ToolCall = { name: string; arguments: Record<string, unknown>; isError: boolean };

export type Verdict = { pass: boolean; failures: string[] };

function matches(value: unknown, matcher: Matcher): boolean {
  if (typeof matcher === "object") {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    return new RegExp(matcher.re, "i").test(text);
  }
  if (typeof matcher === "string") {
    return typeof value === "string" ? value.trim().toLowerCase() === matcher.trim().toLowerCase() : String(value) === matcher;
  }
  return value === matcher;
}

function callMatches(call: ToolCall, expected: ExpectedCall): boolean {
  if (call.name !== expected.tool) return false;
  return Object.entries(expected.args ?? {}).every(([key, matcher]) => matches(call.arguments[key], matcher));
}

export function grade(grading: Grading, calls: readonly ToolCall[], reply: string): Verdict {
  const failures: string[] = [];
  for (const expected of grading.expect ?? []) {
    const found = calls.filter((call) => callMatches(call, expected)).length;
    if (found < (expected.count ?? 1)) {
      failures.push(`expected ${expected.count ?? 1}× ${expected.tool}${expected.args ? ` ${JSON.stringify(expected.args)}` : ""}, got ${found}`);
    }
  }
  for (const tool of grading.forbid ?? []) {
    const used = calls.filter((call) => call.name === tool);
    if (used.length) failures.push(`called forbidden ${tool}: ${used.map((call) => JSON.stringify(call.arguments)).join("; ")}`);
  }
  for (const [tool, max] of Object.entries(grading.maxCalls ?? {})) {
    const used = calls.filter((call) => call.name === tool).length;
    if (used > max) failures.push(`${tool} called ${used}× (max ${max})`);
  }
  if (grading.order?.length) {
    const firsts = grading.order.map((tool) => calls.findIndex((call) => call.name === tool));
    const inOrder = firsts.every((index, position) => index >= 0 && (position === 0 || index > firsts[position - 1]!));
    if (!inOrder) failures.push(`expected order ${grading.order.join(" → ")}, got ${calls.map((call) => call.name).join(" → ") || "(no calls)"}`);
  }
  if (grading.answer && !new RegExp(grading.answer, "i").test(reply)) {
    failures.push(`reply does not match /${grading.answer}/i`);
  }
  return { pass: failures.length === 0, failures };
}
