import SwiftUI

/// The account's provider sign-ins on the phone (Cloud 4): the mirror of the
/// desktop's `settings/providers/cloud/*` (`adeCloudSignInModel.ts`,
/// `adeCloudPageModel.ts`, `SignInAccountCard.tsx`, `ProviderSignInsPanel.tsx`)
/// and the dashboard's `CloudSignIns.tsx`.
///
/// One read, `providerLogins.status`, on the machine the phone drives: the
/// account part (each sign-in, the computer it came from, whether ADE Cloud
/// uses it) is the same from any of the person's machines, and "In use here"
/// is that machine's own. The writes (`use`, `setCloud`, `setCloudAll`) are
/// account-wide and go to the same machine; only a controlling phone sends
/// them. Nothing here wakes a cloud computer.

// MARK: - The status

struct ProviderLoginsPhoneStatus: Decodable, Equatable {
  struct ThisComputer: Decodable, Equatable {
    let capture: String
    let reason: String?
    let message: String?
    let label: String?
    let cloudComputer: Bool
  }

  struct Cloud: Decodable, Equatable {
    /// The one off switch for all of ADE Cloud's sign-ins.
    let enabled: Bool
    /// Place → the vault key in use, "key" for the saved key.
    let inUse: [String: String]
  }

  struct SignIn: Decodable, Equatable, Identifiable {
    struct Origin: Decodable, Equatable {
      let label: String
      let thisComputer: Bool
    }
    struct Account: Decodable, Equatable {
      let email: String?
      let id: String?
    }
    struct RenewsNow: Decodable, Equatable {
      let label: String
      let cloudComputer: Bool
      let thisComputer: Bool
    }

    let key: String
    let provider: String
    let slot: String
    let renewal: String?
    let origin: Origin
    let account: Account?
    let capturedAt: String?
    let renewedAt: String?
    let renewedBy: String?
    let renewsNow: RenewsNow?
    let onForCloud: Bool
    let inUseOnCloud: Bool

    var id: String { key }

    private enum CodingKeys: String, CodingKey {
      case key, provider, slot, renewal = "class", origin, account, capturedAt, renewedAt, renewedBy, renewsNow, onForCloud, inUseOnCloud
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      key = try c.decode(String.self, forKey: .key)
      provider = try c.decode(String.self, forKey: .provider)
      slot = (try? c.decode(String.self, forKey: .slot)) ?? "default"
      renewal = try? c.decodeIfPresent(String.self, forKey: .renewal)
      origin = try c.decode(Origin.self, forKey: .origin)
      account = try? c.decodeIfPresent(Account.self, forKey: .account)
      capturedAt = try? c.decodeIfPresent(String.self, forKey: .capturedAt)
      renewedAt = try? c.decodeIfPresent(String.self, forKey: .renewedAt)
      renewedBy = try? c.decodeIfPresent(String.self, forKey: .renewedBy)
      renewsNow = try? c.decodeIfPresent(RenewsNow.self, forKey: .renewsNow)
      onForCloud = (try? c.decode(Bool.self, forKey: .onForCloud)) ?? true
      inUseOnCloud = (try? c.decode(Bool.self, forKey: .inUseOnCloud)) ?? false
    }

    var email: String? {
      guard let email = account?.email?.trimmingCharacters(in: .whitespacesAndNewlines), !email.isEmpty else { return nil }
      return email
    }

    /// The email, else "Sign-in from Mac Studio" (K4).
    var title: String { email ?? "Sign-in from \(origin.label)" }

    /// The confirm's words: the email, else "the sign-in from Mac Studio".
    var name: String { email ?? "the sign-in from \(origin.label)" }

    /// A Claude pass is never a carried sign-in.
    var isClaudePass: Bool { key.hasPrefix("claude-pass/") }
  }

