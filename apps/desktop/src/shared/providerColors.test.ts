import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDER_IOS_COLORS } from "./providerColors";

function swiftComponentToByte(expression: string): number | null {
  const match = expression.trim().match(/^(0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)\s*\/\s*(255(?:\.0+)?|1(?:\.0+)?)$/);
  if (!match) return null;
  const numerator = match[1]!.toLowerCase().startsWith("0x")
    ? Number.parseInt(match[1]!.slice(2), 16)
    : Number(match[1]);
  const denominator = Number(match[2]);
  const byte = Math.round((numerator / denominator) * 255);
  return Number.isInteger(byte) && byte >= 0 && byte <= 255 ? byte : null;
}

function swiftColorHex(swift: string, name: string): string | null {
  const match = swift.match(new RegExp(
    `public\\s+static\\s+let\\s+${name}\\b\\s*=\\s*Color\\s*\\(\\s*red:\\s*([^,]+?)\\s*,\\s*green:\\s*([^,]+?)\\s*,\\s*blue:\\s*([^\\)]+?)\\s*\\)`,
  ));
  if (!match) return null;
  const components = match.slice(1).map((component) => swiftComponentToByte(component));
  if (components.some((component) => component === null)) return null;
  return `#${components.map((component) => component!.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

describe("provider color mirrors", () => {
  it("keeps Swift provider RGB components aligned with the shared TypeScript table", () => {
    const swiftCandidates = [
      path.resolve(process.cwd(), "../ios/ADE/Shared/ADESharedTheme.swift"),
      path.resolve(process.cwd(), "apps/ios/ADE/Shared/ADESharedTheme.swift"),
    ];
    const swiftPath = swiftCandidates.find((candidate) => fs.existsSync(candidate));
    expect(swiftPath).toBeDefined();
    const swift = fs.readFileSync(swiftPath!, "utf8");
    const mirrors = {
      brandClaude: "claude",
      brandCodex: "codex",
      brandPi: "pi",
      brandCursor: "cursor",
      brandOpenCode: "opencode",
      brandGoogle: "google",
      brandMistral: "mistral",
      brandDeepSeek: "deepseek",
      brandXAI: "xai",
      brandGroq: "groq",
      brandCTO: "cto",
      brandQwen: "qwen",
      brandKimi: "kimi",
      brandCopilot: "copilot",
    } as const;

    for (const [swiftName, provider] of Object.entries(mirrors)) {
      expect(swiftColorHex(swift, swiftName), swiftName).toBe(PROVIDER_IOS_COLORS[provider].toUpperCase());
    }
  });
});
