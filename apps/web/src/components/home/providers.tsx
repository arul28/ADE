import claudeColor from "@lobehub/icons-static-svg/icons/claude-color.svg";
import codexColor from "@lobehub/icons-static-svg/icons/codex-color.svg";
import cursorMono from "@lobehub/icons-static-svg/icons/cursor.svg";
import opencodeMono from "@lobehub/icons-static-svg/icons/opencode.svg";
import metaColor from "@lobehub/icons-static-svg/icons/meta-color.svg";
import copilotMono from "@lobehub/icons-static-svg/icons/githubcopilot.svg";
import grokMono from "@lobehub/icons-static-svg/icons/grok.svg";
import kimiColor from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import qwenColor from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import openrouterMono from "@lobehub/icons-static-svg/icons/openrouter.svg";
import ollamaMono from "@lobehub/icons-static-svg/icons/ollama.svg";
import lmstudioMono from "@lobehub/icons-static-svg/icons/lmstudio.svg";
import deepseekColor from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import x_anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg";
import x_openai from "@lobehub/icons-static-svg/icons/openai.svg";
import x_gemini_color from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import x_vertexai_color from "@lobehub/icons-static-svg/icons/vertexai-color.svg";
import x_bedrock_color from "@lobehub/icons-static-svg/icons/bedrock-color.svg";
import x_azure_color from "@lobehub/icons-static-svg/icons/azure-color.svg";
import x_mistral_color from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import x_xai from "@lobehub/icons-static-svg/icons/xai.svg";
import x_groq from "@lobehub/icons-static-svg/icons/groq.svg";
import x_moonshot from "@lobehub/icons-static-svg/icons/moonshot.svg";
import x_zhipu_color from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import x_minimax_color from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import x_cohere_color from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import x_perplexity_color from "@lobehub/icons-static-svg/icons/perplexity-color.svg";
import x_together_color from "@lobehub/icons-static-svg/icons/together-color.svg";
import x_fireworks_color from "@lobehub/icons-static-svg/icons/fireworks-color.svg";
import x_cerebras_color from "@lobehub/icons-static-svg/icons/cerebras-color.svg";
import x_huggingface_color from "@lobehub/icons-static-svg/icons/huggingface-color.svg";
import x_nvidia_color from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import x_deepinfra_color from "@lobehub/icons-static-svg/icons/deepinfra-color.svg";
import x_baseten from "@lobehub/icons-static-svg/icons/baseten.svg";
import x_novita_color from "@lobehub/icons-static-svg/icons/novita-color.svg";
import x_siliconcloud_color from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg";
import x_vercel from "@lobehub/icons-static-svg/icons/vercel.svg";
import x_cloudflare_color from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import x_github from "@lobehub/icons-static-svg/icons/github.svg";
import x_zai from "@lobehub/icons-static-svg/icons/zai.svg";
import x_inference from "@lobehub/icons-static-svg/icons/inference.svg";
import x_upstage_color from "@lobehub/icons-static-svg/icons/upstage-color.svg";
import x_nebius from "@lobehub/icons-static-svg/icons/nebius.svg";
import x_friendli from "@lobehub/icons-static-svg/icons/friendli.svg";
import x_morph_color from "@lobehub/icons-static-svg/icons/morph-color.svg";
import x_inception from "@lobehub/icons-static-svg/icons/inception.svg";
import piMono from "../../assets/providers/pi.svg";
import droidMark from "../../assets/providers/droid.svg";
import devinMark from "../../assets/providers/devin.svg";
import { cn } from "../../lib/cn";

/**
 * Every provider ADE runs, with the same marks the desktop app uses
 * (`@lobehub/icons` plus three local files copied from
 * `apps/desktop/src/renderer/assets/provider-logos`). A "mono" mark is a
 * single-colour glyph drawn as a CSS mask so it paints white on the dark page;
 * the rest are full-colour images.
 */
export type Provider = {
  id: string;
  name: string;
  src: string;
  mono?: boolean;
  /** Where the agent runs from: its own SDK/CLI, or the Agent Client Protocol. */
  kind: "agent" | "source";
};

export const AGENTS: Provider[] = [
  { id: "claude", name: "Claude Code", src: claudeColor, kind: "agent" },
  { id: "codex", name: "Codex", src: codexColor, kind: "agent" },
  { id: "cursor", name: "Cursor", src: cursorMono, mono: true, kind: "agent" },
  { id: "opencode", name: "OpenCode", src: opencodeMono, mono: true, kind: "agent" },
  { id: "copilot", name: "GitHub Copilot", src: copilotMono, mono: true, kind: "agent" },
  { id: "droid", name: "Factory Droid", src: droidMark, kind: "agent" },
  { id: "muse", name: "Muse Code", src: metaColor, kind: "agent" },
  { id: "grok", name: "Grok", src: grokMono, mono: true, kind: "agent" },
  { id: "pi", name: "Pi", src: piMono, mono: true, kind: "agent" },
  { id: "devin", name: "Devin", src: devinMark, kind: "agent" },
  { id: "kimi", name: "Kimi", src: kimiColor, kind: "agent" },
  { id: "qwen", name: "Qwen Code", src: qwenColor, kind: "agent" },
];

