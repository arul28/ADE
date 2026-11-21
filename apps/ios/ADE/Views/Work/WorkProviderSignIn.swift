import SwiftUI
import UIKit

/// The phone's sign-in card: the twin of desktop `ProviderSignInCard.tsx`.
///
/// A chat's last turn stopped because its agent is signed out on the chat's
/// machine (`errorInfo.agentCli`, read into `WorkChatEnvelope.signedOutAgent`).
/// The card takes the composer's place and runs that provider's own sign-in on
/// the chat's machine, through the same host commands the desktop uses
/// (`providerAccounts.login*` for Claude and Codex, `ai.cliLogin*` for the CLIs
/// ADE signs in headlessly, `ai.antigravitySignIn*`), sent to that machine's
/// connection. The phone only opens the link, shows the code, and passes back
/// a pasted code; the login lands on the machine. Once the machine reads it
/// back, the turn that stopped is sent again.

/// The name a provider's card and transcript line use.
func workProviderSignInLabel(_ provider: String) -> String {
  switch provider.lowercased() {
  case "claude": return "Claude Code"
  case "codex": return "Codex"
  case "cursor": return "Cursor"
  case "copilot": return "GitHub Copilot"
  case "grok": return "Grok"
  case "kimi": return "Kimi Code"
  case "droid": return "Droid"
  case "muse": return "Muse Code"
  case "devin": return "Devin"
  case "antigravity": return "Antigravity"
  case "qwen": return "Qwen Code"
  case "opencode": return "OpenCode"
  case "pi": return "Pi"
  default: return provider
  }
}

/// Who the person signs in with: "Continue with Claude". Nil when the sign-in
/// belongs to the agent itself: "Sign in to Codex" runs `codex login`, and
/// "Continue with ChatGPT" is the label of OpenAI's separate app program.
private func workProviderSignInVia(_ provider: String) -> String? {
  switch provider.lowercased() {
  case "claude": return "Claude"
  case "codex": return nil
  case "copilot": return "GitHub"
  case "grok": return "xAI"
  case "kimi": return "Kimi"
  case "droid": return "Factory"
  case "muse": return "Meta"
  case "devin": return "Devin"
  case "antigravity": return "Google"
  default: return workProviderSignInLabel(provider)
  }
}

enum WorkProviderSignInKind: Equatable {
  /// A Claude or Codex account on the machine.
  case account(ProviderAccountProvider)
  /// An agent CLI ADE signs in headlessly there.
  case cli
  case antigravity
  /// Signed in by a key or a sub-provider, from Settings on that machine.
  case settings
}

func workProviderSignInKind(_ provider: String) -> WorkProviderSignInKind {
  let id = provider.lowercased()
  if let account = ProviderAccountProvider(rawValue: id) { return .account(account) }
  switch id {
  case "copilot", "grok", "kimi", "droid", "muse", "devin": return .cli
  case "antigravity": return .antigravity
  default: return .settings
  }
}

/// The signed-out lines a later turn got past (an answer or a completed turn
/// after them), so the transcript reads "signed in again" there. Empty unless
/// the chat was ever signed out.
func workSignInRecoveredIds(_ transcript: [WorkChatEnvelope]) -> Set<String> {
  guard transcript.contains(where: { $0.signedOutAgent != nil }) else { return [] }
  var recovered = Set<String>()
  var workedAfter = false
  for envelope in transcript.reversed() {
    if envelope.signedOutAgent != nil {
      if workedAfter { recovered.insert(envelope.id) }
      continue
    }
    switch envelope.event {
    case .assistantText(let text, _, _) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
      workedAfter = true
    case .done(let status, _, _, _, _, _, _) where status == "completed":
      workedAfter = true
    default:
      break
    }
  }
  return recovered
}

/// The chat's last turn stopped because its own agent is signed out, and
/// nothing has worked since: the error's envelope id (it keys the card, so a
/// dismissed card comes back for the next failure), or nil.
func workLatestSignInFailure(_ transcript: [WorkChatEnvelope], provider: String?) -> String? {
  guard let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !provider.isEmpty else {
    return nil
  }
  for envelope in transcript.suffix(80).reversed() {
    if let agent = envelope.signedOutAgent {
      // A tool's own CLI being signed out is not the chat's agent.
      return agent.lowercased() == provider ? envelope.id : nil
    }
    switch envelope.event {
    case .assistantText(let text, _, _) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
      return nil
    case .toolCall, .toolResult, .command:
      return nil
    case .done(let status, _, _, _, _, _, _) where status == "completed":
      return nil
    case .status(let turnStatus, _, _) where turnStatus == "started":
      return nil
    default:
      continue
    }
  }
  return nil
}

