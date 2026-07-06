import AVFoundation
import SwiftUI
import UIKit

/// Full-screen camera sheet for scanning a machine's pairing QR. Recognizes a
/// smart pairing URL (or bare payload), parses it locally, and hands the result
/// back — the PIN is never in the code, so a scan alone can't pair. Unparseable
/// codes surface a brief inline hint and scanning continues.
struct SettingsPairingScannerSheet: View {
  @Environment(\.dismiss) private var dismiss

  let onScanned: (PairingQrPayload) -> Void

  @State private var authorization: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
  @State private var torchOn = false
  @State private var showUnrecognized = false
  @State private var didHandle = false
  @State private var unrecognizedResetTask: Task<Void, Never>?

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      if authorization == .authorized {
        QRScannerView(torchOn: torchOn, onCode: handleCode)
          .ignoresSafeArea()
        viewfinderOverlay
      } else {
        permissionPrompt
      }

      VStack {
        topBar
        Spacer()
        if authorization == .authorized {
          instructions
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 12)
      .padding(.bottom, 28)
    }
    .task {
      if authorization == .notDetermined {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        authorization = granted ? .authorized : .denied
      }
    }
    .onDisappear {
      unrecognizedResetTask?.cancel()
    }
  }

  private var topBar: some View {
    HStack {
      Button {
        dismiss()
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(.white)
          .frame(width: 40, height: 40)
          .background(Circle().fill(.black.opacity(0.35)))
      }
      .accessibilityLabel("Cancel scanning")

      Spacer()

      if authorization == .authorized {
        Button {
          torchOn.toggle()
        } label: {
          Image(systemName: torchOn ? "bolt.fill" : "bolt.slash.fill")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(torchOn ? ADEColor.purpleAccent : .white)
            .frame(width: 40, height: 40)
            .background(Circle().fill(.black.opacity(0.35)))
        }
        .accessibilityLabel(torchOn ? "Turn off torch" : "Turn on torch")
      }
    }
  }

  private var viewfinderOverlay: some View {
    GeometryReader { proxy in
      let side = min(proxy.size.width, proxy.size.height) * 0.7
      ZStack {
        Color.black.opacity(0.45)
          .reverseMask {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
              .frame(width: side, height: side)
          }
          .ignoresSafeArea()

        RoundedRectangle(cornerRadius: 28, style: .continuous)
          .strokeBorder(
            showUnrecognized ? ADEColor.danger : ADEColor.purpleAccent.opacity(0.9),
            lineWidth: 2.5
          )
          .frame(width: side, height: side)
          .shadow(color: ADEColor.purpleGlow.opacity(0.4), radius: 10)
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
    }
    .ignoresSafeArea()
  }

  private var instructions: some View {
    VStack(spacing: 8) {
      if showUnrecognized {
        Text("Not an ADE pairing code")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.white)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background(Capsule().fill(ADEColor.danger.opacity(0.85)))
      } else {
        Text("Point at the pairing code in ADE on your computer")
          .font(.subheadline.weight(.medium))
          .foregroundStyle(.white)
          .multilineTextAlignment(.center)
      }
    }
    .frame(maxWidth: .infinity)
  }

  private var permissionPrompt: some View {
    VStack(spacing: 16) {
      Image(systemName: "qrcode.viewfinder")
        .font(.system(size: 44, weight: .regular))
        .foregroundStyle(ADEColor.purpleAccent)
      Text("Camera access needed")
        .font(.title3.weight(.semibold))
        .foregroundStyle(.white)
      Text("ADE scans your computer's pairing code to connect. Enable camera access in Settings.")
        .font(.subheadline)
        .foregroundStyle(.white.opacity(0.75))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
      Button {
        if let url = URL(string: UIApplication.openSettingsURLString) {
          UIApplication.shared.open(url)
        }
      } label: {
        Text("Open Settings")
          .font(.subheadline.weight(.semibold))
          .padding(.horizontal, 18)
          .padding(.vertical, 10)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.purpleAccent)
    }
    .padding(.horizontal, 36)
  }

  private func handleCode(_ raw: String) {
    guard !didHandle else { return }
    guard let payload = PairingQrPayload.parse(raw) else {
      surfaceUnrecognized()
      return
    }
    didHandle = true
    ADEHaptics.success()
    onScanned(payload)
    dismiss()
  }

  private func surfaceUnrecognized() {
    unrecognizedResetTask?.cancel()
    if !showUnrecognized {
      ADEHaptics.error()
      withAnimation(.snappy) { showUnrecognized = true }
    }
    unrecognizedResetTask = Task { @MainActor in
      try? await Task.sleep(for: .seconds(1.6))
      guard !Task.isCancelled else { return }
      withAnimation(.snappy) { showUnrecognized = false }
    }
  }
}

/// Thin `AVCaptureSession` wrapper that streams recognized QR strings up. The
/// session runs off the main thread; the metadata callback hops back to main.
private struct QRScannerView: UIViewRepresentable {
  let torchOn: Bool
  let onCode: (String) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(onCode: onCode)
  }

  func makeUIView(context: Context) -> PreviewView {
    let view = PreviewView()
    context.coordinator.configure(previewView: view)
    return view
  }

  func updateUIView(_ uiView: PreviewView, context: Context) {
    context.coordinator.setTorch(torchOn)
  }

  static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
    coordinator.stop()
  }

  final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    private let onCode: (String) -> Void
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "ade.pairing.qr.session")

    init(onCode: @escaping (String) -> Void) {
      self.onCode = onCode
    }

    func configure(previewView: PreviewView) {
      previewView.previewLayer.session = session
      previewView.previewLayer.videoGravity = .resizeAspectFill

      sessionQueue.async { [weak self] in
        guard let self else { return }
        self.session.beginConfiguration()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              self.session.canAddInput(input) else {
          self.session.commitConfiguration()
          return
        }
        self.session.addInput(input)

        let output = AVCaptureMetadataOutput()
        if self.session.canAddOutput(output) {
          self.session.addOutput(output)
          output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
          output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []
        }
        self.session.commitConfiguration()
        self.session.startRunning()
      }
    }

    func setTorch(_ on: Bool) {
      sessionQueue.async {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        // Only mutate/unlock if the lock was actually acquired — unlocking
        // without a lock throws an NSGenericException.
        guard (try? device.lockForConfiguration()) != nil else { return }
        device.torchMode = on ? .on : .off
        device.unlockForConfiguration()
      }
    }

    func stop() {
      sessionQueue.async { [session] in
        if session.isRunning { session.stopRunning() }
      }
    }

    func metadataOutput(
      _ output: AVCaptureMetadataOutput,
      didOutput metadataObjects: [AVMetadataObject],
      from connection: AVCaptureConnection
    ) {
      guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
            object.type == .qr,
            let value = object.stringValue else {
        return
      }
      onCode(value)
    }
  }

  final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
  }
}

private extension View {
  /// Cuts a shape out of the receiver (used for the viewfinder dimming mask).
  func reverseMask<Mask: View>(@ViewBuilder _ mask: () -> Mask) -> some View {
    self.mask {
      Rectangle()
        .overlay(mask().blendMode(.destinationOut))
    }
  }
}
