import AVFoundation
import CoreMedia
import Foundation

/// Annex-B framing in, AVCC framing out, for every live H.264 picture on the
/// phone (the Mac Desktop view and the Apple device viewer).
///
/// Hosts send H.264 Annex-B access units — start codes in front of every NAL,
/// and SPS/PPS repeated in front of every keyframe. The video renderer wants
/// AVCC: one length prefix per NAL and a parameter-set-bearing
/// `CMVideoFormatDescription`. Everything here is synchronous and testable
/// without a decoder or a socket.
enum H264AnnexB {
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

  static let nalTypeIdr: UInt8 = 5
  static let nalTypeSps: UInt8 = 7
  static let nalTypePps: UInt8 = 8
  static let nalTypeAccessUnitDelimiter: UInt8 = 9
  static let nalTypeFiller: UInt8 = 12

  /// The first SPS and PPS in an access unit, when the host repeated them in
  /// front of a keyframe.
  static func parameterSets(in units: [[UInt8]]) -> (sps: [UInt8], pps: [UInt8])? {
    guard
      let sps = units.first(where: { nalUnitType($0) == nalTypeSps }),
      let pps = units.first(where: { nalUnitType($0) == nalTypePps })
    else { return nil }
    return (sps, pps)
  }

  /// Rewrites an Annex-B access unit as AVCC: every NAL prefixed with its
  /// big-endian 32-bit length.
  ///
  /// The decoder form (the default) leaves out the parameter sets, because
  /// they travel in the format description — leaving them in is how a stream
  /// decodes to nothing on some devices and fine on others — and access unit
  /// delimiters and filler, which carry nothing a decoder needs and which
  /// some decoders reject inside a sample.
  static func avccAccessUnit(
    fromAnnexB data: Data,
    excludingParameterSets: Bool = true
  ) -> Data {
    avccAccessUnit(from: nalUnits(in: data), excludingParameterSets: excludingParameterSets)
  }