/// Why the card shows: a turn stopped on the sign-in, or the machine already
/// says the agent has no login (before anything is sent).
enum WorkProviderSignInReason: Equatable {
  case failedTurn
  case noLogin
}

/// Before a send: the chat machine's `ai.getStatus` answer says this
/// provider's agent is there but has no login and no other way to run, the
/// same test as desktop's "no-login" card. Keys and sub-providers never
/// count; their status is not a login ADE can read.
func workProviderSignedOutBeforeSend(_ status: Any, provider: String) -> Bool {
  let id = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard workProviderSignInKind(id) != .settings,
        let connections = (status as? [String: Any])?["providerConnections"] as? [String: Any],
        let connection = connections[id] as? [String: Any] else { return false }
  return connection["runtimeDetected"] as? Bool == true
    && connection["authAvailable"] as? Bool == false
    // A login ADE cannot see but the machine still runs with is not a missing one.
    && connection["runtimeAvailable"] as? Bool == false
}

/// A failed sign-in command in words. A connection that is not ready says
/// so (never its "ready" line as an error); anything else is the machine's
/// own message.
func workSignInFailureMessage(_ error: Error) -> String {
  isSyncHostUnavailableError(error) ? SyncUserFacingError.message(for: error) : error.localizedDescription
}

/// A sign-in page link the card may open: http(s) only, whatever a CLI printed.
func workSignInPageURL(_ url: String?) -> URL? {
  guard let url, let link = URL(string: url), let scheme = link.scheme?.lowercased(),
        scheme == "https" || scheme == "http" else { return nil }
  return link
}

/// One sign-in on the chat's machine, whichever host flow the provider uses.
@MainActor
final class WorkProviderSignInController: ObservableObject {
  enum Phase: Equatable { case idle, starting, waiting, verifying, done, failed }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var url: String?
  @Published private(set) var deviceCode: String?
  @Published private(set) var awaitingCode = false
  @Published private(set) var submitting = false
  @Published var message: String?

  let provider: String
  let kind: WorkProviderSignInKind
  private let host: ProviderAccountsHost?
  private let instanceId: String?
  private var loginId: String?
  private var pollTask: Task<Void, Never>?
  private var openedLoginId: String?
  private var attempt = 0

  init(provider: String, host: ProviderAccountsHost?, instanceId: String?) {
    self.provider = provider.lowercased()
    self.kind = workProviderSignInKind(provider)
    self.host = host
    self.instanceId = instanceId
  }

  #if DEBUG
  /// Fixture screens: a sign-in frozen at one phase, with nothing to reach.
  convenience init(fixtureProvider provider: String, phase: Phase, url: String?, deviceCode: String?, awaitingCode: Bool = false) {
    self.init(provider: provider, host: nil, instanceId: nil)
    self.phase = phase
    self.url = url
    self.deviceCode = deviceCode
    self.awaitingCode = awaitingCode
  }
  #endif

  var signingIn: Bool { phase == .starting || phase == .waiting || phase == .verifying }
  /// The phone has a connection to the chat's machine to sign in on.
  var canReachMachine: Bool { host != nil }

  func start(kimiRegion: String = "global") async {
    guard let host, !signingIn else { return }
    await stopOnHost()
    attempt += 1
    let current = attempt
    phase = .starting
    message = nil
    url = nil
    deviceCode = nil
    awaitingCode = false
    do {
      let started = try await retryingWhileHostWakes(attempt: current) {
        try await self.begin(on: host, kimiRegion: kimiRegion, attempt: current)
      }
      if started { schedulePoll(attempt: current) }
    } catch {
      guard current == attempt else { return }
      phase = .failed
      message = workSignInFailureMessage(error)
    }
  }

  /// The account this controller made on the machine, for a retry.
  private var createdAccountId: String?

