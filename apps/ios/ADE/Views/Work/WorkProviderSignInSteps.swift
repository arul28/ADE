import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// The parts every phone sign-in shows (Cloud 4, the desktop's
/// `signInSheetParts.tsx`): the account note, then three steps (ADE started
/// the sign-in; approve in your browser, with the code, its QR and Open
/// sign-in page; ADE checks the sign-in). The Settings sheet
/// (`ProviderSignInSheet`) and the chat's card in the composer's place
/// (`WorkProviderSignInCard`) draw the same parts over the same controller,
/// which runs the provider's own sign-in on the machine it was given.

/// "Sign in as you@example.com. Your browser can be on another account. Check
/// the name on Codex's page before you approve." With no known account: "Check
/// the account on Codex's page before you approve."
func providerSignInAccountNote(provider: String, expected: String?) -> String {
  let label = workProviderSignInLabel(provider)
  if let expected, !expected.isEmpty {
    return "Sign in as \(expected). Your browser can be on another account. Check the name on \(label)'s page before you approve."
  }
  return "Check the account on \(label)'s page before you approve."
}

/// A sign-in link as a QR code, so another device can open it.
func providerSignInQRImage(_ text: String) -> UIImage? {
  let filter = CIFilter.qrCodeGenerator()
  filter.message = Data(text.utf8)
  filter.correctionLevel = "M"
  guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
        let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
  return UIImage(cgImage: image)
}

/// The three steps, each with its state, and the approve step's controls.
struct ProviderSignInStepList: View {
  @ObservedObject var controller: WorkProviderSignInController
  @Binding var code: String
  /// The chat card is narrower and quieter than the sheet.
  var compact = false
  @State private var copied = false
  @FocusState private var codeFocused: Bool

  private enum StepState { case done, active, upcoming, failed }

  private var label: String { workProviderSignInLabel(controller.provider) }
  private var linkHost: String? {
    controller.url.flatMap { URL(string: $0)?.host }.map { $0.replacingOccurrences(of: "www.", with: "") }
  }

  private var states: [StepState] {
    switch controller.phase {
    case .idle: return [.upcoming, .upcoming, .upcoming]
    case .starting: return [.active, .upcoming, .upcoming]
    case .waiting: return [.done, .active, .upcoming]
    case .verifying: return [.done, .done, .active]
    case .done: return [.done, .done, .done]
    case .failed:
      // The step it stopped on: the start, or the approve once a link was shown.
      return controller.url == nil ? [.failed, .upcoming, .upcoming] : [.done, .failed, .upcoming]
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: compact ? 8 : 12) {
      step(0, "ADE started the sign-in", detail: nil)
      step(1, "Approve in your browser", detail: linkHost.map { "on \($0)" })
      if states[1] == .active {
        approveControls
          .padding(.leading, 30)
      }
      step(2, "ADE checks the sign-in", detail: nil)
    }
    .onChange(of: controller.awaitingCode) { _, awaiting in
      if awaiting { codeFocused = true }
    }
  }

