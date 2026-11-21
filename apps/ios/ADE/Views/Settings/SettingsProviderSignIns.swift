import Combine
import SwiftUI

/// The account's provider sign-ins on the phone (Cloud 4): the mirror of the
/// desktop's `settings/providers/cloud/*` (`adeCloudSignInModel.ts`,
/// `adeCloudPageModel.ts`, `SignInAccountCard.tsx`, `ProviderSignInsPanel.tsx`).
/// The status it reads is `Services/ProviderLoginsPhoneStatus.swift`; the ADE
/// Cloud page's card (`CloudSignIns.tsx`) is `Views/Cloud/CloudSignInsCard.swift`.
///
/// One read, `providerLogins.status`, on the machine the phone drives: the
/// account part (each sign-in, the computer it came from, whether ADE Cloud
/// uses it) is the same from any of the person's machines, and "In use here"
/// is that machine's own. The writes (`use`, `setCloud`, `setCloudAll`) are
/// account-wide and go to the same machine; only a controlling phone sends
/// them. Nothing here wakes a cloud computer.

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
    switch providerCloudClaudePassNeed(status) {
    case .ended(let at):
      return tile(.notSignedIn, nil, providerCloudPassEndedLine(at))
    case .off:
      return tile(.notSignedIn, nil, "Off for ADE Cloud")
    case .noPass, nil:
      break
    }
    let passes = (status.claudePasses ?? []).filter { $0.unreadable != true && $0.on != false && $0.state != "ended" }
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

/// Why ADE Cloud has no Claude pass that works, from the account's passes
/// (desktop `claudeTile` rows C1, C5 and C6).
enum ProviderCloudClaudePassNeed: Equatable {
  /// C1: the account has no Claude pass.
  case noPass
  /// C5: Claude ended every pass. The date is when the newest one ended.
  case ended(at: Date?)
  /// C6: no pass that still works is on for ADE Cloud.
  case off
}

/// What ADE Cloud lacks to run Claude, or nil when a pass works or the phone
/// can't tell (an older brain, a pass it can't read). Only a definite answer
/// may hold a send. Sign-ins switched off for ADE Cloud are checked by the
/// caller: that is a choice, not a missing pass.
func providerCloudClaudePassNeed(_ status: ProviderLoginsPhoneStatus) -> ProviderCloudClaudePassNeed? {
  guard let passes = status.claudePasses else { return nil }
  if passes.isEmpty { return .noPass }
  // A pass with no state comes from an older brain: not known, never ended.
  let readable = passes.filter { $0.unreadable != true && $0.state != nil }
  guard !readable.isEmpty else { return nil }
  if readable.allSatisfy({ $0.state == "ended" }) {
    let newest = readable.compactMap(\.endedAt).max()
    return .ended(at: newest.map { Date(timeIntervalSince1970: $0 / 1000) })
  }
  if !readable.contains(where: { $0.on != false && $0.state != "ended" }) { return .off }
  return nil
}

/// "today", "yesterday" or "on Nov 3", after "stopped working".
func providerCloudPassEndDay(_ date: Date) -> String {
  if Calendar.current.isDateInToday(date) { return "today" }
  if Calendar.current.isDateInYesterday(date) { return "yesterday" }
  let sameYear = Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year)
  return "on " + (sameYear
    ? date.formatted(.dateTime.month(.abbreviated).day())
    : date.formatted(.dateTime.month(.abbreviated).day().year()))
}

/// "Claude ended your pass on Nov 3" (C5).
func providerCloudPassEndedLine(_ endedAt: Date?) -> String {
  endedAt.map { "Claude ended your pass \(providerCloudPassEndDay($0))" } ?? "Claude ended your pass"
}

/// The words of an ended pass, as desktop's end notice says them
/// (`adeCloudEndNotice.ts`). The phone can't make a pass: it says where to.
func providerCloudPassEndedDetail(_ endedAt: Date?) -> String {
  let stopped = endedAt.map { "stopped working \(providerCloudPassEndDay($0))" } ?? "stopped working"
  return "Claude chats and automations on your ADE Cloud computers \(stopped). ADE can't renew a pass on its own: renew it in the ADE desktop app, in Settings › Providers › ADE Cloud › Claude, and they work again."
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
        ADESettingsNotice(message: "ADE couldn't read your sign-ins on \(syncService.machineDisplayName).", actionTitle: "Retry", action: {
          Task { await model.load() }
        })
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
          switch status.cloud.enabled ? providerCloudClaudePassNeed(status) : nil {
          case .ended(let at):
            ADESettingsNotice(message: "Claude ended your pass for ADE Cloud. \(providerCloudPassEndedDetail(at))", tone: .crit)
          case .off:
            ADESettingsNotice(message: "Every Claude pass is off for ADE Cloud. Turn one on in the ADE desktop app, in Settings › Providers › ADE Cloud › Claude.", tone: .warn)
          case .noPass, nil:
            EmptyView()
          }
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
      } else if model.failed || !model.supported {
        // Opened from a chat, the read can fail where Settings would not show this page.
        ADESettingsNotice(message: "ADE couldn't read your sign-ins. Connect to one of your computers, then try again.", actionTitle: "Retry", action: {
          Task { await model.load() }
        })
      } else {
        ADESettingsRows { ADESettingsLoadingRow(title: "Reading your sign-ins…") }
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
/// drives: read on open, after each write (the write's answer is the new
/// status), when the machine pushes `provider_logins_changed` and when the
/// connection comes back (a push sent while it was down is not replayed). No
/// timer and no poll. The newest read or write's answer wins.
@MainActor
final class ProviderLoginsModel: ObservableObject {
  @Published private(set) var status: ProviderLoginsPhoneStatus?
  @Published private(set) var failed = false
  @Published private(set) var busy: Set<String> = []
  @Published private(set) var pendingAll: Bool?
  @Published var error: String?

  private let host: SyncService?
  private var changeWatch: AnyCancellable?
  /// Bumped by each read and write: only the newest one's answer lands.
  private var request = 0

  init(host: SyncService) {
    self.host = host
    changeWatch = host.$providerLoginsRevision
      .dropFirst()
      .removeDuplicates()
      .sink { [weak self] _ in
        Task { @MainActor in await self?.load() }
      }
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
    request += 1
    let mine = request
    do {
      let read = try await ProviderLoginsPhoneStatus.read(on: host)
      guard mine == request else { return }
      status = read
      failed = false
    } catch {
      guard mine == request else { return }
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
    request += 1
    let mine = request
    do {
      let written = try await ProviderLoginsPhoneStatus.write(method, args: args, on: host)
      if mine == request { status = written }
    } catch {
      self.error = "ADE couldn't change that. \(SyncUserFacingError.message(for: error))"
      ADEHaptics.error()
    }
  }
}
