import type { AdeUsageClientSurface } from "../../../../desktop/src/shared/types";

type PrepareProductAnalyticsRemoteCommandArgs = {
  action: string;
  args: Record<string, unknown>;
  surface: AdeUsageClientSurface;
  projectId: string | null;
  clientEnabled: boolean;
};

export type PreparedProductAnalyticsRemoteCommand = {
  args: Record<string, unknown>;
  clientEnabled: boolean;
  captureDisabled: boolean;
};

/** Apply peer-scoped consent and bind untrusted analytics identity fields. */
export function prepareProductAnalyticsRemoteCommand(
  input: PrepareProductAnalyticsRemoteCommandArgs,
): PreparedProductAnalyticsRemoteCommand {
  if (input.action === "analytics.setClientEnabled") {
    if (typeof input.args.enabled !== "boolean") {
      throw new Error("analytics.setClientEnabled requires a boolean enabled value.");
    }
    return {
      args: input.args,
      clientEnabled: input.args.enabled,
      captureDisabled: false,
    };
  }
  if (input.action !== "analytics.capture") {
    return {
      args: input.args,
      clientEnabled: input.clientEnabled,
      captureDisabled: false,
    };
  }
  const {
    projectId: _untrustedProjectId,
    surface: _untrustedSurface,
    dedupeKey: clientDedupeKey,
    ...safeArgs
  } = input.args;
  return {
    args: {
      ...safeArgs,
      surface: input.surface,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.args.event === "ade_project_opened" && input.projectId
        ? { dedupeKey: `${input.surface}_project_opened:${input.projectId}` }
        : { dedupeKey: clientDedupeKey }),
    },
    clientEnabled: input.clientEnabled,
    captureDisabled: !input.clientEnabled,
  };
}
