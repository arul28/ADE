import Foundation

// The `ade android` part of the computer-use summary parser
// (`WorkComputerUseSummary.swift`). A port of the Android section of the
// desktop parser, `apps/desktop/src/shared/computerUseActionSummary.ts`. Keep
// them in step.

private func cuPassive(_ past: String, _ progressive: String, _ infinitive: String, _ target: CUTargetKind = .none) -> CUVerbSpec {
  CUVerbSpec(past: past, progressive: progressive, infinitive: infinitive, target: target, passive: true)
}

/// `ade android` verbs that read as an action row, by the word typed.
private let cuAndroidVerbs: [String: CUVerbSpec] = [
  "start": cuPassive("Started", "Starting", "start"),
  "stop": cuPassive("Stopped", "Stopping", "stop"),
  "device-create": cuPassive("Created", "Creating", "create"),
  "device-attach": cuPassive("Attached", "Attaching", "attach"),
  "device-detach": cuPassive("Released", "Releasing", "release"),
  "find-element": cuPassive("Found", "Finding", "find", .element),
  "fill-element": cuVerbs["fill"]!,
  "drag": .init(past: "Dragged", progressive: "Dragging", infinitive: "drag", target: .none),
  "rotate": .init(past: "Rotated to", progressive: "Rotating to", infinitive: "rotate to", target: .none),
  "install": .init(past: "Installed", progressive: "Installing", infinitive: "install", target: .app),
  "uninstall": .init(past: "Uninstalled", progressive: "Uninstalling", infinitive: "uninstall", target: .app),
  "app-state": cuPassive("Checked", "Checking", "check", .app),
  "location": .init(past: "Set the location to", progressive: "Setting the location to", infinitive: "set the location to", target: .none),
  "appearance": .init(past: "Switched to", progressive: "Switching to", infinitive: "switch to", target: .none),
  "fold": .init(past: "Set the hinge to", progressive: "Setting the hinge to", infinitive: "set the hinge to", target: .none),
  "posture": cuPassive("Read the hinge of", "Reading the hinge of", "read the hinge of"),
  "settings": .init(past: "Set", progressive: "Setting", infinitive: "set", target: .none),
  "permission": .init(past: "Granted", progressive: "Granting", infinitive: "grant", target: .none),
  "proof-bundle": .init(past: "Filed a proof bundle", progressive: "Filing a proof bundle", infinitive: "file a proof bundle", target: .caption),
  "preview": .init(past: "Rendered Compose previews", progressive: "Rendering Compose previews", infinitive: "render Compose previews", target: .none),
  "test": .init(past: "Ran tests", progressive: "Running tests", infinitive: "run tests", target: .none),
  "render": cuPassive("Rendered", "Rendering", "render"),
  "log": cuPassive("Read the log of", "Reading the log of", "read the log of"),
  "inspect": cuPassive("Inspected", "Inspecting", "inspect", .element),
  "frame": cuPassive("Took a frame of", "Taking a frame of", "take a frame of", .page),
  "foreground": .init(past: "Switched to", progressive: "Switching to", infinitive: "switch to", target: .app),
  "select": cuPassive("Picked", "Picking", "pick", .element),
]

/// Verbs shared with the other surfaces, read through `cuVerbs`.
private let cuAndroidSharedVerbs: Set<String> = [
  "tap", "tap-element", "long-press", "swipe", "scroll", "type", "key", "button", "launch", "relaunch",
  "terminate", "open-url", "snapshot", "screenshot", "wait-for-element", "assert-visible",
  "record-start", "record-stop",
]

/// `ade android` verbs whose object is the emulator itself.
let cuAndroidLifecycleVerbs: Set<String> = ["start", "stop", "device-create", "device-attach", "device-detach"]

/// `ade android key`'s modifier flags, in the CLI's order, and the name each reads as.
private let cuAndroidKeyModifiers: [(flag: String, name: String)] = [
  ("--shift", "Shift"), ("--ctrl", "Ctrl"), ("--control", "Ctrl"), ("--alt", "Alt"),
  ("--option", "Alt"), ("--meta", "Meta"), ("--cmd", "Meta"), ("--command", "Meta"),
]

