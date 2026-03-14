import type { HostedJobType } from "../../../core/src/types";
import { ApiError } from "./http";

const JOB_TYPES: HostedJobType[] = [
  "NarrativeGeneration",
  "ConflictResolution",
  "ProposeConflictResolution",
  "DraftPrDescription"
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, {
      code: "VALIDATION_ERROR",
      message: `${field} must be a string`
    });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApiError(400, {
      code: "VALIDATION_ERROR",
      message: `${field} must not be empty`
    });
  }
  return trimmed;
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function parseJobType(value: unknown): HostedJobType {
  const type = requireString(value, "type") as HostedJobType;
  if (!JOB_TYPES.includes(type)) {
    throw new ApiError(400, {
      code: "VALIDATION_ERROR",
      message: `Unsupported job type '${type}'`
    });
  }
  return type;
}

export function parseSha256(value: unknown, field: string): string {
  const digest = requireString(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ApiError(400, {
      code: "VALIDATION_ERROR",
      message: `${field} must be a 64-character lowercase sha256 hex string`
    });
  }
  return digest;
}
