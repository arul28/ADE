import { useState } from "react";
import { motion } from "motion/react";
import { ArrowSquareOut, FileImage, Image as ImageIcon, XCircle } from "@phosphor-icons/react";
import type { AgentChatEvent } from "../../../../shared/types";
import { ChatStatusGlyph } from "../chatStatusVisuals";
import { cn } from "../../ui/cn";

type ImageGenerationEvent = Extract<AgentChatEvent, { type: "codex_image_generation" }>;

type CodexImageGenerationCardProps = {
  event: ImageGenerationEvent;
};

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const m = trimmed.match(/[^\\/]+$/);
  return m ? m[0] : trimmed;
}

function isHttpOrDataUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^(https?:\/\/|data:)/i.test(value);
}

// Plan §B.4: "no `file://` prefix; renderer must handle this." Codex sometimes
// emits local paths as file:// URLs — `window.ade.app.openPath` expects an OS
// path, so strip the prefix before passing it through.
function stripFileUrlPrefix(value: string | null): string | null {
  if (!value) return value;
  if (!/^file:\/\//i.test(value)) return value;
  return value.replace(/^file:\/\//i, "");
}

export function CodexImageGenerationCard({ event }: CodexImageGenerationCardProps) {
  const isRunning = event.status === "running";
  const isFailed = event.status === "failed";
  const result = event.result ?? null;
  const previewSrc = isHttpOrDataUrl(result) ? result : null;
  const savedPathRaw = event.savedPath ?? (!isHttpOrDataUrl(result) ? result : null);
  const savedPath = stripFileUrlPrefix(savedPathRaw);
  const prompt = (event.prompt ?? "").trim();
  const revised = (event.revisedPrompt ?? "").trim();
  const showRevisedDisclosure = Boolean(revised && revised !== prompt);
  const [revisedOpen, setRevisedOpen] = useState(false);

  const titleText = prompt || revised || (savedPath ? basename(savedPath) : "Generated image");

  const openSaved = () => {
    if (!savedPath) return;
    void window.ade.app.openPath(savedPath).catch(() => undefined);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
      className={cn(
        "overflow-hidden rounded-xl border",
        isFailed
          ? "border-red-400/20 bg-red-950/20"
          : "border-fuchsia-400/15 bg-fuchsia-500/[0.04]",
      )}
    >
      <div className="flex items-start gap-3 px-4 pb-3 pt-3">
        <div className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          isFailed ? "bg-red-500/10" : "bg-fuchsia-500/12",
          isRunning && "ade-glow-pulse",
        )}>
          {isRunning ? (
            <ChatStatusGlyph status="working" size={14} />
          ) : isFailed ? (
            <XCircle size={16} weight="bold" className="text-red-300/85" />
          ) : (
            <ImageIcon size={16} weight="bold" className="text-fuchsia-200/80" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[length:calc(var(--chat-font-size)*12.5/14)] font-semibold tracking-[-0.005em] text-fuchsia-100">
              {isFailed ? "Image generation failed" : isRunning ? "Generating image" : "Image generated"}
            </h3>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.45] text-fg/75">
            {titleText}
          </p>

          {previewSrc ? (
            <div className="mt-3 inline-flex max-w-full rounded-lg border border-fuchsia-400/12 bg-black/30 p-1">
              <img
                src={previewSrc}
                alt={titleText}
                loading="lazy"
                draggable={false}
                className="max-h-60 max-w-full rounded object-contain"
              />
            </div>
          ) : savedPath ? (
            <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-lg border border-fuchsia-400/12 bg-fuchsia-950/15 px-2.5 py-1.5">
              <FileImage size={14} weight="bold" className="shrink-0 text-fuchsia-200/65" />
              <span className="truncate font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/70" title={savedPath}>
                {basename(savedPath)}
              </span>
            </div>
          ) : null}

          {savedPath ? (
            <div className="mt-2.5">
              <button
                type="button"
                onClick={openSaved}
                className="inline-flex items-center gap-1.5 rounded-md border border-fuchsia-400/25 bg-fuchsia-500/12 px-2.5 py-1 text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-fuchsia-100 transition-colors hover:bg-fuchsia-500/20"
              >
                <ArrowSquareOut size={12} weight="bold" />
                Open
              </button>
            </div>
          ) : null}

          {showRevisedDisclosure ? (
            <div className="mt-2.5">
              <button
                type="button"
                onClick={() => setRevisedOpen((v) => !v)}
                className="inline-flex items-center gap-1 text-[length:calc(var(--chat-font-size)*10.5/14)] text-fuchsia-200/55 transition-colors hover:text-fuchsia-100"
                aria-expanded={revisedOpen}
              >
                <span aria-hidden>{revisedOpen ? "▾" : "▸"}</span>
                <span>revised prompt</span>
              </button>
              {revisedOpen ? (
                <p className="mt-1 rounded-md border border-fuchsia-400/10 bg-fuchsia-950/15 px-2.5 py-2 text-[length:calc(var(--chat-font-size)*11/14)] italic leading-[1.5] text-fg/65">
                  {revised}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}

export default CodexImageGenerationCard;
