import SwiftUI

/// Settings › Providers: the coding agents on the connected machine as tiles
/// (Cloud 4), each with its sign-in word (Signed in, Not signed in, Unknown)
/// and the account, read with `ai.getStatus`. Mirrors the desktop provider
/// list (`ProvidersSection.tsx`, `providers/descriptors.tsx`,
/// `providerSignInView.ts`): the same names, words and order (what works
/// first, then what asks for something, then what is not set up).
///
/// A tile opens the provider: its sign-in runs on that machine from the
/// phone (`ProviderSignInSheet`), and the account's sign-ins of that
/// provider show as cards ("In use here"). With ADE Cloud for the account,
/// ADE Cloud is a second place with the same tiles (`ProviderCloudPlace`).
/// API keys are added on the computer.
struct SettingsProvidersPage: View {
  let syncService: SyncService
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @StateObject private var logins: ProviderLoginsModel

  @State private var status: SettingsAiStatus?
  @State private var disabledProviders: Set<String> = []
  @State private var loadError: String?
  @State private var loading = false
  @State private var place: ProvidersPlace = .machine

  enum ProvidersPlace: Hashable { case machine, cloud }

  init(syncService: SyncService) {
    self.syncService = syncService
    _logins = StateObject(wrappedValue: ProviderLoginsModel(host: syncService))
  }

  private var connected: Bool { syncService.connectionState == .connected }
  private var machine: String { syncService.machineDisplayName }
  /// ADE Cloud is a place only for an account with access, on a machine that can say.
  private var cloudOffered: Bool { syncService.cloudAvailable && syncService.cloudSupported && logins.supported }
  private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

  var body: some View {
    ADESettingsPage(route: .providers) {
      if !connected {
        ADESettingsNotice(message: SettingsPageCopy.connectMachine)
      } else if !syncService.supportsRemoteAction("ai.getStatus") {
        ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
      } else {
        if cloudOffered {
          ADEKitSegmented(selection: $place, options: [(ProvidersPlace.machine, machine), (ProvidersPlace.cloud, "ADE Cloud")])
        }
        if place == .cloud && cloudOffered {
          ProviderCloudPlace(syncService: syncService, model: logins)
        } else {
          providersSections
          accountsSection
        }
      }
    }
    .task(id: connected) {
      guard connected else { return }
      async let ai: Void = load()
      async let accountSignIns: Void = logins.load()
      _ = await (ai, accountSignIns)
    }
    .onChange(of: cloudOffered) { _, offered in
      if !offered { place = .machine }
    }
  }

  // MARK: - Provider tiles

  @ViewBuilder
  private var providersSections: some View {
    if let status {
      let rows = SettingsProviderRow.build(status: status, disabled: disabledProviders)
      let needsYou = rows.filter { $0.state == .signIn || $0.state == .attention }
      let ready = rows.filter { $0.state == .connected }
      summaryCard(rows: rows, ready: ready, needsYou: needsYou)
      LazyVGrid(columns: columns, spacing: 10) {
        ForEach(rows) { row in
          NavigationLink {
            SettingsProviderDetailPage(syncService: syncService, row: row, logins: logins, onChanged: { Task { await load(force: true) } })
          } label: {
            SettingsProviderTile(row: row)
          }
          .buttonStyle(.plain)
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
        ADESettingsLoadingRow(title: "Checking \(machine)…")
      }
    }
  }

  /// The page's lead: which machine, how many of its agents are signed in,
  /// and the signed-in ones' logos.
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
            + Text(" of \(rows.count) signed in").font(.system(size: 15)).foregroundColor(ADEColor.textSecondary))
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