  /// Starts the provider's sign-in on the machine. False when there is
  /// nothing to wait for (a newer attempt took over, or no flow here).
  private func begin(on host: ProviderAccountsHost, kimiRegion: String, attempt current: Int) async throws -> Bool {
    switch kind {
    case .account(let accountProvider):
      let client = ProviderAccountsClient(host: host)
      let accounts = try await client.list(accountProvider)
      // A retry after a create that went through uses that account, never a second one.
      let account = accounts.first(where: { $0.id == instanceId })
        ?? accounts.first(where: { $0.id == createdAccountId })
        ?? accounts.first(where: \.isDefault)
      let target: ProviderAccount
      if let account {
        target = account
      } else {
        target = try await client.create(accountProvider)
        createdAccountId = target.id
      }
      let login = try await client.startLogin(id: target.id, provider: accountProvider)
      guard current == attempt else { return false }
      apply(state: login.state, loginId: login.loginId, url: login.url, deviceCode: login.deviceCode, awaitingCode: login.awaitingCode, message: login.message)
    case .cli:
      var args: [String: Any] = ["provider": provider]
      if provider == "kimi" { args["kimiRegion"] = kimiRegion }
      let raw = try await host.runProviderAccountsCommand("ai.cliLoginStart", args: args)
      guard current == attempt else { return false }
      applyCli(raw)
    case .antigravity:
      let raw = try await host.runProviderAccountsCommand("ai.antigravitySignInStart", args: ["method": "oauth-personal"])
      guard current == attempt else { return false }
      applyAntigravity(raw)
    case .settings:
      phase = .idle
      return false
    }
    return true
  }

  /// Waits between tries when the machine answers `host_unavailable`: its
  /// project connection is restarting, as while a cloud computer wakes. That
  /// state passes by itself (`isSyncHostUnavailableError`), so a press that
  /// lands in it tries again before the card shows a failure.
  static let hostWakeRetrySeconds: [UInt64] = [2, 3, 5]

  /// Runs `body`, again after each wait while the machine is not ready. The
  /// machine refused the command, so it never ran and a retry is safe.
  private func retryingWhileHostWakes<T>(attempt current: Int, _ body: () async throws -> T) async throws -> T {
    var waits = Self.hostWakeRetrySeconds[...]
    while true {
      do {
        return try await body()
      } catch let error where isSyncHostUnavailableError(error) && !waits.isEmpty && current == attempt {
        let wait = waits.removeFirst()
        try await Task.sleep(nanoseconds: wait * 1_000_000_000)
        guard current == attempt else { throw error }
      }
    }
  }

  func submit(code: String) async {
    let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let host, let loginId, !trimmed.isEmpty, !submitting else { return }
    submitting = true
    defer { submitting = false }
    let kind = self.kind
    do {
      try await retryingWhileHostWakes(attempt: attempt) {
        switch kind {
        case .account:
          let login = try await ProviderAccountsClient(host: host).submitLoginCode(loginId: loginId, code: trimmed)
          self.apply(state: login.state, loginId: login.loginId, url: login.url, deviceCode: login.deviceCode, awaitingCode: login.awaitingCode, message: login.message)
        case .cli:
          self.applyCli(try await host.runProviderAccountsCommand("ai.cliLoginSubmitCode", args: ["loginId": loginId, "code": trimmed]))
        case .antigravity:
          self.applyAntigravity(try await host.runProviderAccountsCommand("ai.antigravitySignInComplete", args: ["flowId": loginId, "callbackUrl": trimmed]))
        case .settings:
          return
        }
      }
    } catch {
      message = workSignInFailureMessage(error)
    }
  }

  func cancel() async {
    attempt += 1
    await stopOnHost()
    phase = .idle
    url = nil
    deviceCode = nil
    awaitingCode = false
  }

  /// Stops the machine's sign-in when the card goes away mid-flow, so its CLI
  /// does not hold on until its timeout, and leaves the card ready to start
  /// again if SwiftUI shows this same card later.
  func close() {
    attempt += 1
    let wasSigningIn = signingIn
    let stop = detachLogin()
    phase = .idle
    url = nil
    deviceCode = nil
    awaitingCode = false
    guard wasSigningIn, let stop else { return }
    Task { await stop() }
  }

