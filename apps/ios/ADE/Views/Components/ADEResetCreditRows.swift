import SwiftUI

// The banked reset-credit rows, in one place.
//
// Two surfaces spend a reset credit — the Work Limits module and the Settings
// Usage page — and they used to carry a line-for-line copy of the row, the
// spend state, and the spend call. Two copies of a mutation is two chances to
// drift: one surface gaining a confirmation, a haptic, or a fixed capability
// gate while the other quietly keeps the old behaviour. The row lives here so
// both call sites are one line and one edit reaches both.

/// The accounts on `provider` that have a credit banked.
///
/// Codex and Claude both grant banked reset credits; a provider that does not,
/// or a host that predates the `resetCredits` field, gets an empty list and
/// renders nothing. A macOS host withholds Claude's control because its OAuth
/// token lives in the Keychain, which ADE will not read unattended.
func resetCreditAccounts(
  in snapshot: MobileUsageQuotaSnapshot,
  provider: String
) -> [MobileUsageAccount] {
  (snapshot.accounts ?? []).filter {
    $0.provider == provider && ($0.resetCredits?.availableCount ?? 0) > 0
  }
}

/// One row per account with a credit banked: who it belongs to, and the way to
/// spend it.
///
/// A banked credit with no way to spend it is the state this row removes. The
/// outcome replaces the button rather than sitting beside it: the credit is
/// gone either way, and a live button invites a second spend.
///
/// Outcomes are keyed by account, not held view-wide — a provider can expose
/// more than one banked credit, and a single outcome would wrongly replace
/// every account's button after one spend.
struct ADEResetCreditRows: View {
  /// Accounts on this provider with a credit banked. Empty renders nothing.
  let accounts: [MobileUsageAccount]

  @EnvironmentObject private var syncService: SyncService
  @State private var spendingAccountIds: Set<String> = []
  @State private var resetOutcomes: [String: String] = [:]

  var body: some View {
    ForEach(accounts) { account in
      HStack(spacing: 6) {
        Text("Reset credit banked")
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textSecondary)
        Text(account.email ?? account.label ?? account.id)
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer(minLength: 4)
        if let outcome = workUsageResetOutcome(accountId: account.id, outcomes: resetOutcomes) {
          Text(outcome)
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
        } else if syncService.canInvokeRemoteAction("usage.consumeResetCredit") {
          Button("Use reset") {
            Task { await spendResetCredit(accountId: account.id) }
          }
          .buttonStyle(.plain)
          .font(ADEUsageType.microFont(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .disabled(spendingAccountIds.contains(account.id))
          .adeTapTarget(visual: 16)
          .accessibilityHint("Clears this account's limit windows now.")
        } else {
          Text("Use reset on the host device.")
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
        }
      }
      .frame(minHeight: 44)
    }
  }

  /// The host names the outcome; the phone only phrases it — the same helper
  /// the chat's reset-credit notice uses, so one server answer never reads two
  /// different ways across the surfaces that can spend a credit. A reset that
  /// did not happen is never reported as one.
  @MainActor
  private func spendResetCredit(accountId: String) async {
    spendingAccountIds.insert(accountId)
    resetOutcomes[accountId] = nil
    defer { spendingAccountIds.remove(accountId) }
    do {
      let result = try await syncService.consumeUsageResetCredit(accountId: accountId)
      resetOutcomes[accountId] = workResetCreditOutcomeText(result)
    } catch {
      ADEHaptics.error()
      resetOutcomes[accountId] = error.localizedDescription
    }
  }
}
