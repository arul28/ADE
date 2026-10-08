import Foundation

// How a computer-use action reads: the sentence parts, its plain text, the
// surface it used, the outcome note, and how a run of actions lays out. A
// faithful port of `apps/desktop/src/shared/computerUseActionPresentation.ts`;
// keep them in step. The actions come from `WorkComputerUseSummary.swift`.

/// One action as one line, naming what it acted on: "Clicked “Save” in
/// TextEdit", "Pressed ⌘Space on Mac Desktop".
struct WorkComputerUseParts: Equatable {
  let lead: String
  let target: String?
  let targetQuoted: Bool
  let place: WorkComputerUsePlace?
  /// The surface, only when nothing else says where: "on Mac Desktop", "using your Chrome".
  let using: (preposition: String, label: String, symbol: String, warning: Bool)?
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
  // A look at a whole screen or simulator names it: "Looked at Mac Desktop".
  let looksAtSurface = lookedAt && action.target == nil
    && (action.surface == .laneScreen || action.surface == .appleDevice)
  let lead: String
  if action.target != nil {
    lead = verbPhrase
  } else if looksAtSurface {
    lead = "\(verbPhrase) \(workComputerUseSurfaceLabel(action).label)"
  } else if lookedAt {
    lead = "\(verbPhrase) \(action.domain == "browser" ? "the page" : "the screen")"
  } else if action.verb == "launch" {
    // "Launched the app": App Control could not tell which.
    lead = "\(verbPhrase) the app"
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
    place: action.place, using: looksAtSurface ? nil : workComputerUseWhere(action),
    suffix: action.postedToPr.map { "· posted to PR #\($0)" } ?? action.prNumber.map { "· on PR #\($0)" }
  )
}

/// The sentence as plain text, for accessibility (desktop `computerUseActionText`).
func workComputerUseText(_ action: WorkComputerUseAction) -> String {
  let parts = workComputerUseParts(action)
  let target = parts.target.map { parts.targetQuoted ? "“\($0)”" : $0 }
  let place = parts.place.map { "\($0.preposition) \($0.label)" }
  let using = parts.using.map { "\($0.preposition) \($0.label)" }
  let text = [parts.lead, target, place, using, parts.suffix].compactMap { $0 }.joined(separator: " ")
  return action.outcome == .running ? "\(text)…" : text
}

/// Desktop `computerUseWhere`: a surface shows only when no app says where.
/// App Control never names itself; a screen or simulator names itself for a
/// screen-level action; a page names its site; proof is ADE's own and needs no
/// name; the user's own browser always shows, in amber.
private func workComputerUseWhere(_ action: WorkComputerUseAction) -> (preposition: String, label: String, symbol: String, warning: Bool)? {
  let surface = workComputerUseSurfaceLabel(action)
  let namesApp = action.appName != nil && (action.place?.kind == .app || action.target == action.appName)
  switch action.surface {
  case .appControl, .proof: return nil
  case .laneScreen, .appleDevice:
    return namesApp ? nil : ("on", surface.label, surface.symbol, surface.warning)
  case .adeBrowser:
    return action.place != nil ? nil : ("using", surface.label, surface.symbol, surface.warning)
  case .userBrowser:
    return ("using", surface.label, surface.symbol, surface.warning)
  }
}

/// Which surface an action used, in whose hands.
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
  // A proof says why ADE could not confirm it; an input, that nothing changed.
  case .unconfirmed:
    if action.verb.hasPrefix("proof"), let reason = action.reason { return (reason, false) }
    return ("Sent, but no change seen yet", false)
  default: return nil
  }
}

/// Desktop `computerUseShownProofIds`: the records a filed-proof line shows as
/// small pictures under it. A publish posts records filed elsewhere, and a
/// failed or running capture has nothing to show.
func workComputerUseShownProofIds(_ action: WorkComputerUseAction) -> [String] {
  guard action.verb.hasPrefix("proof"), action.verb != "proof publish" else { return [] }
  guard action.outcome != .failed, action.outcome != .running else { return [] }
  return action.proofIds
}

/// One drawn line: an action, and how many identical actions in a row it stands for.
struct WorkComputerUseRunLine: Identifiable, Hashable {
  /// The first action of the line, so its identity holds while it grows.
  let id: String
  var action: WorkComputerUseAction
  var count: Int
}

/// An App Control action that named no app, told the app the run is driving.
private func workComputerUseWithApp(_ action: WorkComputerUseAction, _ appName: String) -> WorkComputerUseAction {
  var copy = action
  copy.appName = appName
  // "Looked at ADE", "Launched ADE": the app is the object.
  if (action.verb == "observe" || action.verb == "snapshot" || action.verb == "launch") && action.target == nil {
    copy.target = appName
    copy.targetQuoted = false
    copy.place = nil
  } else if action.place == nil && action.target != appName {
    copy.place = WorkComputerUsePlace(preposition: "in", label: appName, kind: .app)
  }
  return copy
}

/// Desktop `layoutComputerUseRun`: plain lines, the latest drawn in full.
/// Apple actions borrow the last device named in the run, App Control actions
/// the last app, and identical actions in a row merge into one line with a
/// count ("Looked at ADE ×3"). Posting proof to a PR adds to the line that
/// filed it ("Filed proof “Login” · posted to PR #12") when every record it
/// posted was filed earlier in the run.
func workComputerUseRunLayout(_ actions: [WorkComputerUseAction]) -> (earlier: [WorkComputerUseRunLine], latest: WorkComputerUseRunLine?) {
  var lastDevice: (String?, String?)? = nil
  var lastApp: String? = nil
  var lines: [(line: WorkComputerUseRunLine, key: String)] = []
  for original in actions {
    var action = original
    if action.surface == .appleDevice {
      if action.deviceName != nil {
        lastDevice = (action.deviceName, action.deviceOS)
      } else if let device = lastDevice {
        action.deviceName = device.0
        action.deviceOS = action.deviceOS ?? device.1
      }
    }
    if action.surface == .appControl {
      if let appName = action.appName {
        lastApp = appName
      } else if let appName = lastApp {
        action = workComputerUseWithApp(action, appName)
      }
    }
    if action.verb == "proof publish", action.outcome != .failed, action.outcome != .running,
       let prNumber = action.prNumber, !action.proofIds.isEmpty {
      let filed = action.proofIds.map { id in
        lines.firstIndex { $0.line.action.verb != "proof publish" && $0.line.action.proofIds.contains(id) }
      }
      if filed.allSatisfy({ $0 != nil }) {
        for index in Set(filed.compactMap { $0 }) {
          lines[index].line.action.postedToPr = prNumber
          lines[index].key = "\(lines[index].line.action.outcome)\u{0}\(workComputerUseText(lines[index].line.action))"
        }
        continue
      }
    }
    let key = "\(action.outcome)\u{0}\(workComputerUseText(action))"
    if let last = lines.last, last.key == key {
      lines[lines.count - 1].line.action = action
      lines[lines.count - 1].line.count += 1
    } else {
      lines.append((WorkComputerUseRunLine(id: action.id, action: action, count: 1), key))
    }
  }
  let drawn = lines.map(\.line)
  return (Array(drawn.dropLast()), drawn.last)
}
