import type { CursorSdkErrorDetail } from "./cursorSdkProtocol";
import { classifyCursorSdkErrorText } from "./cursorSdkProtocol";

type CursorSdkRunLike = {
  agentId: string;
  id: string;
  requestId?: unknown;
  error?: unknown;
};

type CursorSdkRunStoreLike = {
  runs?: {
    get?(args: { agentId: string; runId: string }): Promise<{
      error?: string | null;
      requestId?: string | null;
    } | null | undefined>;
  };
  getRun?(agentId: string, runId: string): Promise<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toJsonRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  const toJSON = (record as { toJSON?: () => unknown } | null)?.toJSON;
  if (typeof toJSON !== "function") return null;
  try {
    return asRecord(toJSON.call(value));
  } catch {
    return null;
  }
}

function readStringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumberField(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBooleanField(record: Record<string, unknown> | null, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function sdkErrorDetail(error: unknown): CursorSdkErrorDetail | undefined {
  if (error == null) return undefined;
  const record = asRecord(error);
  const json = toJsonRecord(error);
  const rawMessage = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : typeof error === "string"
        ? error
        : undefined;
  const code = readStringField(record, "code") ?? readStringField(json, "code");
  const status = readNumberField(record, "status") ?? readNumberField(json, "status");
  const isRetryable = readBooleanField(record, "isRetryable") ?? readBooleanField(json, "isRetryable");
  const requestId = readStringField(record, "requestId") ?? readStringField(json, "requestId");
  const operation = readStringField(record, "operation") ?? readStringField(json, "operation");
  const endpoint = readStringField(record, "endpoint") ?? readStringField(json, "endpoint");
  const detail: CursorSdkErrorDetail = {
    ...(rawMessage?.trim() ? { message: rawMessage.trim() } : {}),
    ...(code ? { code } : {}),
    ...(status != null ? { status } : {}),
    ...(isRetryable != null ? { isRetryable } : {}),
    ...(requestId ? { requestId } : {}),
    ...(operation ? { operation } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(error instanceof Error && error.name && error.name !== "Error" ? { name: error.name } : {}),
  };
  return Object.keys(detail).length ? detail : undefined;
}

export function sdkErrorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  const json = toJsonRecord(error);
  const code = record?.code ?? json?.code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

function mergeErrorDetail(
  ...details: Array<CursorSdkErrorDetail | undefined>
): CursorSdkErrorDetail | undefined {
  const merged: CursorSdkErrorDetail = {};
  for (const detail of details) {
    if (!detail) continue;
    if (!merged.message && detail.message) merged.message = detail.message;
    if (!merged.code && detail.code) merged.code = detail.code;
    if (merged.status == null && detail.status != null) merged.status = detail.status;
    if (merged.isRetryable == null && detail.isRetryable != null) merged.isRetryable = detail.isRetryable;
    if (!merged.requestId && detail.requestId) merged.requestId = detail.requestId;
    if (!merged.operation && detail.operation) merged.operation = detail.operation;
    if (!merged.endpoint && detail.endpoint) merged.endpoint = detail.endpoint;
    if (!merged.name && detail.name) merged.name = detail.name;
  }
  return Object.keys(merged).length ? merged : undefined;
}

function detailTexts(detail: CursorSdkErrorDetail | undefined): string[] {
  if (!detail) return [];
  return [
    detail.message,
    detail.code,
    detail.name,
    detail.operation,
    detail.endpoint,
    detail.status != null ? String(detail.status) : undefined,
  ].filter((value): value is string => Boolean(value));
}

export function cursorSdkStreamFailureDetail(
  detail: CursorSdkErrorDetail | undefined,
  runtime: "local" | "cloud",
): CursorSdkErrorDetail {
  const fallbackMessage = runtime === "cloud"
    ? "Cursor SDK cloud stream failed."
    : "Cursor SDK local stream failed.";
  return {
    ...(detail ?? {}),
    message: detail?.message?.trim() || fallbackMessage,
    code: detail?.code?.trim() || "stream_error",
  };
}

export function cursorSdkResultWithStreamFailure<T>(
  result: T,
  detail: CursorSdkErrorDetail | undefined,
  runtime: "local" | "cloud",
): T {
  if (!detail) return result;
  const record = asRecord(result);
  if (!record || record.status === "error") return result;
  const failure = cursorSdkStreamFailureDetail(detail, runtime);
  return {
    ...record,
    status: "error",
    error: {
      message: failure.message ?? "Cursor SDK stream failed.",
      ...(failure.code ? { code: failure.code } : {}),
    },
  } as T;
}

function runResultErrorDetail(result: unknown): CursorSdkErrorDetail | undefined {
  const record = asRecord(result);
  const error = asRecord(record?.error);
  const message = readStringField(error, "message");
  const code = readStringField(error, "code");
  const requestId = readStringField(record, "requestId");
  const detail: CursorSdkErrorDetail = {
    ...(message ? { message } : {}),
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
  };
  return Object.keys(detail).length ? detail : undefined;
}

export async function readCursorSdkRunFailureDetail(args: {
  run: CursorSdkRunLike | null;
  result?: unknown;
  extraDetail?: CursorSdkErrorDetail;
  store?: CursorSdkRunStoreLike | null;
  onStoreReadError?: (error: unknown, run: CursorSdkRunLike) => void;
}): Promise<{ errorCode?: string; errorDetail?: CursorSdkErrorDetail }> {
  const { run, result, extraDetail, store, onStoreReadError } = args;
  const resultDetail = runResultErrorDetail(result);
  const runErrorDetail = sdkErrorDetail(run?.error);
  let storeDetail: CursorSdkErrorDetail | undefined;
  const readRun = store?.runs?.get;
  if (run && (readRun || store?.getRun)) {
    try {
      const record = readRun
        ? await readRun.call(store?.runs, { agentId: run.agentId, runId: run.id })
        : await store?.getRun?.(run.agentId, run.id);
      if (record) {
        const recordData = asRecord(record);
        const errorMessage =
          readStringField(recordData, "error")
          ?? readStringField(recordData, "errorMessage");
        const errorCode = readStringField(recordData, "errorCode");
        const requestId = readStringField(recordData, "requestId");
        storeDetail = {
          ...(errorMessage ? { message: errorMessage } : {}),
          ...(errorCode ? { code: errorCode } : {}),
          ...(requestId ? { requestId } : {}),
        };
      }
    } catch (error) {
      onStoreReadError?.(error, run);
    }
  }
  const requestDetail: CursorSdkErrorDetail | undefined =
    typeof run?.requestId === "string" && run.requestId.trim()
      ? { requestId: run.requestId.trim() }
      : undefined;
  const merged = mergeErrorDetail(resultDetail, runErrorDetail, storeDetail, extraDetail, requestDetail);
  let code = merged?.code?.trim();
  const classification = classifyCursorSdkErrorText(...detailTexts(merged));
  if (!code && classification.kind !== "unknown") {
    code = classification.kind === "rate_limit" ? "rate_limited" : classification.kind;
  }
  if (!code && storeDetail?.message) code = storeDetail.message;
  return {
    ...(code ? { errorCode: code } : {}),
    ...(merged ? { errorDetail: merged } : {}),
  };
}
