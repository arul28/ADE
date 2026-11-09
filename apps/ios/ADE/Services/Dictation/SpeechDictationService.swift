@preconcurrency import AVFoundation
import Foundation
import Speech
import SwiftUI

/// On-device dictation capture built on the iOS 26 Speech framework
/// (`SpeechAnalyzer` + `SpeechTranscriber`), NOT the legacy
/// `SFSpeechRecognizer` streaming API.
///
/// Flow is **record-then-transcribe**: `start()` begins `AVAudioEngine`
/// capture and streams buffers into the analyzer; `stop()` finalizes the
/// analyzer and returns the accumulated transcript. While recording, the
/// service publishes `isRecording`, `elapsedTime`, and a live `audioLevel`
/// (RMS from the input tap) so the composer can drive a real-amplitude
/// waveform and timer.
///
/// Glossary `contextualTerms` are fed to the analyzer's `AnalysisContext`
/// (`contextualStrings`) to bias recognition toward ADE/dev vocabulary.
///
/// All published state is mutated on the main actor; the audio tap hops back to
/// the main actor to publish levels and forwards buffers to the analyzer.
@MainActor
final class SpeechDictationService: ObservableObject {
  /// Authorization state surfaced to the UI so it can show an "enable in
  /// Settings" prompt when speech or microphone access is denied.
  enum AuthorizationState: Equatable {
    /// Not yet requested — call `requestAuthorization()`.
    case notDetermined
    /// Both microphone and speech recognition are granted.
    case authorized
    /// At least one permission was denied/restricted — route the user to
    /// Settings.
    case denied
  }

  /// High-level errors the UI can react to. `transcriptionUnavailable` covers
  /// missing locale assets / unsupported configuration.
  enum DictationError: Error, Equatable {
    case notAuthorized
    case transcriptionUnavailable
    case audioSessionFailed
  }

  // MARK: - Published state

  @Published private(set) var isRecording = false
  @Published private(set) var isStarting = false
  @Published private(set) var elapsedTime: TimeInterval = 0
  /// Normalized 0...1 input amplitude (RMS) for the waveform. 0 when idle.
  @Published private(set) var audioLevel: Float = 0
  @Published private(set) var authorizationState: AuthorizationState = .notDetermined
  /// Set while locale assets are downloading so the UI can show a spinner.
  @Published private(set) var isPreparing = false

  // MARK: - Availability

