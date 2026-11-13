import Combine
import OSLog
import SwiftUI
import UIKit

private let settingsAccountLog = Logger(subsystem: "com.ade.ios", category: "SettingsAccount")

/// Settings › Account: the desktop's Account page (`AccountPage.tsx`) on the
/// phone, in its order. Signed in: who you are, your computers, then the
/// account's details and Sign out (this phone only). Signed out: the sign-in
/// card. The desktop's "This computer" panel and its update-other-machines
/// block have no phone counterpart and are left out.
struct SettingsAccountPage: View {
  let syncService: SyncService
  @ObservedObject var machineController: SettingsMachineController
  let onSignIn: () -> Void
  let machinesPage: () -> AnyView
  let integrationsPage: () -> AnyView
  @ObservedObject private var account = AccountService.shared
  @ObservedObject private var hidden = HiddenMachineStore.shared
  @ObservedObject private var github = GitHubAccountConnection.shared
  @Environment(\.openURL) private var openURL
  @State private var confirmGitHubDisconnect = false
  @State private var githubDisconnecting = false
  /// After a disconnect: where the person can also revoke the App on GitHub.
  @State private var githubRevokeURL: URL?
  @EnvironmentObject private var fleet: MachineFleet
  /// The desktop's "hide this suggestion" for the GitHub row, by the same key.
  @AppStorage("ade.account.repoBridgeDismissed.v1") private var repoBridgeDismissed = false
  @State private var githubNotConnected = false
  @State private var showIntegrations = false
  @State private var confirmSignOut = false
  @State private var signingOut = false
  @State private var copiedAccountId = false
  /// The account's invite summary, read only with ADE Cloud (`cloud.read referral`).
  @State private var referral: CloudPhoneReferral?

  /// "Were you invited?" (desktop `AccountInviteFact`): for 30 days after the
  /// account was made, while it has no referrer, and only with ADE Cloud.
  @ViewBuilder
  private var inviteSection: some View {
    if let referral, referral.offersCodeBox, syncService.cloudAvailable, syncService.cloudSupported {
      ADESettingsSection(
        "Invite",
        hint: "Were you invited? You both get \(cloudHours(referral.rewardMilli)) free cloud hours.\(referral.enterCodeUntil.map { " Add it by \(cloudDate($0))." } ?? "")"
      ) {
        // The box keeps its "Invite added" line; the section is gone on the next visit.
        CloudInviteCodeBox(syncService: syncService, rewardMilli: referral.rewardMilli, onDone: { _ in })
        .adeKitCard()
      }
    }
  }

