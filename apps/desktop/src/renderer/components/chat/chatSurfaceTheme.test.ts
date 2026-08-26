import { describe, expect, it } from "vitest";
import {
  NEUTRAL_CHAT_ACCENT,
  PROVIDER_CHAT_ACCENTS,
  chatSurfaceVars,
  providerChatAccent,
  chatAccentForRenderedChat,
} from "./chatSurfaceTheme";

/** The value a surface actually paints, as the DOM would see it. */
function vars(accent: string | null, tint: "colored" | "neutral" = "colored") {
  return chatSurfaceVars("standard", accent, { chromeTint: tint }) as Record<string, string>;
}

describe("chat surface accents", () => {
  it("gives every first-class runtime its own accent", () => {
    const perRuntime = {
      claude: "#D97706",
      codex: "#E7E5E4",
      opencode: "#739CEE",
      cursor: "#13120C",
      droid: "#D46C2E",
      pi: "#181C25",
    };
    for (const [provider, expected] of Object.entries(perRuntime)) {
      expect(providerChatAccent(provider)).toBe(expected);
    }
    // Distinct values, or two runtimes are indistinguishable in the transcript.
    expect(new Set(Object.values(perRuntime)).size).toBe(Object.keys(perRuntime).length);
  });

  it("keeps provider aliases on the same accent as their runtime", () => {
    expect(providerChatAccent("anthropic")).toBe(providerChatAccent("claude"));
    expect(providerChatAccent("openai")).toBe(providerChatAccent("codex"));
    expect(providerChatAccent("factory")).toBe(providerChatAccent("droid"));
    expect(providerChatAccent("PI")).toBe(PROVIDER_CHAT_ACCENTS.pi);
    expect(providerChatAccent("not-a-runtime")).toBeNull();
  });

  // The stops used to mix toward a fixed violet, so every provider's bubble
  // came out purple regardless of its accent — the colour was set but never
  // visible as itself.
  it("shades a re-coloured provider's bubble from its own accent", () => {
    for (const accent of ["#739CEE", "#D46C2E", "#13120C", "#181C25"]) {
      const gradient = vars(accent)["--chat-user-bubble-gradient"] ?? "";
      expect(gradient).toContain("var(--chat-accent)");
      expect(gradient).not.toContain("#7c3aed");
      expect(gradient).not.toContain("#4c1d95");
    }
  });

  // Claude and Codex already looked right, and re-colouring the other four was
  // not licence to restyle them.
  it("leaves the Claude and Codex bubbles exactly as they shipped", () => {
    const claude = vars("#D97706");
    expect(claude["--chat-user-bubble-gradient"]).toBe(
      "linear-gradient(135deg, color-mix(in srgb, var(--chat-accent) 76%, #ffffff 6%) 0%, color-mix(in srgb, var(--chat-accent) 60%, #7c3aed 40%) 50%, color-mix(in srgb, var(--chat-accent) 58%, #4c1d95 42%) 100%)",
    );
    expect(claude["--chat-user-border-accent-mix"]).toBe("28%");
    expect(claude["--chat-user-shadow-accent-mix"]).toBe("34%");

    const codex = vars("#E7E5E4");
    expect(codex["--chat-user-bubble-gradient"]).toBe(
      "linear-gradient(135deg, color-mix(in srgb, var(--chat-accent) 74%, #78716c 10%) 0%, color-mix(in srgb, var(--chat-accent) 58%, #7c3aed 42%) 50%, color-mix(in srgb, var(--chat-accent) 56%, #4c1d95 44%) 100%)",
    );
    expect(codex["--chat-user-border-accent-mix"]).toBe("22%");
    expect(codex["--chat-user-shadow-accent-mix"]).toBe("28%");
  });

  it("lifts a near-black accent instead of deepening it", () => {
    const deep = vars("#181C25");
    const normal = vars("#D97706");
    expect(deep["--chat-user-bubble-gradient"]).not.toBe(normal["--chat-user-bubble-gradient"]);
    // A wider border mix is what keeps the bubble's edge on a dark fill.
    expect(deep["--chat-user-border-accent-mix"]).toBe("46%");
    expect(normal["--chat-user-border-accent-mix"]).toBe("28%");
  });

  it("drops every provider colour when the user picks no tint", () => {
    const neutral = vars("#D46C2E", "neutral");
    expect(neutral["--chat-accent"]).toBe("#52525b");
    expect(vars("#181C25", "neutral")["--chat-accent"]).toBe(neutral["--chat-accent"]);
  });
});

describe("chatAccentForRenderedChat", () => {
  const CLAUDE = PROVIDER_CHAT_ACCENTS.claude;
  const CODEX = PROVIDER_CHAT_ACCENTS.codex;

  it("prefers the rendered chat's own session provider", () => {
    expect(chatAccentForRenderedChat({
      sessionProvider: "claude",
      lockSessionProvider: "claude",
      modelFamily: "codex",
      modelColor: "#123456",
    })).toBe(CLAUDE);
  });

  // The switch frame: the pane still holds the outgoing Claude chat and its
  // Claude composer model, so it withholds both by passing null, and the row it
  // is being pointed at — Codex — is what paints.
  it("paints the incoming chat's provider on the switch frame, not the outgoing one", () => {
    expect(chatAccentForRenderedChat({
      sessionProvider: null,
      lockSessionProvider: "codex",
      modelFamily: null,
      modelColor: null,
    })).toBe(CODEX);
  });

  // The invariant: an unplumbed host may show gray, never the previous chat.
  it("falls to neutral rather than a stale colour when nothing identifies the chat", () => {
    expect(chatAccentForRenderedChat({
      sessionProvider: null,
      lockSessionProvider: null,
      modelFamily: null,
      modelColor: null,
    })).toBe(NEUTRAL_CHAT_ACCENT);
  });

  // A draft pane has no session at all; its composer model is the only truth,
  // and its state is never stale, so it passes the model through.
  it("keeps a draft pane on its composer model's colour", () => {
    expect(chatAccentForRenderedChat({
      sessionProvider: null,
      lockSessionProvider: null,
      modelFamily: "opencode",
      modelColor: "#123456",
    })).toBe(PROVIDER_CHAT_ACCENTS.opencode);
    expect(chatAccentForRenderedChat({
      sessionProvider: null,
      lockSessionProvider: null,
      modelFamily: "not-a-runtime",
      modelColor: "#123456",
    })).toBe("#123456");
  });
});
