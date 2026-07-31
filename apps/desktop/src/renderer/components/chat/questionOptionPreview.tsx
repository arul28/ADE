import { ChatMarkdown } from "./chatMarkdown";

// Wireframe / ASCII previews must render in a true monospace block with columns
// preserved; piping them through proportional markdown collapses the alignment.
// Genuine markdown previews still get the rich, code-fence-aware pipeline.
const WIREFRAME_CHARS = /[│┌┐└┘├┤┬┴┼─━┃┏┓┗┛┣┫┳┻╋╭╮╰╯║╔╗╚╝╠╣╦╩╬▸▹◂◃▪▫■□●○◦◆◇]/;

export function looksLikeWireframe(text: string): boolean {
  if (WIREFRAME_CHARS.test(text)) return true;
  const lines = text.split("\n");
  if (lines.length < 2) return false;
  const indented = lines.filter((line) => /^\s{2,}\S/.test(line)).length;
  return indented >= 2;
}

export function QuestionOptionPreview({
  preview,
  previewFormat,
}: {
  preview: string;
  previewFormat?: "markdown" | "html";
}) {
  const monospace = previewFormat === "html" || looksLikeWireframe(preview);
  if (monospace) {
    return (
      <pre className="m-0 whitespace-pre font-mono text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.55] text-fg/72 [tab-size:2]">
        {preview}
      </pre>
    );
  }
  return (
    <div className="max-w-none text-[length:calc(var(--chat-font-size)*11.5/14)] [&_p]:my-1">
      <ChatMarkdown>{preview}</ChatMarkdown>
    </div>
  );
}