  var body: some View {
    ADESettingsPage(route: .account) {
      if account.phase == .loading {
        // A cached session is still restoring; do not offer Sign in yet.
        ADESettingsRows {
          ADESettingsLoadingRow(title: "Checking your account…")
        }
      } else if let identity = account.identity, account.phase == .signedIn {
        heroSection(identity)
        githubAccountSection
        computersSection
        detailsSection(identity)
        inviteSection
      } else {
        signedOutPanel
      }
    }
    .navigationDestination(isPresented: $showIntegrations) { integrationsPage() }
    .task(id: githubCheckKey) { await loadGitHub() }
    .task(id: account.phase == .signedIn) {
      if account.phase == .signedIn { await github.refreshStatus() }
    }
    .confirmationDialog("Disconnect GitHub from ADE?", isPresented: $confirmGitHubDisconnect, titleVisibility: .visible) {
      Button("Disconnect", role: .destructive) {
        Task {
          githubDisconnecting = true
          githubRevokeURL = await github.disconnect()
          githubDisconnecting = false
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Your devices and computers stop using this GitHub sign-in. Computers with their own GitHub CLI sign-in or token keep using it.")
    }
    // The invite box is part of ADE Cloud: no read, and no box, without access.
    .task(id: syncService.cloudAvailable && syncService.cloudSupported) {
      referral = await syncService.readCloudReferral()
    }
    .confirmationDialog("Sign out of ADE?", isPresented: $confirmSignOut, titleVisibility: .visible) {
      Button("Sign out", role: .destructive) {
        Task {
          signingOut = true
          await account.signOut()
          signingOut = false
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Signing out removes this \(UIDevice.current.model)'s access to your account and its account-connected machines. Devices paired directly with a code stay connected.")
    }
  }

  // MARK: Who you are

  private func heroSection(_ identity: AccountIdentity) -> some View {
    ADESettingsRows {
      SettingsGeneralLeadRow(
        title: identity.displayName,
        subtitle: identity.email == identity.displayName ? nil : identity.email
      ) {
        AccountAvatar(identity: identity)
      } trailing: {
        ADEKitTag(text: identity.providerLabel)
      }
    }
  }

  // MARK: Your computers

  private var accountMachines: [SettingsMachine] {
    settingsMachines(syncService: syncService, account: account, fleet: fleet, hidden: hidden)
      .filter { $0.account != nil }
  }

  private var computersSection: some View {
    let machines = accountMachines
    return ADESettingsSection(
      "Your computers",
      hint: "Every computer signed in to this account. Open one to see how it connects and what's signed in on it.",
      symbol: "desktopcomputer",
      tint: .blue
    ) {
      ADESettingsRows {
        if machines.isEmpty {
          switch account.machinesState {
          case .idle, .loading:
            HStack { ProgressView().controlSize(.small) }
              .frame(maxWidth: .infinity, minHeight: 48)
          case .unconfigured:
            ADESettingsRow("This build has no account directory", hint: "Pair a computer with a code from Machines.")
          case .unreachable(let message):
            ADESettingsRow("Couldn't load your computers", hint: message)
          case .loaded:
            ADESettingsRow("No computers yet", hint: "Sign in to ADE on a computer and it shows here.")
          }
        }
        ForEach(machines) { machine in
          NavigationLink {
            SettingsMachinePage(syncService: syncService, controller: machineController, machineId: machine.id)
          } label: {
            SettingsMachineRow(
              machine: machine,
              busy: machineController.busyMachineIds.contains(machine.id),
              error: machineController.errors[machine.id],
              onConnect: { machineController.connect(machine) },
              onRetry: { machineController.retry(machine) }
            )
          }
          .buttonStyle(ADEKitRowButtonStyle())
        }
        // The desktop's "Manage connections".
        ADESettingsPageLink(title: SettingsRoute.machines.title, destination: machinesPage) { _, pushes in
          ADESettingsRow(title: "Manage connections", symbol: SettingsRoute.machines.symbol, tint: SettingsRoute.machines.tint) {
            if pushes { ADESettingsChevron() }
          }
        }
      }
    }
    .task { await account.loadMachines() }
  }

  // MARK: Account

  private func detailsSection(_ identity: AccountIdentity) -> some View {
    ADESettingsSection("Account", symbol: SettingsRoute.account.symbol, tint: .violet) {
      ADESettingsRows {
        ADESettingsRow(
          title: "Email",
          hint: "Signed in with \(identity.providerLabel)",
          symbol: "at",
          sizesControlFirst: false
        ) {
          Text(identity.email ?? "Your ADE account")
            .font(.system(size: 14))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        if !identity.userId.isEmpty {
          ADESettingsRow(title: "Account ID", symbol: "person.text.rectangle", sizesControlFirst: false) {
            HStack(spacing: 8) {
              Text(identity.userId)
                .font(.adeMono(12))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
              Button {
                UIPasteboard.general.string = identity.userId
                copiedAccountId = true
                Task { @MainActor in
                  try? await Task.sleep(nanoseconds: 1_500_000_000)
                  copiedAccountId = false
                }
              } label: {
                Image(systemName: copiedAccountId ? "checkmark" : "doc.on.doc")
                  .font(.system(size: 13, weight: .semibold))
              }
              .buttonStyle(.borderless)
              .accessibilityLabel(copiedAccountId ? "Copied" : "Copy account ID")
            }
          }
        }
        if githubNotConnected && !repoBridgeDismissed && github.state == .unsupported {
          // The phone cannot connect GitHub; Integrations says where to.
          ADESettingsNotice(
            message: "GitHub is not connected on \(syncService.machineDisplayName). Lanes, pull requests and checks need it.",
            tone: .neutral,
            actionTitle: "Open Integrations",
            action: { showIntegrations = true },
            dismiss: { repoBridgeDismissed = true }
          )
          .padding(ADEKit.inset)
        }
        Button {
          confirmSignOut = true
        } label: {
          ADESettingsRow(
            title: "Sign out of this \(UIDevice.current.model)",
            hint: "Signing out only affects this \(UIDevice.current.model). Your computers and other devices stay signed in.",
            symbol: "rectangle.portrait.and.arrow.right",
            titleColor: ADEColor.danger,
            tint: .red
          ) {
            if signingOut { ProgressView().controlSize(.small) }
          }
        }
        .buttonStyle(ADEKitRowButtonStyle())
        .disabled(signingOut)
      }
    }
  }

  // MARK: GitHub (the account's sign-in)

  /// The account's GitHub sign-in (spec 3.9). Hidden with an account
  /// directory that has no GitHub App routes: then the machine notice below
  /// says where to connect, as before.
  @ViewBuilder
  private var githubAccountSection: some View {
    switch github.state {
    case .signedOut, .unsupported:
      EmptyView()
    default:
      ADESettingsSection(
        "GitHub",
        hint: "Pull requests and repositories on every device, with no computer on. ADE renews the sign-in for you.",
        symbol: "arrow.triangle.pull",
        tint: .slate
      ) {
        ADESettingsRows {
          githubAccountRow
          if let githubRevokeURL, github.state == .notConnected {
            ADESettingsNotice(
              message: "GitHub is disconnected from ADE. To also remove ADE's access on GitHub, revoke it there.",
              tone: .neutral,
              actionTitle: "Revoke on GitHub",
              action: { openURL(githubRevokeURL) },
              dismiss: { self.githubRevokeURL = nil }
            )
            .padding(ADEKit.inset)
          }
          if let problem = github.problem {
            ADESettingsNotice(message: problem, tone: .crit)
              .padding(ADEKit.inset)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var githubAccountRow: some View {
    switch github.state {
    case .unknown:
      ADESettingsLoadingRow(title: "Checking GitHub…")
    case .connected(let login):
      ADESettingsRow(title: "Connected as @\(login)", symbol: "checkmark.seal", tint: .green) {
        Button(githubDisconnecting ? "Disconnecting…" : "Disconnect") { confirmGitHubDisconnect = true }
          .buttonStyle(ADEKitButtonStyle())
          .disabled(githubDisconnecting)
      }
    case .needsReauth:
      githubConnectRow(
        title: "GitHub connection ended",
        hint: "Connect GitHub again to keep working with pull requests.",
        symbol: "exclamationmark.triangle",
        tint: .amber
      )
    case .unavailable(let retryAt):
      ADESettingsRow(
        "GitHub isn't answering",
        hint: retryAt.map { "GitHub isn't answering right now. ADE tries again at \($0.formatted(date: .omitted, time: .shortened))." }
          ?? "GitHub isn't answering right now. ADE tries again soon.",
        symbol: "clock",
        tint: .slate
      )
    default:
      githubConnectRow(
        title: "Not connected",
        hint: "Connect GitHub to see pull requests from this phone.",
        symbol: "link",
        tint: .slate
      )
    }
  }

  /// A GitHub state with Connect GitHub under its text. Beside the text, the
  /// wide button cut the title and hint to "…" on a small phone.
  private func githubConnectRow(title: String, hint: String, symbol: String, tint: ADESettingsTint) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      ADESettingsRow(title, hint: hint, symbol: symbol, tint: tint)
      githubConnectButton
        // Under the text, past the 28 pt icon tile and its 12 pt gap.
        .padding(.leading, ADEKit.inset + 40)
        .padding(.bottom, 12)
    }
  }

  private var githubConnectButton: some View {
    Button {
      githubRevokeURL = nil
      Task { await github.connect() }
    } label: {
      HStack(spacing: 6) {
        if github.connecting { ProgressView().controlSize(.mini).tint(.white) }
        Text(github.connecting ? "Connecting…" : "Connect GitHub")
      }
    }
    .buttonStyle(ADEKitButtonStyle(prominent: true))
    .disabled(github.connecting)
  }

  // MARK: GitHub (the machine)

  /// GitHub status is read from the primary machine's open project.
  private var githubCheckKey: String {
    [
      account.phase == .signedIn ? "in" : "out",
      syncService.connectionState.rawValue,
      syncService.activeProjectId ?? "",
    ].joined(separator: "|")
  }

  private func loadGitHub() async {
    githubNotConnected = false
    guard account.phase == .signedIn,
          !repoBridgeDismissed,
          syncService.connectionState == .connected,
          syncService.activeProject != nil,
          syncService.supportsRemoteAction("github.getStatus") else { return }
    do {
      let status = try await syncService.fetchGitHubSettingsStatus()
      guard !Task.isCancelled else { return }
      githubNotConnected = IntegrationSummary(github: status) == .notConnected
    } catch {
      // A new check cancels this one; that is not a failure.
      guard !Task.isCancelled else { return }
      // The notice stays hidden; the log says why.
      settingsAccountLog.warning("github status check failed: \(error.localizedDescription, privacy: .public)")
    }
  }

  /// Signed out: the desktop's sign-in card. The empty avatar, what an
  /// account gives you, and one wide Sign in, centred in one panel.
  private var signedOutPanel: some View {
    VStack(spacing: 14) {
      Image(systemName: "person.fill")
        .font(.system(size: 30, weight: .medium))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 72, height: 72)
        .background(ADEKit.track, in: Circle())
        .overlay(Circle().strokeBorder(ADEKit.rule, lineWidth: 1))
        .accessibilityHidden(true)
      VStack(spacing: 6) {
        Text("Sign in to ADE")
          .font(.system(size: 19, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(account.isConfigured
          ? "Sign in to reach your machines from any network and keep your settings on every device."
          : "Account sign-in isn't available in this build. Pair a computer with a code instead.")
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      if account.isConfigured {
        Button("Sign in", action: onSignIn)
          .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
          .padding(.top, 4)
        Text("Sign in to use ADE Relay.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 22)
    .padding(.vertical, 26)
    .frame(maxWidth: .infinity)
    .adeKitCard(padding: nil)
  }
}

/// The root list's account row: avatar, name and email, opening Account. A
/// sidebar row, so on the Duo's two columns it fills the right column
/// instead of pushing.
struct SettingsAccountHeaderLink<Destination: View>: View {
  let identity: AccountIdentity
  @ViewBuilder var destination: () -> Destination

  var body: some View {
    ADESettingsPageLink(title: SettingsRoute.account.title, shape: .sidebar, destination: destination) { _, pushes in
      label(pushes: pushes)
    }
  }

  private func label(pushes: Bool) -> some View {
    HStack(spacing: 12) {
      AccountAvatar(identity: identity)
      VStack(alignment: .leading, spacing: 2) {
        Text(identity.displayName)
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let email = identity.email {
          Text(email)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 8)
      if pushes {
        ADESettingsChevron()
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .accessibilityElement(children: .combine)
    .accessibilityHint("Opens Account.")
  }
}
