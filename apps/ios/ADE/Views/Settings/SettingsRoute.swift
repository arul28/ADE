import SwiftUI

/// Settings' pages, in the desktop sidebar's order and under its group names
/// (`SETTINGS_TABS` in `apps/desktop/src/shared/settingsManifest.ts`), so a
/// person who learns one finds the other in the same place. A desktop page the
/// phone cannot reach (Keyboard, the desktop's own Appearance, ADE MCP,
/// Secrets, Location, Storage) is left out rather than shown empty: the
/// machine has no command a phone may call for it.
enum SettingsRoute: String, CaseIterable, Identifiable, Hashable {
  case general
  case account
  case usage
  case chat
  case providers
  case integrations
  case notifications
  case appearance
  case lanes
  case machines
  case advanced

  var id: String { rawValue }

  var title: String {
    switch self {
    case .general: return "General"
    case .account: return "Account"
    case .usage: return "Usage"
    case .chat: return "Chat"
    case .providers: return "Providers"
    case .integrations: return "Integrations"
    case .notifications: return "Notifications"
    case .appearance: return "Appearance"
    case .lanes: return "Lanes"
    case .machines: return "Machines"
    case .advanced: return "Advanced"
    }
  }

  /// The line under the page title, the desktop page's description where the
  /// phone's page covers the same ground. Nil where the desktop has none.
  var subtitle: String? {
    switch self {
    case .general, .account, .providers, .machines: return nil
    case .usage: return "Spend and pacing across your providers and machines."
    case .chat: return "How agents behave in chat, and what they may spend."
    case .integrations: return "GitHub, Linear, Jira and webhooks: the services ADE and your agents use."
    case .notifications: return "What ADE tells you about running work, and where."
    case .appearance: return "How ADE looks on this \(UIDevice.current.model)."
    case .lanes: return "How new lanes start in this project."
    case .advanced: return "How this phone reaches its machine, delivery checks, and this build."
    }
  }

  var symbol: String {
    switch self {
    case .general: return "gearshape"
    case .account: return "person.crop.circle"
    case .usage: return "chart.bar"
    case .chat: return "bubble.left"
    case .providers: return "cpu"
    case .integrations: return "square.grid.2x2"
    case .notifications: return "bell"
    case .appearance: return "circle.lefthalf.filled"
    case .lanes: return "arrow.triangle.branch"
    case .machines: return "desktopcomputer"
    case .advanced: return "wrench.and.screwdriver"
    }
  }

  var group: SettingsRouteGroup {
    switch self {
    case .general: return .overview
    case .account, .usage: return .you
    case .chat, .providers, .integrations, .notifications, .appearance: return .app
    case .lanes: return .project
    case .machines, .advanced: return .system
    }
  }
}

/// The desktop sidebar's groups (`SETTINGS_GROUPS`). General is one row above
/// them with no heading of its own.
enum SettingsRouteGroup: CaseIterable {
  case overview, you, app, project, system

  var title: String? {
    switch self {
    case .overview: return nil
    case .you: return "You"
    case .app: return "App"
    case .project: return "Project"
    case .system: return "System"
    }
  }
}

// MARK: - Shared page copy

/// The notices and save toasts every machine-backed Settings page shows the
/// same way.
enum SettingsPageCopy {
  static let connectMachine = "Connect a machine to change these."
  static let openProject = "Open a project to change these."

  static func updateADE(on machine: String) -> String {
    "Update ADE on \(machine) to change this here."
  }

  static func queued(on machine: String) -> String {
    "Saved. It reaches \(machine) when it reconnects."
  }

  /// Runs one optimistic save and returns the toast it ends with: none when
  /// the machine applied it, a note when the phone holds it until the machine
  /// is back, or `failure` and the reason after `revert` (given the reason)
  /// puts the control back.
  @MainActor
  static func commit(
    failure: String,
    on machine: String,
    revert: (_ reason: String) -> Void,
    _ write: () async throws -> SettingsWriteOutcome
  ) async -> ADEToastMessage? {
    do {
      return try await write() == .queued ? ADEToastMessage(text: queued(on: machine), kind: .info) : nil
    } catch {
      let reason = SyncUserFacingError.message(for: error)
      revert(reason)
      return ADEToastMessage(text: "\(failure) \(reason)", kind: .failure)
    }
  }
}
