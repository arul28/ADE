/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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
    Google: brand(),
    Grok: brand(),
    Groq: brand(),
    OpenAI: brand(),
    OpenCode: brand(),
    OpenRouter: brand(),
    XAI: brand(),
  };
});

afterEach(() => {
  cleanup();
});

describe("ChatAppearancePreview", () => {
  it("applies chat font size and row gap CSS variables to appearance roots", () => {
    const { container } = render(
      <ChatAppearancePreview
        theme="dark"
        chatFontSizePx={17}
        transcriptDensity="compact"
        chromeTint="colored"
        shellGeometry="default"
      />,
    );
    const roots = container.querySelectorAll("[data-chat-appearance-root]");
    expect(roots.length).toBeGreaterThanOrEqual(1);
    for (const el of roots) {
      const style = (el as HTMLElement).style;
      expect(style.getPropertyValue("--chat-font-size").trim()).toBe("17px");
      expect(style.getPropertyValue("--chat-row-gap").trim()).toBe("6px");
      expect(style.getPropertyValue("--chat-bubble-user-px").trim()).toBe("12px");
    }
  });

  it("maps spacious density to wider row gap and bubble padding", () => {
    const { container } = render(
      <ChatAppearancePreview
        theme="dark"
        chatFontSizePx={14}
        transcriptDensity="spacious"
        chromeTint="colored"
        shellGeometry="default"
      />,
    );
    const first = container.querySelector("[data-chat-appearance-root]") as HTMLElement;
    expect(first.style.getPropertyValue("--chat-row-gap").trim()).toBe("28px");
    expect(first.style.getPropertyValue("--chat-bubble-assistant-py").trim()).toBe("22px");
  });

  it("renders three chat surface shells with colored chrome rail and standard border mix", () => {
    const { container } = render(
      <ChatAppearancePreview
        theme="dark"
        chatFontSizePx={14}
        transcriptDensity="comfortable"
        chromeTint="colored"
        shellGeometry="sharp"
      />,
    );
    const shells = container.querySelectorAll("section[data-chat-shell-layout]");
    expect(shells.length).toBe(3);
    const sharp = container.querySelectorAll("section[data-chat-shell-geometry='sharp']");
    expect(sharp.length).toBe(3);
    for (const el of shells) {
      const style = (el as HTMLElement).style;
      expect(style.getPropertyValue("--chat-user-border-accent-mix").trim()).toBe("28%");
      expect(style.getPropertyValue("--chat-lane-rail-width").trim()).toBe("3px");
    }
  });

  it("hides the colored lane rail in no-tint (neutral) mode", () => {
    const { container } = render(
      <ChatAppearancePreview
        theme="dark"
        chatFontSizePx={14}
        transcriptDensity="comfortable"
        chromeTint="neutral"
        shellGeometry="default"
      />,
    );
    const first = container.querySelector("section[data-chat-chrome-tint='neutral']") as HTMLElement;
    expect(first).toBeTruthy();
    const style = first.style;
    expect(style.getPropertyValue("--chat-lane-rail-width").trim()).toBe("0px");
    expect(style.getPropertyValue("--chat-lane-rail-opacity").trim()).toBe("0");
  });

  it("scopes theme to the preview subtree", () => {
    const { container } = render(
      <ChatAppearancePreview
        theme="light"
        chatFontSizePx={14}
        transcriptDensity="comfortable"
        chromeTint="colored"
        shellGeometry="default"
      />,
    );
    const themed = container.querySelector("[data-theme='light']");
    expect(themed).toBeTruthy();
  });
});