  private func load(force: Bool = false) async {
    guard !loading else { return }
    loading = true
    defer { loading = false }
    loadError = nil
    do {
      status = try await syncService.fetchAiSettingsStatus()
    } catch {
      if status == nil { loadError = SyncUserFacingError.message(for: error) }
      return
    }
    // The providers switched off for this project read "Off", as on the
    // desktop. Best effort: without it the list still shows each one's state.
    if syncService.activeProjectId != nil, syncService.supportsRemoteAction("projectConfig.get"),
       let config = try? await syncService.fetchProjectChatConfig() {
      disabledProviders = config.disabledProviders
    }
    if force { await logins.load() }
  }
}

/// One provider's tile on a computer: logo, name, the sign-in word and the account.
struct SettingsProviderTile: View {
  let row: SettingsProviderRow

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        ADEBrandTile(brand: .provider(row.id), size: 28, dimmed: row.state.isUnset)
        Text(row.label)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(row.state.isUnset ? ADEColor.textSecondary : ADEColor.textPrimary)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
      }
      ADESettingsStatus(text: row.state.label, tone: row.state.tone)
      if let fact = row.fact {
        Text(fact)
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
          .truncationMode(.middle)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
    .adeKitCard(padding: nil)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(row.label), \(row.state.label)\(row.fact.map { ", \($0)" } ?? "")")
  }
}

/// One provider on the machine the phone drives: its state, its sign-in
/// (run there from the phone), and the account's sign-ins as cards.
struct SettingsProviderDetailPage: View {
  let syncService: SyncService
  let row: SettingsProviderRow
  @ObservedObject var logins: ProviderLoginsModel
  let onChanged: () -> Void
  @State private var signingIn = false

  private var machine: String { syncService.machineDisplayName }
  private var kind: WorkProviderSignInKind { workProviderSignInKind(row.id) }
  private var signInAction: String {
    switch kind {
    case .account: return "providerAccounts.loginStart"
    case .antigravity: return "ai.antigravitySignInStart"
    default: return "ai.cliLoginStart"
    }
  }
  private var canSignIn: Bool { kind != .settings && syncService.canInvokeRemoteAction(signInAction) }

  var body: some View {
    ADESettingsPage(title: row.label) {
      HStack(spacing: 12) {
        ADEBrandTile(brand: .provider(row.id), size: 44, dimmed: row.state.isUnset)
        VStack(alignment: .leading, spacing: 3) {
          Text(row.label)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("on \(machine)")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
          ADESettingsStatus(text: row.state.label, tone: row.state.tone)
        }
        Spacer(minLength: 0)
      }
      .adeKitCard()

      ADESettingsSection("Sign-in") {
        ADESettingsRows {
          if let fact = row.fact {
            ADESettingsValueRow(title: row.state == .connected ? "Account" : "State", value: fact)
          }
          if row.state == .notInstalled {
            ADESettingsRow("Not on \(machine) yet", hint: "Download it from Settings › Providers on that computer.")
          } else if row.state == .disabled {
            ADESettingsRow("Off for this project", hint: "Turn it on in the project's chat settings on the computer.")
          } else if kind == .settings {
            ADESettingsRow("Sign in on the computer", hint: "\(row.label) signs in with a key or a sub-provider, in Settings › Providers on \(machine).")
          } else if canSignIn {
            ADESettingsActionRow(
              title: row.state == .connected ? "Sign in again" : "Sign in to \(row.label)",
              symbol: "person.badge.key"
            ) {
              signingIn = true
            }
          } else {
            ADESettingsRow("Sign in from a phone that controls \(machine)", hint: "This phone only watches \(machine).")
          }
        }
      }

      if row.id == "claude" || row.id == "codex" {
        ADESettingsRows {
          ADESettingsLink(title: "AI accounts", hint: "Every \(row.label) login on each machine", symbol: "person.2") {
            SettingsProviderAccountsPage(syncService: syncService)
          }
        }
      }

      ProviderMachineSignIns(
        model: logins,
        provider: row.id,
        machineName: machine,
        cloudOn: syncService.cloudAvailable && syncService.cloudSupported
      )
    }
    .sheet(isPresented: $signingIn) {
      ProviderSignInSheet(
        provider: row.id,
        machineName: machine,
        host: syncService,
        expected: row.state == .connected ? row.account : nil,
        readAccount: { [syncService, id = row.id] in
          let status = try? await syncService.fetchAiSettingsStatus()
          let email = status?.providerConnections?[id]?.accountEmail?.trimmingCharacters(in: .whitespacesAndNewlines)
          return email?.isEmpty == false ? email : nil
        },
        onDone: onChanged
      )
      .presentationDetents([.large])
    }
  }
}

