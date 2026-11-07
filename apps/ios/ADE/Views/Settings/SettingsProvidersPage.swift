import SwiftUI

/// Settings › Providers: the coding agents on the connected machine and
/// whether each one is ready, read with `ai.getStatus`. Mirrors the desktop
/// provider list (`ProvidersSection.tsx`, `providers/descriptors.tsx`): the
/// same names, the same status words and order (what works first, then what
/// asks for something, then what is not set up). Sign-in, downloads and API
/// keys run on the machine itself, so the phone shows status and opens the
/// machine's AI accounts.
struct SettingsProvidersPage: View {
  let syncService: SyncService
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared

  @State private var status: SettingsAiStatus?
  @State private var disabledProviders: Set<String> = []
  @State private var loadError: String?
  @State private var loading = false

  private var connected: Bool { syncService.connectionState == .connected }
  private var machine: String { syncService.machineDisplayName }

  var body: some View {
    ADESettingsPage(route: .providers) {
      if !connected {
        ADESettingsNotice(message: SettingsPageCopy.connectMachine)
      } else if !syncService.supportsRemoteAction("ai.getStatus") {
        ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
      } else {
        providersSections
        accountsSection
      }
    }
    .task(id: connected) {
      guard connected else { return }
      await load()
    }
  }

  // MARK: - Provider list

  @ViewBuilder
  private var providersSections: some View {
    if let status {
      let rows = SettingsProviderRow.build(status: status, disabled: disabledProviders)
      let ready = rows.filter { !$0.state.isUnset }
      let unset = rows.filter(\.state.isUnset)
      // With nothing set up yet there is nothing to fold the rest behind.
      let folds = !ready.isEmpty && !unset.isEmpty
      // Headed by the machine, not "Providers" again under the page title.
      ADESettingsSection(machine, hint: "\(SettingsProviderRow.summary(rows)).", symbol: "desktopcomputer", tint: .accent) {
        ADESettingsRows {
          ForEach(folds ? ready : rows) { row in
            providerRow(row)
          }
        }
      }
      if folds {
        ADESettingsSection("Not set up · \(unset.count)") {
          ADESettingsRows {
            ForEach(unset) { row in
              providerRow(row)
            }
          }
        }
      }
    } else if let loadError {
      ADESettingsSection(machine, symbol: "desktopcomputer", tint: .accent) {
        ADESettingsNotice(
          message: "Couldn't read the providers on \(machine). \(loadError)",
          actionTitle: "Retry",
          action: { Task { await load() } }
        )
      }
    } else {
      ADESettingsSection(machine, hint: "Checking. This can take up to 30 seconds.", symbol: "desktopcomputer", tint: .accent) {
        ADESettingsRows {
          ADESettingsLoadingRow(title: "Checking providers…")
        }
      }
    }
  }

  private func providerRow(_ row: SettingsProviderRow) -> some View {
    ADESettingsRow(title: row.label, hint: row.fact) {
      ADEKitTag(text: row.state.label, tone: row.state.tone)
    }
    .accessibilityElement(children: .combine)
  }

  // MARK: - Accounts

  private var accountsSection: some View {
    ADESettingsSection("Accounts", hint: "API keys are added on the computer, in Settings › Providers.", symbol: "person.2", tint: .blue) {
      if syncService.supportsRemoteAction("providerAccounts.list") {
        ADESettingsRows {
          ADESettingsLink(title: "AI accounts", hint: "Claude and Codex logins on each machine", symbol: "person.2") {
            SettingsProviderAccountsPage(syncService: syncService)
          }
        }
      } else {
        ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
      }
    }
  }

  // MARK: - Loading

  private func load() async {
    guard !loading else { return }
    loading = true
    defer { loading = false }
    loadError = nil
    do {
      status = try await syncService.fetchAiSettingsStatus()
    } catch {
      loadError = SyncUserFacingError.message(for: error)
      return
    }
    // The providers switched off for this project read "Disabled", as on the
    // desktop. Best effort: without it the list still shows each one's state.
    if syncService.activeProjectId != nil, syncService.supportsRemoteAction("projectConfig.get"),
       let config = try? await syncService.fetchProjectChatConfig() {
      disabledProviders = config.disabledProviders
    }
  }
}

// MARK: - Presentation

/// A provider tile's state, in the desktop's six words (minus "Checking…",
/// which the whole list shows while `ai.getStatus` runs).
enum SettingsProviderState: Int, Comparable {
  case connected, attention, signIn, notInstalled, disabled

  var label: String {
    switch self {
    case .connected: return "Connected"
    case .attention: return "Needs attention"
    case .signIn: return "Sign in required"
    case .notInstalled: return "Not downloaded"
    case .disabled: return "Disabled"
    }
  }

