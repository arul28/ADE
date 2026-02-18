import React from "react";
import { Copy } from "lucide-react";

type GitCommandPreviewProps = {
  commands: string[];
  title?: string;
};

export function GitCommandPreview({ commands, title }: GitCommandPreviewProps) {
  const fullText = commands.map((c) => `$ ${c}`).join("\n");

  const handleCopy = () => {
    void navigator.clipboard.writeText(commands.join("\n"));
  };

  return (
    <div className="relative rounded-lg bg-neutral-900 p-3">
      {title && (
        <div className="mb-2 text-xs font-medium text-neutral-400">{title}</div>
      )}
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
        title="Copy commands"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <pre className="font-mono text-xs text-green-400 whitespace-pre-wrap">
        {fullText}
      </pre>
    </div>
  );
}
