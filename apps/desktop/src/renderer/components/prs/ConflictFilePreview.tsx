import React from "react";
import { Warning, Code, File, FileTs, FileJs, FileCss, FileJsx, FilePy, FileHtml } from "@phosphor-icons/react";

type ConflictFile = {
  path: string;
  conflictMarkers: string;
  oursExcerpt: string | null;
  theirsExcerpt: string | null;
  diffHunk: string | null;
};

function getFileIcon(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const iconMap: Record<string, React.ElementType> = {
    ts: FileTs,
    tsx: FileTs,
    js: FileJs,
    jsx: FileJsx,
    css: FileCss,
    scss: FileCss,
    py: FilePy,
    html: FileHtml,
    htm: FileHtml,
  };
  return iconMap[ext] ?? File;
}

function getLanguageHint(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript/JSX",
    js: "JavaScript",
    jsx: "JavaScript/JSX",
    css: "CSS",
    scss: "SCSS",
    py: "Python",
    html: "HTML",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    md: "Markdown",
    rs: "Rust",
    go: "Go",
    java: "Java",
    swift: "Swift",
  };
  return langMap[ext] ?? null;
}

export function ConflictFilePreview({ file }: { file: ConflictFile }) {
  const [showRawMarkers, setShowRawMarkers] = React.useState(false);
  const FileIcon = getFileIcon(file.path);
  const langHint = getLanguageHint(file.path);
  const hasDetailContent = file.oursExcerpt || file.theirsExcerpt || file.diffHunk || file.conflictMarkers;

  return (
    <div
      style={{
        background: "#0C0A10",
        border: "1px solid #1E1B26",
        marginBottom: 8,
      }}
    >
      {/* File path header */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: "8px 12px",
          borderBottom: hasDetailContent ? "1px solid #1E1B26" : "none",
          background: "#13101A",
        }}
      >
        <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
          <FileIcon size={16} weight="duotone" style={{ color: "#F59E0B", flexShrink: 0 }} />
          <span
            className="font-mono font-semibold truncate"
            style={{ fontSize: 12, color: "#FAFAFA" }}
          >
            {file.path}
          </span>
          {langHint && (
            <span
              className="font-mono font-bold uppercase tracking-[1px]"
              style={{
                fontSize: 8,
                padding: "1px 5px",
                background: "#A78BFA12",
                color: "#A78BFA",
                border: "1px solid #A78BFA20",
                flexShrink: 0,
              }}
            >
              {langHint}
            </span>
          )}
        </div>
        <div className="flex items-center" style={{ gap: 6, flexShrink: 0 }}>
          <Warning size={12} weight="fill" style={{ color: "#F59E0B" }} />
          <span
            className="font-mono font-bold uppercase tracking-[1px]"
            style={{ fontSize: 8, color: "#F59E0B" }}
          >
            CONFLICT
          </span>
          {file.conflictMarkers && (
            <button
              type="button"
              className="flex items-center font-mono font-bold uppercase tracking-[1px] transition-colors duration-100"
              style={{
                fontSize: 9,
                padding: "2px 8px",
                background: showRawMarkers ? "#A78BFA18" : "transparent",
                color: showRawMarkers ? "#A78BFA" : "#52525B",
                border: `1px solid ${showRawMarkers ? "#A78BFA30" : "#27272A"}`,
                cursor: "pointer",
                marginLeft: 4,
              }}
              onClick={() => setShowRawMarkers(!showRawMarkers)}
            >
              <Code size={10} weight="bold" style={{ marginRight: 4 }} />
              RAW
            </button>
          )}
        </div>
      </div>

      {/* Ours / Theirs side-by-side excerpts */}
      {(file.oursExcerpt || file.theirsExcerpt) && !showRawMarkers && (
        <div style={{ padding: 12 }}>
          <div className="flex" style={{ gap: 8 }}>
            {/* OURS */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="font-mono font-bold uppercase tracking-[1px]"
                style={{
                  fontSize: 9,
                  color: "#22C55E",
                  marginBottom: 6,
                }}
              >
                OURS (current branch)
              </div>
              <pre
                className="font-mono"
                style={{
                  fontSize: 11,
                  lineHeight: "18px",
                  color: "#A1A1AA",
                  padding: "8px 10px",
                  margin: 0,
                  background: "#22C55E08",
                  borderLeft: "2px solid #22C55E40",
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {file.oursExcerpt || "(empty)"}
              </pre>
            </div>

            {/* THEIRS */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="font-mono font-bold uppercase tracking-[1px]"
                style={{
                  fontSize: 9,
                  color: "#EF4444",
                  marginBottom: 6,
                }}
              >
                THEIRS (incoming branch)
              </div>
              <pre
                className="font-mono"
                style={{
                  fontSize: 11,
                  lineHeight: "18px",
                  color: "#A1A1AA",
                  padding: "8px 10px",
                  margin: 0,
                  background: "#EF444408",
                  borderLeft: "2px solid #EF444440",
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {file.theirsExcerpt || "(empty)"}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Diff hunk preview */}
      {file.diffHunk && !showRawMarkers && (
        <div
          style={{
            padding: "0 12px 12px",
          }}
        >
          <div
            className="font-mono font-bold uppercase tracking-[1px]"
            style={{
              fontSize: 9,
              color: "#71717A",
              marginBottom: 6,
            }}
          >
            DIFF HUNK
          </div>
          <pre
            className="font-mono"
            style={{
              fontSize: 11,
              lineHeight: "18px",
              color: "#A1A1AA",
              padding: "8px 10px",
              margin: 0,
              background: "#0F0D14",
              border: "1px solid #1E1B26",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {file.diffHunk.split("\n").map((line, i) => {
              let lineColor = "#A1A1AA";
              if (line.startsWith("+")) lineColor = "#22C55E";
              else if (line.startsWith("-")) lineColor = "#EF4444";
              else if (line.startsWith("@@")) lineColor = "#A78BFA";
              return (
                <span key={i} style={{ color: lineColor, display: "block" }}>
                  {line}
                </span>
              );
            })}
          </pre>
        </div>
      )}

      {/* Raw conflict markers (toggle) */}
      {showRawMarkers && file.conflictMarkers && (
        <div style={{ padding: 12 }}>
          <div
            className="font-mono font-bold uppercase tracking-[1px]"
            style={{
              fontSize: 9,
              color: "#F59E0B",
              marginBottom: 6,
            }}
          >
            CONFLICT MARKERS
          </div>
          <pre
            className="font-mono"
            style={{
              fontSize: 11,
              lineHeight: "18px",
              color: "#A1A1AA",
              padding: "8px 10px",
              margin: 0,
              background: "#F59E0B06",
              border: "1px solid #F59E0B15",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {file.conflictMarkers}
          </pre>
        </div>
      )}

      {/* Fallback: path is known but no detail content available */}
      {!hasDetailContent && file.path && (
        <div
          style={{
            padding: "12px",
          }}
        >
          <div className="flex items-center" style={{ gap: 8, marginBottom: 8 }}>
            <span
              className="font-mono font-bold uppercase tracking-[1px]"
              style={{ fontSize: 9, color: "#F59E0B" }}
            >
              BOTH LANES MODIFIED THIS FILE
            </span>
          </div>
          <div
            className="font-mono"
            style={{
              fontSize: 11,
              color: "#71717A",
              padding: "8px 10px",
              background: "#F59E0B06",
              borderLeft: "2px solid #F59E0B30",
            }}
          >
            File modified in both lanes — detailed conflict markers will be available after full simulation with merge replay.
          </div>
        </div>
      )}
    </div>
  );
}
