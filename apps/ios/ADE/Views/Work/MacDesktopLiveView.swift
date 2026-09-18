import AVFoundation
import CoreMedia
import SwiftUI
import UIKit

/// The pure half of the live view: Annex-B framing in, AVCC framing out.
///
/// The host pushes H.264 Annex-B access units — start codes in front of every
/// NAL, and SPS/PPS repeated in front of every keyframe. `AVSampleBufferDisplayLayer`
/// wants AVCC: one length prefix per NAL and a parameter-set-bearing
/// `CMVideoFormatDescription`. Everything here is synchronous and testable
/// without a decoder or a socket.
enum MacDesktopAnnexB {
  /// Splits an Annex-B byte stream into NAL units, accepting both 3- and
  /// 4-byte start codes.
  ///
  /// A 4-byte code's leading zero belongs to the code, not to the NAL before
  /// it, so it is trimmed; leaving it on an SPS or PPS is the kind of stray
  /// byte a hardware decoder can reject outright.
  static func nalUnits(in data: Data) -> [[UInt8]] {
    let bytes = [UInt8](data)
    var units: [[UInt8]] = []
    var unitStart: Int?
    var index = 0
    while index + 2 < bytes.count {
      guard bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 else {
        index += 1
        continue
      }
      var codeStart = index
      if codeStart > 0, bytes[codeStart - 1] == 0 {
        codeStart -= 1
      }
      if let start = unitStart, start <= codeStart {
        units.append(Array(bytes[start..<codeStart]))
      }
      unitStart = index + 3
      index += 3
    }
    if let start = unitStart, start < bytes.count {
      units.append(Array(bytes[start...]))
    }
    return units.filter { !$0.isEmpty }
  }

  /// The `nal_unit_type` from a NAL unit's first byte.
  static func nalUnitType(_ unit: [UInt8]) -> UInt8? {
    unit.first.map { $0 & 0x1F }
  }

  /// The first SPS and PPS in an access unit, when the host repeated them in
  /// front of a keyframe.
  static func parameterSets(in units: [[UInt8]]) -> (sps: [UInt8], pps: [UInt8])? {
    guard
      let sps = units.first(where: { nalUnitType($0) == 7 }),
      let pps = units.first(where: { nalUnitType($0) == 8 })
    else { return nil }
    return (sps, pps)
  }

  /// Rewrites an Annex-B access unit as AVCC: every NAL prefixed with its
  /// big-endian 32-bit length.
  ///
  /// Parameter sets are excluded by default because they travel in the format
  /// description; a decoder reading an access unit that repeats them is not
  /// wrong, but republishing the format description per keyframe is wasted
  /// work on a path that runs whenever the picture changes.
  static func avccAccessUnit(
    fromAnnexB data: Data,
    excludingParameterSets: Bool = true
  ) -> Data {
    var output = Data()
    for unit in nalUnits(in: data) {
      if excludingParameterSets, let type = nalUnitType(unit), type == 7 || type == 8 {
        continue
      }
      var length = UInt32(unit.count).bigEndian
      withUnsafeBytes(of: &length) { output.append(contentsOf: $0) }
      output.append(contentsOf: unit)
    }
    return output
  }

  /// Builds the H.264 format description VideoToolbox decodes against.
  static func formatDescription(sps: [UInt8], pps: [UInt8]) -> CMVideoFormatDescription? {
    guard !sps.isEmpty, !pps.isEmpty else { return nil }
    var format: CMVideoFormatDescription?
    sps.withUnsafeBufferPointer { spsBuffer in
      pps.withUnsafeBufferPointer { ppsBuffer in
        guard
          let spsBase = spsBuffer.baseAddress,
          let ppsBase = ppsBuffer.baseAddress
        else { return }
        let pointers: [UnsafePointer<UInt8>] = [spsBase, ppsBase]
        let sizes: [Int] = [spsBuffer.count, ppsBuffer.count]
        let status = CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault,
          parameterSetCount: pointers.count,
          parameterSetPointers: pointers,
          parameterSetSizes: sizes,
          nalUnitHeaderLength: 4,
          formatDescriptionOut: &format
        )
        if status != noErr { format = nil }
      }
    }
    return format
  }
}