  struct Provider: Decodable, Equatable {
    struct Local: Decodable, Equatable {
      let state: String
      let key: String?
    }
    let provider: String
    /// `carried`, `fallback` or `never`.
    let carry: String
    let message: String
    let local: Local
  }

  /// A Claude pass for ADE Cloud, by name and state only.
  struct Pass: Decodable, Equatable {
    let key: String
    let unreadable: Bool?
    let email: String?
    let label: String?
    let on: Bool?
    let newChats: Bool?
    let endsInDays: Double?
  }

  let thisComputer: ThisComputer
  let cloud: Cloud
  let signIns: [SignIn]
  let providers: [Provider]
  let claudePasses: [Pass]?

  private enum CodingKeys: String, CodingKey { case thisComputer, cloud, signIns, providers, claudePasses }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    thisComputer = try c.decode(ThisComputer.self, forKey: .thisComputer)
    cloud = try c.decode(Cloud.self, forKey: .cloud)
    // One sign-in a newer brain shapes differently drops alone.
    signIns = ((try? c.decode([ProviderLoginsLenient<SignIn>].self, forKey: .signIns)) ?? []).compactMap(\.value)
    providers = ((try? c.decode([ProviderLoginsLenient<Provider>].self, forKey: .providers)) ?? []).compactMap(\.value)
    claudePasses = (try? c.decodeIfPresent([ProviderLoginsLenient<Pass>].self, forKey: .claudePasses))?.compactMap(\.value)
  }

  func provider(_ id: String) -> Provider? { providers.first { $0.provider == id } }

  /// The account's sign-ins of one provider, newest first; never a Claude
  /// pass, and never Pi's Claude sign-in (it is not carried).
  func cards(for provider: String) -> [SignIn] {
    signIns
      .filter { $0.provider == provider && !$0.isClaudePass && !(provider == "pi" && $0.slot == "anthropic") }
      .sorted { ($0.capturedAt ?? "") > ($1.capturedAt ?? "") }
  }

  @MainActor
  static func read(on host: ProviderAccountsHost) async throws -> ProviderLoginsPhoneStatus {
    try decode(try await host.runProviderAccountsCommand("providerLogins.status", args: [:]))
  }

  /// One of the person's writes; the answer is the new status.
  @MainActor
  static func write(_ method: String, args: [String: Any], on host: ProviderAccountsHost) async throws -> ProviderLoginsPhoneStatus {
    try decode(try await host.runProviderAccountsCommand("providerLogins.\(method)", args: args))
  }

  private static func decode(_ raw: Any) throws -> ProviderLoginsPhoneStatus {
    let data = try JSONSerialization.data(withJSONObject: raw)
    return try JSONDecoder().decode(ProviderLoginsPhoneStatus.self, from: data)
  }
}

/// Decodes one element of a list, or nil when that element alone is malformed.
struct ProviderLoginsLenient<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws {
    value = try? T(from: decoder)
  }
}

// MARK: - Words

/// "From Mac Studio (this computer) · Nov 10" (K5).
func providerSignInSourceLine(_ signIn: ProviderLoginsPhoneStatus.SignIn) -> String {
  let source = "From \(signIn.origin.label)\(signIn.origin.thisComputer ? " (this computer)" : "")"
  guard let captured = providerSignInDate(signIn.capturedAt) else { return source }
  return "\(source) · \(providerSignInDay(captured))"
}

/// "Renewed by cloud-a 5 min ago" (K6), for a sign-in that renews.
func providerSignInRenewedLine(_ signIn: ProviderLoginsPhoneStatus.SignIn, now: Date = Date()) -> String? {
  guard signIn.renewal == "renewing", let by = signIn.renewedBy, let at = providerSignInDate(signIn.renewedAt) else { return nil }
  return "Renewed by \(by) \(cloudAgo(at.timeIntervalSince1970 * 1000, now: now))"
}

