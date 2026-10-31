import SwiftUI

/// Which login or key a chat runs on, as one quiet row pinned to the bottom of
/// Chat Info. The phone's twin of desktop `ChatAccountNote`
/// (`apps/desktop/src/renderer/components/chat/ChatAccountNote.tsx`).
///
/// The phone reads the account the chat is bound to (its `instanceId`,
/// resolved against the chat machine's account registry). A provider with one
/// identity per machine renders nothing rather than a placeholder.
///
/// On Claude and Codex, when another signed-in account exists, the row opens a
/// menu that moves the chat to that account: same chat, same thread, next turn
/// on the other login.
struct WorkChatAccountNoteModel: Equatable {
  /// Provider family, for the logo.
  var provider: String
  /// Email, "API key", or the account id.
  var primary: String
  /// The account the chat runs on now, when it is a registry account.
  var current: ProviderAccount?
  /// Other signed-in accounts the chat can move to.
  var targets: [ProviderAccount]
}

/// The chat machine's account registry for one provider, and its usage
/// readings when it shared them.
struct WorkChatAccountRegistry: Equatable {
  var accounts: [ProviderAccount]
  var quota: MobileUsageQuotaSnapshot?
}

private func workChatAccountClean(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

func workChatAccountNoteModel(
  provider rawProvider: String?,
  instanceId: String?,
  presetId: String?,
  credentialId: String?,
  accounts: [ProviderAccount]?
) -> WorkChatAccountNoteModel? {
  guard let provider = workChatAccountClean(rawProvider)?.lowercased() else { return nil }
  // A saved key or custom provider pays for the turns: no account to switch.
  if workChatAccountClean(credentialId) != nil {
    return WorkChatAccountNoteModel(provider: provider, primary: "API key", current: nil, targets: [])
  }
  if workChatAccountClean(presetId) != nil {
    return WorkChatAccountNoteModel(provider: provider, primary: "Custom provider", current: nil, targets: [])
  }
  guard ProviderAccountProvider(rawValue: provider) != nil, let accounts else { return nil }
  let forProvider = accounts.filter { $0.provider == provider }
  let boundId = workChatAccountClean(instanceId) ?? provider
  // An id that no longer names an account falls back to the default at launch.
  guard let current = forProvider.first(where: { $0.id == boundId })
    ?? forProvider.first(where: \.isDefault) else { return nil }
  guard let primary = current.email ?? workChatAccountClean(current.label) else { return nil }
  // Copies of one login are one account.
  let targets = forProvider.filter { $0.id != current.id && $0.signedIn && $0.sameLoginAs == nil }
  return WorkChatAccountNoteModel(provider: provider, primary: primary, current: current, targets: targets)
}

/// The tighter of an account's five-hour and weekly room, in percent, when known.
func workChatAccountRoomLeft(_ account: ProviderAccount, quota: MobileUsageQuotaSnapshot?) -> Double? {
  let left = providerAccountWindows(account, snapshot: quota)
    .filter { $0.windowType == "five_hour" || $0.windowType == "weekly" }
    .map { adeUsageDisplayPercentLeft($0) }
  return left.min()
}

struct WorkChatAccountNote: View {
  let provider: String
  let instanceId: String?
  let presetId: String?
  let credentialId: String?
  /// Machine plus provider. A chat switch renders the last answer at once and
  /// reads again behind it, so the row does not blink.
  let cacheKey: String
  /// Reads the chat machine's accounts; nil when that machine cannot list them.
  let loadAccounts: (@MainActor () async throws -> WorkChatAccountRegistry)?
  /// A turn is running; switching waits for it to end.
  var busy = false
  /// Moves the chat; returns the sentence to show when it did not move. Nil
  /// when the chat's machine (or this device's role) cannot switch accounts.
  let onSwitch: (@MainActor (String) async -> String?)?

  @MainActor private static var cache: [String: WorkChatAccountRegistry] = [:]

  @State private var registry: WorkChatAccountRegistry?
  @State private var pendingId: String?
  @State private var errorMessage: String?

  private var resolvedRegistry: WorkChatAccountRegistry? {
    registry ?? Self.cache[cacheKey]
  }

  private var model: WorkChatAccountNoteModel? {
    workChatAccountNoteModel(
      provider: provider,
      instanceId: instanceId,
      presetId: presetId,
      credentialId: credentialId,
      accounts: resolvedRegistry?.accounts
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      // Always present, so the read below runs before there is a row to show.
      Color.clear.frame(height: 0)
      if let model {
        // The divider belongs to the row: a chat with nothing to name leaves
        // no line behind (desktop's footer rule).
        Rectangle()
          .fill(ADEColor.border.opacity(0.35))
          .frame(height: 0.5)
        VStack(alignment: .leading, spacing: 0) {
          if let onSwitch, let current = model.current, !model.targets.isEmpty {
            switcher(model: model, current: current, onSwitch: onSwitch)
          } else {
            row(model: model, switchable: false)
          }
          if let errorMessage {
            Button {
              self.errorMessage = nil
            } label: {
              Label(errorMessage, systemImage: "exclamationmark.circle")
                .font(.caption2)
                .foregroundStyle(ADEColor.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .accessibilityHint("Dismisses the message")
          }
        }
      }
    }
    // Read again when the bound account changes (a move) or the chat does.
    .task(id: "\(cacheKey)|\(instanceId ?? "")") {
      guard let loadAccounts else { return }
      do {
        let next = try await loadAccounts()
        guard !Task.isCancelled else { return }
        Self.cache[cacheKey] = next
        registry = next
      } catch {
        // The row is decoration on a working chat: a failed read leaves the
        // last answer (or nothing) on screen.
      }
    }
  }

  private func row(model: WorkChatAccountNoteModel, switchable: Bool) -> some View {
    HStack(spacing: 8) {
      Group {
        if let asset = providerAssetName(model.provider) {
          ADEProviderMark(assetName: asset, size: 14)
        } else {
          Image(systemName: providerIcon(model.provider))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 14, height: 14)
        }
      }
      .opacity(0.85)
      Text(model.primary)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 8)
      if pendingId != nil {
        ProgressView().controlSize(.mini)
      } else if switchable {
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 16)
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    .contentShape(.rect)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel(model))
  }

  private func accessibilityLabel(_ model: WorkChatAccountNoteModel) -> String {
    let providerName = workChatSurfaceProviderName(model.provider)
    if model.current == nil { return "\(providerName) runs on a \(model.primary.lowercased())" }
    return "Runs on \(providerName) account \(model.primary)"
  }

  private func switcher(
    model: WorkChatAccountNoteModel,
    current: ProviderAccount,
    onSwitch: @escaping @MainActor (String) async -> String?
  ) -> some View {
    let quota = resolvedRegistry?.quota
    return Menu {
      Section("Run this chat on") {
        Button {} label: {
          Label(current.displayName, systemImage: "checkmark")
          if let side = roomLabel(current, quota: quota) { Text(side) }
        }
        ForEach(model.targets) { target in
          Button {
            switchTo(target, onSwitch: onSwitch)
          } label: {
            Text(target.displayName)
            if let side = roomLabel(target, quota: quota) { Text(side) }
          }
          .disabled(busy || pendingId != nil)
        }
      }
      if busy {
        Text("Wait for this turn to finish.")
      }
    } label: {
      row(model: model, switchable: true)
    }
    .buttonStyle(.plain)
    .disabled(pendingId != nil)
    .accessibilityHint("Moves this chat to another account")
    .accessibilityIdentifier("Work.ChatInfo.Account")
  }

  private func roomLabel(_ account: ProviderAccount, quota: MobileUsageQuotaSnapshot?) -> String? {
    workChatAccountRoomLeft(account, quota: quota).map { "\(Int($0.rounded()))% left" }
  }

  private func switchTo(_ target: ProviderAccount, onSwitch: @escaping @MainActor (String) async -> String?) {
    guard !busy, pendingId == nil else { return }
    pendingId = target.id
    errorMessage = nil
    Task { @MainActor in
      errorMessage = await onSwitch(target.id)
      pendingId = nil
    }
  }
}
