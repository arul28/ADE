import type { FileContent } from "../../../../shared/types";
import type { SyncFileBlob } from "../../../../shared/types/sync";
import type { AdeSyncClient, SupportedFileAction } from "../../sync";
import type { AdapterProjectState } from "./projectState";

export function fileContentFromBlob(blob: SyncFileBlob): FileContent {
  return {
    content: blob.content,
    encoding: blob.encoding,
    size: blob.size,
    languageId: blob.languageId ?? "plaintext",
    isBinary: blob.isBinary,
    previewKind: blob.previewKind,
    mimeType: blob.mimeType,
    dataUrl: blob.dataUrl,
    contentOmitted: blob.contentOmitted,
    omittedReason: blob.omittedReason,
    totalSize: blob.size,
  };
}

export function dataUrlFromBlob(blob: SyncFileBlob): string | null {
  if (blob.dataUrl) return blob.dataUrl;
  if (blob.encoding === "base64") {
    return `data:${blob.mimeType ?? "application/octet-stream"};base64,${blob.content}`;
  }
  return null;
}

export async function requestFileBlob(
  client: AdeSyncClient,
  state: AdapterProjectState,
  action: SupportedFileAction,
  args: Record<string, unknown>,
  timeoutMs?: number
): Promise<SyncFileBlob> {
  return (await client.requestFile(action, args as never, {
    projectId: state.getProjectId(),
    timeoutMs,
  })) as SyncFileBlob;
}

export async function requestDataUrl(
  client: AdeSyncClient,
  state: AdapterProjectState,
  action: SupportedFileAction,
  args: Record<string, unknown>
): Promise<string | null> {
  const blob = await requestFileBlob(client, state, action, args);
  return dataUrlFromBlob(blob);
}
