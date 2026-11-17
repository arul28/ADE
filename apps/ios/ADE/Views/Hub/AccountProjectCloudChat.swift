import SwiftUI
import UIKit

// The account project screen's chat on ADE Cloud, for a person with no
// computer of their own: a composer (the message, a model, "Runs on ADE
// Cloud", Send) and one setup card per launch (Computer started, Cloned repo,
// Sign in to <provider>, Send your message). The web project page has the
// same parts (`AccountProjectSections.tsx`, `CloudSetupCard.tsx`).

/// The composer. The first message makes the cloud computer; the server keeps
/// the message, so the app may close.
struct AccountProjectCloudComposer: View {
  let project: AccountProject
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var text = ""
  @State private var provider: String?
  @State private var modelId: String?
  @State private var sending = false
  @FocusState private var focused: Bool

  private var origin: String { "\(project.host)/\(project.owner)/\(project.name)".lowercased() }
  private var pickedProvider: CloudCatalogProvider? {
    launches.catalog?.providers.first { $0.provider == provider }
  }
  private var desktopOnly: Bool { pickedProvider?.remoteSignIn == "desktop" }
  private var canSend: Bool {
    !sending && !desktopOnly && provider != nil && modelId != nil
      && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ZStack(alignment: .topLeading) {
        if text.isEmpty {
          Text("What should the agent do?")
            .font(.system(size: 15))
            .foregroundStyle(ADEColor.textMuted)
            .padding(.horizontal, 5)
            .padding(.vertical, 8)
            .allowsHitTesting(false)
        }
        TextEditor(text: $text)
          .font(.system(size: 15))
          .foregroundStyle(ADEColor.textPrimary)
          .scrollContentBackground(.hidden)
          .focused($focused)
          .frame(minHeight: 84, maxHeight: 180)
          .accessibilityLabel("Message for the agent")
      }
      .padding(8)
      .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

      HStack(spacing: 8) {
        modelMenu
        Spacer(minLength: 4)
        Button {
          send()
        } label: {
          if sending {
            ProgressView().controlSize(.small).tint(.white)
          } else {
            Label("Send", systemImage: "arrow.up")
          }
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true))
        .disabled(!canSend)
        .accessibilityHint("Starts a computer on ADE Cloud for this project and sends the message")
      }

      Text(footnote)
        .font(.system(size: 12))
        .foregroundStyle(desktopOnly ? ADEColor.warning : ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)

      if let error = launches.catalogError, launches.catalog == nil {
        ADESettingsNotice(message: "Couldn't load the models. \(error)", tone: .crit, actionTitle: "Try again") {
          Task { await launches.loadCatalogIfNeeded(using: syncService) }
        }
      }
    }
    .padding(14)
    .adeKitCard(padding: nil)
    .task {
      await launches.loadCatalogIfNeeded(using: syncService)
      pickDefault()
    }
    .onChange(of: launches.catalog) { _, _ in pickDefault() }
  }

  private var footnote: String {
    if desktopOnly {
      return "\(pickedProvider?.label ?? "This provider") signs in only in ADE desktop. Pick another model, or sign in there."
    }
    return "Runs on ADE Cloud. The first message starts a computer for this project."
  }

  private var modelMenu: some View {
    Menu {
      ForEach(launches.catalog?.providers ?? [], id: \.provider) { entry in
        Section(entry.label) {
          ForEach(entry.models, id: \.id) { model in
            Button {
              provider = entry.provider
              modelId = model.id
            } label: {
              if entry.provider == provider && model.id == modelId {
                Label(model.displayName, systemImage: "checkmark")
              } else {
                Text(model.displayName)
              }
            }
          }
        }
      }
    } label: {
      HStack(spacing: 5) {
        Text(modelLabel)
          .font(.system(size: 13, weight: .medium))
          .lineLimit(1)
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 10, weight: .semibold))
      }
      .foregroundStyle(ADEColor.textPrimary)
      .padding(.horizontal, 10)
      .frame(minHeight: 34)
      .background(ADEColor.textPrimary.opacity(0.07), in: Capsule())
    }
    .disabled(launches.catalog == nil)
    .accessibilityLabel("Model, \(modelLabel)")
  }

  private var modelLabel: String {
    guard let pickedProvider, let modelId else { return launches.catalog == nil ? "Loading models…" : "Pick a model" }
    return pickedProvider.models.first { $0.id == modelId }?.displayName ?? modelId
  }

  private func pickDefault() {
    guard provider == nil, let pick = launches.defaultModel() else { return }
    provider = pick.provider
    modelId = pick.modelId
  }

  private func send() {
    guard canSend, let provider, let modelId else { return }
    let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
    sending = true
    focused = false
    Task {
      await launches.start(
        accountProjectId: project.id,
        origin: origin,
        prompt: prompt,
        provider: provider,
        modelId: modelId,
        using: syncService
      )
      // Text typed while the send was out stays.
      if text.trimmingCharacters(in: .whitespacesAndNewlines) == prompt { text = "" }
      sending = false
    }
  }
}

