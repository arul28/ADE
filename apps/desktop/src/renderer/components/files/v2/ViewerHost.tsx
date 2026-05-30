import React from "react";
import { COLORS } from "../../lanes/laneDesignTokens";
import type { MonacoModelRegistry } from "../monacoModelRegistry";
import type { EditorTab } from "./editorGroupsStore";
import { useFileContent } from "./useFileContent";
import { CodeViewer } from "./viewers/CodeViewer";
import { ImageViewer } from "./viewers/ImageViewer";
import { MarkdownViewer } from "./viewers/MarkdownViewer";
import { CsvViewer } from "./viewers/CsvViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { LargeTextViewer } from "./viewers/LargeTextViewer";
import { BinaryViewer } from "./viewers/BinaryViewer";
import type { EditorApi, EditorThemeMode, ViewerProps } from "./viewers/types";

export type ViewerHostProps = {
  workspaceId: string;
  rootPath: string;
  tab: EditorTab;
  canEdit: boolean;
  theme: EditorThemeMode;
  registry: MonacoModelRegistry;
  reloadToken?: number;
  onDirtyChange?: (path: string, dirty: boolean) => void;
  onEdit?: (path: string) => void;
  onRegisterEditorApi?: (path: string, api: EditorApi | null) => void;
};

/**
 * Resolve the active tab's viewer from its kind and render it with the loaded
 * file content. Replaces FilesPage's hardcoded if/else preview surface.
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
    readOnly: !props.canEdit || tab.viewerKind !== "code",
    theme: props.theme,
    registry: props.registry,
    onDirtyChange: props.onDirtyChange,
    onEdit: props.onEdit,
    onRegisterEditorApi: props.onRegisterEditorApi,
  };

  // Non-code viewers carry per-file view state (zoom, page, scroll), so key them
  // by path to reset on file change. CodeViewer is intentionally NOT keyed: one
  // stable Monaco instance per group re-binds models via the registry, so tab
  // switches are an instant setModel rather than an editor rebuild.
  switch (tab.viewerKind) {
    case "image":
      return <ImageViewer key={tab.path} {...viewerProps} />;
    case "markdown":
      return <MarkdownViewer key={tab.path} {...viewerProps} />;
    case "csv":
      return <CsvViewer key={tab.path} {...viewerProps} />;
    case "pdf":
      return <PdfViewer key={tab.path} {...viewerProps} />;
    case "largeText":
      return <LargeTextViewer key={tab.path} {...viewerProps} />;
    case "binary":
      return <BinaryViewer key={tab.path} {...viewerProps} />;
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