/// The per-sample attachment dictionary the display layer actually reads.
///
/// `AVSampleBufferDisplayLayer` consults the sample-attachments array, not the
/// buffer-level attachments `CMSetAttachment` writes. Two keys matter here:
/// `DisplayImmediately` makes a sample present without a control timebase —
/// this stream has none, so without it the layer holds every frame forever
/// while `hasFrame` still flips and the placeholder disappears over black —
/// and `NotSync` marks a P-frame as a delta frame, so the layer does not treat
/// a mid-GOP picture as a sync sample. Keyframes need no `NotSync` entry: an
/// absent key means sync.
enum MacDesktopSampleAttachments {
  static func apply(to sampleBuffer: CMSampleBuffer, keyframe: Bool) {
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true),
      CFArrayGetCount(attachments) > 0
    else { return }
    let dictionary = unsafeBitCast(
      CFArrayGetValueAtIndex(attachments, 0),
      to: CFMutableDictionary.self
    )
    CFDictionarySetValue(
      dictionary,
      Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
      Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
    )
    if !keyframe {
      CFDictionarySetValue(
        dictionary,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
      )
    }
  }
}

/// Decides which pushed frames may reach the decoder.
///
/// The host may skip frames under backpressure and the contract says it always
/// resumes at a keyframe, so once a sequence number jumps, every P-frame until
/// the next keyframe references a picture the decoder never saw. Handing those
/// to VideoToolbox paints corruption that outlives the drop.
struct MacDesktopStreamFrameGate {
  private(set) var lastSeq: Int?
  private(set) var awaitingKeyframe = true

  mutating func shouldDeliver(keyframe: Bool, seq: Int) -> Bool {
    if let lastSeq, seq > lastSeq + 1 {
      awaitingKeyframe = true
    }
    lastSeq = seq
    if awaitingKeyframe {
      guard keyframe else { return false }
      awaitingKeyframe = false
    }
    return true
  }

  /// After a flush, a format change, or a decode error the decoder has no
  /// reference picture, so it waits for the next keyframe again.
  mutating func requireKeyframe() {
    awaitingKeyframe = true
  }

  mutating func reset() {
    lastSeq = nil
    awaitingKeyframe = true
  }
}

/// One lane's live-view subscription and its decoder.
///
/// Owns the `AVSampleBufferDisplayLayer` relationship, the frame gate, and the
/// format description. It deliberately does not own the socket: records arrive
/// through `SyncService.registerMacDesktopStream`, and lifecycle (visible,
/// foreground, connected) is the sheet's business.
@MainActor
final class MacDesktopLiveSession: ObservableObject {
  enum Phase: Equatable {
    case idle
    case connecting
    case waitingForKeyframe
    case live
    case ended(reason: String, message: String?)
    case failed(String)
  }

  let laneId: String
  /// Stable per lane and per app instance, so a rebuilt view cannot stack a
  /// second subscription onto the host for the same lane.
  let subscriptionId: String
  let viewerLabel: String?

  /// The label the host records for this viewer. Deliberately generic: the
  /// device's own name ("Arul's iPhone") is user-identifying, and the host
  /// only uses this to say who is watching.
  static func defaultViewerLabel() -> String {
    UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
  }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var hasFrame = false
  @Published private(set) var pictureWidth: Int?
  @Published private(set) var pictureHeight: Int?

  private weak var displayLayer: AVSampleBufferDisplayLayer?
  private var formatDescription: CMVideoFormatDescription?
  private var parameterSets: [[UInt8]]?
  private var gate = MacDesktopStreamFrameGate()
  private var isStarting = false
  /// Bumped by every stop so a subscribe still in flight cannot land its reply
  /// on a session that was torn down while it waited.
  private var generation = 0

  init(laneId: String, subscriptionId: String, viewerLabel: String?) {
    self.laneId = laneId
    self.subscriptionId = subscriptionId
    self.viewerLabel = viewerLabel
  }

  /// The picture's shape for the card's aspect ratio. The config record and the
  /// subscribe reply both carry it; 16:9 is the host's own default until one
  /// lands.
  var aspectRatio: CGFloat {
    guard
      let width = pictureWidth,
      let height = pictureHeight,
      width > 0,
      height > 0
    else { return 16.0 / 9.0 }
    return CGFloat(width) / CGFloat(height)
  }

  // MARK: - Lifecycle

  /// Confirms the lane has a display, then asks the host to start pushing.
  func start(using service: SyncService) async {
    guard !isStarting else { return }
    isStarting = true
    defer { isStarting = false }
    generation += 1
    let token = generation
    phase = .connecting
    do {
      let status = try await service.macDesktopGetStatus(laneId: laneId)
      guard token == generation else { return }
      guard status.supported else {
        phase = .failed("This Mac can't host a desktop.")
        return
      }
      guard let display = status.display else {
        phase = .failed("This lane has no desktop running.")
        return
      }
      pictureWidth = display.width
      pictureHeight = display.height
      let reply = try await service.macDesktopStreamSubscribe(
        laneId: laneId,
        subscriptionId: subscriptionId,
        viewerLabel: viewerLabel
      )
      guard token == generation else { return }
      if let width = reply.width, let height = reply.height, width > 0, height > 0 {
        pictureWidth = width
        pictureHeight = height
      }
      phase = .waitingForKeyframe
    } catch {
      guard token == generation else { return }
      phase = .failed(Self.message(for: error))
    }
  }

