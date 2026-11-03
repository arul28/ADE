import Foundation

// PostHog error tracking for the iPhone app: the report `CrashReporting`
// reads off a scrubbed Sentry event, and the reduction it goes through before
// it is sent as `$exception`.

/// One error Sentry admitted, read off its scrubbed event by `CrashReporting`
/// and reduced again by `ProductAnalytics.sanitizedExceptionProperties`
/// before it becomes a PostHog `$exception`.
struct ADEAnalyticsExceptionReport {
  struct Frame {
    var module: String?
    var filename: String?
    var function: String?
    var line: Int?
    var instructionAddress: String?
    var imageAddress: String?
    var inApp: Bool
  }

  struct Exception {
    var type: String
    var value: String?
    var mechanism: String?
    var handled: Bool
    /// Outermost caller first, the failing frame last.
    var frames: [Frame]
  }

  /// The headline exception first.
  var exceptions: [Exception]
  /// `fatal`, `error` or `warning`.
  var level: String
  /// Only a fingerprint ADE chose (`CrashReporting.capture`).
  var fingerprint: String?
  /// The replay session running when it happened, so PostHog links the two.
  var replaySessionId: String?
}

extension ProductAnalytics {
  private static let maxExceptions = 5
  private static let maxFrames = 50
  private static let exceptionTypePattern = try? NSRegularExpression(pattern: #"^[A-Za-z_$][\w$.: -]{0,79}$"#)
  private static let frameFunctionPattern = try? NSRegularExpression(pattern: #"^[\w$.<>\[\]() ,:?!&@*+=~-]{1,160}$"#)
  private static let hexAddressPattern = try? NSRegularExpression(pattern: #"^0x[0-9a-fA-F]{1,16}$"#)
  private static let mechanismPattern = try? NSRegularExpression(pattern: #"^[a-z0-9][a-z0-9._+-]{0,63}$"#)
  /// What desktop's `scrubFreeText` removes on top of the secret scrub:
  /// email addresses, `file:` URLs and absolute paths, which name the person
  /// or their device.
  private static let freeTextPatterns: [(NSRegularExpression, String)] = [
    (#"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, "[email]"),
    (#"(?i)\bfile://[^\s"'`<>]*"#, "[path]"),
    (#"(?<![\w./\\~-])(?:~/[^\s"'`<>]+|/(?:[^\s/"'`<>]+/)+[^\s/"'`<>]*)"#, "[path]"),
  ].compactMap { pattern, template in
    (try? NSRegularExpression(pattern: pattern)).map { ($0, template) }
  }

  private static func matches(_ pattern: NSRegularExpression?, _ value: String) -> Bool {
    guard let pattern else { return false }
    return pattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
  }

  /// An error message as it may leave the phone: Sentry's scrub already ran,
  /// then emails and absolute paths go, and it is cut to `maxLength`.
  static func scrubExceptionText(_ input: String, maxLength: Int) -> String {
    var output = String(input.prefix(maxLength * 2))
    for (pattern, template) in freeTextPatterns {
      output = pattern.stringByReplacingMatches(
        in: output,
        range: NSRange(output.startIndex..., in: output),
        withTemplate: template
      )
    }
    return String(output.prefix(maxLength))
  }

  /// A path reduced to its last component (`/private/var/.../ADE.app/ADE`
  /// becomes `ADE`), never the folder it was installed to.
  private static func lastPathComponent(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
      return nil
    }
    let last = trimmed.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? trimmed
    return last.isEmpty ? nil : String(last.prefix(120))
  }

  /// PostHog error tracking's properties for one report, the same contract
  /// as desktop's `sanitizeExceptionProperties`: at most five chained
  /// exceptions of 50 frames, the type, the scrubbed message (500
  /// characters), and per frame only the module and file name, function,
  /// line, instruction and image address, and whether it is in-app. No
  /// source lines, variables, breadcrumbs, contexts or tags.
  static func sanitizedExceptionProperties(_ report: ADEAnalyticsExceptionReport) -> [String: Any]? {
    let level: String
    switch report.level {
    case "fatal", "error", "warning": level = report.level
    default: return nil
    }
    let exceptionList: [[String: Any]] = report.exceptions.prefix(maxExceptions).map { exception in
      let trimmedType = exception.type.trimmingCharacters(in: .whitespacesAndNewlines)
      let type = matches(exceptionTypePattern, trimmedType) ? trimmedType : "Error"
      let frames: [[String: Any]] = exception.frames.suffix(maxFrames).compactMap { frame in
        let module = lastPathComponent(frame.module)
        let filename = lastPathComponent(frame.filename)
        let trimmedFunction = frame.function?.trimmingCharacters(in: .whitespacesAndNewlines)
        let function = trimmedFunction.flatMap { matches(frameFunctionPattern, $0) ? $0 : nil }
        let instructionAddress = frame.instructionAddress.flatMap { matches(hexAddressPattern, $0) ? $0 : nil }
        guard module != nil || filename != nil || function != nil || instructionAddress != nil else {
          return nil
        }
        var output: [String: Any] = ["platform": "apple", "in_app": frame.inApp]
        if let module { output["module"] = module }
        if let filename { output["filename"] = filename }
        if let function { output["function"] = function }
        if let line = frame.line, (0..<10_000_000).contains(line) { output["lineno"] = line }
        if let instructionAddress { output["instruction_addr"] = instructionAddress }
        if let imageAddress = frame.imageAddress, matches(hexAddressPattern, imageAddress) {
          output["image_addr"] = imageAddress
        }
        return output
      }
      let mechanismValue = exception.mechanism?.lowercased() ?? ""
      var output: [String: Any] = [
        "type": type,
        "value": scrubExceptionText(exception.value ?? "", maxLength: 500),
        "mechanism": [
          "type": matches(mechanismPattern, mechanismValue) ? mechanismValue : "generic",
          "handled": exception.handled,
          "synthetic": false,
        ],
      ]
      if !frames.isEmpty {
        output["stacktrace"] = ["type": "raw", "frames": frames]
      }
      return output
    }
    guard !exceptionList.isEmpty else { return nil }
    var properties: [String: Any] = [
      "$exception_list": exceptionList,
      "$exception_level": level,
    ]
    if let fingerprint = report.fingerprint?.trimmingCharacters(in: .whitespacesAndNewlines),
       !fingerprint.isEmpty {
      properties["$exception_fingerprint"] = scrubExceptionText(fingerprint, maxLength: 200)
    }
    return properties
  }
}