// MARK: - Presentation

/// A provider's state (minus "Checking…", which the whole list shows while
/// `ai.getStatus` runs), in the desktop's sign-in words (`providerSignInView.ts`).
enum SettingsProviderState: Int, Comparable {
  case connected, unknown, attention, signIn, notInstalled, disabled

  /// The word next to the dot.
  var label: String {
    switch self {
    case .connected: return "Signed in"
    case .unknown: return "Unknown"
    case .attention: return "Needs attention"
    case .signIn: return "Not signed in"
    case .notInstalled: return "Not downloaded"
    case .disabled: return "Off"
    }
  }

  var tone: ADEKitTone {
    switch self {
    case .connected: return .ok
    case .attention: return .crit
    case .signIn: return .warn
    case .unknown, .notInstalled, .disabled: return .neutral
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
  /// The signed-in account's email, when the provider records one.
  var account: String? = nil

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
    // Whether a chat can run now, and whether ADE's copy of the runtime is
    // there; the host's sign-in word then decides (`signInStatusView`).
    var connected = false
    var detected = false
    var problem: String?
    switch kind {
    case .claude:
      let claude = status.availableProviders?.claude
      detected = claude?.binary?.present == true
      connected = detected && claude?.auth?.ready == true
    case .opencode:
      if status.opencodeBinaryInstalled == false {
        return SettingsProviderRow(id: id, label: label, state: .notInstalled, fact: nil)
      }
      if let error = trimmed(status.opencodeInventoryError) {
        return SettingsProviderRow(id: id, label: label, state: .attention, fact: error)
      }
      return SettingsProviderRow(id: id, label: label, state: .connected, fact: trimmed(connection?.accountEmail), account: trimmed(connection?.accountEmail))
    case .muse:
      detected = connection?.runtimeDetected == true
      connected = connection?.runtimeAvailable == true && connection?.authAvailable == true
    case .pi:
      let installation = status.piInstallation
      connected = connection?.runtimeAvailable == true
      detected = installation?.installed == true || connection?.runtimeDetected == true
      if installation?.installed == true, installation?.sdkAvailable != true, !connected {
        problem = trimmed(connection?.blocker) ?? "Pi is installed but ADE can't load it."
        return SettingsProviderRow(id: id, label: label, state: .attention, fact: problem)
      }
    case .cli:
      connected = connection?.runtimeAvailable == true
      detected = connection?.runtimeDetected == true || connection?.authAvailable == true
    case .acp:
      connected = connection?.runtimeAvailable == true
      detected = connection?.runtimeDetected == true
    }
    let word = connection?.signInState ?? "signed-out"
    let account = trimmed(connection?.accountEmail)
    let state: SettingsProviderState
    if connected {
      state = word == "unknown" ? .unknown : .connected
    } else if !detected {
      state = .notInstalled
    } else if word == "signed-in" {
      // A saved sign-in the runtime can't use yet: something else is wrong.
      state = .attention
      problem = trimmed(connection?.blocker)
    } else if word == "unknown" {
      state = .unknown
    } else {
      state = .signIn
    }
    let fact: String?
    switch state {
    case .connected: fact = account
    case .attention: fact = problem ?? account
    case .unknown: fact = "ADE can't tell from here"
    case .signIn, .notInstalled, .disabled: fact = nil
    }
    return SettingsProviderRow(id: id, label: label, state: state, fact: fact, account: account)
  }

  private static func trimmed(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
    return value
  }
}