/// "cloud-a renews it while Mac Studio is off."
func providerSignInRenewsNowLine(_ signIn: ProviderLoginsPhoneStatus.SignIn) -> String? {
  guard let renews = signIn.renewsNow, renews.cloudComputer, !renews.thisComputer else { return nil }
  return "\(renews.label) renews it while \(signIn.origin.thisComputer ? "this computer" : signIn.origin.label) is off."
}

private func providerSignInDate(_ iso: String?) -> Date? {
  guard let iso else { return nil }
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = formatter.date(from: iso) { return date }
  formatter.formatOptions = [.withInternetDateTime]
  return formatter.date(from: iso)
}

private func providerSignInDay(_ date: Date) -> String {
  if Calendar.current.isDateInToday(date) { return "today" }
  if Calendar.current.isDateInYesterday(date) { return "yesterday" }
  return date.formatted(.dateTime.month(.abbreviated).day())
}

// MARK: - ADE Cloud as a place

/// One provider's tile for ADE Cloud: its status word, the account, and one
/// line on how the sign-in got there (`adeCloudTile`, in the phone's words).
struct ProviderCloudTile: Identifiable, Equatable {
  enum State: Equatable { case signedIn, notSignedIn, off }

  let provider: String
  let label: String
  let state: State
  let account: String?
  /// "From Mac Studio", "Cloud pass", "Saved key", "Sign in on the cloud computer".
  let source: String
  /// The sign-in in use, for its switch; nil when there is none to switch.
  let signIn: ProviderLoginsPhoneStatus.SignIn?

  var id: String { provider }

  var word: String {
    switch state {
    case .signedIn: return "Signed in"
    case .notSignedIn: return "Not signed in"
    case .off: return "Off"
    }
  }

  var tone: ADEKitTone {
    switch state {
    case .signedIn: return .ok
    case .notSignedIn: return .warn
    case .off: return .neutral
    }
  }
}

/// The providers ADE Cloud can use, in the desktop's order.
let providerCloudCatalogue: [String] = [
  "claude", "codex", "cursor", "droid", "copilot", "opencode", "pi", "qwen", "kimi", "grok", "devin", "antigravity", "muse",
]

func providerCloudTiles(_ status: ProviderLoginsPhoneStatus) -> [ProviderCloudTile] {
  providerCloudCatalogue.map { provider in providerCloudTile(provider, status: status) }
}

func providerCloudTile(_ provider: String, status: ProviderLoginsPhoneStatus) -> ProviderCloudTile {
  let label = workProviderSignInLabel(provider)
  func tile(_ state: ProviderCloudTile.State, _ account: String?, _ source: String, _ signIn: ProviderLoginsPhoneStatus.SignIn? = nil) -> ProviderCloudTile {
    ProviderCloudTile(provider: provider, label: label, state: state, account: account, source: source, signIn: signIn)
  }
  if !status.cloud.enabled {
    return tile(.off, nil, "Your sign-ins aren't shared with ADE Cloud")
  }
  if provider == "claude" {
    // Claude's own login is never carried: ADE Cloud uses a Claude pass.
    let passes = (status.claudePasses ?? []).filter { $0.unreadable != true && $0.on != false }
    if let pass = passes.first(where: { $0.newChats == true }) ?? passes.first {
      let ends = pass.endsInDays.map { $0 <= 14 ? ". Ends in \(max(0, Int($0))) days" : "" } ?? ""
      return tile(.signedIn, pass.email ?? pass.label, "Cloud pass\(ends)")
    }
    return tile(.notSignedIn, nil, "Approve a Claude pass in the ADE desktop app")
  }
  if status.cloud.inUse[provider] == "key" {
    return tile(.signedIn, nil, "Saved key")
  }
  let cards = status.cards(for: provider)
  if let inUse = cards.first(where: \.inUseOnCloud) {
    return tile(.signedIn, inUse.email, "From \(inUse.origin.label)", inUse)
  }
  if status.provider(provider)?.carry == "fallback" {
    return tile(.notSignedIn, nil, "Sign in on the cloud computer, or use a key")
  }
  if !cards.isEmpty {
    return tile(.notSignedIn, nil, "Every sign-in is off for ADE Cloud")
  }
  return tile(.notSignedIn, nil, "Sign in on any of your computers")
}

