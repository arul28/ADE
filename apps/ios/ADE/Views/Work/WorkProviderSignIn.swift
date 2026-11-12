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
      switch kind {
      case .account(let accountProvider):
        let client = ProviderAccountsClient(host: host)
        let accounts = try await client.list(accountProvider)
        let account = accounts.first(where: { $0.id == instanceId })
          ?? accounts.first(where: \.isDefault)
        let target: ProviderAccount
        if let account {
          target = account
        } else {
          target = try await client.create(accountProvider)
        }
        let login = try await client.startLogin(id: target.id, provider: accountProvider)
        guard current == attempt else { return }
        apply(state: login.state, loginId: login.loginId, url: login.url, deviceCode: login.deviceCode, awaitingCode: login.awaitingCode, message: login.message)
      case .cli:
        var args: [String: Any] = ["provider": provider]
        if provider == "kimi" { args["kimiRegion"] = kimiRegion }
        let raw = try await host.runProviderAccountsCommand("ai.cliLoginStart", args: args)
        guard current == attempt else { return }
        applyCli(raw)
      case .antigravity:
        let raw = try await host.runProviderAccountsCommand("ai.antigravitySignInStart", args: ["method": "oauth-personal"])
        guard current == attempt else { return }
        applyAntigravity(raw)
      case .settings:
        phase = .idle
        return
      }
      schedulePoll(attempt: current)
    } catch {
      guard current == attempt else { return }
      phase = .failed
      message = error.localizedDescription
    }
  }

  func submit(code: String) async {
    let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let host, let loginId, !trimmed.isEmpty, !submitting else { return }
    submitting = true
    defer { submitting = false }
    do {
      switch kind {
      case .account:
        let login = try await ProviderAccountsClient(host: host).submitLoginCode(loginId: loginId, code: trimmed)
        apply(state: login.state, loginId: login.loginId, url: login.url, deviceCode: login.deviceCode, awaitingCode: login.awaitingCode, message: login.message)
      case .cli:
        applyCli(try await host.runProviderAccountsCommand("ai.cliLoginSubmitCode", args: ["loginId": loginId, "code": trimmed]))
      case .antigravity:
        applyAntigravity(try await host.runProviderAccountsCommand("ai.antigravitySignInComplete", args: ["flowId": loginId, "callbackUrl": trimmed]))
      case .settings:
        return
      }
    } catch {
      message = error.localizedDescription
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
        } catch {
          guard current == self.attempt else { return }
          self.phase = .failed
          self.message = error.localizedDescription
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
    onDismiss: @escaping () -> Void
  ) {
    self.provider = provider
    self.machineName = machineName
    self.reason = reason
    self.onSignedIn = onSignedIn
    self.onDismiss = onDismiss
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