export const MODEL_SOURCES: Provider[] = [
  { id: "openrouter", name: "OpenRouter", src: openrouterMono, mono: true, kind: "source" },
  { id: "deepseek", name: "DeepSeek", src: deepseekColor, kind: "source" },
  { id: "ollama", name: "Ollama", src: ollamaMono, mono: true, kind: "source" },
  { id: "lmstudio", name: "LM Studio", src: lmstudioMono, mono: true, kind: "source" },
];

export const ALL_PROVIDERS = [...AGENTS, ...MODEL_SOURCES];

/**
 * Model providers a user can connect through ADE's OpenCode harness (the
 * models.dev catalog), shown only in the opening logo cloud.
 */
export const OPENCODE_PROVIDERS: Provider[] = [
  { id: "x-anthropic", name: "Anthropic", src: x_anthropic, mono: true, kind: "source" },
  { id: "x-openai", name: "OpenAI", src: x_openai, mono: true, kind: "source" },
  { id: "x-gemini-color", name: "Google Gemini", src: x_gemini_color, kind: "source" },
  { id: "x-vertexai-color", name: "Google Vertex AI", src: x_vertexai_color, kind: "source" },
  { id: "x-bedrock-color", name: "Amazon Bedrock", src: x_bedrock_color, kind: "source" },
  { id: "x-azure-color", name: "Azure OpenAI", src: x_azure_color, kind: "source" },
  { id: "x-mistral-color", name: "Mistral", src: x_mistral_color, kind: "source" },
  { id: "x-xai", name: "xAI", src: x_xai, mono: true, kind: "source" },
  { id: "x-groq", name: "Groq", src: x_groq, mono: true, kind: "source" },
  { id: "x-moonshot", name: "Moonshot AI", src: x_moonshot, mono: true, kind: "source" },
  { id: "x-zhipu-color", name: "Zhipu AI", src: x_zhipu_color, kind: "source" },
  { id: "x-minimax-color", name: "MiniMax", src: x_minimax_color, kind: "source" },
  { id: "x-cohere-color", name: "Cohere", src: x_cohere_color, kind: "source" },
  { id: "x-perplexity-color", name: "Perplexity", src: x_perplexity_color, kind: "source" },
  { id: "x-together-color", name: "Together AI", src: x_together_color, kind: "source" },
  { id: "x-fireworks-color", name: "Fireworks AI", src: x_fireworks_color, kind: "source" },
  { id: "x-cerebras-color", name: "Cerebras", src: x_cerebras_color, kind: "source" },
  { id: "x-huggingface-color", name: "Hugging Face", src: x_huggingface_color, kind: "source" },
  { id: "x-nvidia-color", name: "NVIDIA", src: x_nvidia_color, kind: "source" },
  { id: "x-deepinfra-color", name: "DeepInfra", src: x_deepinfra_color, kind: "source" },
  { id: "x-baseten", name: "Baseten", src: x_baseten, mono: true, kind: "source" },
  { id: "x-novita-color", name: "Novita AI", src: x_novita_color, kind: "source" },
  { id: "x-siliconcloud-color", name: "SiliconFlow", src: x_siliconcloud_color, kind: "source" },
  { id: "x-vercel", name: "Vercel AI Gateway", src: x_vercel, mono: true, kind: "source" },
  { id: "x-cloudflare-color", name: "Cloudflare Workers AI", src: x_cloudflare_color, kind: "source" },
  { id: "x-github", name: "GitHub Models", src: x_github, mono: true, kind: "source" },
  { id: "x-zai", name: "Z.ai", src: x_zai, mono: true, kind: "source" },
  { id: "x-inference", name: "Inference.net", src: x_inference, mono: true, kind: "source" },
  { id: "x-upstage-color", name: "Upstage", src: x_upstage_color, kind: "source" },
  { id: "x-nebius", name: "Nebius", src: x_nebius, mono: true, kind: "source" },
  { id: "x-friendli", name: "Friendli", src: x_friendli, mono: true, kind: "source" },
  { id: "x-morph-color", name: "Morph", src: x_morph_color, kind: "source" },
  { id: "x-inception", name: "Inception", src: x_inception, mono: true, kind: "source" },
];

export function providerById(id: string): Provider {
  const found = ALL_PROVIDERS.find((p) => p.id === id) ?? OPENCODE_PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown provider ${id}`);
  return found;
}

export function ProviderMark({ provider, className }: { provider: Provider; className?: string }) {
  if (provider.mono) {
    return (
      <span
        role="img"
        aria-label={provider.name}
        className={cn("block bg-white", className)}
        style={{
          WebkitMaskImage: `url(${provider.src})`,
          maskImage: `url(${provider.src})`,
          WebkitMaskSize: "contain",
          maskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
        }}
      />
    );
  }
  return <img src={provider.src} alt={provider.name} className={cn("block object-contain", className)} draggable={false} />;
}

/** A logo on a rounded glass tile, the unit every section builds from. */
export function ProviderTile({
  provider,
  size = 56,
  className,
}: {
  provider: Provider;
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid place-items-center rounded-[28%] border border-white/12 bg-[#15151d]/90 shadow-[0_10px_30px_rgba(0,0,0,0.45)] backdrop-blur",
        className,
      )}
      style={{ width: size, height: size }}
      title={provider.name}
    >
      <ProviderMark provider={provider} className="h-[52%] w-[52%]" />
    </div>
  );
}