/// Settings › Providers › ADE Cloud: the same tiles as each computer, the
/// one switch for all, and each provider's page with its cards.
struct ProviderCloudPlace: View {
  let syncService: SyncService
  @ObservedObject var model: ProviderLoginsModel

  private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

  var body: some View {
    VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
      if let status = model.status {
        ADESettingsSection("ADE Cloud", hint: "Your cloud computers sign in with these. A sign-in on any of your computers reaches them in about a minute.") {
          ADESettingsRows {
            ADESettingsRow(
              title: "Share my sign-ins with ADE Cloud",
              hint: status.cloud.enabled ? "Cloud computers use the accounts you're signed in to on your computers." : "Off: you sign in on each cloud computer yourself."
            ) {
              Toggle("", isOn: Binding(
                get: { model.pendingAll ?? status.cloud.enabled },
                set: { next in Task { await model.setAll(next) } }
              ))
              .labelsHidden()
              .tint(ADEColor.accent)
              .disabled(!model.canWrite || model.pendingAll != nil)
            }
          }
        }
        LazyVGrid(columns: columns, spacing: 10) {
          ForEach(providerCloudTiles(status)) { tile in
            NavigationLink {
              ProviderCloudProviderPage(model: model, provider: tile.provider)
            } label: {
              ProviderCloudTileView(tile: tile)
            }
            .buttonStyle(.plain)
          }
        }
        if let error = model.error {
          ADESettingsNotice(message: error, tone: .crit, dismiss: { model.error = nil })
        }
      } else if model.failed {
        ADESettingsNotice(message: "ADE couldn't read your sign-ins on \(syncService.machineDisplayName).", actionTitle: "Retry") {
          Task { await model.load() }
        }
      } else {
        ADESettingsRows { ADESettingsLoadingRow(title: "Reading your sign-ins…") }
      }
    }
  }
}

struct ProviderCloudTileView: View {
  let tile: ProviderCloudTile

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        ADEBrandTile(brand: .provider(tile.provider), size: 28, dimmed: tile.state != .signedIn)
        Text(tile.label)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
      }
      ADESettingsStatus(text: tile.word, tone: tile.tone)
      VStack(alignment: .leading, spacing: 2) {
        if let account = tile.account {
          Text(account)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Text(tile.source)
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .frame(maxWidth: .infinity, minHeight: 128, alignment: .topLeading)
    .adeKitCard(padding: nil)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(tile.label), \(tile.word)\(tile.account.map { ", \($0)" } ?? ""). \(tile.source)")
  }
}

/// One provider on ADE Cloud: its sign-in cards, "In use on ADE Cloud" or
/// "Use on ADE Cloud", and each card's switch.
struct ProviderCloudProviderPage: View {
  @ObservedObject var model: ProviderLoginsModel
  let provider: String
  @State private var confirming: ProviderLoginsPhoneStatus.SignIn?

