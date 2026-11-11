import OSLog
import SwiftUI

private let settingsIntegrationsLog = Logger(subsystem: "com.ade.ios", category: "SettingsIntegrations")

/// Settings › Integrations: what the connected machine is connected to, in the
/// desktop's order (`integrations/IntegrationsHome.tsx`): GitHub, Linear and
/// Jira, then Webhooks. Each status is read on that machine, where its
/// credentials live. Linear connects from the phone through the same screen
/// the Linear pane uses; GitHub and Jira connect on the computer, so their
/// cards only show where they stand. ADE Cloud has its own Settings row
/// (`SettingsRoute.adeCloud`), as on the desktop.
struct SettingsIntegrationsPage: View {
  let syncService: SyncService
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared

  @State private var github: IntegrationSummary = .checking
  @State private var githubRepo: String?
  @State private var jira: IntegrationSummary = .checking
  /// Linear's own status lives on `SyncService` (the Work pane reads it too),
  /// so a connect or disconnect on the pushed screen shows here on return.
  @State private var linearChecked = false

  private var connected: Bool { syncService.connectionState == .connected }
  private var machine: String { syncService.machineDisplayName }
  private var hasProject: Bool { syncService.activeProjectId != nil }

  var body: some View {
    ADESettingsPage(route: .integrations) {
      if !connected {
        ADESettingsNotice(message: SettingsPageCopy.connectMachine)
      } else {
        if !hasProject {
          // Said once here; the three project cards below then show only a
          // quiet status row, not the same warning three times.
          ADESettingsNotice(message: "GitHub, Linear and Jira follow the open project. Open a project to see them.", tone: .neutral)
        }
        githubSection
        linearSection
        jiraSection
        webhooksSection
      }
    }
    // One read per card, side by side: a slow GitHub check never holds up Jira.
    .task(id: connected) { if connected { await loadGitHub() } }
    .task(id: connected) { if connected { await loadLinear() } }
    .task(id: connected) { if connected { await loadJira() } }
  }

  // MARK: - GitHub

  private var githubSection: some View {
    SettingsIntegrationCard(
      name: "GitHub",
      tagline: "Open, review and merge pull requests, follow checks, and work on issues.",
      status: projectStatus(github, readBy: "github.getStatus")
    ) {
      ADEBrandTile(brand: .github, size: 42)
    } rows: {
      updateNotice(readBy: "github.getStatus")
      if hasProject, let githubRepo {
        ADESettingsValueRow(title: "Repository", value: githubRepo, mono: true)
      }
      if hasProject, github == .notConnected {
        ADESettingsRow("Connect on your computer", hint: "Settings › Integrations › GitHub")
      }
    }
  }

  // MARK: - Linear

  private var linearStatus: LinearConnectionStatus? { syncService.linearConnectionStatus }

