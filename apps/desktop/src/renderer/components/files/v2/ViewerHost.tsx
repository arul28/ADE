import React from "react";
import { COLORS } from "../../lanes/laneDesignTokens";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
import type { EditorTab } from "./editorGroupsStore";
import { useFileContent } from "./useFileContent";
import { tabIsTextEditable } from "./viewerRegistry";
import { CodeViewer } from "./viewers/CodeViewer";
import { ImageViewer } from "./viewers/ImageViewer";
import { MarkdownViewer } from "./viewers/MarkdownViewer";
import { CsvViewer } from "./viewers/CsvViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { MediaViewer } from "./viewers/MediaViewer";
import { DocumentViewer } from "./viewers/DocumentViewer";
import { LargeTextViewer } from "./viewers/LargeTextViewer";
import { BinaryViewer } from "./viewers/BinaryViewer";
import type { EditorApi, EditorThemeMode, ViewerProps } from "./viewers/types";

export type ViewerHostProps = {
  workspaceId: string;
  rootPath: string;
  tab: EditorTab;
  theme: EditorThemeMode;
  registry: MonacoModelRegistry;
  reloadToken?: number;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
  onEdit?: (tabId: string) => void;
  onRegisterEditorApi?: (tabId: string, api: EditorApi | null) => void;
  onError?: (message: string) => void;
};

/**
 * Resolve the active tab's viewer from its kind and render it with the loaded
 * file content for the active workbench tab.
 */
export function ViewerHost(props: ViewerHostProps) {
  const { workspaceId, tab, reloadToken = 0 } = props;
  const contentState = useFileContent(workspaceId, tab.path, reloadToken);

  if (contentState.status === "loading") {
    return <Centered>Loading {tab.title}…</Centered>;
  }
  if (contentState.status === "error") {
    return <Centered tone="danger">Couldn't open {tab.title}: {contentState.error}</Centered>;
  }

  const viewerProps: ViewerProps = {
    workspaceId,
    rootPath: props.rootPath,
    tab,
    content: contentState.content,
    // Read-only only when the payload can't round-trip as text (partial stream,
    // binary, base64) — never as a trust/permission gate on writable text files.
    readOnly: !tabIsTextEditable(tab.viewerKind, contentState.content),
    theme: props.theme,
    registry: props.registry,
    onDirtyChange: props.onDirtyChange,
    onEdit: props.onEdit,
    onRegisterEditorApi: props.onRegisterEditorApi,
    onError: props.onError,
  };

  // Non-code viewers carry per-tab view state (zoom, page, scroll), so key them
  // by tab id to reset when the active tab identity changes. CodeViewer is
  // intentionally NOT keyed: one stable Monaco instance per group re-binds
  // models via the registry, so tab switches are an instant setModel rather than
  // an editor rebuild.
  switch (tab.viewerKind) {
    case "image":
      return <ImageViewer key={tab.id} {...viewerProps} />;
    case "markdown":
      return <MarkdownViewer key={tab.id} {...viewerProps} />;
    case "csv":
      return <CsvViewer key={tab.id} {...viewerProps} />;
    case "pdf":
      return <PdfViewer key={tab.id} {...viewerProps} />;
    case "audio":
      return <MediaViewer key={tab.id} {...viewerProps} kind="audio" />;
    case "video":
      return <MediaViewer key={tab.id} {...viewerProps} kind="video" />;
    case "document":
      return <DocumentViewer key={tab.id} {...viewerProps} />;
    case "largeText":
      return <LargeTextViewer key={tab.id} {...viewerProps} />;
    case "binary":
      return <BinaryViewer key={tab.id} {...viewerProps} />;
    case "code":
    default:
      return <CodeViewer {...viewerProps} />;
  }
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "danger" }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm" style={{ color: tone === "danger" ? COLORS.danger : COLORS.textDim }}>
      {children}
    </div>
  );
}
