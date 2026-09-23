import SwiftUI

// MARK: - Chips (pure)

/// What a lane tool chip opens onto. Only things the phone can actually watch
/// or read get a chip: the Mac's active tool on its own ("Apple active") is a
/// fact about someone else's window, not something to tap, so it has none.
enum WorkToolChipKind: Equatable {
  /// The lane's Apple device, while it is up. Opens `AppleDeviceViewer`.
  /// `family` is the status's raw family, for the glyph.
  case simulator(family: String?)
  /// The desktop browser's tabs. Opens `WorkToolsSheet`.
  case browser
  /// What App Control is attached to. Opens `WorkToolsSheet`.
  case appControl
}

struct WorkToolChip: Equatable, Identifiable {
  let kind: WorkToolChipKind
  let label: String
  /// Browser chip only: a chat in this lane is driving the browser right now.
  var agentUsingBrowser: Bool = false

  /// The text on the chip. The simulator chip already shows the device icon,
  /// so it drops the family word: "iPhone 16 Pro" shows as "16 Pro". VoiceOver
  /// still reads the full `label`.
  var displayLabel: String {
    guard case .simulator = kind else { return label }
    return appleDeviceChipModelName(label)
  }

  var id: String {
    switch kind {
    case .simulator: return "simulator"
    case .browser: return "browser"
    case .appControl: return "app-control"
    }
  }
}

/// The lane's tool chips for the chat's floating badge row, in order:
/// simulator, browser, App Control.
///
/// - Simulator: only while the lane's device is up (`appleDeviceRunningName`).
///   A device the lane keeps after Shut down is not advertised.
/// - Browser: when the desktop browser has tabs ("1 tab" / "N tabs"), or when
///   an agent is driving it with none listed ("Browser") — an agent on the
///   browser was always reason enough to surface it.
/// - App Control: the attached app's name.
func workToolChips(state: WorkToolsLaneState?, appleDevice: AppleDeviceStatus?) -> [WorkToolChip] {
  var chips: [WorkToolChip] = []
  if let name = appleDeviceRunningName(appleDevice) {
    chips.append(WorkToolChip(kind: .simulator(family: appleDevice?.device?.family), label: name))
  }
  let tabCount = state?.browser?.tabs.count ?? 0
  let agentUsingBrowser = workToolsAgentIsUsingBrowser(state)
  if tabCount > 0 || agentUsingBrowser {
    let label: String
    switch tabCount {
    case 0: label = "Browser"
    case 1: label = "1 tab"
    default: label = "\(tabCount) tabs"
    }
    chips.append(WorkToolChip(kind: .browser, label: label, agentUsingBrowser: agentUsingBrowser))
  }
  if let appName = state?.appControl?.appName.trimmingCharacters(in: .whitespacesAndNewlines),
     !appName.isEmpty {
    chips.append(WorkToolChip(kind: .appControl, label: appName))
  }
  return chips
}

/// Whether a chat in this lane is driving the browser right now. Derived on the
/// Mac from the browser commands themselves, and it expires on its own — so a
/// chip that stops seeing it simply stops showing it.
func workToolsAgentIsUsingBrowser(_ state: WorkToolsLaneState?) -> Bool {
  !(state?.agentBrowserPresence ?? []).isEmpty
}

/// The lane's device name while it is up ("iPhone 16 Pro"), nil otherwise.
///
/// Up means simctl reports it `Booted`, or the host is streaming it. A device
/// the lane keeps after Shut down carries its own `state` ("Shutdown"), and a
/// status with no device state at all is not evidence the device is on, so
/// both read as off. The host fills a missing name with the udid; that is not
/// a name, so the family ("iPhone") stands in for it.
/// A device name without its leading family word: "iPhone 16 Pro" -> "16 Pro",
/// "iPad Air (M2)" -> "Air (M2)". A name that is only the family word, or that
/// does not start with one, stays as it is.
func appleDeviceChipModelName(_ name: String) -> String {
  for family in ["iPhone", "iPad"] {
    guard name.count > family.count,
          name.prefix(family.count).caseInsensitiveCompare(family) == .orderedSame
    else { continue }
    let rest = name.dropFirst(family.count)
    guard rest.first == " " else { continue }
    let model = rest.trimmingCharacters(in: .whitespaces)
    return model.isEmpty ? name : model
  }
  return name
}

func appleDeviceRunningName(_ status: AppleDeviceStatus?) -> String? {
  guard let device = status?.device else { return nil }
  let booted = device.state?.caseInsensitiveCompare("Booted") == .orderedSame
  guard booted || status?.stream?.running == true else { return nil }
  let name = device.name?.trimmingCharacters(in: .whitespacesAndNewlines)
  let usableName = (name?.isEmpty == false && name != device.udid) ? name : nil
  return usableName ?? appleDeviceFamilyLabel(device.family) ?? "Simulator"
}

// MARK: - Model

/// Reads the lane's tool state for the chat's badge row.
///
/// The Work tools pane — browser, App Control, the Apple device — runs on the
/// Mac. The phone can watch the device and read the rest, so the chat shows a
/// chip for each of those that exists right now. The Mac's state is not
/// table-backed, so this polls: one loop per chat, every 10 s, cancelled with
/// the chat's `.task`.
///
/// Only the derived chips are published. `apple.status` carries fps and
/// bitrate, which change on every read while a stream runs; publishing the raw
/// status would re-render the whole chat every tick for numbers no chip shows.
@MainActor
final class WorkLaneToolsModel: ObservableObject {
  /// Deliberately much slower than `WorkToolsSheet`'s 3 s: that is a surface
  /// the user opened to watch, whereas these chips sit behind every chat.
  static let refreshInterval: Duration = .seconds(10)