  private var linear: IntegrationSummary {
    guard linearChecked else { return .checking }
    guard let status = linearStatus, status.connected else { return .notConnected }
    let workspace = [status.organizationName, status.organizationUrlKey]
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty }
    return IntegrationSummary(label: workspace.map { "Connected to \($0)" } ?? "Connected", tone: .ok)
  }

  /// The phone can sign in to Linear (OAuth or an API key) or sign it out.
  private var canManageLinear: Bool {
    syncService.supportsRemoteAction("cto.startLinearMobileOAuth")
      || syncService.supportsViewerRemoteAction("cto.setLinearToken")
      || (linearStatus?.connected == true && syncService.supportsViewerRemoteAction("cto.clearLinearToken"))
  }

  private var linearSection: some View {
    SettingsIntegrationCard(
      name: "Linear",
      tagline: "Start lanes from Linear issues, link them to PRs, and let your team assign work to ADE.",
      status: projectStatus(linear, readBy: "cto.getLinearConnectionStatus")
    ) {
      ADEBrandTile(brand: .linear, size: 42)
    } rows: {
      updateNotice(readBy: "cto.getLinearConnectionStatus")
      if hasProject, linearChecked {
        if canManageLinear {
          ADESettingsLink(
            title: linearStatus?.connected == true ? "Manage Linear" : "Connect Linear",
            symbol: "link",
            tint: .violet
          ) {
            SettingsLinearConnectionPage(syncService: syncService)
          }
        } else if linearStatus?.connected != true {
          ADESettingsRow("Connect on your computer", hint: "Settings › Integrations › Linear")
        }
      }
    }
  }

  // MARK: - Jira

  private var jiraSection: some View {
    SettingsIntegrationCard(
      name: "Jira",
      tagline: "Bring a Jira Cloud site's issues into ADE and tie them to this project.",
      status: projectStatus(jira, readBy: "jira.getConnectionStatus")
    ) {
      ADEBrandTile(brand: .jira, size: 42)
    } rows: {
      updateNotice(readBy: "jira.getConnectionStatus")
      if hasProject, jira == .notConnected {
        ADESettingsRow("Connect on your computer", hint: "Settings › Integrations › Jira")
      }
    }
  }

  // MARK: - Webhooks

  private var webhooksSection: some View {
    SettingsIntegrationCard(
      name: "Webhooks",
      tagline: "Requests that reach your automations.",
      status: nil
    ) {
      ADESettingsIconTile(symbol: "point.3.connected.trianglepath.dotted", tint: .pink, size: 42)
    } rows: {
      ADESettingsLink(title: "Manage webhooks", symbol: "slider.horizontal.3", tint: .pink) {
        SettingsWebhooksPage(syncService: syncService)
      }
    }
  }

  // MARK: - Status

  /// A card whose status the machine reads in the open project: nil while
  /// the machine is too old to say (the card shows `updateNotice` instead),
  /// "No project open" when there is none (the page says why once, above).
  private func projectStatus(_ summary: IntegrationSummary, readBy action: String) -> IntegrationSummary? {
    guard syncService.supportsRemoteAction(action) else { return nil }
    return hasProject ? summary : IntegrationSummary(label: "No project open", tone: .neutral)
  }

  /// "Update ADE" on a card whose status the machine is too old to read.
  @ViewBuilder
  private func updateNotice(readBy action: String) -> some View {
    if !syncService.supportsRemoteAction(action) {
      ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
        .padding(ADEKit.inset)
    }
  }

  // MARK: - Loading

  private func loadGitHub() async {
    guard hasProject, syncService.supportsRemoteAction("github.getStatus") else { return }
    do {
      let status = try await syncService.fetchGitHubSettingsStatus()
      github = IntegrationSummary(github: status)
      githubRepo = status.repo.map { "\($0.owner)/\($0.name)" }
    } catch {
      settingsIntegrationsLog.warning("GitHub status read failed: \(error.localizedDescription, privacy: .public)")
      github = .couldNotCheck
    }
  }

  private func loadLinear() async {
    guard hasProject, syncService.supportsRemoteAction("cto.getLinearConnectionStatus") else { return }
    await syncService.refreshLinearConnection()
    linearChecked = true
  }

  private func loadJira() async {
    guard hasProject, syncService.supportsRemoteAction("jira.getConnectionStatus") else { return }
    do {
      jira = IntegrationSummary(jira: try await syncService.fetchJiraSettingsStatus())
    } catch {
      settingsIntegrationsLog.warning("Jira status read failed: \(error.localizedDescription, privacy: .public)")
      jira = .couldNotCheck
    }
  }
}

/// One integration as one card (desktop `IntegrationsHome` rows): its logo
/// tile, name, status and what it is for, then the card's own rows.
struct SettingsIntegrationCard<Mark: View, Rows: View>: View {
  let name: String
  let tagline: String
  let status: IntegrationSummary?
  @ViewBuilder var mark: () -> Mark
  @ViewBuilder var rows: () -> Rows

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top, spacing: 14) {
        mark()
        VStack(alignment: .leading, spacing: 4) {
          Text(name)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if let status {
            ADESettingsStatus(text: status.label, tone: status.tone, checking: status == .checking, truncates: true)
          }
          Text(tagline)
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }
      .padding(ADEKit.inset)
      .accessibilityElement(children: .combine)
      Group(subviews: rows()) { subviews in
        ForEach(subviews) { subview in
          ADESettingsHairline()
          subview
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeKitCard(padding: nil)
  }
}

/// One integration's status line, in the desktop's words.
struct IntegrationSummary: Equatable {
  var label: String
  var tone: ADEKitTone

  static let checking = IntegrationSummary(label: "Checking…", tone: .neutral)
  static let notConnected = IntegrationSummary(label: "Not connected", tone: .neutral)
  static let needsAttention = IntegrationSummary(label: "Needs attention", tone: .warn)
  static let couldNotCheck = IntegrationSummary(label: "Couldn't check", tone: .neutral)

  /// "Connected as arul28", or why not.
  init(github status: SettingsGitHubStatus) {
    if status.connected == true {
      let login = status.userLogin?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      self.init(label: login.isEmpty ? "Connected" : "Connected as \(login)", tone: .ok)
    } else {
      self = status.needsAttention ? .needsAttention : .notConnected
    }
  }

  /// "Connected to acme.atlassian.net", or why not.
  init(jira status: SettingsJiraStatus) {
    if status.error != nil {
      self = .needsAttention
    } else if status.connected {
      let site = (status.siteUrl ?? "")
        .replacingOccurrences(of: "https://", with: "")
        .replacingOccurrences(of: "http://", with: "")
        .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      self.init(label: site.isEmpty ? "Connected" : "Connected to \(site)", tone: .ok)
    } else {
      self = .notConnected
    }
  }

  init(label: String, tone: ADEKitTone) {
    self.label = label
    self.tone = tone
  }
}

/// The Linear pane's connect screen, pushed from Settings with a store of its own.
private struct SettingsLinearConnectionPage: View {
  @StateObject private var store: LinearPaneStore

  init(syncService: SyncService) {
    _store = StateObject(wrappedValue: LinearPaneStore(sync: syncService))
  }

  var body: some View {
    LinearConnectionScreen(store: store)
  }
}
