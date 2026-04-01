/**
 * LobeHub static SVGs — same artwork as `@lobehub/icons` without the React package
 * (main entry pulls `IconCombine` → `@lobehub/ui`, which breaks Vite/Rolldown here).
 * @see https://lobehub.com/icons/skill.md
 */
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg";
import deepseekColor from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import googleColor from "@lobehub/icons-static-svg/icons/google-color.svg";
import groq from "@lobehub/icons-static-svg/icons/groq.svg";
import lmstudio from "@lobehub/icons-static-svg/icons/lmstudio.svg";
import metaColor from "@lobehub/icons-static-svg/icons/meta-color.svg";
import mistralColor from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg";
import togetherColor from "@lobehub/icons-static-svg/icons/together-color.svg";
import vllmColor from "@lobehub/icons-static-svg/icons/vllm-color.svg";
import xai from "@lobehub/icons-static-svg/icons/xai.svg";

/** ADE `ProviderFamily` (lowercase) → bundled SVG URL */
export const LOBE_PROVIDER_ICON_SRC: Record<string, string> = {
  anthropic,
  openai,
  google: googleColor,
  mistral: mistralColor,
  deepseek: deepseekColor,
  xai,
  openrouter,
  ollama,
  lmstudio,
  vllm: vllmColor,
  groq,
  together: togetherColor,
  meta: metaColor,
};

export function lobeProviderIconSrc(family: string): string | undefined {
  return LOBE_PROVIDER_ICON_SRC[family.trim().toLowerCase()];
}