  private func stopOnHost() async {
    guard signingIn, let stop = detachLogin() else {
      pollTask?.cancel()
      pollTask = nil
      return
    }
    await stop()
  }

  /// Takes the running login off the card and returns the call that stops it
  /// on the machine. Bound to that login's id, so it cannot stop a sign-in
  /// started after it.
  private func detachLogin() -> (() async -> Void)? {
    pollTask?.cancel()
    pollTask = nil
    guard let host, let loginId else { return nil }
    self.loginId = nil
    let kind = self.kind
    return {
      switch kind {
      case .account:
        _ = try? await ProviderAccountsClient(host: host).cancelLogin(loginId: loginId)
      case .cli:
        _ = try? await host.runProviderAccountsCommand("ai.cliLoginCancel", args: ["loginId": loginId])
      case .antigravity:
        _ = try? await host.runProviderAccountsCommand("ai.antigravitySignInCancel", args: ["flowId": loginId])
      case .settings:
        break
      }
    }
  }

  private func schedulePoll(attempt current: Int) {
    pollTask?.cancel()
    guard signingIn else { return }
    pollTask = Task { [weak self] in
      // Status reads the machine refused while its connection restarts.
      var hostWaits = 0
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        guard let self, !Task.isCancelled, current == self.attempt, self.signingIn, let host = self.host else { return }
        do {
          switch self.kind {
          case .account:
            guard let loginId = self.loginId else { return }
            let login = try await ProviderAccountsClient(host: host).loginStatus(loginId: loginId)
            guard current == self.attempt else { return }
            self.apply(state: login.state, loginId: login.loginId, url: login.url, deviceCode: login.deviceCode, awaitingCode: login.awaitingCode, message: login.message)
          case .cli:
            guard let loginId = self.loginId else { return }
            let raw = try await host.runProviderAccountsCommand("ai.cliLoginStatus", args: ["loginId": loginId])
            guard current == self.attempt else { return }
            self.applyCli(raw)
          case .antigravity:
            let raw = try await host.runProviderAccountsCommand("ai.antigravitySignInStatus", args: [:])
            guard current == self.attempt else { return }
            self.applyAntigravity(raw)
          case .settings:
            return
          }
          hostWaits = 0
        } catch {
          guard current == self.attempt else { return }
          // A restarting connection is not a failed sign-in: read again next tick.
          if isSyncHostUnavailableError(error) && hostWaits < 10 {
            hostWaits += 1
            continue
          }
          self.phase = .failed
          self.message = workSignInFailureMessage(error)
          return
        }
      }
    }
  }

  private func apply(state: String, loginId: String, url: String?, deviceCode: String?, awaitingCode: Bool, message: String?) {
    self.loginId = loginId
    self.url = url
    self.deviceCode = deviceCode
    self.awaitingCode = awaitingCode
    switch state {
    case "succeeded":
      // The machine has a sign-in now: its free-models answer is out of date.
      if let host { WorkFreeModelsStatusStore.shared.invalidate(for: host) }
      phase = .done
      self.message = nil
    case "verifying":
      phase = .verifying
    case "running":
      phase = .waiting
      openOnce(loginId: loginId, url: url)
    case "cancelled":
      phase = .idle
    default:
      phase = .failed
      self.message = message ?? "The sign-in did not finish. Try again."
    }
  }

  private func applyCli(_ raw: Any) {
    guard let dict = raw as? [String: Any], let loginId = dict["loginId"] as? String else { return }
    apply(
      state: dict["state"] as? String ?? "failed",
      loginId: loginId,
      url: dict["url"] as? String,
      deviceCode: dict["deviceCode"] as? String,
      awaitingCode: dict["awaitingCode"] as? Bool ?? false,
      message: dict["message"] as? String
    )
  }

  private func applyAntigravity(_ raw: Any) {
    guard let dict = raw as? [String: Any] else { return }
    let flowId = dict["flowId"] as? String ?? loginId ?? ""
    let phaseText = dict["phase"] as? String ?? "failed"
    let state: String
    switch phaseText {
    case "succeeded": state = "succeeded"
    case "verifying": state = "verifying"
    case "starting", "waiting": state = "running"
    case "cancelled", "idle": state = "cancelled"
    default: state = "failed"
    }
    apply(
      state: state,
      loginId: flowId,
      url: dict["authorizationUrl"] as? String,
      deviceCode: nil,
      // The phone is never the machine, so Google's return address is pasted back.
      awaitingCode: dict["acceptsCallbackUrl"] as? Bool ?? false,
      message: dict["message"] as? String
    )
  }

  /// The sign-in page opens in Safari once per sign-in.
  private func openOnce(loginId: String, url: String?) {
    guard let link = workSignInPageURL(url), openedLoginId != loginId else { return }
    openedLoginId = loginId
    UIApplication.shared.open(link)
  }
}

