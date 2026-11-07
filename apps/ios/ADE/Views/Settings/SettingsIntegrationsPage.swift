import OSLog
import SwiftUI

private let settingsIntegrationsLog = Logger(subsystem: "com.ade.ios", category: "SettingsIntegrations")

/// Settings › Integrations: what the connected machine is connected to, in the
/// desktop's order (`integrations/IntegrationsHome.tsx`): GitHub, Linear,
/// Jira and Agent 37, then Webhooks. Each status is read on that machine,
/// where its credentials live. Linear connects from the phone through the
/// same screen the Linear pane uses, and Agent 37 opens its pane; GitHub and
/// Jira connect on the computer, so their cards only show where they stand.
struct SettingsIntegrationsPage: View {
  let syncService: SyncService
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared

  @State private var github: IntegrationSummary = .checking
  @State private var githubRepo: String?
  @State private var jira: IntegrationSummary = .checking
  @State private var agent37: IntegrationSummary = .checking
  /// Linear's own status lives on `SyncService` (the Work pane reads it too),
  /// so a connect or disconnect on the pushed screen shows here on return.
  @State private var linearChecked = false
  @State private var agent37Presented = false

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
        agent37Section
        webhooksSection
      }
    }
    .sheet(isPresented: $agent37Presented) {
      Agent37PaneSheet(syncService: syncService)
        .environmentObject(syncService)
    }
    // One read per card, side by side: a slow GitHub check never holds up Jira.
    .task(id: connected) { if connected { await loadGitHub() } }
    .task(id: connected) { if connected { await loadLinear() } }
    .task(id: connected) { if connected { await loadJira() } }
    .task(id: connected) { if connected { await loadAgent37() } }
  }

  // MARK: - GitHub

  private var githubSection: some View {
    ADESettingsSection("GitHub", hint: "Open, review and merge pull requests, follow checks, and work on issues.", symbol: "chevron.left.forwardslash.chevron.right", tint: .slate) {
      projectStatus(readBy: "github.getStatus") {
        ADESettingsRows {
          statusRow(github, connectHint: "Connect on your computer.")
          if let githubRepo {
            ADESettingsValueRow(title: "Repository", value: githubRepo, mono: true)
          }
        }
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
    ADESettingsSection("Linear", hint: "Start lanes from Linear issues, link them to PRs, and let your team assign work to ADE.", symbol: "circle.lefthalf.striped.horizontal", tint: .violet) {
      projectStatus(readBy: "cto.getLinearConnectionStatus") {
        ADESettingsRows {
          statusRow(linear, connectHint: canManageLinear ? nil : "Connect on your computer.")
          if canManageLinear && linearChecked {
            ADESettingsLink(
              title: linearStatus?.connected == true ? "Manage Linear" : "Connect Linear",
              symbol: "link"
            ) {
              SettingsLinearConnectionPage(syncService: syncService)
            }
          }
        }
      }
    }
  }

  // MARK: - Jira

  private var jiraSection: some View {
    ADESettingsSection("Jira", hint: "Bring a Jira Cloud site's issues into ADE and tie them to this project.", symbol: "square.stack.3d.up", tint: .blue) {
      projectStatus(readBy: "jira.getConnectionStatus") {
        ADESettingsRows {
          statusRow(jira, connectHint: "Connect on your computer.")
        }
      }
    }
  }

  // MARK: - Agent 37

  private var agent37Section: some View {
    ADESettingsSection("Agent 37", hint: "Make cloud Linux machines for your lanes, signed in to your account with no code to type.", symbol: "cloud", tint: .teal) {
      if !syncService.agent37Supported {
        ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
      } else {
        ADESettingsRows {
          statusRow(agent37, connectHint: "Connect on your computer.")
          ADESettingsActionRow(title: "Open Agent 37", symbol: "server.rack") {
            agent37Presented = true
          }
        }
      }
    }
  }

  // MARK: - Webhooks

  private var webhooksSection: some View {
    ADESettingsSection("Webhooks", hint: "Requests that reach your automations.", symbol: "point.3.connected.trianglepath.dotted", tint: .pink) {
      ADESettingsRows {
        ADESettingsLink(title: "Webhooks", symbol: "link") {
          SettingsWebhooksPage(syncService: syncService)
        }
      }
    }
  }

  // MARK: - Rows

  /// A card whose status the machine reads in the open project: a notice
  /// when the machine is too old for `action`, a quiet row when no project
  /// is open (the page says why once, above the cards).
  @ViewBuilder
  private func projectStatus<Content: View>(readBy action: String, @ViewBuilder content: () -> Content) -> some View {
    if !syncService.supportsRemoteAction(action) {
      ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
    } else if !hasProject {
      ADESettingsRows {
        ADESettingsValueRow(title: "Status", value: "No project open")
      }
    } else {
      content()
    }
  }

  /// The card's status line. `connectHint` shows under it while not connected.
  private func statusRow(_ summary: IntegrationSummary, connectHint: String?) -> some View {
    ADESettingsRow(title: "Status", hint: summary == .notConnected ? connectHint : nil) {
      HStack(spacing: 6) {
        if summary == .checking {
          ProgressView().controlSize(.small)
        } else {
          ADEKitDot(tone: summary.tone)
        }
        Text(summary.label)
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
          .multilineTextAlignment(.trailing)
      }
    }
    .accessibilityElement(children: .combine)
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

  private func loadAgent37() async {
    guard syncService.agent37Supported else { return }
    do {
      let list = try await syncService.agent37Read("list", as: Agent37PhoneList.self)
      agent37 = IntegrationSummary(
        label: list.balanceUsd.map { String(format: "Connected · $%.2f left", $0) } ?? "Connected",
        tone: .ok
      )
    } catch {
      // The same test the Agent 37 pane uses for "no key on the account".
      if error.localizedDescription.localizedCaseInsensitiveContains("connect agent 37") {
        agent37 = .notConnected
      } else {
        settingsIntegrationsLog.warning("Agent 37 status read failed: \(error.localizedDescription, privacy: .public)")
        agent37 = IntegrationSummary(label: "Couldn't reach Agent 37", tone: .warn)
      }
    }
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