/// `ade android settings`' one-setting flags, in the CLI's order.
private let cuAndroidSettingFlags = [
  "--text-size", "--display-size", "--animations", "--show-taps", "--layout-bounds",
  "--battery", "--charging", "--wifi", "--data", "--airplane",
]

func cuResolveAndroidVerb(_ first: String, _ invocation: CUInvocation) -> (key: String, spec: CUVerbSpec)? {
  if first == "preview", invocation.positionals.first == "list" {
    return ("preview list", cuPassive("Listed Compose previews", "Listing Compose previews", "list Compose previews"))
  }
  if first == "settings", cuAndroidSettingChange(invocation) == nil {
    return ("settings", cuPassive("Read the settings of", "Reading the settings of", "read the settings of"))
  }
  if first == "permission", invocation.positionals.first?.lowercased() == "revoke" {
    return ("permission", .init(past: "Revoked", progressive: "Revoking", infinitive: "revoke", target: .none))
  }
  if first == "auto-record" {
    let word = invocation.positionals.first?.lowercased() ?? "status"
    guard word == "on" || word == "off" else { return (first, cuPassive("Checked auto-record", "Checking auto-record", "check auto-record")) }
    return (first, .init(past: "Turned \(word) auto-record", progressive: "Turning \(word) auto-record", infinitive: "turn \(word) auto-record", target: .none))
  }
  if first == "fill-element" { return ("fill", cuAndroidVerbs["fill-element"]!) }
  if let own = cuAndroidVerbs[first] { return (first, own) }
  guard cuAndroidSharedVerbs.contains(first) else { return nil }
  return cuVerbs[first].map { (first, $0) }
}

/// The setting `ade android settings` changed, as words: "text size to large".
private func cuAndroidSettingChange(_ invocation: CUInvocation) -> String? {
  for flag in cuAndroidSettingFlags {
    if let value = invocation.flag(flag) {
      return "\(flag.dropFirst(2).replacingOccurrences(of: "-", with: " ")) to \(value)"
    }
  }
  return nil
}

/// Package names whose last word is not the app's name.
private let cuAndroidKnownApps: [String: String] = [
  "com.android.chrome": "Chrome",
  "com.android.vending": "Play Store",
  "com.google.android.gm": "Gmail",
  "com.google.android.youtube": "YouTube",
  "com.google.android.dialer": "Phone",
  "com.google.android.apps.messaging": "Messages",
  "com.google.android.apps.photos": "Photos",
  "com.google.android.apps.nexuslauncher": "Home",
]

func cuAppName(fromPackage packageName: String?) -> String? {
  guard let packageName else { return nil }
  return cuAndroidKnownApps[packageName.lowercased()] ?? cuAppName(fromBundleId: packageName)
}

/// A stroke's way, as the finger moves: from y 1500 to y 500 is "up".
private func cuStrokeDirection(_ positionals: [String]) -> String? {
  guard positionals.count >= 4 else { return nil }
  let values = positionals.prefix(4).compactMap { Double($0) }
  guard values.count == 4, values.allSatisfy({ $0.isFinite }) else { return nil }
  let dx = values[2] - values[0]
  let dy = values[3] - values[1]
  if dx == 0, dy == 0 { return nil }
  return abs(dy) >= abs(dx) ? (dy < 0 ? "up" : "down") : (dx < 0 ? "left" : "right")
}