  var body: some View {
    ADESettingsPage(title: workProviderSignInLabel(provider)) {
      if let status = model.status {
        let tile = providerCloudTile(provider, status: status)
        HStack(spacing: 12) {
          ADEBrandTile(brand: .provider(provider), size: 40)
          VStack(alignment: .leading, spacing: 3) {
            Text("\(tile.label) on ADE Cloud")
              .font(.system(size: 16, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            ADESettingsStatus(text: tile.word, tone: tile.tone)
          }
          Spacer(minLength: 0)
        }
        .adeKitCard()
        let cards = status.cards(for: provider)
        if provider == "claude" {
          ADESettingsNotice(message: "ADE Cloud never uses Claude's own login. A Claude pass (one approve, good for a year, cloud only) is made in the ADE desktop app.", tone: .neutral)
        } else if cards.isEmpty {
          ADESettingsNotice(message: status.provider(provider)?.carry == "fallback"
            ? "\(tile.label) can't be carried to ADE Cloud. Sign in on the cloud computer, or use a key."
            : "No \(tile.label) sign-in in your ADE account yet. Sign in on any of your computers and it reaches ADE Cloud.", tone: .neutral)
        } else {
          ADESettingsSection("Sign-ins in your ADE account") {
            VStack(spacing: 10) {
              ForEach(cards) { card in
                ProviderSignInCardView(
                  signIn: card,
                  badge: card.inUseOnCloud ? .inUse("In use on ADE Cloud") : card.onForCloud ? .action("Use on ADE Cloud") : .off,
                  lines: [],
                  busy: model.busy.contains(card.key),
                  canWrite: model.canWrite,
                  onAction: { confirming = card },
                  toggle: (label: "On for ADE Cloud", isOn: card.onForCloud, set: { next in Task { await model.setCloud(card, on: next) } })
                )
              }
            }
          }
        }
        if let error = model.error {
          ADESettingsNotice(message: error, tone: .crit, dismiss: { model.error = nil })
        }
      }
    }
    .confirmationDialog(
      confirming.map { "Use \($0.name) on ADE Cloud?" } ?? "",
      isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible,
      presenting: confirming
    ) { card in
      Button("Use it") { Task { await model.use(card) } }
      Button("Cancel", role: .cancel) {}
    } message: { _ in
      Text("A turn that runs now finishes on the sign-in it started with. The next message on ADE Cloud uses this one.")
    }
  }
}

// MARK: - A computer's cards

/// A computer's provider page part: the provider's sign-ins in the ADE
/// account as cards, "In use here" on the one the machine the phone drives
/// uses. A computer can't take a sign-in from the account yet, so the other
/// cards say how to use them there, with no button that would fail.
struct ProviderMachineSignIns: View {
  @ObservedObject var model: ProviderLoginsModel
  let provider: String
  let machineName: String
  let cloudOn: Bool

  var body: some View {
    if let status = model.status, let row = status.provider(provider), row.carry == "carried" {
      let cards = status.cards(for: provider)
      ADESettingsSection("Sign-ins in your ADE account") {
        if cards.isEmpty {
          ADESettingsRows {
            ADESettingsRow("No \(workProviderSignInLabel(provider)) sign-in in your ADE account yet.")
          }
        } else {
          VStack(spacing: 10) {
            ForEach(cards) { card in
              let inUseHere = status.thisComputer.cloudComputer
                ? card.inUseOnCloud
                : row.local.key == card.key
              ProviderSignInCardView(
                signIn: card,
                badge: inUseHere ? .inUse("In use here") : .none,
                lines: (inUseHere ? [] : ["To use it here, sign in on \(machineName)."])
                  + (cloudOn && card.inUseOnCloud ? ["In use on ADE Cloud"] : []),
                busy: false,
                canWrite: false,
                onAction: {},
                toggle: nil
              )
            }
          }
        }
      }
    }
  }
}

/// One sign-in in the ADE account (`SignInAccountCard`): its name, where it
/// came from, who renewed it, the place's mark or button, and its switch.
struct ProviderSignInCardView: View {
  enum Badge: Equatable {
    case none
    case inUse(String)
    case action(String)
    case off
  }

  let signIn: ProviderLoginsPhoneStatus.SignIn
  let badge: Badge
  let lines: [String]
  let busy: Bool
  let canWrite: Bool
  let onAction: () -> Void
  let toggle: (label: String, isOn: Bool, set: (Bool) -> Void)?

  private var marked: Bool {
    if case .inUse = badge { return true }
    return false
  }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous)
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(signIn.title)
          .font(.system(size: 14.5, weight: .semibold))
          .foregroundStyle(signIn.onForCloud ? ADEColor.textPrimary : ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer(minLength: 6)
        switch badge {
        case .none:
          EmptyView()
        case .inUse(let text):
          ADEKitTag(text: text, tone: .accent, keepsCase: true)
        case .off:
          ADEKitTag(text: "Off for ADE Cloud", keepsCase: true)
        case .action(let text):
          Button(text, action: onAction)
            .buttonStyle(ADEKitButtonStyle())
            .disabled(busy || !canWrite)
        }
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(providerSignInSourceLine(signIn))
        if let renewed = providerSignInRenewedLine(signIn) { Text(renewed) }
        if let renewsNow = providerSignInRenewsNowLine(signIn) { Text(renewsNow) }
        ForEach(lines, id: \.self) { line in
          Text(line).foregroundStyle(ADEColor.textSecondary)
        }
      }
      .font(.system(size: 12.5))
      .foregroundStyle(ADEColor.textMuted)
      if let toggle {
        HStack {
          Text(toggle.label)
            .font(.system(size: 13))
            .foregroundStyle(toggle.isOn ? ADEColor.textSecondary : ADEColor.textMuted)
          Spacer()
          if busy {
            ProgressView().controlSize(.small)
          } else {
            Toggle("", isOn: Binding(get: { toggle.isOn }, set: toggle.set))
              .labelsHidden()
              .tint(ADEColor.accent)
              .disabled(!canWrite)
          }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(toggle.label): \(signIn.title)")
      }
    }
    .padding(ADEKit.inset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(marked ? ADEColor.accent.opacity(0.06) : ADEKit.surface, in: shape)
    .overlay(shape.strokeBorder(marked ? ADEColor.accent.opacity(0.4) : ADEKit.edge, lineWidth: marked ? 1 : 0.75))
  }
}

// MARK: - The model

/// The account's sign-ins as one page reads them, on the machine the phone
/// drives: read on open and after each write (the write's answer is the new
/// status). No timer and no poll.
@MainActor
final class ProviderLoginsModel: ObservableObject {
  @Published private(set) var status: ProviderLoginsPhoneStatus?
  @Published private(set) var failed = false
  @Published private(set) var busy: Set<String> = []
  @Published private(set) var pendingAll: Bool?
  @Published var error: String?