  private func step(_ index: Int, _ title: String, detail: String?) -> some View {
    let state = states[index]
    return HStack(alignment: .center, spacing: 10) {
      ZStack {
        Circle()
          .fill(state == .done ? ADEColor.success : state == .active ? ADEColor.accent.opacity(0.16) : state == .failed ? ADEColor.danger.opacity(0.16) : ADEKit.track)
          .frame(width: 20, height: 20)
        switch state {
        case .done:
          Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
        case .active where index == 2 || (index == 0 && controller.phase == .starting):
          ProgressView().controlSize(.mini)
        case .failed:
          Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(ADEColor.danger)
        default:
          Text("\(index + 1)")
            .font(.system(size: 10.5, weight: .semibold, design: .rounded))
            .foregroundStyle(state == .active ? ADEColor.accent : ADEColor.textMuted)
        }
      }
      HStack(spacing: 4) {
        Text(title)
          .font(.system(size: compact ? 13 : 14, weight: state == .active ? .semibold : .regular))
          .foregroundStyle(state == .upcoming ? ADEColor.textMuted : ADEColor.textPrimary)
        if let detail, state != .upcoming {
          Text(detail)
            .font(.system(size: compact ? 12 : 13))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Step \(index + 1), \(title), \(stateWord(state))")
  }

  private func stateWord(_ state: StepState) -> String {
    switch state {
    case .done: return "done"
    case .active: return "now"
    case .upcoming: return "next"
    case .failed: return "stopped"
    }
  }

  @ViewBuilder
  private var approveControls: some View {
    let link = workSignInPageURL(controller.url)
    VStack(alignment: .leading, spacing: 10) {
      if let deviceCode = controller.deviceCode {
        HStack(alignment: .center, spacing: 12) {
          Button {
            UIPasteboard.general.string = deviceCode
            ADEHaptics.light()
            copied = true
          } label: {
            VStack(alignment: .leading, spacing: 3) {
              Text(deviceCode)
                .font(.system(size: compact ? 20 : 26, weight: .semibold, design: .monospaced))
                .tracking(2)
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
              Label(copied ? "Copied" : "Copy code", systemImage: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Copy the code \(deviceCode)")
          Spacer(minLength: 0)
          if let url = controller.url, let qr = providerSignInQRImage(url) {
            Image(uiImage: qr)
              .interpolation(.none)
              .resizable()
              .frame(width: compact ? 64 : 88, height: compact ? 64 : 88)
              .padding(5)
              .background(Color.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
              .accessibilityLabel("QR code of the sign-in page")
          }
        }
      } else if let url = controller.url, let qr = providerSignInQRImage(url), !compact {
        Image(uiImage: qr)
          .interpolation(.none)
          .resizable()
          .frame(width: 88, height: 88)
          .padding(5)
          .background(Color.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
          .accessibilityLabel("QR code of the sign-in page")
      }
      if let link {
        Button {
          // Opening the page copies the code too, so it pastes there.
          if let deviceCode = controller.deviceCode {
            UIPasteboard.general.string = deviceCode
            copied = true
          }
          UIApplication.shared.open(link)
        } label: {
          Label("Open sign-in page", systemImage: "arrow.up.right.square")
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, brand: providerTint(controller.provider)))
      }
      if controller.awaitingCode {
        HStack(spacing: 8) {
          TextField(controller.kind == .antigravity ? "Paste the address it ends on" : "Paste the code it shows", text: $code)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.adeMono(13))
            .focused($codeFocused)
            .submitLabel(.go)
            .onSubmit { Task { await controller.submit(code: code) } }
            .adeKitField(padding: 10)
          Button("Finish") {
            Task { await controller.submit(code: code) }
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || controller.submitting)
        }
      } else {
        Text(controller.deviceCode == nil
          ? "Approve on \(linkHost ?? "\(label)'s page"). This finishes by itself."
          : "Enter the code on \(linkHost ?? "\(label)'s page") and approve. This finishes by itself.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

// MARK: - The Settings sheet

/// Settings › Providers › a provider › Sign in: a banner sheet with the steps,
/// for the machine the phone drives. The end states are "Signed in as …", or
/// in red "This is B, not A" with Keep B and Try again.
struct ProviderSignInSheet: View {
  let provider: String
  let machineName: String
  /// The account the person means to sign in as (a sign-in again), or nil.
  let expected: String?
  let readAccount: () async -> String?
  let onDone: () -> Void
  @StateObject private var controller: WorkProviderSignInController
  @Environment(\.dismiss) private var dismiss
  @State private var code = ""
  @State private var signedInAs: String?
  @State private var readDone = false
  @State private var kimiRegion = "global"
  @State private var spin = false

  init(
    provider: String,
    machineName: String,
    host: ProviderAccountsHost?,
    expected: String?,
    readAccount: @escaping () async -> String?,
    onDone: @escaping () -> Void
  ) {
    self.provider = provider
    self.machineName = machineName
    self.expected = expected
    self.readAccount = readAccount
    self.onDone = onDone
    _controller = StateObject(wrappedValue: WorkProviderSignInController(provider: provider, host: host, instanceId: nil))
  }

  #if DEBUG
  init(fixture controller: WorkProviderSignInController, machineName: String, expected: String?, signedInAs: String? = nil) {
    self.provider = controller.provider
    self.machineName = machineName
    self.expected = expected
    self.readAccount = { signedInAs }
    self.onDone = {}
    _controller = StateObject(wrappedValue: controller)
    _signedInAs = State(initialValue: signedInAs)
    _readDone = State(initialValue: signedInAs != nil)
  }
  #endif

  private var label: String { workProviderSignInLabel(provider) }
  private var wrongAccount: Bool {
    guard let expected, let signedInAs else { return false }
    return expected.caseInsensitiveCompare(signedInAs) != .orderedSame
  }

  var body: some View {
    VStack(spacing: 0) {
      banner
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          ADESettingsNotice(message: providerSignInAccountNote(provider: provider, expected: expected), tone: .warn)
          ProviderSignInStepList(controller: controller, code: $code)
          if controller.phase == .done {
            endState
          } else if controller.phase == .failed {
            ADESettingsNotice(message: controller.message ?? "The sign-in did not finish. Try again.", tone: .crit, actionTitle: "Try again") {
              Task { await controller.start(kimiRegion: kimiRegion) }
            }
          } else if controller.phase == .idle {
            if provider == "kimi" {
              ADEKitSegmented(selection: $kimiRegion, options: [("global", "kimi.ai"), ("mainland-cn", "kimi.com (China)")])
            }
            Button("Start") { Task { await controller.start(kimiRegion: kimiRegion) } }
              .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true, brand: providerTint(provider)))
          }
          if let message = controller.message, controller.phase != .failed, !message.isEmpty {
            Text(message).font(.system(size: 12.5)).foregroundStyle(ADEColor.danger)
          }
        }
        .padding(20)
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .task {
      // Kimi asks for its region first; every other provider starts at once.
      if controller.phase == .idle && provider != "kimi" { await controller.start() }
    }
    .onChange(of: controller.phase) { _, phase in
      guard phase == .done else { return }
      ADEHaptics.success()
      if !UIAccessibility.isReduceMotionEnabled {
        withAnimation(.easeInOut(duration: 0.6)) { spin = true }
      }
      Task {
        signedInAs = await readAccount()
        readDone = true
      }
    }
    .onDisappear {
      controller.close()
      if controller.phase == .done { onDone() }
    }
  }

  private var banner: some View {
    let brand = ADEBrand.provider(provider)
    return ZStack(alignment: .topTrailing) {
      LinearGradient(colors: brand.colors, startPoint: .topLeading, endPoint: .bottomTrailing)
        .frame(height: 96)
      Button { dismiss() } label: {
        Image(systemName: "xmark")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(.white)
          .frame(width: 30, height: 30)
          .background(Color.black.opacity(0.25), in: Circle())
      }
      .padding(12)
      .accessibilityLabel(controller.phase == .done ? "Close" : "Cancel the sign-in")
    }
    .overlay(alignment: .bottomLeading) {
      HStack(spacing: 12) {
        ADEBrandTile(brand: brand, size: 44)
          .rotationEffect(.degrees(spin ? 360 : 0))
        VStack(alignment: .leading, spacing: 2) {
          Text("Sign in to \(label)")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("on \(machineName)")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .padding(.horizontal, 20)
      .offset(y: 34)
    }
    .padding(.bottom, 40)
  }

  @ViewBuilder
  private var endState: some View {
    if wrongAccount, let expected, let signedInAs {
      VStack(alignment: .leading, spacing: 10) {
        Text("This is \(signedInAs), not \(expected).")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.danger)
        Text("\(label) on \(machineName) now uses \(signedInAs).")
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
        HStack(spacing: 10) {
          Button("Keep \(signedInAs)") { dismiss() }
            .buttonStyle(ADEKitButtonStyle())
          Button("Try again") {
            self.signedInAs = nil
            readDone = false
            Task { await controller.start(kimiRegion: kimiRegion) }
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
        }
      }
      .adeKitCard()
    } else {
      HStack(spacing: 10) {
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: 22))
          .foregroundStyle(ADEColor.success)
        VStack(alignment: .leading, spacing: 2) {
          Text(signedInAs.map { "Signed in as \($0)" } ?? (readDone ? "Signed in" : "Signed in. Reading the account…"))
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("on \(machineName)")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 0)
        Button("Done") { dismiss() }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
      }
      .adeKitCard()
    }
  }
}