/// The card in the composer's place.
struct WorkProviderSignInCard: View {
  let provider: String
  let machineName: String
  let reason: WorkProviderSignInReason
  let onSignedIn: () -> Void
  let onDismiss: () -> Void
  /// A brand-new person on a machine with free models: switch the chat to the
  /// machine's free default instead of signing in. Nil hides the offer.
  let onUseFreeModel: (() -> Void)?
  @StateObject private var controller: WorkProviderSignInController
  @State private var code = ""
  @State private var copied = false
  @State private var kimiRegion = "global"

  init(
    provider: String,
    machineName: String,
    host: ProviderAccountsHost?,
    instanceId: String?,
    reason: WorkProviderSignInReason = .failedTurn,
    onSignedIn: @escaping () -> Void,
    onDismiss: @escaping () -> Void,
    onUseFreeModel: (() -> Void)? = nil
  ) {
    self.provider = provider
    self.machineName = machineName
    self.reason = reason
    self.onSignedIn = onSignedIn
    self.onDismiss = onDismiss
    self.onUseFreeModel = onUseFreeModel
    _controller = StateObject(wrappedValue: WorkProviderSignInController(provider: provider, host: host, instanceId: instanceId))
  }

  private var label: String { workProviderSignInLabel(provider) }
  private var tint: Color { providerTint(provider) }
  private var linkHost: String? { controller.url.flatMap { URL(string: $0)?.host }.map { $0.replacingOccurrences(of: "www.", with: "") } }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        WorkProviderLogo(provider: provider, tint: tint, size: 30)
        VStack(alignment: .leading, spacing: 2) {
          Text(reason == .failedTurn ? "Sign in to \(label) again" : "Sign in to \(label)")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("on \(machineName)")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
        Spacer(minLength: 0)
        Button {
          controller.close()
          onDismiss()
        } label: {
          Image(systemName: "xmark")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 28, height: 28)
        }
        .accessibilityLabel("Not now")
      }

      Text(reason == .noLogin
        ? "\(label) isn't signed in on \(machineName) yet."
        : controller.kind == .settings
          ? "\(label) is signed out on \(machineName). Sign it in from Settings › Providers on that computer, then send again."
          : "\(label) is signed out on \(machineName). Your message sends again as soon as you're back in.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      if controller.kind != .settings {
        if controller.canReachMachine {
          actionRow
        } else {
          Text("The phone can't reach \(machineName) right now. Reconnect to it to sign in.")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      if let onUseFreeModel, !controller.signingIn, controller.phase != .done {
        freeModelOffer(onUseFreeModel)
      }

      if let message = controller.message, !message.isEmpty {
        Text(message)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(14)
    .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(tint.opacity(0.35), lineWidth: 1))
    .onChange(of: controller.phase) { _, phase in
      if phase == .done { onSignedIn() }
    }
    .onDisappear { controller.close() }
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private var actionRow: some View {
    if controller.phase == .waiting || controller.phase == .verifying {
      // The same parts as the Settings sheet: the account note, then the steps
      // with the code, its QR and Open sign-in page.
      VStack(alignment: .leading, spacing: 10) {
        Text(providerSignInAccountNote(provider: provider, expected: nil))
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        ProviderSignInStepList(controller: controller, code: $code, compact: true)
        cancelButton
      }
    } else {
      if provider.lowercased() == "kimi" && !controller.signingIn {
        Picker("Kimi account region", selection: $kimiRegion) {
          Text("kimi.ai").tag("global")
          Text("kimi.com (China)").tag("mainland-cn")
        }
        .pickerStyle(.segmented)
      }
      HStack(spacing: 12) {
        Button {
          copied = false
          Task { await controller.start(kimiRegion: kimiRegion) }
        } label: {
          HStack(spacing: 6) {
            if controller.signingIn || controller.phase == .done {
              ProgressView().controlSize(.small).tint(.white)
            }
            Text(primaryTitle)
              .font(.subheadline.weight(.semibold))
          }
          .frame(maxWidth: .infinity)
          .frame(height: 40)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
        .disabled(controller.signingIn || controller.phase == .done)
        if controller.signingIn {
          cancelButton
        }
      }
    }
  }

  /// The other way in for a new person: chat now on a free model.
  private func freeModelOffer(_ action: @escaping () -> Void) -> some View {
    HStack(spacing: 8) {
      Text("No account yet?")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
      Button(action: action) {
        Label("Use a free model", systemImage: "gift")
          .font(.footnote.weight(.semibold))
      }
      .buttonStyle(.plain)
      .foregroundStyle(ADEColor.success)
      .accessibilityIdentifier("Work.SignIn.UseFreeModel")
      .accessibilityHint("Switches this chat to a free model. No account or key needed.")
      Spacer(minLength: 0)
    }
  }

  private var primaryTitle: String {
    switch controller.phase {
    case .starting: return "Starting…"
    case .verifying, .done: return "Checking…"
    case .waiting: return linkHost.map { "Waiting for \($0)…" } ?? "Waiting for the browser…"
    case .failed: return "Try again"
    case .idle:
      return workProviderSignInVia(provider).map { "Continue with \($0)" }
        ?? "Sign in to \(workProviderSignInLabel(provider))"
    }
  }

  private var cancelButton: some View {
    Button("Cancel") {
      Task { await controller.cancel() }
    }
    .font(.footnote)
    .foregroundStyle(ADEColor.textMuted)
  }
}

// MARK: - Claude on ADE Cloud

/// The account's answer on Claude for a chat on an ADE Cloud computer. A
/// cloud computer takes Claude from the account's Claude pass, never from a
/// sign-in on that one computer, so this is read from the account
/// (`providerLogins.status`, the same from every machine of the account),
/// like desktop's `useAdeCloudSignInNeed`. Only a definite answer is kept.
enum WorkAdeCloudClaudeRead: Equatable {
  /// A pass works for ADE Cloud.
  case passWorks
  /// ADE Cloud has no Claude pass that works.
  case needsPass(ProviderCloudClaudePassNeed)
  /// Sign-ins are off for ADE Cloud: the person signs in on each cloud
  /// computer, so the computer's own sign-in card applies.
  case signInsOff
}

/// One definite account answer, for the chat it was read for.
struct WorkAdeCloudClaudeReadState: Equatable {
  let key: String
  let read: WorkAdeCloudClaudeRead
  let status: ProviderLoginsPhoneStatus
}

/// `pass-<id>` → `claude-pass/<id>`: the pass a chat's account is; nil for
/// any other account (desktop `claudePassKeyOfAccountId`).
func workClaudePassKey(ofAccountId id: String?) -> String? {
  guard let id = id?.trimmingCharacters(in: .whitespacesAndNewlines), id.hasPrefix("pass-") else { return nil }
  let rest = id.dropFirst("pass-".count)
  guard !rest.isEmpty, rest.allSatisfy({ $0.isLetter || $0.isNumber }) else { return nil }
  return "claude-pass/\(rest)"
}

/// The account's status as a Claude answer for ADE Cloud, or nil when the
/// machine could not read the account. `accountId` is the chat's own
/// account: a chat on one pass stays on it, so another pass that works does
/// not fix it.
func workAdeCloudClaudeRead(_ status: ProviderLoginsPhoneStatus, accountId: String? = nil) -> WorkAdeCloudClaudeRead? {
  guard status.readsAccount else { return nil }
  if !status.cloud.enabled { return .signInsOff }
  if let passKey = workClaudePassKey(ofAccountId: accountId),
     let pass = status.claudePasses?.first(where: { $0.key == passKey && $0.unreadable != true }) {
    if pass.state == "ended" { return .needsPass(.ended(at: pass.endedAt.map { Date(timeIntervalSince1970: $0 / 1000) })) }
    if pass.on == false { return .needsPass(.off) }
    return pass.state != nil ? .passWorks : nil
  }
  if let need = providerCloudClaudePassNeed(status) { return .needsPass(need) }
  // Passes this brain can't read, or none it knows the state of: not known.
  guard let passes = status.claudePasses,
        passes.contains(where: { $0.unreadable != true && $0.state != nil && $0.state != "ended" && $0.on != false })
  else { return nil }
  return .passWorks
}

/// The card in the composer's place for Claude on an ADE Cloud computer: it
/// points at the account's Claude pass, the one thing that fixes it. The
/// pass is made and renewed in the ADE desktop app; the button opens
/// Settings › Providers › ADE Cloud › Claude, which says where and how.
struct WorkAdeCloudClaudePassCard: View {
  /// What the account says is wrong; nil when the phone could not read it.
  let need: ProviderCloudClaudePassNeed?
  let reason: WorkProviderSignInReason
  /// The account now has a pass that works: a stopped turn can go again.
  let passWorks: Bool
  let onOpenPass: () -> Void
  let onSendAgain: () -> Void
  let onDismiss: () -> Void

  private var tint: Color { providerTint("claude") }
  private var ready: Bool { passWorks && reason == .failedTurn }

  var title: String {
    if ready { return "Your Claude pass works again" }
    switch need {
    case .ended: return "Claude ended your pass"
    case .off: return "Claude is off"
    case .noPass: return "Approve a Claude pass"
    case nil: return "No Claude pass works"
    }
  }

  var detail: String {
    if ready { return "Send your message again to run it on ADE Cloud." }
    let again = reason == .failedTurn ? " Then send your message again." : ""
    switch need {
    case .ended(let at):
      return providerCloudPassEndedDetail(at) + again
    case .off:
      return "Every Claude pass is off for ADE Cloud. Turn one on in the ADE desktop app, in Settings › Providers › ADE Cloud › Claude." + again
    case .noPass:
      return "ADE Cloud never uses Claude's own login. One approve in the ADE desktop app lets your cloud chats use your Claude plan for about a year." + again
    case nil:
      return "Cloud computers use your account's Claude pass, not a sign-in on the computer. Renew the pass in the ADE desktop app, in Settings › Providers › ADE Cloud › Claude." + again
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        WorkProviderLogo(provider: "claude", tint: tint, size: 30)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          Text("on ADE Cloud")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
        Spacer(minLength: 0)
        Button(action: onDismiss) {
          Image(systemName: "xmark")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 28, height: 28)
        }
        .accessibilityLabel("Not now")
      }

      Text(detail)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      Button(action: ready ? onSendAgain : onOpenPass) {
        Text(ready ? "Send again" : "Open Claude pass")
          .font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity)
          .frame(height: 40)
      }
      .buttonStyle(.borderedProminent)
      .tint(tint)
      .accessibilityIdentifier(ready ? "Work.SignIn.CloudPass.SendAgain" : "Work.SignIn.CloudPass.Open")
    }
    .padding(14)
    .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(tint.opacity(0.35), lineWidth: 1))
    .accessibilityElement(children: .contain)
  }
}