  /// True whenever on-device transcription is supported on this build/OS.
  /// Gating the mic on this lets older OSes / SDKs hide the affordance entirely
  /// rather than surfacing a broken control.
  static var isAvailable: Bool {
    if #available(iOS 26.0, *) {
      return true
    }
    return false
  }

  // MARK: - Private speech/audio state

  private let glossary: VoiceGlossary
  private let audioEngine = AVAudioEngine()

  #if compiler(>=6.0)
  // iOS 26 Speech analyzer pieces are only referenced under availability.
  @available(iOS 26.0, *)
  private final class AnalyzerBox {
    var analyzer: SpeechAnalyzer?
    var transcriber: SpeechTranscriber?
    var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    var analyzerFormat: AVAudioFormat?
    var recognizerTask: Task<Void, Never>?
    let converter = DictationBufferConverter()
    var finalizedTranscript = ""
  }
  private var analyzerBoxStorage: AnyObject?

  @available(iOS 26.0, *)
  private var box: AnalyzerBox {
    if let existing = analyzerBoxStorage as? AnalyzerBox { return existing }
    let created = AnalyzerBox()
    analyzerBoxStorage = created
    return created
  }
  #endif

  private var timerTask: Task<Void, Never>?
  private var startDate: Date?
  private var startGeneration = 0

  /// Exponential moving average of the raw RMS level. Smooths the per-buffer
  /// amplitude so the published `audioLevel` rises/falls without spiky jumps,
  /// which keeps the waveform readable when the steady display tick samples it.
  private var smoothedLevel: Float = 0

  // MARK: - Init

  init(glossary: VoiceGlossary = .shared) {
    self.glossary = glossary
    self.authorizationState = Self.currentAuthorizationState()
  }

  // MARK: - Authorization

  /// Snapshot the current authorization without prompting.
  private static func currentAuthorizationState() -> AuthorizationState {
    let speech = SFSpeechRecognizer.authorizationStatus()
    let mic = AVAudioApplication.shared.recordPermission
    switch (speech, mic) {
    case (.authorized, .granted):
      return .authorized
    case (.denied, _), (.restricted, _), (_, .denied):
      return .denied
    default:
      return .notDetermined
    }
  }

  /// Request both microphone and speech-recognition permission, updating
  /// `authorizationState`. Returns true only when both are granted.
  @discardableResult
  func requestAuthorization() async -> Bool {
    let speechGranted = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status == .authorized)
      }
    }
    let micGranted = await AVAudioApplication.requestRecordPermission()

    let granted = speechGranted && micGranted
    authorizationState = granted ? .authorized : .denied
    return granted
  }

  // MARK: - Recording lifecycle

  /// Begin capture + streaming transcription. Throws if unauthorized or the
  /// analyzer/audio session can't be configured.
  func start() async throws {
    guard !isRecording, !isStarting else { return }
    guard Self.isAvailable else { throw DictationError.transcriptionUnavailable }
    startGeneration += 1
    let generation = startGeneration
    isStarting = true
    defer {
      if startGeneration == generation {
        isStarting = false
      }
    }

    if authorizationState != .authorized {
      let granted = await requestAuthorization()
      try checkStartStillCurrent(generation)
      guard granted else { throw DictationError.notAuthorized }
    }

    if #available(iOS 26.0, *) {
      do {
        try await startIOS26(generation: generation)
        try checkStartStillCurrent(generation)
      } catch {
        // Capture may have partially started (audio session active, input tap
        // installed, analyzer running) before the throw — tear it all down so a
        // failed start doesn't leak the audio session/engine/analyzer tasks.
        // Mirrors cancel()'s teardown; cancelIOS26() is optional-chained and
        // safe on a partially-configured analyzer box.
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning {
          audioEngine.stop()
        }
        deactivateAudioSession()
        await cancelIOS26()
        throw error
      }
    } else {
      throw DictationError.transcriptionUnavailable
    }

    isRecording = true
    startDate = Date()
    elapsedTime = 0
    startTimer()
  }

  /// Stop capture, finalize transcription, and return the full raw transcript.
  /// Safe to call when not recording (returns an empty string).
  @discardableResult
  func stop() async -> String {
    guard isRecording else { return "" }
    isRecording = false
    stopTimer()
    audioLevel = 0
    smoothedLevel = 0

    audioEngine.inputNode.removeTap(onBus: 0)
    if audioEngine.isRunning {
      audioEngine.stop()
    }

    if #available(iOS 26.0, *) {
      let transcript = await finishIOS26()
      deactivateAudioSession()
      return transcript
    }
    deactivateAudioSession()
    return ""
  }

  /// Cancel the current recording without producing a transcript.
  func cancel() async {
    guard isRecording || isStarting || isPreparing else { return }
    startGeneration += 1
    isStarting = false
    isPreparing = false
    isRecording = false
    stopTimer()
    elapsedTime = 0
    audioLevel = 0
    smoothedLevel = 0

    audioEngine.inputNode.removeTap(onBus: 0)
    if audioEngine.isRunning {
      audioEngine.stop()
    }

    if #available(iOS 26.0, *) {
      await cancelIOS26()
    }
    deactivateAudioSession()
  }

  // MARK: - Timer

  private func startTimer() {
    timerTask?.cancel()
    timerTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 200_000_000)
        guard let self, let start = await self.startDate else { continue }
        await MainActor.run {
          self.elapsedTime = Date().timeIntervalSince(start)
        }
      }
    }
  }

  private func stopTimer() {
    timerTask?.cancel()
    timerTask = nil
    startDate = nil
  }

  // MARK: - Audio session

  private func configureAudioSession() throws {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      throw DictationError.audioSessionFailed
    }
  }

  private func deactivateAudioSession() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func checkStartStillCurrent(_ generation: Int) throws {
    guard startGeneration == generation, isStarting else { throw CancellationError() }
  }

  /// Compute a normalized RMS level (0...1) from a captured buffer for the
  /// waveform. Uses a simple log-ish scaling so quiet speech is still visible.
  nonisolated private static func rmsLevel(of buffer: AVAudioPCMBuffer) -> Float {
    guard let channelData = buffer.floatChannelData else { return 0 }
    let channelCount = Int(buffer.format.channelCount)
    let frameLength = Int(buffer.frameLength)
    guard frameLength > 0 else { return 0 }

    var sumSquares: Float = 0
    for channel in 0..<channelCount {
      let samples = channelData[channel]
      for frame in 0..<frameLength {
        let sample = samples[frame]
        sumSquares += sample * sample
      }
    }
    let meanSquare = sumSquares / Float(frameLength * max(channelCount, 1))
    let rms = sqrt(meanSquare)
    // Speech RMS is small (~0.01–0.1). Apply a strong gain AND a <1 power curve
    // so quiet/medium speech is lifted into a clearly visible range — otherwise
    // the bars barely move and it reads as "not lighting up". Loud speech
    // saturates near 1.
    let gained = min(1, max(0, rms * 16))
    let normalized = pow(gained, 0.6)
    return normalized
  }

  /// Apply a short exponential moving average to the raw RMS before publishing
  /// so the waveform glides instead of spiking. A higher weight on the new
  /// sample keeps it responsive; the smoothing mainly tames single-buffer
  /// transients (clicks, plosives).
  private func publishLevel(_ raw: Float) {
    guard isRecording else { return }
    // Fast attack, slower release: the meter snaps up the instant you speak (so
    // it visibly lights up) and eases back down during pauses, instead of an
    // even average that stays low.
    let alpha: Float = raw > smoothedLevel ? 0.6 : 0.18
    smoothedLevel = smoothedLevel + alpha * (raw - smoothedLevel)
    audioLevel = smoothedLevel
  }

  // MARK: - iOS 26 SpeechAnalyzer implementation

  @available(iOS 26.0, *)
  private func startIOS26(generation: Int) async throws {
    let box = self.box
    box.finalizedTranscript = ""

    let transcriber = SpeechTranscriber(
      locale: Self.preferredLocale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults],
      attributeOptions: []
    )
    box.transcriber = transcriber

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    box.analyzer = analyzer

    // Ensure the locale assets are present, downloading on demand. Failures
    // here surface as `transcriptionUnavailable` so the UI can degrade.
    do {
      isPreparing = true
      try await ensureModel(transcriber: transcriber, locale: Self.preferredLocale)
      isPreparing = false
      try checkStartStillCurrent(generation)
    } catch is CancellationError {
      isPreparing = false
      throw CancellationError()
    } catch {
      isPreparing = false
      throw DictationError.transcriptionUnavailable
    }

    // Bias recognition toward ADE/dev vocabulary. Best-effort: if the platform
    // ignores contextual strings for this module the deterministic correction
    // pass still fixes technical terms.
    if !glossary.contextualTerms.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings[.general] = glossary.contextualTerms
      try? await analyzer.setContext(context)
      try checkStartStillCurrent(generation)
    }

    guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw DictationError.transcriptionUnavailable
    }
    try checkStartStillCurrent(generation)
    box.analyzerFormat = analyzerFormat

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    box.inputBuilder = continuation

    // Accumulate finalized transcript text off the results stream.
    box.recognizerTask = Task { [weak self] in
      do {
        for try await case let result in transcriber.results {
          guard let self else { return }
          if result.isFinal {
            await self.appendFinalized(String(result.text.characters))
          }
        }
      } catch {
        // Stream ended with an error — keep whatever was finalized so far.
      }
    }

    try await analyzer.start(inputSequence: stream)
    try checkStartStillCurrent(generation)

    try configureAudioSession()
    try installInputTap(box: box)
    audioEngine.prepare()
    try audioEngine.start()
  }

  @available(iOS 26.0, *)
  private func installInputTap(box: AnalyzerBox) throws {
    let inputNode = audioEngine.inputNode
    let inputFormat = inputNode.outputFormat(forBus: 0)

    // A smaller buffer means the tap fires more often (~20-40Hz at 44.1/48kHz),
    // so `audioLevel` is republished more frequently and the steady-tick
    // waveform always has fresh amplitude to interpolate toward.
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
      guard let self else { return }
      let level = Self.rmsLevel(of: buffer)

      // Forward the buffer to the analyzer, converting to its preferred format.
      if let analyzerFormat = box.analyzerFormat,
         let converted = try? box.converter.convert(buffer, to: analyzerFormat) {
        box.inputBuilder?.yield(AnalyzerInput(buffer: converted))
      }

      Task { @MainActor [weak self] in
        self?.publishLevel(level)
      }
    }
  }

  @available(iOS 26.0, *)
  private func finishIOS26() async -> String {
    let box = self.box
    box.inputBuilder?.finish()
    box.inputBuilder = nil
    try? await box.analyzer?.finalizeAndFinishThroughEndOfInput()

    // Wait for the results task to drain so any trailing final result is
    // captured before we read the transcript.
    await box.recognizerTask?.value
    box.recognizerTask = nil

    let transcript = box.finalizedTranscript
    teardownIOS26(box: box)
    return transcript.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  @available(iOS 26.0, *)
  private func cancelIOS26() async {
    let box = self.box
    box.inputBuilder?.finish()
    box.inputBuilder = nil
    await box.analyzer?.cancelAndFinishNow()
    box.recognizerTask?.cancel()
    box.recognizerTask = nil
    teardownIOS26(box: box)
  }

  @available(iOS 26.0, *)
  private func teardownIOS26(box: AnalyzerBox) {
    box.analyzer = nil
    box.transcriber = nil
    box.analyzerFormat = nil
    box.finalizedTranscript = ""
  }

  private func appendFinalized(_ text: String) {
    #if compiler(>=6.0)
    if #available(iOS 26.0, *) {
      box.finalizedTranscript += text
    }
    #endif
  }

  // MARK: - Locale / asset management

  /// Preferred dictation locale — US English, the locale the ADE glossary is
  /// tuned for. The current device locale is tried as a fallback.
  @available(iOS 26.0, *)
  private static var preferredLocale: Locale {
    Locale(identifier: "en-US")
  }

  /// Ensure the transcriber's locale assets are installed, downloading and
  /// reserving them if needed. Mirrors Apple's documented `AssetInventory`
  /// flow.
  @available(iOS 26.0, *)
  private func ensureModel(transcriber: SpeechTranscriber, locale: Locale) async throws {
    // Download any assets this module needs.
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }

    let supported = await SpeechTranscriber.supportedLocales
    let isSupported = supported.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
    guard isSupported else {
      throw DictationError.transcriptionUnavailable
    }

    // Reserve the locale if it isn't already reserved.
    let reserved = await AssetInventory.reservedLocales
    if !reserved.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
      try await AssetInventory.reserve(locale: locale)
    }
  }
}

