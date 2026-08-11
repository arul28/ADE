/**
 * LobeHub static SVGs — same artwork as `@lobehub/icons` without the React package
 * (main entry pulls `IconCombine` → `@lobehub/ui`, which breaks Vite/Rolldown here).
 * @see https://lobehub.com/icons/skill.md
 */
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg";
import azureColor from "@lobehub/icons-static-svg/icons/azure-color.svg";
import baseten from "@lobehub/icons-static-svg/icons/baseten.svg";
import bedrockColor from "@lobehub/icons-static-svg/icons/bedrock-color.svg";
import cerebrasColor from "@lobehub/icons-static-svg/icons/cerebras-color.svg";
import cloudflareColor from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import cohereColor from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import deepseekColor from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import fireworksColor from "@lobehub/icons-static-svg/icons/fireworks-color.svg";
import googleColor from "@lobehub/icons-static-svg/icons/google-color.svg";
import groq from "@lobehub/icons-static-svg/icons/groq.svg";
import huggingfaceColor from "@lobehub/icons-static-svg/icons/huggingface-color.svg";
import kimiColor from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import lmstudio from "@lobehub/icons-static-svg/icons/lmstudio.svg";
import metaColor from "@lobehub/icons-static-svg/icons/meta-color.svg";
import minimaxColor from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistralColor from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import moonshot from "@lobehub/icons-static-svg/icons/moonshot.svg";
import nvidiaColor from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg";
import perplexityColor from "@lobehub/icons-static-svg/icons/perplexity-color.svg";
import qwenColor from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import togetherColor from "@lobehub/icons-static-svg/icons/together-color.svg";
import vercel from "@lobehub/icons-static-svg/icons/vercel.svg";
import xai from "@lobehub/icons-static-svg/icons/xai.svg";
import xiaomimimo from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import zai from "@lobehub/icons-static-svg/icons/zai.svg";

/** ADE `ProviderFamily` (lowercase) → bundled SVG URL */
export const LOBE_PROVIDER_ICON_SRC: Record<string, string> = {
  anthropic,
  openai,
  google: googleColor,
  "google-vertex": googleColor,
  "google-vertex-anthropic": googleColor,
  mistral: mistralColor,
  deepseek: deepseekColor,
  xai,
  grok: xai,
  openrouter,
  ollama,
  lmstudio,
  groq,
  together: togetherColor,
  togetherai: togetherColor,
  meta: metaColor,
  // Pi ships roughly forty providers, most of which fell through to a grey
  // letter avatar. These are the same LobeHub marks, keyed by the ids Pi and
  // OpenCode actually use — including their regional and plan variants.
  cerebras: cerebrasColor,
  fireworks: fireworksColor,
  baseten,
  nvidia: nvidiaColor,
  huggingface: huggingfaceColor,
  cohere: cohereColor,
  perplexity: perplexityColor,
  minimax: minimaxColor,
  "minimax-cn": minimaxColor,
  moonshotai: moonshot,
  "moonshotai-cn": moonshot,
  moonshot,
  kimi: kimiColor,
  "kimi-coding": kimiColor,
  "kimi-for-coding": kimiColor,
  zai,
  "zai-coding-cn": zai,
  zhipu: zai,
  "qwen-token-plan": qwenColor,
  "qwen-token-plan-cn": qwenColor,
  qwen: qwenColor,
  xiaomi: xiaomimimo,
  "xiaomi-token-plan-ams": xiaomimimo,
  "xiaomi-token-plan-cn": xiaomimimo,
  "xiaomi-token-plan-sgp": xiaomimimo,
  "amazon-bedrock": bedrockColor,
  bedrock: bedrockColor,
  "azure-openai-responses": azureColor,
  azure: azureColor,
  "cloudflare-ai-gateway": cloudflareColor,
  "cloudflare-workers-ai": cloudflareColor,
  cloudflare: cloudflareColor,
  "vercel-ai-gateway": vercel,
  vercel,
};

export function lobeProviderIconSrc(family: string): string | undefined {
  return LOBE_PROVIDER_ICON_SRC[family.trim().toLowerCase()];
}