/// One launch: the four steps, the message and what to do next.
struct AccountProjectCloudSetupCard: View {
  let entry: AccountCloudLaunchStore.Entry
  /// The chat is running: open the project, where the chat lists.
  var onOpenChat: () -> Void = {}
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var retrying = false
  @State private var cancelling = false
  @State private var cancelError: String?
  @Environment(\.openURL) private var openURL

  private var record: CloudLaunchRecord? { entry.record }
  private var steps: CloudSetupStepStates {
    var states = cloudSetupStepStates(record)
    if entry.startError != nil { states.computer = .failed }
    return states
  }
  private var failed: Bool { entry.startError != nil || record?.failed == true }
  private var running: Bool { record?.sessionId != nil || record?.state == "running" || record?.state == "done" }
  private var providerLabel: String {
    if let label = record?.signIn?.label, !label.isEmpty { return label }
    let id = entry.provider ?? record?.provider
    return launches.catalog?.providers.first { $0.provider == id }?.label ?? (id.map { $0.capitalized } ?? "your provider")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.system(size: 14.5, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)

      VStack(alignment: .leading, spacing: 2) {
        stepRow("Computer started", steps.computer)
        if record?.state == "needs_approval", let link = record?.approvalUrl.flatMap(URL.init(string:)) {
          HStack(spacing: 8) {
            Text("Confirm the computer's sign-in to your account.")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textSecondary)
            Button("Confirm") { openURL(link) }
              .buttonStyle(ADEKitButtonStyle())
          }
          .padding(.leading, 30)
          .padding(.vertical, 4)
        }
        stepRow("Cloned repo", steps.repo)
        stepRow("Sign in to \(providerLabel)", steps.signIn)
        if steps.signIn == .waiting, let signIn = record?.signIn {
          AccountProjectCloudSignInDetail(signIn: signIn, instanceId: record?.instanceId, launchId: entry.launchId)
            .padding(.leading, 30)
            .padding(.vertical, 6)
        }
        stepRow("Send your message", steps.send)
      }

      if !entry.prompt.isEmpty {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(entry.prompt)
            .font(.system(size: 13.5))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(3)
          Spacer(minLength: 6)
          ADEKitTag(text: messageTag.text, tone: messageTag.tone)
        }
        .padding(10)
        .background(ADEColor.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      }