  /// Drops the subscription and the decoder's state. Safe to call twice, and
  /// safe to call when the start never completed.
  func stop(using service: SyncService) {
    generation += 1
    isStarting = false
    service.unregisterMacDesktopStream(subscriptionId: subscriptionId)
    if service.connectionState == .connected, service.supportsMacDesktopStream {
      let id = subscriptionId
      Task { try? await service.macDesktopStreamUnsubscribe(subscriptionId: id) }
    }
    phase = .idle
    hasFrame = false
    formatDescription = nil
    parameterSets = nil
    gate.reset()
    displayLayer?.flushAndRemoveImage()
  }

  // MARK: - Decoder

  func attach(_ layer: AVSampleBufferDisplayLayer) {
    guard displayLayer !== layer else { return }
    displayLayer = layer
    layer.videoGravity = .resizeAspect
    layer.backgroundColor = UIColor.clear.cgColor
  }

  func detach(_ layer: AVSampleBufferDisplayLayer) {
    guard displayLayer === layer else { return }
    layer.flushAndRemoveImage()
    displayLayer = nil
  }

  func consume(_ record: MacDesktopStreamRecord) {
    guard record.subscriptionId == subscriptionId else { return }
    switch record.kind {
    case .config:
      noteConfig(record.data)
    case .frame:
      noteFrame(record)
    }
  }

  func noteEnded(_ ended: MacDesktopStreamEnded) {
    guard ended.subscriptionId == subscriptionId else { return }
    switch ended.reason {
    case "unsubscribed":
      phase = .idle
    case "connection_closed":
      // The socket is gone; the sheet's reconnect path re-subscribes. Keep the
      // last frame on screen rather than flashing the placeholder.
      phase = .connecting
    case "stopped", "display_destroyed":
      phase = .ended(reason: ended.reason, message: ended.message)
    default:
      phase = .failed(ended.message ?? "The desktop stream stopped.")
    }
  }

  private func noteConfig(_ data: Data) {
    guard let config = try? JSONDecoder().decode(MacDesktopStreamConfig.self, from: data) else {
      return
    }
    if config.width > 0, config.height > 0 {
      pictureWidth = config.width
      pictureHeight = config.height
    }
    if !hasFrame {
      phase = .waitingForKeyframe
    }
  }

  private func noteFrame(_ record: MacDesktopStreamRecord) {
    let units = MacDesktopAnnexB.nalUnits(in: record.data)
    if let sets = MacDesktopAnnexB.parameterSets(in: units) {
      updateFormatDescription(sps: sets.sps, pps: sets.pps)
    }
    guard let layer = displayLayer else { return }
    if layer.status == .failed || layer.requiresFlushToResumeDecoding {
      // The decoder lost its references. Drop back to the keyframe the host
      // repeats in front of every access unit that matters, and stop showing a
      // picture that no longer decodes.
      layer.flushAndRemoveImage()
      hasFrame = false
      gate.requireKeyframe()
    }
    guard gate.shouldDeliver(keyframe: record.keyframe, seq: record.seq) else { return }
    guard formatDescription != nil else { return }
    let accessUnit = MacDesktopAnnexB.avccAccessUnit(fromAnnexB: record.data)
    guard !accessUnit.isEmpty else { return }
    guard enqueue(accessUnit: accessUnit, keyframe: record.keyframe, timestampUs: record.timestampUs) else {
      gate.requireKeyframe()
      return
    }
    if !hasFrame {
      hasFrame = true
    }
    if phase != .live {
      phase = .live
    }
  }

  private func updateFormatDescription(sps: [UInt8], pps: [UInt8]) {
    if let current = parameterSets,
       current.count == 2,
       current[0] == sps,
       current[1] == pps,
       formatDescription != nil {
      return
    }
    guard let format = MacDesktopAnnexB.formatDescription(sps: sps, pps: pps) else { return }
    formatDescription = format
    parameterSets = [sps, pps]
    // A new resolution or profile invalidates every queued sample.
    displayLayer?.flushAndRemoveImage()
    hasFrame = false
    gate.requireKeyframe()
  }