/// Thin wrapper around `AVAudioConverter` that converts mic buffers to the
/// analyzer's preferred format. Mirrors the converter used by Apple's
/// SpeechAnalyzer samples; isolated here so the tap callback can call it
/// without touching main-actor state.
final class DictationBufferConverter: @unchecked Sendable {
  enum ConversionError: Error {
    case failedToCreateConverter
    case failedToCreateBuffer
    case conversionFailed(NSError?)
  }

  private var converter: AVAudioConverter?
  private var converterInputFormat: AVAudioFormat?
  private var converterOutputFormat: AVAudioFormat?

  func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    let inputFormat = buffer.format
    guard inputFormat != format else { return buffer }

    let inputFormatChanged = converterInputFormat?.isEqual(inputFormat) != true
    let outputFormatChanged = converterOutputFormat?.isEqual(format) != true
    if converter == nil || inputFormatChanged || outputFormatChanged {
      converter = AVAudioConverter(from: inputFormat, to: format)
      converterInputFormat = inputFormat
      converterOutputFormat = format
      converter?.primeMethod = .none
    }
    guard let converter else { throw ConversionError.failedToCreateConverter }

    let ratio = converter.outputFormat.sampleRate / converter.inputFormat.sampleRate
    let scaledFrames = Double(buffer.frameLength) * ratio
    let frameCapacity = AVAudioFrameCount(scaledFrames.rounded(.up))
    guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: frameCapacity) else {
      throw ConversionError.failedToCreateBuffer
    }

    var consumed = false
    var nsError: NSError?
    let status = converter.convert(to: outputBuffer, error: &nsError) { _, inputStatus in
      if consumed {
        inputStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      inputStatus.pointee = .haveData
      return buffer
    }

    guard status != .error else { throw ConversionError.conversionFailed(nsError) }
    return outputBuffer
  }
}
