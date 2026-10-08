import Foundation

// How a computer-use action reads: the sentence parts, its plain text, the
// surface it used, the outcome note, and how a run of actions lays out. A
// faithful port of `apps/desktop/src/shared/computerUseActionPresentation.ts`;
// keep them in step. The actions come from `WorkComputerUseSummary.swift`.

/// One action as one line: "Clicked “Save” in TextEdit using Mac Desktop".
struct WorkComputerUseParts: Equatable {
  let lead: String
  let target: String?
  let targetQuoted: Bool
  let place: WorkComputerUsePlace?
  let using: (label: String, symbol: String, warning: Bool)?
  let suffix: String?

  static func == (lhs: WorkComputerUseParts, rhs: WorkComputerUseParts) -> Bool {
    lhs.lead == rhs.lead && lhs.target == rhs.target && lhs.targetQuoted == rhs.targetQuoted
      && lhs.place == rhs.place && lhs.using?.label == rhs.using?.label && lhs.suffix == rhs.suffix
  }
}

func workComputerUseParts(_ action: WorkComputerUseAction) -> WorkComputerUseParts {
  let verbPhrase: String
  switch action.outcome {
  case .running: verbPhrase = action.progressive
  case .failed: verbPhrase = "Couldn't \(action.infinitive)"
  default: verbPhrase = action.past
  }
  // With no target, a look names what it looked at ("Looked at the screen");
  // any other verb drops its dangling preposition ("Took a screenshot").
  let lookedAt = action.verb == "observe" || action.verb == "snapshot"
  let lead: String
  if action.target != nil {
    lead = verbPhrase
  } else if lookedAt {
    lead = "\(verbPhrase) \(action.domain == "browser" ? "the page" : "the screen")"
  } else {
    lead = verbPhrase.replacingOccurrences(of: #"\s+(?:of|at|for|to|in)$"#, with: "", options: .regularExpression)
  }
  // "Connected to your Chrome on studio-mac": the browser is already the object.
  if action.verb == "attach" {
    return WorkComputerUseParts(
      lead: lead, target: action.target, targetQuoted: action.targetQuoted,
      place: action.hostLabel.map { WorkComputerUsePlace(preposition: "on", label: $0, kind: .other) },
      using: nil, suffix: nil
    )
  }
  return WorkComputerUseParts(
    lead: lead, target: action.target, targetQuoted: action.targetQuoted,
    place: action.place, using: workComputerUseSurfaceLabel(action),
    suffix: action.prNumber.map { "· on PR #\($0)" }
  )
}

/// The sentence as plain text, for accessibility (desktop `computerUseActionText`).
func workComputerUseText(_ action: WorkComputerUseAction) -> String {
  let parts = workComputerUseParts(action)
  let target = parts.target.map { parts.targetQuoted ? "“\($0)”" : $0 }
  let place = parts.place.map { "\($0.preposition) \($0.label)" }
  let using = parts.using.map { "using \($0.label)" }
  let text = [parts.lead, target, place, using, parts.suffix].compactMap { $0 }.joined(separator: " ")
  return action.outcome == .running ? "\(text)…" : text
}

func workComputerUseSurfaceLabel(_ action: WorkComputerUseAction) -> (label: String, symbol: String, warning: Bool) {
  switch action.surface {
  case .laneScreen:
    let label = action.screenProduct == "windows" ? "Windows Desktop"
      : action.screenProduct == "mac" ? "Mac Desktop" : "the lane screen"
    return (label, "display", false)
  case .appControl: return ("App Control", "macwindow", false)
  case .adeBrowser: return ("ADE browser", "globe", false)
  case .userBrowser:
    let browser = "your \(action.browserName ?? "browser")"
    return (action.hostLabel.map { "\(browser) on \($0)" } ?? browser, "person", true)
  case .appleDevice:
    return (action.deviceName.flatMap { $0.isEmpty ? nil : $0 } ?? "the simulator", "iphone", false)
  case .proof: return ("ADE proof", "checkmark.seal", false)
  }
}

func workComputerUseNote(_ action: WorkComputerUseAction) -> (text: String, danger: Bool)? {
  switch action.outcome {
  case .failed: return action.reason.map { ($0, true) }
  case .unconfirmed: return ("Sent, but no change seen yet", false)
  default: return nil
  }
}

enum WorkComputerUseRunItem: Identifiable, Hashable {
  case action(WorkComputerUseAction)
  case appFold(appName: String, actions: [WorkComputerUseAction])

  var id: String {
    switch self {
    case .action(let action): return action.id
    case .appFold(_, let actions): return "fold:\(actions.first?.id ?? "")"
    }
  }
}

/// Desktop `layoutComputerUseRun`: earlier actions compact (consecutive
/// confirmed actions in one app, through the same surface, folded), the
/// latest one in full.
func workComputerUseRunLayout(_ actions: [WorkComputerUseAction]) -> (earlier: [WorkComputerUseRunItem], latest: WorkComputerUseAction?) {
  guard !actions.isEmpty else { return ([], nil) }
  var lastDevice: (String?, String?)? = nil
  let withDevices = actions.map { action -> WorkComputerUseAction in
    guard action.surface == .appleDevice else { return action }
    if action.deviceName != nil {
      lastDevice = (action.deviceName, action.deviceOS)
      return action
    }
    guard let device = lastDevice else { return action }
    var copy = action
    copy.deviceName = device.0
    copy.deviceOS = action.deviceOS ?? device.1
    return copy
  }
  let compact = Array(withDevices.dropLast())
  func foldable(_ action: WorkComputerUseAction) -> Bool {
    action.appName != nil && action.outcome != .failed && action.outcome != .unconfirmed
  }
  // The surface label carries the screen product, the user browser and its
  // machine, and the Apple device: two actions fold only when every part matches.
  func foldKey(_ action: WorkComputerUseAction) -> String? {
    guard let appName = action.appName else { return nil }
    return "\(appName.lowercased())\u{0}\(action.surface.rawValue)\u{0}\(workComputerUseSurfaceLabel(action).label)"
  }
  var earlier: [WorkComputerUseRunItem] = []
  var index = 0
  while index < compact.count {
    let first = compact[index]
    guard foldable(first), let key = foldKey(first) else {
      earlier.append(.action(first))
      index += 1
      continue
    }
    var end = index + 1
    while end < compact.count, foldable(compact[end]), foldKey(compact[end]) == key { end += 1 }
    if end - index >= 2 {
      earlier.append(.appFold(appName: first.appName ?? "", actions: Array(compact[index..<end])))
    } else {
      earlier.append(.action(first))
    }
    index = end
  }
  return (earlier, withDevices.last)
}