  private func enqueue(
    accessUnit: Data,
    keyframe: Bool,
    timestampUs: Int
  ) -> Bool {
    guard let layer = displayLayer, let format = formatDescription else { return false }
    guard !accessUnit.isEmpty else { return false }

    var blockBuffer: CMBlockBuffer?
    let blockStatus = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: accessUnit.count,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: accessUnit.count,
      flags: 0,
      blockBufferOut: &blockBuffer
    )
    guard blockStatus == kCMBlockBufferNoErr, let blockBuffer else { return false }
    let copyStatus = accessUnit.withUnsafeBytes { raw -> OSStatus in
      guard let base = raw.baseAddress else { return -1 }
      return CMBlockBufferReplaceDataBytes(
        with: base,
        blockBuffer: blockBuffer,
        offsetIntoDestination: 0,
        dataLength: accessUnit.count
      )
    }
    guard copyStatus == kCMBlockBufferNoErr else { return false }

    var sampleBuffer: CMSampleBuffer?
    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMTime(value: CMTimeValue(timestampUs), timescale: 1_000_000),
      decodeTimeStamp: .invalid
    )
    var sampleSize = accessUnit.count
    let sampleStatus = CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: blockBuffer,
      formatDescription: format,
      sampleCount: 1,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 1,
      sampleSizeArray: &sampleSize,
      sampleBufferOut: &sampleBuffer
    )
    guard sampleStatus == noErr, let sampleBuffer else { return false }
    // Per-sample attachments, not `CMSetAttachment`: the layer reads the
    // sample dictionary, so a buffer-level write is invisible to it.
    MacDesktopSampleAttachments.apply(to: sampleBuffer, keyframe: keyframe)
    layer.enqueue(sampleBuffer)
    return true
  }

  private static func message(for error: Error) -> String {
    let nsError = error as NSError
    if (nsError.userInfo["ADEErrorCode"] as? String) == "unsupported_action" {
      return "Live video isn't available from this machine."
    }
    return nsError.localizedDescription
  }
}

/// The `UIView` whose backing layer is the display layer.
final class MacDesktopDisplayLayerView: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }

  var displayLayer: AVSampleBufferDisplayLayer {
    // `layerClass` guarantees this cast.
    guard let layer = layer as? AVSampleBufferDisplayLayer else {
      fatalError("MacDesktopDisplayLayerView's backing layer must be AVSampleBufferDisplayLayer")
    }
    return layer
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    isOpaque = false
    displayLayer.videoGravity = .resizeAspect
    displayLayer.backgroundColor = UIColor.clear.cgColor
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
}

/// Bridges the display layer into SwiftUI, with the session as the coordinator
/// so dismantling detaches the layer even when the card is rebuilt.
struct MacDesktopLiveView: UIViewRepresentable {
  @ObservedObject var session: MacDesktopLiveSession

  final class Coordinator {
    let session: MacDesktopLiveSession

    init(session: MacDesktopLiveSession) {
      self.session = session
    }
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(session: session)
  }

  func makeUIView(context: Context) -> MacDesktopDisplayLayerView {
    let view = MacDesktopDisplayLayerView()
    session.attach(view.displayLayer)
    return view
  }

  func updateUIView(_ uiView: MacDesktopDisplayLayerView, context: Context) {
    session.attach(uiView.displayLayer)
  }

  static func dismantleUIView(_ uiView: MacDesktopDisplayLayerView, coordinator: Coordinator) {
    coordinator.session.detach(uiView.displayLayer)
  }
}

/// The card's picture slot: the live layer, with the last still (or a small
/// status line) behind it until the first keyframe decodes.
struct MacDesktopLivePicture: View {
  @ObservedObject var session: MacDesktopLiveSession
  var placeholder: UIImage?

  var body: some View {
    ZStack {
      MacDesktopLiveView(session: session)
      if !session.hasFrame {
        if let placeholder {
          Image(uiImage: placeholder)
            .resizable()
            .scaledToFit()
        } else {
          waitingSurface
        }
      }
    }
    .frame(maxWidth: .infinity)
    .aspectRatio(session.aspectRatio, contentMode: .fit)
    .background(
      Color.black.opacity(0.12),
      in: RoundedRectangle(cornerRadius: 12, style: .continuous)
    )
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("This lane's Mac Desktop")
  }

  @ViewBuilder
  private var waitingSurface: some View {
    VStack(spacing: 6) {
      switch session.phase {
      case .connecting:
        ProgressView()
        Text("Connecting to the Mac…")
      case .waitingForKeyframe:
        ProgressView()
        Text("Starting the picture…")
      case .ended:
        Image(systemName: "pause.circle")
          .foregroundStyle(ADEColor.textMuted)
        Text("The stream stopped.")
      case .failed(let message):
        Image(systemName: "exclamationmark.triangle")
          .foregroundStyle(ADEColor.warning)
        Text(message)
      case .idle, .live:
        Color.clear
      }
    }
    .font(.caption)
    .foregroundStyle(ADEColor.textSecondary)
    .multilineTextAlignment(.center)
    .padding(8)
  }
}