  static func avccAccessUnit(from units: [[UInt8]], excludingParameterSets: Bool = true) -> Data {
    var output = Data()
    for unit in units {
      if excludingParameterSets, let type = nalUnitType(unit),
         type == nalTypeSps || type == nalTypePps
         || type == nalTypeAccessUnitDelimiter || type == nalTypeFiller {
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

/// The per-sample attachment dictionary the renderer actually reads.
///
/// The renderer consults the sample-attachments array, not the buffer-level
/// attachments `CMSetAttachment` writes. Two keys matter here:
/// `DisplayImmediately` makes a sample present without a control timebase —
/// these streams have none, so without it the renderer holds every frame
/// forever while the caller's "has a frame" still flips and the placeholder
/// disappears over black — and `NotSync` marks a P-frame as a delta frame, so
/// the renderer does not treat a mid-GOP picture as a sync sample. Keyframes
/// need no `NotSync` entry: an absent key means sync.
enum H264SampleAttachments {
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

/// Decides which access units may reach the decoder.
///
/// After a flush, a format change or a decode error the decoder has no
/// reference picture, so only a keyframe may restart it. A pushed stream also
/// carries sequence numbers: the host may skip frames under backpressure and
/// the contract says it always resumes at a keyframe, so once a sequence
/// number jumps, every P-frame until the next keyframe references a picture
/// the decoder never saw. Handing those to VideoToolbox paints corruption that
/// outlives the drop. The desktop renderer carries the same state machine in
/// `h264FrameGate.ts`.
struct H264FrameGate {
  private(set) var lastSeq: Int?
  private(set) var awaitingKeyframe = true

  /// A transport without sequence numbers passes none, and only the keyframe
  /// wait applies.
  mutating func shouldDeliver(keyframe: Bool, seq: Int? = nil) -> Bool {
    if let seq {
      if let lastSeq, seq > lastSeq + 1 {
        awaitingKeyframe = true
      }
      lastSeq = seq
    }
    if awaitingKeyframe {
      guard keyframe else { return false }
      awaitingKeyframe = false
    }
    return true
  }

  mutating func requireKeyframe() {
    awaitingKeyframe = true
  }

  mutating func reset() {
    lastSeq = nil
    awaitingKeyframe = true
  }
}

/// Feeds Annex-B access units into an `AVSampleBufferDisplayLayer`'s video
/// renderer: the one decoder path behind the Mac Desktop live view and the
/// Apple device viewer.
///
/// The display layer rather than a raw `VTDecompressionSession`: the phone
/// only ever displays these streams, never samples them, so the layer's own
/// hardware decode path is both less code and one fewer buffer copy per frame.
/// The format description is rebuilt whenever the SPS or PPS bytes change,
/// which is what makes a mid-stream rotation or resize on the Mac survive
/// without a reconnect.
@MainActor
final class H264SampleBufferFeeder {
  enum Outcome: Equatable {
    /// A sample reached the renderer.
    case enqueued
    /// Nothing to decode yet: no layer, no format, parameter sets only, or a
    /// P-frame the gate is holding.
    case held
    /// The renderer had failed or asked for a flush. It was flushed and its
    /// picture removed, and the feeder now waits for a keyframe.
    case recovering
  }

  private weak var layer: AVSampleBufferDisplayLayer?
  private(set) var formatDescription: CMVideoFormatDescription?
  private var parameterSets: (sps: [UInt8], pps: [UInt8])?
  private var gate = H264FrameGate()
  /// Pixel size of the current format, once a keyframe has carried one.
  private(set) var presentedSize: CGSize?

  /// Feeds `layer` from now on. A different layer has no decoder state, so the
  /// picture restarts at the next keyframe.
  func attach(_ layer: AVSampleBufferDisplayLayer) {
    guard self.layer !== layer else { return }
    self.layer = layer
    gate.requireKeyframe()
  }

  /// Stops feeding `layer` and empties it.
  func detach(_ layer: AVSampleBufferDisplayLayer) {
    guard self.layer === layer else { return }
    layer.sampleBufferRenderer.flush(removingDisplayedImage: true, completionHandler: nil)
    self.layer = nil
  }

  /// Forgets the stream — format, parameter sets, gate — and removes the
  /// picture. The next stream starts from its first keyframe.
  func reset() {
    formatDescription = nil
    parameterSets = nil
    presentedSize = nil
    gate.reset()
    layer?.sampleBufferRenderer.flush(removingDisplayedImage: true, completionHandler: nil)
  }

  /// Decodes one Annex-B access unit. `seq` is the host's sequence number
  /// when the transport carries one.
  @discardableResult
  func feed(annexB: Data, keyframe: Bool, seq: Int? = nil) -> Outcome {
    let units = H264AnnexB.nalUnits(in: annexB)
    guard !units.isEmpty else { return .held }
    if let sets = H264AnnexB.parameterSets(in: units) {
      updateFormat(sps: sets.sps, pps: sets.pps)
    }
    guard let renderer = layer?.sampleBufferRenderer else { return .held }

    var recovering = false
    if renderer.status == .failed || renderer.requiresFlushToResumeDecoding {
      // The decoder lost its references: the renderer refuses every further
      // sample until it is flushed, so a decode error must not be sticky.
      // Restart at the next keyframe, and stop showing a picture that no
      // longer decodes.
      renderer.flush(removingDisplayedImage: true, completionHandler: nil)
      gate.requireKeyframe()
      recovering = true
    }
    // Nothing can be decoded before a keyframe has carried the parameter
    // sets. Holding these units is correct, not a failure: a host sends a
    // keyframe to a reader that attaches.
    guard let format = formatDescription else { return recovering ? .recovering : .held }
    // Before the gate: parameter sets alone must not count as the keyframe
    // that reopens it.
    let accessUnit = H264AnnexB.avccAccessUnit(from: units)
    guard !accessUnit.isEmpty else { return recovering ? .recovering : .held }
    guard gate.shouldDeliver(keyframe: keyframe, seq: seq) else { return recovering ? .recovering : .held }
    guard let sample = Self.makeSampleBuffer(accessUnit: accessUnit, format: format, keyframe: keyframe) else {
      // A frame that never reached the decoder breaks the reference chain
      // just like a skipped one.
      gate.requireKeyframe()
      return .held
    }
    renderer.enqueue(sample)
    return .enqueued
  }

  private func updateFormat(sps: [UInt8], pps: [UInt8]) {
    if let current = parameterSets, current.sps == sps, current.pps == pps, formatDescription != nil {
      return
    }
    guard let format = H264AnnexB.formatDescription(sps: sps, pps: pps) else { return }
    formatDescription = format
    parameterSets = (sps, pps)
    let dimensions = CMVideoFormatDescriptionGetDimensions(format)
    presentedSize = CGSize(width: CGFloat(dimensions.width), height: CGFloat(dimensions.height))
    // A new resolution or profile invalidates every queued sample, or the
    // renderer keeps decoding against the sets it was built with and shows a
    // torn picture. The old picture stays up: the keyframe that carried the
    // new sets replaces it in the same call.
    layer?.sampleBufferRenderer.flush(removingDisplayedImage: false, completionHandler: nil)
    gate.requireKeyframe()
  }

  private static func makeSampleBuffer(
    accessUnit: Data,
    format: CMVideoFormatDescription,
    keyframe: Bool
  ) -> CMSampleBuffer? {
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
    guard blockStatus == kCMBlockBufferNoErr, let blockBuffer else { return nil }
    let copyStatus = accessUnit.withUnsafeBytes { raw -> OSStatus in
      guard let base = raw.baseAddress else { return -1 }
      return CMBlockBufferReplaceDataBytes(
        with: base,
        blockBuffer: blockBuffer,
        offsetIntoDestination: 0,
        dataLength: accessUnit.count
      )
    }
    guard copyStatus == kCMBlockBufferNoErr else { return nil }

    var sampleBuffer: CMSampleBuffer?
    var sampleSize = accessUnit.count
    // No timing: a live stream with no control timebase, so every sample is
    // displayed the moment it decodes (see `H264SampleAttachments`). Inventing
    // presentation times here would make the renderer queue and then drift
    // behind the screen it is mirroring.
    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: .invalid,
      decodeTimeStamp: .invalid
    )
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
    guard sampleStatus == noErr, let sampleBuffer else { return nil }
    // Per-sample attachments, not `CMSetAttachment`: the renderer reads the
    // sample dictionary, so a buffer-level write is invisible to it.
    H264SampleAttachments.apply(to: sampleBuffer, keyframe: keyframe)
    return sampleBuffer
  }
}
