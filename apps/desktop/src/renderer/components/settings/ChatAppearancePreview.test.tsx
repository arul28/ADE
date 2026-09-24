/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatAppearancePreview } from "./ChatAppearancePreview";

vi.mock("@lobehub/icons", () => {
  const brand = () => {
    const Component = () => null;
    Object.assign(Component, {
      Avatar: () => null,
      Color: () => null,
      Combine: () => null,
      Text: () => null,
      colorPrimary: "#888",
      title: "stub",
    });
    return Component;
  };
  return {
    Anthropic: brand(),
    Claude: brand(),
    Codex: brand(),
    Cursor: brand(),
    Gemini: brand(),
    GithubCopilot: brand(),
    Google: brand(),
    Grok: brand(),
    Groq: brand(),
    OpenAI: brand(),
    OpenCode: brand(),
    OpenRouter: brand(),
    Qwen: brand(),
    XAI: brand(),
  };
});

afterEach(() => {
  cleanup();
});

describe("ChatAppearancePreview", () => {
  it("shows a shared sample thread under each provider", () => {
    render(
      <ChatAppearancePreview
        theme="dark"
        chatFontSizePx={14}
        transcriptDensity="compact"
        chromeTint="colored"
        shellGeometry="default"
      />,
    );
    for (const provider of ["Codex", "Claude", "OpenCode", "Cursor", "Droid", "Pi"]) {
      expect(screen.queryByText(provider, { exact: true })).not.toBeNull();
    }
    expect(screen.getAllByRole("heading", { name: "Files in scope", level: 3 })).toHaveLength(6);
  });
});