/// The target of an `ade android` verb whose words differ from the shared reading. Nil hands it to `cuDescribeTarget`.
func cuAndroidTarget(verbKey: String, invocation: CUInvocation, parsed: CUOutput, output: String) -> CUTargetShape? {
  func shape(_ target: String?, _ quoted: Bool = false, _ direction: String? = nil) -> CUTargetShape {
    CUTargetShape(target: target, quoted: quoted, direction: direction, point: false)
  }
  let words = invocation.positionals
  let first = words.first
  let second = words.count > 1 ? words[1] : nil
  switch verbKey {
  case "tap-element", "fill", "find-element", "wait-for-element", "assert-visible":
    if let named = parsed.hitName ?? cuReadAndroidElementName(output) ?? invocation.flag("--label", "--text", "--identifier") {
      return shape(named, true)
    }
    if verbKey == "fill" { return shape(invocation.flag("--value") ?? first, true) }
    return nil
  case "long-press":
    let x = invocation.flag("--x") ?? first
    let y = invocation.flag("--y") ?? second
    if let x, let y, cuTests(cuNumberPattern, x), cuTests(cuNumberPattern, y), let xv = Double(x), let yv = Double(y) {
      return CUTargetShape(target: "\(cuJSRound(xv)), \(cuJSRound(yv))", quoted: false, direction: nil, point: true)
    }
    return shape(nil)
  case "swipe":
    return shape(nil, false, cuStrokeDirection(words))
  case "button":
    return shape(first ?? invocation.flag("--name", "--key"), true)
  case "key":
    // `key --shift a`: the key may sit in the last modifier's slot.
    let modifiers = cuAndroidKeyModifiers.filter { invocation.has($0.flag) }
    let stuck = modifiers.lazy.compactMap { invocation.flags[$0.flag] ?? nil }.first
    guard let key = first ?? invocation.flag("--name", "--key") ?? stuck else { return shape(nil, true) }
    var names: [String] = []
    for modifier in modifiers where !names.contains(modifier.name) { names.append(modifier.name) }
    return shape((names + [key]).joined(separator: "+"), true)
  case "inspect", "select":
    if let name = parsed.hitName { return shape(name, true) }
    if let x = invocation.flag("--x"), let y = invocation.flag("--y"), cuTests(cuNumberPattern, x), cuTests(cuNumberPattern, y),
       let xv = Double(x), let yv = Double(y) {
      return CUTargetShape(target: "\(cuJSRound(xv)), \(cuJSRound(yv))", quoted: false, direction: nil, point: true)
    }
    return shape(invocation.flag("--ref"))
  case "rotate", "appearance":
    return shape(first.map { "\($0.lowercased())\(verbKey == "appearance" ? " mode" : "")" })
  case "launch", "relaunch", "terminate", "uninstall", "app-state", "foreground":
    let packageName = invocation.flag("--package") ?? first ?? cuReadString(parsed.json?["packageName"])
    return shape(cuAppName(fromPackage: packageName) ?? (verbKey == "launch" ? "the app" : nil))
  case "install":
    let apk = invocation.flag("--apk")
    let installed = cuAppName(fromPackage: cuReadString(parsed.json?["packageName"]))
    let apkName = apk.map { String($0.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? Substring($0)) }
    return shape(installed ?? apkName ?? "the app")
  case "location":
    let latitude = invocation.flag("--latitude") ?? first
    let longitude = invocation.flag("--longitude") ?? second
    if let latitude, let longitude { return shape("\(latitude), \(longitude)") }
    return shape(nil)
  case "fold":
    guard let word = invocation.flag("--angle") ?? first else { return shape(nil) }
    if cuTests(cuNumberPattern, word) { return shape("\(word)°") }
    return shape(word.lowercased() == "half" ? "half open" : word.lowercased())
  case "settings":
    return shape(cuAndroidSettingChange(invocation))
  case "permission":
    return shape(second.map { "\($0) permission" })
  case "record-start", "record-stop", "proof-bundle":
    return shape(invocation.flag("--label", "--caption"), true)
  case "preview":
    return shape(invocation.flag("--fqn").flatMap { $0.split(separator: ".").last.map(String.init) }, true)
  case "test":
    let className = invocation.flag("--class").flatMap { $0.split(separator: ".").last.map(String.init) }
    let method = invocation.flag("--method")
    return shape(className.map { name in method.map { "\(name).\($0)" } ?? name }, true)
  default:
    return nil
  }
}
