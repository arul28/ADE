// Stub for @lobehub/icons to avoid nwsapi CSS selector errors in jsdom tests.
// The real package pulls in @lobehub/ui and antd-style which render elements
// with Tailwind arbitrary-value classes (e.g. `rounded-[8px]`) that nwsapi
// cannot parse.  Tests don't exercise icon visuals, so plain <span> stubs
// are sufficient.

import { createElement, forwardRef } from "react";

/** A no-op component that renders a plain <span> with the forwarded props. */
const Stub = /* @__PURE__ */ forwardRef(function Stub(props, ref) {
  return createElement("span", { ref, "data-testid": "lobe-icon-stub", ...props });
});

/** Build a brand object matching the real module shape (Mono + .Color/.Text/.Combine/.Avatar). */
function brand(title) {
  const B = /* @__PURE__ */ forwardRef(function BrandMono(props, ref) {
    return createElement("span", { ref, "aria-label": title, "data-testid": "lobe-icon-stub", ...props });
  });
  B.Color = Stub;
  B.Text = Stub;
  B.Combine = Stub;
  B.Avatar = Stub;
  B.colorPrimary = "#888";
  B.title = title;
  return B;
}

export const Anthropic = brand("Anthropic");
export const Claude = brand("Claude");
export const Codex = brand("Codex");
export const Cursor = brand("Cursor");
export const Gemini = brand("Gemini");
export const Google = brand("Google");
export const Grok = brand("Grok");
export const Groq = brand("Groq");
export const Kimi = brand("Kimi");
export const OpenAI = brand("OpenAI");
export const OpenRouter = brand("OpenRouter");
export const XAI = brand("xAI");