      if failed {
        VStack(alignment: .leading, spacing: 8) {
          Text("\(entry.startError ?? record?.error ?? "ADE Cloud didn't say why.") Your message is not sent.")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Button {
            retrying = true
            Task {
              await launches.retry(entry.launchId, using: syncService)
              retrying = false
            }
          } label: {
            if retrying { ProgressView().controlSize(.small) } else { Text("Retry") }
          }
          .buttonStyle(ADEKitButtonStyle(tone: .crit))
          .disabled(retrying || (entry.body == nil && entry.record?.request == nil))
        }
      } else if running {
        Button("Open chat", action: onOpenChat)
          .buttonStyle(ADEKitButtonStyle(prominent: true))
      } else {
        Text("You can close the app. ADE Cloud keeps your message and sends it when the agent is ready.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
        if record != nil, record?.state != "cancelled" {
          Button {
            cancelling = true
            cancelError = nil
            Task {
              cancelError = await launches.cancel(entry.launchId, using: syncService)
              cancelling = false
            }
          } label: {
            if cancelling { ProgressView().controlSize(.small) } else { Text("Cancel") }
          }
          .buttonStyle(ADEKitButtonStyle())
          .disabled(cancelling)
        }
        if let cancelError {
          Text("The chat wasn't cancelled. \(cancelError)")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .padding(14)
    .adeKitCard(padding: nil)
  }

  private var title: String {
    if failed { return "ADE Cloud couldn't start this chat" }
    if running { return "The chat is running" }
    if record?.state == "waiting_for_sign_in" { return "Sign in to \(providerLabel) to go on" }
    return "Setting up ADE Cloud"
  }

  private var messageTag: (text: String, tone: ADEKitTone) {
    if failed { return ("Not sent", .crit) }
    if steps.send == .done { return ("Sent", .ok) }
    return ("Waiting", .neutral)
  }

  private func stepRow(_ label: String, _ state: CloudSetupStepState) -> some View {
    HStack(spacing: 10) {
      stepIcon(state)
        .frame(width: 20, height: 20)
      Text(label)
        .font(.system(size: 14))
        .foregroundStyle(state == .todo ? ADEColor.textSecondary : ADEColor.textPrimary)
      Spacer(minLength: 0)
    }
    .frame(minHeight: 34)
    .accessibilityElement(children: .combine)
    .accessibilityValue(stateWord(state))
  }

  @ViewBuilder
  private func stepIcon(_ state: CloudSetupStepState) -> some View {
    switch state {
    case .done:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(ADEColor.success)
    case .failed:
      Image(systemName: "xmark.circle.fill").foregroundStyle(ADEColor.danger)
    case .running:
      ProgressView().controlSize(.small)
    case .waiting:
      Image(systemName: "hand.raised.circle.fill").foregroundStyle(ADEColor.warning)
    case .todo:
      Image(systemName: "circle").foregroundStyle(ADEColor.textMuted)
    }
  }

  private func stateWord(_ state: CloudSetupStepState) -> String {
    switch state {
    case .done: return "Done"
    case .failed: return "Failed"
    case .running: return "In progress"
    case .waiting: return "Waiting for you"
    case .todo: return "Not started"
    }
  }
}

/// What the person does for the provider sign-in a launch waits on.
struct AccountProjectCloudSignInDetail: View {
  let signIn: CloudLaunchSignIn
  let instanceId: String?
  let launchId: String
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.openURL) private var openURL
  @State private var value = ""
  @State private var busy = false
  @State private var error: String?
  @State private var sent = false
  /// Dropped on send: the keyboard would hide the answer under the field.
  @FocusState private var fieldFocused: Bool

  private var needsInput: Bool { signIn.kind == "api_key" || signIn.kind == "url_paste" || signIn.needsPastedCode }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if signIn.kind == "desktop" {
        Text("\(signIn.reason ?? "\(signIn.label) signs in only in ADE desktop.") Sign in from ADE desktop, or start a new chat with another model.")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        if signIn.kind == "device", let code = signIn.userCode {
          HStack(spacing: 8) {
            Text(code)
              .font(.system(size: 17, weight: .semibold, design: .monospaced))
              .foregroundStyle(ADEColor.textPrimary)
              .textSelection(.enabled)
              .accessibilityLabel("Sign-in code \(code)")
            Button {
              UIPasteboard.general.string = code
            } label: {
              Image(systemName: "doc.on.doc")
            }
            .buttonStyle(ADEKitButtonStyle())
            .accessibilityLabel("Copy the code")
          }
        }
        if let reason = signIn.reason {
          Text(reason)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let link = signIn.url.flatMap(URL.init(string:)) {
          Button {
            openURL(link)
          } label: {
            Label("Open sign-in", systemImage: "arrow.up.right.square")
          }
          .buttonStyle(ADEKitButtonStyle())
        }
        if needsInput && !sent {
          HStack(spacing: 8) {
            SecureField(signIn.kind == "api_key" ? "API key" : "Code from the page", text: $value)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .font(.system(size: 14))
              .padding(.horizontal, 10)
              .frame(minHeight: 36)
              .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
              .focused($fieldFocused)
              .onSubmit(submit)
            Button(signIn.kind == "api_key" ? "Save" : "Send code", action: submit)
              .buttonStyle(ADEKitButtonStyle(prominent: true))
              .disabled(busy || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
        if sent {
          Text(signIn.kind == "api_key" ? "Key saved. The chat starts when the computer reads it." : "Code sent. The chat starts when the sign-in is done.")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
        }
        if let error {
          Text(error)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func submit() {
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !busy else { return }
    busy = true
    error = nil
    fieldFocused = false
    Task {
      defer { busy = false }
      guard let client = await syncService.cloudServerClient() else {
        error = "Sign in to ADE again, then try again."
        return
      }
      do {
        if signIn.kind == "api_key" {
          guard let signInId = signIn.signInId else {
            error = "ADE Cloud didn't say which key to save."
            return
          }
          _ = try await client.saveAccountSignIn(signInId, key: text)
        } else {
          guard let instanceId, let jobId = signIn.jobId else {
            error = "The computer isn't ready for the code yet. Try again in a moment."
            return
          }
          if let refusal = try await client.sendSignInCode(instanceId: instanceId, jobId: jobId, code: text) {
            error = refusal
            return
          }
        }
        value = ""
        sent = true
        await launches.refresh(launchId, using: syncService)
      } catch {
        self.error = cloudServerFailureMessage(error)
      }
    }
  }
}
