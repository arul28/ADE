/* @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import "./index";
import { listTours } from "../registry";

// AI-slop phrasing patterns. Each regex matches a specific bad habit we
// want to keep out of tour copy. If a regex is too aggressive it'll show
// up here as a violation — tighten or allowlist a specific phrase rather
// than softening the copy to dodge the check.
//
// Notes on a few allowlisted words:
//   - "tour" the noun is banned. It showed up in a lot of "X tour" /
//     "Replay ... tour" strings that all read as AI slop. The replay
//     copy now says "walkthrough" or omits the noun entirely.
//   - "overview" the noun is banned. Same reason — every "X overview"
//     title was the bland kind.
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Match "tour" as a standalone word, but allow compounds like
  // "tour-sample" (a real sample lane name we create during the first run).
  { re: /\btour\b(?!-)/i, label: "'tour' (the noun — say walkthrough or drop it)" },
  { re: /\boverview\b/i, label: "'overview' (say what it does)" },
  { re: /\bin this step\b/i, label: "'in this step' meta-narration" },
  { re: /\blet['’]s\b/i, label: "'let's' meta-narration" },
  { re: /!/, label: "exclamation mark" },
  { re: /\busers? can\b/i, label: "'users can' (use second person)" },
  {
    re: /\b(powerful|seamless|intuitive|effortless|robust|enhance)\b/i,
    label: "marketing cliché",
  },
  { re: /^this is\b/i, label: "'This is...' filler opener" },
  { re: /^here (you|is)\b/i, label: "'Here you...' filler opener" },
  { re: /\blearn about\b/i, label: "'learn about' (show what it does)" },
];

describe("tour copy audit", () => {
  it("tour titles avoid AI-slop phrasing", () => {
    const violations: string[] = [];
    for (const tour of listTours()) {
      const title = tour.title ?? "";
      for (const { re, label } of FORBIDDEN_PATTERNS) {
        if (re.test(title)) {
          violations.push(`${tour.id} (${tour.variant}) tour title: "${title}" — ${label}`);
        }
      }
    }
    expect(violations, "AI-slop in tour titles:\n" + violations.join("\n")).toEqual([]);
  });

  it("step titles and bodies avoid AI-slop phrasing", () => {
    const violations: string[] = [];
    for (const tour of listTours()) {
      for (const step of tour.steps) {
        const title = typeof step.title === "string" ? step.title : "";
        const body = typeof step.body === "string" ? step.body : "";
        for (const { re, label } of FORBIDDEN_PATTERNS) {
          if (re.test(title)) {
            violations.push(
              `${tour.id}::${step.id ?? "?"} title="${title}" — ${label}`,
            );
          }
          if (re.test(body)) {
            violations.push(
              `${tour.id}::${step.id ?? "?"} body="${body.slice(0, 100)}" — ${label}`,
            );
          }
        }
      }
    }
    expect(violations, "AI-slop phrasing still present:\n" + violations.join("\n")).toEqual([]);
  });

  it("actIntro titles and subtitles avoid AI-slop phrasing", () => {
    const violations: string[] = [];
    for (const tour of listTours()) {
      for (const step of tour.steps) {
        const intro = step.actIntro;
        if (!intro) continue;
        const fields: Array<[string, string | undefined]> = [
          ["title", intro.title],
          ["subtitle", intro.subtitle],
        ];
        for (const [key, value] of fields) {
          if (!value) continue;
          for (const { re, label } of FORBIDDEN_PATTERNS) {
            if (re.test(value)) {
              violations.push(
                `${tour.id}::${step.id ?? "?"} actIntro.${key}="${value}" — ${label}`,
              );
            }
          }
        }
      }
    }
    expect(violations, "AI-slop in actIntro copy:\n" + violations.join("\n")).toEqual([]);
  });
});