  var tone: ADEKitTone {
    switch self {
    case .connected: return .ok
    case .attention: return .crit
    case .signIn: return .warn
    case .notInstalled, .disabled: return .neutral
    }
  }

  /// Folded under "Not set up", as on the desktop.
  var isUnset: Bool { self == .notInstalled || self == .disabled }

  static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// One provider in the list: its desktop name, state and the one fact worth a line.
struct SettingsProviderRow: Identifiable, Equatable {
  let id: String
  let label: String
  let state: SettingsProviderState
  let fact: String?

  private enum Kind { case claude, cli, muse, pi, opencode, acp }

  /// The desktop's provider order (`PROVIDER_DESCRIPTORS`, then the ACP ones).
  private static let catalogue: [(id: String, label: String, kind: Kind)] = [
    ("claude", "Claude Code", .claude),
    ("codex", "Codex CLI", .cli),
    ("cursor", "Cursor", .cli),
    ("droid", "Droid", .cli),
    ("copilot", "GitHub Copilot", .cli),
    ("muse", "Muse Code", .muse),
    ("pi", "Pi", .pi),
    ("opencode", "OpenCode", .opencode),
    ("qwen", "Qwen Code", .acp),
    ("kimi", "Kimi", .acp),
    ("grok", "Grok", .acp),
    ("devin", "Devin", .acp),
    ("antigravity", "Antigravity", .acp),
  ]

  /// Every provider, sorted by state and then by the desktop's order.
  static func build(status: SettingsAiStatus, disabled: Set<String>) -> [SettingsProviderRow] {
    let built: [(order: Int, row: SettingsProviderRow)] = catalogue.enumerated().map {
      (order: $0.offset, row: makeRow($0.element.id, label: $0.element.label, kind: $0.element.kind, status: status, disabled: disabled))
    }
    return built
      .sorted { lhs, rhs in
        lhs.row.state == rhs.row.state ? lhs.order < rhs.order : lhs.row.state < rhs.row.state
      }
      .map(\.row)
  }

  /// "13 coding agents — 3 ready, 2 need you".
  static func summary(_ rows: [SettingsProviderRow]) -> String {
    let ready = rows.filter { $0.state == .connected }.count
    let asking = rows.filter { $0.state == .signIn || $0.state == .attention }.count
    var tail = "\(ready) ready"
    if asking > 0 { tail += ", \(asking) need\(asking == 1 ? "s" : "") you" }
    return "\(rows.count) coding agents — \(tail)"
  }

  private static func makeRow(
    _ id: String,
    label: String,
    kind: Kind,
    status: SettingsAiStatus,
    disabled: Set<String>
  ) -> SettingsProviderRow {
    if disabled.contains(id) {
      return SettingsProviderRow(id: id, label: label, state: .disabled, fact: nil)
    }
    let connection = status.providerConnections?[id]
    let state: SettingsProviderState
    var problem: String?
    switch kind {
    case .claude:
      let claude = status.availableProviders?.claude
      if claude?.binary?.present == true, claude?.auth?.ready == true {
        state = .connected
      } else if claude?.binary?.present == true {
        state = .signIn
      } else {
        state = .notInstalled
      }
    case .opencode:
      if status.opencodeBinaryInstalled == false {
        state = .notInstalled
      } else if let error = trimmed(status.opencodeInventoryError) {
        state = .attention
        problem = error
      } else {
        state = .connected
      }
    case .muse:
      if connection?.runtimeAvailable == true, connection?.authAvailable == true {
        state = .connected
      } else if connection?.runtimeDetected == true {
        state = .signIn
      } else {
        state = .notInstalled
      }
    case .pi:
      let installation = status.piInstallation
      if connection?.runtimeAvailable == true {
        state = .connected
      } else if installation?.installed != true, connection?.runtimeDetected != true {
        state = .notInstalled
      } else if installation?.installed == true, installation?.sdkAvailable != true {
        state = .attention
        problem = trimmed(connection?.blocker) ?? "Pi is installed but ADE can't load it."
      } else {
        state = .signIn
      }
    case .cli:
      if connection?.runtimeAvailable == true {
        state = .connected
      } else if connection?.runtimeDetected == true || connection?.authAvailable == true {
        state = .signIn
      } else {
        state = .notInstalled
      }
    case .acp:
      if connection?.runtimeAvailable == true {
        state = .connected
      } else if connection?.runtimeDetected == true {
        state = .signIn
      } else {
        state = .notInstalled
      }
    }
    let fact: String?
    switch state {
    case .connected: fact = trimmed(connection?.accountEmail)
    case .signIn: fact = "Not signed in"
    case .attention: fact = problem
    case .notInstalled, .disabled: fact = nil
    }
    return SettingsProviderRow(id: id, label: label, state: state, fact: fact)
  }

  private static func trimmed(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
    return value
  }
}