  @Published private(set) var chips: [WorkToolChip] = []
  /// Handed to `AppleDeviceViewer` as its first frame of state. Not published.
  private(set) var appleStatus: AppleDeviceStatus?
  /// True while the tools sheet or the device viewer is up. Both poll the same
  /// reads faster and are the authoritative view, so a tick here would be a
  /// duplicate RPC for chips nobody can see. The next tick after dismissal
  /// catches up.
  var paused = false

  func run(laneId: String, syncService: SyncService) async {
    chips = []
    appleStatus = nil
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    await refresh(laneId: trimmed, syncService: syncService)
    while !Task.isCancelled {
      try? await Task.sleep(for: Self.refreshInterval)
      guard !Task.isCancelled else { return }
      guard !paused else { continue }
      await refresh(laneId: trimmed, syncService: syncService)
    }
  }

  /// Both reads at once, each gated on its own action: a Mac with the pane
  /// state but no Apple support keeps the chips it always could show, and
  /// neither read goes on the wire unadvertised.
  func refresh(laneId: String, syncService: SyncService) async {
    let readTools = syncService.supportsWorkToolsState
    let readApple = syncService.supportsAppleDeviceStatus
    async let nextState: WorkToolsLaneState? = readTools
      ? (try? await syncService.fetchWorkToolsLaneState(laneId: laneId))
      : nil
    async let nextApple: AppleDeviceStatus? = readApple
      ? (try? await syncService.fetchAppleDeviceStatus(laneId: laneId))
      : nil
    let (tools, apple) = await (nextState, nextApple)
    guard !Task.isCancelled else { return }
    appleStatus = apple
    let next = workToolChips(state: tools, appleDevice: apple)
    if next != chips { chips = next }
  }

  #if DEBUG
  /// Fixture seam for previews and simulator screenshots.
  func installPreview(state: WorkToolsLaneState?, appleStatus: AppleDeviceStatus?) {
    self.appleStatus = appleStatus
    chips = workToolChips(state: state, appleDevice: appleStatus)
  }
  #endif
}

#if DEBUG
/// What a preview installs into `WorkLaneToolsModel` in place of the poll.
struct WorkLaneToolsPreview {
  var state: WorkToolsLaneState?
  var appleStatus: AppleDeviceStatus?
}
#endif

// MARK: - Chip view

/// One lane tool chip in the chat's badge row. Same capsule as the PR and chat
/// info chips (`WorkComposerBadgeCapsule`), so the row reads as one set.
struct WorkLaneToolChipView: View {
  let chip: WorkToolChip
  let onOpen: () -> Void

  var body: some View {
    WorkComposerBadgeCapsule(
      tint: tint,
      spacing: 6,
      accessibilityLabel: accessibilityText,
      onOpen: onOpen
    ) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .semibold))
      Text(chip.displayLabel)
        .font(.caption.weight(.semibold))
        .lineLimit(1)
      if case .simulator = chip.kind {
        // The device is up: a small live dot, the one colour on the chip.
        Circle()
          .fill(ADEColor.success)
          .frame(width: 6, height: 6)
          .accessibilityHidden(true)
      }
    }
  }

  private var symbol: String {
    switch chip.kind {
    case .simulator(let family): return family == "ipad" ? "ipad" : "iphone"
    case .browser: return "globe"
    case .appControl: return "macwindow"
    }
  }

  /// Neutral by default; the browser chip takes the accent while an agent is
  /// driving it, which is the signal the old Tools row carried as a globe.
  private var tint: Color {
    chip.agentUsingBrowser ? ADEColor.accent : ADEColor.textSecondary
  }

  private var accessibilityText: String {
    switch chip.kind {
    case .simulator:
      return "\(chip.label) running on your Mac. Tap to watch."
    case .browser:
      let base = chip.label == "Browser" ? "Browser on your Mac" : "Browser on your Mac, \(chip.label)"
      return chip.agentUsingBrowser
        ? "\(base). An agent is using the browser. Tap for details."
        : "\(base). Tap for details."
    case .appControl:
      return "App Control on your Mac, \(chip.label). Tap for details."
    }
  }
}

// MARK: - Labels

/// Human label for a `WorkToolId`. Unknown ids come from a newer desktop, so
/// they are shown verbatim rather than dropped — the phone should not decide a
/// tool does not exist because it has not shipped a name for it yet.
func workToolsDisplayName(_ toolId: String?) -> String? {
  guard let toolId, !toolId.isEmpty else { return nil }
  switch toolId {
  case "terminal": return "Terminal"
  case "git": return "Git"
  case "files": return "Files"
  case "ios": return "Apple"
  case "app-control": return "App Control"
  case "browser": return "Browser"
  default: return toolId
  }
}

func workToolsAccessibilityHint(_ toolId: String?) -> String? {
  switch toolId {
  case "ios": return "Apple simulators and previews"
  default: return nil
  }
}