  private let host: SyncService?

  init(host: SyncService) {
    self.host = host
  }

  #if DEBUG
  init(fixture: ProviderLoginsPhoneStatus) {
    self.host = nil
    self.status = fixture
  }
  #endif

  /// The connected machine answers `providerLogins.*` (a newer brain).
  var supported: Bool { host?.supportsRemoteAction("providerLogins.status") ?? true }

  /// The phone may change sign-ins there (a controlling device).
  var canWrite: Bool { host?.canInvokeRemoteAction("providerLogins.use") ?? true }

  func load() async {
    guard let host, supported else { return }
    do {
      status = try await ProviderLoginsPhoneStatus.read(on: host)
      failed = false
    } catch {
      failed = status == nil
    }
  }

  func setAll(_ on: Bool) async {
    pendingAll = on
    defer { pendingAll = nil }
    await write("setCloudAll", args: ["on": on], busyKey: nil)
  }

  func setCloud(_ signIn: ProviderLoginsPhoneStatus.SignIn, on: Bool) async {
    await write("setCloud", args: ["key": signIn.key, "on": on], busyKey: signIn.key)
  }

  func use(_ signIn: ProviderLoginsPhoneStatus.SignIn) async {
    await write("use", args: ["provider": signIn.provider, "key": signIn.key, "slot": signIn.slot], busyKey: signIn.key)
    if error == nil { ADEHaptics.success() }
  }

