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
      let needsYou = rows.filter { $0.state == .signIn || $0.state == .attention }
      let ready = rows.filter { $0.state == .connected }
      let unset = rows.filter(\.state.isUnset)
      summaryCard(rows: rows, ready: ready, needsYou: needsYou)
      if !needsYou.isEmpty {
        ADESettingsSection("Needs you", hint: "Sign in or fix these on \(machine).") {
          ADESettingsRows {
            ForEach(needsYou) { providerRow($0) }
          }
        }
      }
      if !ready.isEmpty {
        ADESettingsSection("Ready") {
          ADESettingsRows {
            ForEach(ready) { providerRow($0) }
          }
        }
      }
      if !unset.isEmpty {
        ADESettingsSection("Not set up") {
          ADESettingsRows {
            ForEach(unset) { providerRow($0) }
          }
        }
      }
    } else if let loadError {
      ADESettingsNotice(
        message: "Couldn't read the providers on \(machine). \(loadError)",
        actionTitle: "Retry",
        action: { Task { await load() } }
      )
    } else {
      ADESettingsRows {
        ADESettingsLoadingRow(title: "Checking \(machine)… this can take 30 seconds")
      }
    }
  }

  /// The page's lead: which machine, how many of its agents are ready, and
  /// the ready ones' logos.
  private func summaryCard(rows: [SettingsProviderRow], ready: [SettingsProviderRow], needsYou: [SettingsProviderRow]) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        ADESettingsIconTile(symbol: "desktopcomputer", tint: .accent, size: 36)
        VStack(alignment: .leading, spacing: 2) {
          Text(machine)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text("\(rows.count) coding agents")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
      }
      HStack(alignment: .center, spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          (Text("\(ready.count)").font(.system(size: 28, weight: .semibold, design: .rounded))
            + Text(" of \(rows.count) ready").font(.system(size: 15)).foregroundColor(ADEColor.textSecondary))
            .foregroundStyle(ADEColor.textPrimary)
          if !needsYou.isEmpty {
            Text("\(needsYou.count) need\(needsYou.count == 1 ? "s" : "") you")
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(ADEKitTone.warn.color)
          }
        }
        Spacer(minLength: 8)
        ADEBrandTileStack(brands: ready.map { ADEBrand.provider($0.id) }, size: 30, limit: 4)
      }
    }
    .padding(ADEKit.inset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeKitCard(padding: nil)
    .accessibilityElement(children: .combine)
  }

  private func providerRow(_ row: SettingsProviderRow) -> some View {
    HStack(spacing: 12) {
      ADEBrandTile(brand: .provider(row.id), size: 34, dimmed: row.state.isUnset)
      VStack(alignment: .leading, spacing: 2) {
        Text(row.label)
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(row.state.isUnset ? ADEColor.textSecondary : ADEColor.textPrimary)
          .lineLimit(1)
        if let fact = row.fact {
          Text(fact)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
            .truncationMode(.middle)
        }
      }
      .layoutPriority(1)
      Spacer(minLength: 8)
      ADESettingsStatus(text: row.state.label, tone: row.state.tone)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  // MARK: - Accounts

  private var accountsSection: some View {
    ADESettingsSection("Accounts", hint: "API keys are added on the computer, in Settings › Providers.") {
      if syncService.supportsRemoteAction("providerAccounts.list") {
        ADESettingsRows {
          ADESettingsPageLink(title: "AI accounts") {
            SettingsProviderAccountsPage(syncService: syncService)
          } label: { _, pushes in
            HStack(spacing: 12) {
              ADEBrandTileStack(brands: [.provider("claude"), .provider("codex")], size: 30)
              VStack(alignment: .leading, spacing: 2) {
                Text("AI accounts")
                  .font(.system(size: 15, weight: .medium))
                  .foregroundStyle(ADEColor.textPrimary)
                Text("Claude and Codex logins on each machine")
                  .font(.system(size: 12.5))
                  .foregroundStyle(ADEColor.textSecondary)
                  .lineLimit(2)
              }
              Spacer(minLength: 8)
              if pushes { ADESettingsChevron() }
            }
            .padding(.horizontal, ADEKit.inset)
            .padding(.vertical, 12)
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

/// A provider's state (minus "Checking…", which the whole list shows while
/// `ai.getStatus` runs).
enum SettingsProviderState: Int, Comparable {
  case connected, attention, signIn, notInstalled, disabled

  /// The word in a row's trailing status.
  var label: String {
    switch self {
    case .connected: return "Ready"
    case .attention: return "Needs attention"
    case .signIn: return "Sign in"
    case .notInstalled: return "Not installed"
    case .disabled: return "Off"
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