/// Settings › Providers › ADE Cloud › Claude in a sheet, opened from a
/// chat's pass card. The account's sign-ins, read on the machine the phone
/// drives (account-wide, so any of the person's machines answers the same).
struct WorkAdeCloudClaudePassSheet: View {
  @StateObject private var model: ProviderLoginsModel
  @Environment(\.dismiss) private var dismiss
  private let loads: Bool

  init(syncService: SyncService) {
    _model = StateObject(wrappedValue: ProviderLoginsModel(host: syncService))
    loads = true
  }

  /// On the machine that answered the chat's read, starting from its answer.
  init(readHost: ProviderAccountsHost, status: ProviderLoginsPhoneStatus?, changes: SyncService?) {
    _model = StateObject(wrappedValue: ProviderLoginsModel(readHost: readHost, status: status, changes: changes))
    loads = true
  }

  #if DEBUG
  init(fixture: ProviderLoginsPhoneStatus) {
    _model = StateObject(wrappedValue: ProviderLoginsModel(fixture: fixture))
    loads = false
  }
  #endif

  var body: some View {
    NavigationStack {
      ProviderCloudProviderPage(model: model, provider: "claude")
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Done") { dismiss() }
          }
        }
    }
    .task {
      if loads { await model.load() }
    }
  }
}
