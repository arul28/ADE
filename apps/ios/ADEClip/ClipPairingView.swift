import StoreKit
import SwiftUI

/// State machine for the clip: parse invocation → PIN entry → pairing →
/// success (hand off + promote the full app) or a retryable error.
@MainActor
final class ClipPairingModel: ObservableObject {
  enum Phase: Equatable {
    case waitingForInvocation
    case invalidInvocation
    case enterPin
    case pairing
    case paired
    case storeFailed
  }

  @Published var phase: Phase = .waitingForInvocation
  @Published var pin: String = ""
  @Published var errorText: String?
  @Published private(set) var payload: PairingQrPayload?

  private let client = ClipPairingClient()

  var hostName: String {
    payload?.hostIdentity.name ?? "your computer"
  }

  func handleInvocation(url: URL) {
    guard phase == .waitingForInvocation || phase == .invalidInvocation else { return }
    guard let parsed = PairingQrPayload.parse(url.absoluteString) else {
      phase = .invalidInvocation
      return
    }
    payload = parsed
    phase = .enterPin
  }

  /// Pairing PINs are exactly 6 digits everywhere (desktop generator, full
  /// app); gate the clip the same way so the button can't submit a
  /// guaranteed-to-fail code.
  static let pinLength = 6

  var pinIsComplete: Bool {
    let code = pin.trimmingCharacters(in: .whitespacesAndNewlines)
    return code.count == Self.pinLength && code.allSatisfy(\.isNumber)
  }

  func submitPin() {
    guard let payload, phase == .enterPin || errorText != nil else { return }
    let code = pin.trimmingCharacters(in: .whitespacesAndNewlines)
    guard pinIsComplete else { return }
    errorText = nil
    phase = .pairing
    Task {
      do {
        let success = try await client.pair(payload: payload, pin: code)
        if ClipHandoff.store(success: success, payload: payload) {
          phase = .paired
        } else {
          phase = .storeFailed
        }
      } catch {
        errorText = (error as? ClipPairingError)?.errorDescription
          ?? "Pairing failed. Try scanning the code again."
        phase = .enterPin
      }
    }
  }
}

struct ClipPairingView: View {
  @ObservedObject var model: ClipPairingModel
  @FocusState private var pinFocused: Bool
  @State private var showAppStoreOverlay = false

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 0)
      card
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
    .appStoreOverlay(isPresented: $showAppStoreOverlay) {
      SKOverlay.AppClipConfiguration(position: .bottom)
    }
    .onChange(of: model.phase) { _, phase in
      if phase == .paired {
        showAppStoreOverlay = true
      }
    }
  }

  private var card: some View {
    VStack(spacing: 20) {
      Image(systemName: symbolName)
        .font(.system(size: 40, weight: .medium))
        .foregroundStyle(symbolTint)
        .frame(height: 48)

      VStack(spacing: 6) {
        Text(title)
          .font(.title2.weight(.semibold))
          .multilineTextAlignment(.center)
        Text(subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }

      content
    }
    .padding(28)
    .frame(maxWidth: 420)
    .background(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(Color(uiColor: .secondarySystemGroupedBackground))
    )
    .padding(.horizontal, 20)
  }

  @ViewBuilder
  private var content: some View {
    switch model.phase {
    case .waitingForInvocation:
      ProgressView()
        .padding(.top, 4)
    case .invalidInvocation:
      Text("Open ADE on your computer and scan the pairing code it shows in Settings.")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    case .enterPin, .pairing:
      VStack(spacing: 14) {
        TextField("6-digit PIN", text: $model.pin)
          .keyboardType(.numberPad)
          .textContentType(.oneTimeCode)
          .multilineTextAlignment(.center)
          .font(.system(.title2, design: .monospaced).weight(.medium))
          .kerning(6)
          .padding(.vertical, 12)
          .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
              .fill(Color(uiColor: .tertiarySystemFill))
          )
          .focused($pinFocused)
          .disabled(model.phase == .pairing)
          .onAppear { pinFocused = true }

        if let errorText = model.errorText {
          Text(errorText)
            .font(.footnote)
            .foregroundStyle(.red)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }

        Button(action: { model.submitPin() }) {
          Group {
            if model.phase == .pairing {
              ProgressView()
                .tint(.white)
            } else {
              Text("Pair")
                .font(.headline)
            }
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 14)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 14))
        .disabled(model.phase == .pairing || !model.pinIsComplete)
      }
    case .paired:
      Text("Get the ADE app to start working with your agents.")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    case .storeFailed:
      Text("Paired, but the handoff couldn't be saved. Install the ADE app and pair again from Settings.")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private var symbolName: String {
    switch model.phase {
    case .paired: return "checkmark.circle.fill"
    case .invalidInvocation, .storeFailed: return "qrcode.viewfinder"
    default: return "laptopcomputer.and.iphone"
    }
  }

  private var symbolTint: Color {
    model.phase == .paired ? .green : .accentColor
  }

  private var title: String {
    switch model.phase {
    case .waitingForInvocation: return "Opening pairing code…"
    case .invalidInvocation: return "Scan an ADE pairing code"
    case .enterPin, .pairing: return "Pair with \(model.hostName)"
    case .paired: return "Paired with \(model.hostName)"
    case .storeFailed: return "Almost there"
    }
  }

  private var subtitle: String {
    switch model.phase {
    case .enterPin, .pairing:
      return "Enter the PIN shown in ADE on your computer."
    case .paired:
      return "Your iPhone is trusted. ADE picks this pairing up automatically."
    default:
      return "ADE pairs your iPhone with your computer to control agents from anywhere."
    }
  }
}