  private func write(_ method: String, args: [String: Any], busyKey: String?) async {
    guard let host else { return }
    if let busyKey { busy.insert(busyKey) }
    defer { if let busyKey { busy.remove(busyKey) } }
    error = nil
    do {
      status = try await ProviderLoginsPhoneStatus.write(method, args: args, on: host)
    } catch {
      self.error = "ADE couldn't change that. \(SyncUserFacingError.message(for: error))"
      ADEHaptics.error()
    }
  }
}

// MARK: - The ADE Cloud page's card

/// The dashboard's "Sign-ins on ADE Cloud" (`CloudSignIns.tsx`): one row per
/// provider ADE Cloud signs in with, in plain words, the rest as one line of
/// names, and the one switch.
struct CloudSignInsCard: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    let tiles = store.signIns.map(providerCloudTiles) ?? []
    let ready = tiles.filter { $0.state == .signedIn }
    let rest = tiles.filter { $0.state != .signedIn }
    ADEKitCard(title: "Sign-ins on ADE Cloud", symbol: "key", count: ready.isEmpty ? nil : "\(ready.count)", flush: true) {
      VStack(alignment: .leading, spacing: 0) {
        if let status = store.signIns {
          if !status.cloud.enabled {
            note("Your sign-ins aren't shared with ADE Cloud. Each cloud computer asks you to sign in on it.")
          } else {
            note(ready.isEmpty
              ? "No sign-in reaches ADE Cloud yet. Sign in to a provider on any of your computers and it reaches your cloud computers."
              : "Your cloud computers sign in with these accounts. A sign-in on any of your computers reaches them in about a minute.")
            ForEach(ready) { tile in
              ADESettingsHairline()
              HStack(spacing: 12) {
                ADEBrandTile(brand: .provider(tile.provider), size: 28)
                VStack(alignment: .leading, spacing: 2) {
                  Text(tile.label)
                    .font(.system(size: 14.5, weight: .medium))
                    .foregroundStyle(ADEColor.textPrimary)
                  Text([tile.account, tile.source].compactMap { $0 }.joined(separator: ". "))
                    .font(.system(size: 12.5))
                    .foregroundStyle(ADEColor.textSecondary)
                    .lineLimit(2)
                }
                Spacer(minLength: 6)
                ADEKitDot(tone: .ok)
              }
              .padding(.horizontal, ADEKit.inset)
              .padding(.vertical, 10)
              .accessibilityElement(children: .combine)
            }
            if !rest.isEmpty {
              ADESettingsHairline()
              VStack(alignment: .leading, spacing: 4) {
                ADEEyebrow("Not signed in")
                Text(rest.map(\.label).joined(separator: ", "))
                  .font(.system(size: 12.5))
                  .foregroundStyle(ADEColor.textSecondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              .padding(.horizontal, ADEKit.inset)
              .padding(.vertical, 10)
            }
          }
          ADESettingsHairline()
          ADESettingsRow(
            title: "Share my sign-ins with ADE Cloud",
            hint: status.cloud.enabled ? "Off: you sign in on each cloud computer yourself." : "On: cloud computers use the accounts you're signed in to on your computers."
          ) {
            Toggle("", isOn: Binding(
              get: { status.cloud.enabled },
              set: { next in Task { await store.setSignInsShared(next) } }
            ))
            .labelsHidden()
            .tint(ADEColor.accent)
            .disabled(store.signInsSaving || !store.syncService.canInvokeRemoteAction("providerLogins.setCloudAll"))
          }
        } else if store.signInsUnreadable {
          note("ADE couldn't read your sign-ins. Pull to read them again.")
        } else if !store.syncService.supportsRemoteAction("providerLogins.status") {
          note("Update ADE on \(store.syncService.machineDisplayName) to see them here.")
        } else {
          note("Reading your sign-ins…")
        }
      }
    }
  }

  private func note(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 13))
      .foregroundStyle(ADEColor.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, ADEKit.inset)
      .padding(.bottom, 12)
  }
}
