import type { PushRelayClient } from "../../../../../ade-cli/src/services/push/pushRelayClient";
import { PushRelayRequestError } from "../../../../../ade-cli/src/services/push/pushRelayClient";
import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionPreferences,
  type AttentionPresence,
  type AttentionSnapshot,
} from "../../../shared/types/attention";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import type { Logger } from "../logging/logger";

type AccountAttentionClient = Pick<
  PushRelayClient,
  | "getAttentionSnapshot"
  | "acknowledgeAttention"
  | "reportAttentionPresence"
  | "getAttentionPreferences"
  | "putAttentionPreferences"
>;

type AttentionAccountCoordinatorOptions = {
  getLogger: () => Pick<Logger, "warn">;
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null;
  accountAttentionClient?: AccountAttentionClient | null;
  getCurrentAccountOwnerId: () => string | null;
};

type AttentionSnapshotRequest = {
  since?: unknown;
  streamId?: unknown;
};

type AttentionAcknowledgmentRequest = {
  itemIds?: unknown;
  sourceRevisions?: unknown;
  expectedAccountOwnerId?: unknown;
  seenAt?: unknown;
  dismissedAt?: unknown;
};

type AttentionPreferenceRequest = {
  accountOwnerId?: unknown;
};

type AttentionPreferenceUpdateRequest = AttentionPreferenceRequest & {
  preferences?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class AttentionAccountCoordinator {
  private loggedRuntimeCompatibilityFailure = false;
  private lastSnapshotScope: AttentionSnapshot["scope"] | null = null;
  private lastSnapshotAccountOwnerId: string | null = null;
  private readonly lastMachineItemRevisions = new Map<string, number>();

  constructor(private readonly options: AttentionAccountCoordinatorOptions) {}

  async getSnapshot(input: unknown): Promise<AttentionSnapshot> {
    const request = isRecord(input) ? input as AttentionSnapshotRequest : {};
    const since = Number.isFinite(Number(request.since))
      ? Math.max(0, Math.trunc(Number(request.since)))
      : 0;
    const streamId =
      typeof request.streamId === "string" && request.streamId.trim()
        ? request.streamId.trim()
        : null;
    const accountOwnerId = this.currentAccountOwnerId();
    let accountFailure: unknown = null;

    if (accountOwnerId && this.options.accountAttentionClient) {
      try {
        const snapshot = await this.options.accountAttentionClient.getAttentionSnapshot(
          since,
          streamId,
        );
        if (snapshot) {
          const accountSnapshot: AttentionSnapshot = {
            ...snapshot,
            scope: "account",
            accountOwnerId,
            availability: {
              state: "ready",
              title: "Account Attention is live",
              message: "Work from every signed-in ADE machine is available.",
              recovery: null,
            },
          };
          this.rememberSnapshot(accountSnapshot, accountOwnerId);
          return accountSnapshot;
        }
      } catch (error) {
        accountFailure = error;
        this.options.getLogger().warn("attention.account_snapshot_failed", {
          error: error instanceof Error ? error.message : String(error),
          fallback: "local_machine",
        });
      }
    }

    if (this.options.localRuntimeConnectionPool) {
      try {
        const snapshot =
          await this.options.localRuntimeConnectionPool.callAttention<AttentionSnapshot>(
            "getMachineSnapshot",
            {},
          );
        const machineName = snapshot.machines?.[0]?.name?.trim() || "this computer";
        const accountAvailability = accountFailure
          ? this.describeAccountFailure(accountFailure)
          : null;
        const machineSnapshot: AttentionSnapshot = {
          ...snapshot,
          scope: "machine",
          accountOwnerId,
          availability: accountOwnerId
            ? {
                state: "degraded",
                title: accountAvailability?.title ?? `Showing ${machineName} only`,
                message: accountAvailability
                  ? `${accountAvailability.message} Showing work from ${machineName}.`
                  : (
                      `Account sync is unavailable. Work from ${machineName} remains available; `
                      + "other machines may be missing."
                    ),
                recovery: accountAvailability?.recovery ?? "retry",
                hostName: machineName,
              }
            : {
                state: "signed_out",
                title: `Showing ${machineName}`,
                message: "Sign in to combine Attention across every ADE machine.",
                recovery: "sign_in",
                hostName: machineName,
              },
        };
        this.rememberSnapshot(machineSnapshot, accountOwnerId);
        return machineSnapshot;
      } catch (error) {
        const compatibilityMessage = this.describeRuntimeCompatibilityFailure(error);
        if (compatibilityMessage) {
          throw new Error(
            accountFailure
              ? (
                  "Account Attention could not connect, and this computer cannot provide a fallback. "
                  + compatibilityMessage
                )
              : compatibilityMessage,
          );
        }
        if (!accountFailure) throw error;
      }
    }

    if (accountFailure) {
      const presentation = this.describeAccountFailure(accountFailure);
      throw new Error(
        `${presentation.title}. ${presentation.message} `
        + "No safe machine-scoped fallback is available on this computer.",
      );
    }
    throw new Error(
      "Attention cannot reach this computer's ADE brain. Restart ADE on this computer, then try again.",
    );
  }

  async acknowledge(input: unknown): Promise<void> {
    const request = isRecord(input) ? input as AttentionAcknowledgmentRequest : {};
    const itemIds = Array.isArray(request.itemIds)
      ? request.itemIds
        .filter((value): value is string =>
          typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
        .slice(0, 64)
      : [];
    if (itemIds.length === 0) {
      throw new Error("At least one Attention item id is required.");
    }
    const acknowledgment = {
      itemIds,
      ...(typeof request.seenAt === "string" ? { seenAt: request.seenAt } : {}),
      ...(request.dismissedAt === null || typeof request.dismissedAt === "string"
        ? { dismissedAt: request.dismissedAt }
        : {}),
    };
    const currentAccountOwnerId = this.currentAccountOwnerId();
    if (this.lastSnapshotAccountOwnerId !== currentAccountOwnerId) {
      throw new Error(
        "The ADE account changed after Attention loaded. Refresh Attention, then try again.",
      );
    }
    if (this.lastSnapshotScope === "machine") {
      const sourceRevisions = isRecord(request.sourceRevisions)
        ? Object.fromEntries(
            Object.entries(request.sourceRevisions)
              .filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
          )
        : {};
      const staleItemIds = itemIds.filter((itemId) =>
        sourceRevisions[itemId] !== this.lastMachineItemRevisions.get(itemId));
      if (staleItemIds.length > 0) {
        throw new Error(
          "This machine can only acknowledge the exact item revision that was loaded. Refresh and try again.",
        );
      }
      const requestedAccountOwnerId =
        request.expectedAccountOwnerId === null
        || typeof request.expectedAccountOwnerId === "string"
          ? request.expectedAccountOwnerId?.trim() || null
          : undefined;
      if (
        requestedAccountOwnerId === undefined
        || requestedAccountOwnerId !== this.lastSnapshotAccountOwnerId
      ) {
        throw new Error(
          "The machine Attention account scope changed after this item loaded. Refresh and try again.",
        );
      }
      if (!this.options.localRuntimeConnectionPool) {
        throw new Error("Machine Attention is unavailable until this computer's ADE brain is ready.");
      }
      await this.options.localRuntimeConnectionPool.callAttention<void>(
        "acknowledge",
        {
          ...acknowledgment,
          scope: "machine",
          sourceRevisions,
          expectedAccountOwnerId: requestedAccountOwnerId,
        },
      );
      return;
    }
    if (this.lastSnapshotScope !== "account") {
      throw new Error("Refresh Attention before acknowledging this item.");
    }
    if (currentAccountOwnerId && this.options.accountAttentionClient) {
      await this.options.accountAttentionClient.acknowledgeAttention(acknowledgment);
      return;
    }
    throw new Error("Sign in again, refresh Attention, then try to acknowledge this item.");
  }

  async reportPresence(input: unknown): Promise<void> {
    const presence = isRecord(input) ? input : null;
    if (!presence || typeof presence.deviceId !== "string" || !presence.deviceId.trim()) {
      throw new Error("A valid Attention presence payload is required.");
    }
    if (this.currentAccountOwnerId() && this.options.accountAttentionClient) {
      await this.options.accountAttentionClient.reportAttentionPresence(
        presence as AttentionPresence,
      );
      return;
    }
    if (this.options.localRuntimeConnectionPool) {
      await this.options.localRuntimeConnectionPool.callAttention<void>(
        "reportPresence",
        presence as AttentionPresence & Record<string, unknown>,
      );
    }
  }

  async getPreferences(input: unknown): Promise<AttentionPreferences> {
    const request = isRecord(input) ? input as AttentionPreferenceRequest : {};
    const accountOwnerId = this.requireCurrentAccountOwner(request.accountOwnerId);
    if (this.options.accountAttentionClient) {
      return await this.options.accountAttentionClient.getAttentionPreferences(accountOwnerId)
        ?? DEFAULT_ATTENTION_PREFERENCES;
    }
    if (!this.options.localRuntimeConnectionPool) return DEFAULT_ATTENTION_PREFERENCES;
    return await this.options.localRuntimeConnectionPool.callAttention<AttentionPreferences>(
      "getPreferences",
      { accountOwnerId },
    );
  }

  async putPreferences(input: unknown): Promise<void> {
    const request = isRecord(input) ? input as AttentionPreferenceUpdateRequest : null;
    if (!request || !isRecord(request.preferences)) {
      throw new Error("A valid Attention preferences payload is required.");
    }
    const accountOwnerId = this.requireCurrentAccountOwner(request.accountOwnerId);
    if (this.options.accountAttentionClient) {
      await this.options.accountAttentionClient.putAttentionPreferences(
        accountOwnerId,
        request.preferences as AttentionPreferences,
      );
      return;
    }
    if (!this.options.localRuntimeConnectionPool) {
      throw new Error("Account Attention is unavailable until this computer's ADE brain is ready.");
    }
    await this.options.localRuntimeConnectionPool.callAttention<void>(
      "putPreferences",
      {
        accountOwnerId,
        preferences: request.preferences,
      },
    );
  }

  private currentAccountOwnerId(): string | null {
    return this.options.getCurrentAccountOwnerId()?.trim() || null;
  }

  private rememberSnapshot(
    snapshot: AttentionSnapshot,
    accountOwnerId: string | null,
  ): void {
    this.lastSnapshotScope = snapshot.scope ?? null;
    this.lastSnapshotAccountOwnerId = accountOwnerId;
    this.lastMachineItemRevisions.clear();
    if (snapshot.scope === "machine") {
      for (const item of snapshot.items) {
        this.lastMachineItemRevisions.set(item.id, item.revision);
      }
    }
  }

  private requireCurrentAccountOwner(value: unknown): string {
    const accountOwnerId = typeof value === "string" ? value.trim() : "";
    if (!accountOwnerId) {
      throw new Error("A valid Attention account owner is required.");
    }
    if (this.currentAccountOwnerId() !== accountOwnerId) {
      throw new Error("The ADE account changed before Attention preferences could be used.");
    }
    return accountOwnerId;
  }

  private describeRuntimeCompatibilityFailure(error: unknown): string | null {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/method attention\.call failed.*code -32601|method not found|domain ['"]attention['"] is unavailable|action ['"]attention\./i
        .test(message)
    ) {
      return null;
    }
    if (!this.loggedRuntimeCompatibilityFailure) {
      this.loggedRuntimeCompatibilityFailure = true;
      this.options.getLogger().warn("attention.runtime_incompatible", {
        reason: message.slice(0, 2_000),
        recovery: "update_and_restart_ade_brain",
      });
    }
    return (
      "Account Attention requires a newer connected ADE brain. "
      + "Update and restart ADE on the host machine so the notch can receive account-wide work."
    );
  }

  private describeAccountFailure(
    error: unknown,
  ): Pick<NonNullable<AttentionSnapshot["availability"]>, "title" | "message" | "recovery"> {
    if (error instanceof PushRelayRequestError && error.status === 401) {
      return {
        title: "Account session needs attention",
        message:
          "ADE could not verify your account after refreshing the session. "
          + "Sign out and back in to restore account-wide Attention.",
        recovery: "sign_in",
      };
    }
    if (error instanceof PushRelayRequestError && error.status === 503) {
      return {
        title: "Account Attention is temporarily unavailable",
        message:
          "ADE's account service is not ready. Machine-scoped work remains available while it recovers.",
        recovery: "retry",
      };
    }
    return {
      title: "Account Attention is reconnecting",
      message:
        "ADE cannot reach the account stream right now. Machine-scoped work remains available.",
      recovery: "retry",
    };
  }
}
