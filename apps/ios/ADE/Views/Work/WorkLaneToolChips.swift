import SwiftUI

// MARK: - Chips (pure)

/// What a lane tool chip opens onto. Only things the phone can actually watch
/// or read get a chip: the Mac's active tool on its own ("Apple active") is a
/// fact about someone else's window, not something to tap, so it has none.
enum WorkToolChipKind: Equatable {
  /// The lane's Apple device, while it is up. Opens `AppleDeviceViewer`.
  /// `family` is the status's raw family, for the glyph.
  case simulator(name: String, family: String?)
  /// The desktop browser, one chip for all its tabs. Opens the browser sheet,
  /// which lists the tabs. `agentUsing`: a chat
  /// in this lane is driving the browser right now.
  case browser(tabCount: Int, agentUsing: Bool)
  /// What App Control is attached to. Opens the App Control sheet.
  case appControl(appName: String)
  /// The lane's private macOS screen, while it has one. Opens
  /// `MacDesktopViewer`. `streamLive`: frames flow at full rate.
  /// `agentDriving`: an agent holds the screen's input lease.
  case macDesktop(streamLive: Bool, agentDriving: Bool)

  /// The SF Symbol on the chip. A simulator's follows its device family, so
  /// an Apple Watch does not show as an iPhone.
  var symbolName: String {
    switch self {
    case .simulator(_, let family): return appleDeviceFamilySymbol(family)
    case .browser: return "globe"
    case .appControl: return "macwindow"
    case .macDesktop: return "desktopcomputer"
    }
  }
}

struct WorkToolChip: Equatable, Identifiable {
  let kind: WorkToolChipKind

  /// The chip's full name, derived from `kind` so the two cannot drift.
  var label: String {
    switch kind {
    case .simulator(let name, _): return name
    case .browser(let tabCount, _): return workBrowserChipLabel(tabCount: tabCount)
    case .appControl(let appName): return appName
    case .macDesktop: return "macOS"
    }
  }

  /// The text on the chip. The simulator chip already shows the device icon,
  /// so it drops the family word: "iPhone 16 Pro" shows as "16 Pro". VoiceOver
  /// still reads the full `label`.
  var displayLabel: String {
    guard case .simulator(let name, _) = kind else { return label }
    return appleDeviceChipModelName(name)
  }

  var id: String {
    switch kind {
    case .simulator: return "simulator"
    case .browser: return "browser"
    case .appControl: return "app-control"
    case .macDesktop: return "mac-desktop"
    }
  }
}

/// The lane's tool chips for the chat's floating badge row, in order:
/// simulator, macOS (the lane's Mac Desktop), browser, App Control. The two screens the phone can
/// watch lead.
///
/// - Simulator: only while the lane's own device is up (`appleDeviceRunningName`).
///   A device the lane keeps after Shut down is not advertised.
/// - Mac Desktop: only while the lane holds a display on a host that can host
///   one. Live dot while frames flow at full rate; accent while an agent
///   drives it.
/// - Browser: when the desktop browser has tabs ("1 tab" / "N tabs"), or when
///   an agent is driving it with none listed ("Browser") — an agent on the
///   browser was always reason enough to surface it.
/// - App Control: the attached app's name.
func workToolChips(state: WorkToolsLaneState?, appleDevice: AppleDeviceStatus?) -> [WorkToolChip] {
  var chips: [WorkToolChip] = []
  if let name = appleDeviceRunningName(appleDevice) {
    chips.append(WorkToolChip(kind: .simulator(name: name, family: appleDevice?.device?.family)))
  }
  if let chip = macDesktopToolChip(state?.macDesktop) {
    chips.append(chip)
  }
  let tabCount = state?.browser?.tabs.count ?? 0
  let agentUsingBrowser = workToolsAgentIsUsingBrowser(state)
  if tabCount > 0 || agentUsingBrowser {
    chips.append(WorkToolChip(kind: .browser(tabCount: tabCount, agentUsing: agentUsingBrowser)))
  }
  if let appName = state?.appControl?.appName.trimmingCharacters(in: .whitespacesAndNewlines),
     !appName.isEmpty {
    chips.append(WorkToolChip(kind: .appControl(appName: appName)))
  }
  return chips
}

/// The Mac Desktop chip, or nil when the lane has no screen to show. A host
/// that cannot hold a display (`supported: false`) and a lane that has not
/// created one both read as "nothing to open".
func macDesktopToolChip(_ macDesktop: WorkToolsMacDesktopState?) -> WorkToolChip? {
  guard let macDesktop, macDesktop.supported, macDesktop.display != nil else { return nil }
  let stream = macDesktop.stream
  return WorkToolChip(kind: .macDesktop(
    streamLive: stream?.running == true && stream?.idle != true,
    agentDriving: macDesktop.lease?.holder == "agent"
  ))
}

/// The lane state the chips show after one poll.
///
/// A failed read (nil from a host that advertises the read) keeps the last
/// answer. The Mac can take longer than the phone waits while an agent drives
/// its screen, and dropping the state then hid the macOS chip for a display
/// that was up the whole time. A host that does not advertise the read has no
/// state at all.
func workToolsStateAfterRead(
  fetched: WorkToolsLaneState?,
  previous: WorkToolsLaneState?,
  supported: Bool
) -> WorkToolsLaneState? {
  guard supported else { return nil }
  return fetched ?? previous
}

/// "Browser" with no tabs, "1 tab", "N tabs".
func workBrowserChipLabel(tabCount: Int) -> String {
  switch tabCount {
  case ...0: return "Browser"
  case 1: return "1 tab"
  default: return "\(tabCount) tabs"
  }
}

/// Whether a chat in this lane is driving the browser right now. Derived on the
/// Mac from the browser commands themselves, and it expires on its own — so a
/// chip that stops seeing it simply stops showing it.
func workToolsAgentIsUsingBrowser(_ state: WorkToolsLaneState?) -> Bool {
  !(state?.agentBrowserPresence ?? []).isEmpty
}

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

/// The lane's device name while it is up ("iPhone 16 Pro"), nil otherwise.
///
/// The lane's means `laneDevice` names the same udid as `device`: for a lane
/// with no device the host reports any booted iPhone on the Mac, which is not
/// this lane's to show. Up means simctl reports it `Booted`, or the host is
/// streaming it. A device the lane keeps after Shut down carries its own
/// `state` ("Shutdown"), and a status with no device state at all is not
/// evidence the device is on, so both read as off. The host fills a missing
/// name with the udid; that is not a name, so the family ("iPhone") stands in.
func appleDeviceRunningName(_ status: AppleDeviceStatus?) -> String? {
  guard let device = status?.device,
        let udid = device.udid, !udid.isEmpty,
        status?.laneDevice?.udid == udid
  else { return nil }
  let booted = device.state?.caseInsensitiveCompare("Booted") == .orderedSame
  guard booted || status?.stream?.running == true else { return nil }
  let name = device.name?.trimmingCharacters(in: .whitespacesAndNewlines)
  let usableName = (name?.isEmpty == false && name != udid) ? name : nil
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

  /// The surface a chip opened.
  enum Surface: Equatable {
    case appleDevice
    case macDesktop
    /// A read-only sheet for one tool.
    case toolSheet(WorkToolsSheet.Tool)
  }

  @Published private(set) var chips: [WorkToolChip] = []
  @Published var presented: Surface?
  /// Handed to `AppleDeviceViewer` as its first frame of state. Not published.
  private(set) var appleStatus: AppleDeviceStatus?
  /// Handed to `MacDesktopViewer` the same way. Not published.
  private(set) var macDesktopState: WorkToolsMacDesktopState?
  /// The last lane state the Mac answered with. A read that fails or times
  /// out keeps it, so one slow reply does not blank every chip.
  private var lastTools: WorkToolsLaneState?

  /// True while a tool sheet or a viewer is up. Both poll the same
  /// reads faster and are the authoritative view, so a tick here would be a
  /// duplicate RPC for chips nobody can see. The next tick after dismissal
  /// catches up.
  var paused: Bool { presented != nil }

  /// `macDesktopStream`: the host can stream the lane's screen. A host
  /// without the live stream can still describe the screen, so the sheet shows
  /// its last still in the macOS sheet instead of a viewer that could only fail.
  func open(_ chip: WorkToolChip, macDesktopStream: Bool) {
    switch chip.kind {
    case .simulator: presented = .appleDevice
    case .macDesktop: presented = macDesktopStream ? .macDesktop : .toolSheet(.macDesktop)
    case .browser: presented = .toolSheet(.browser)
    case .appControl: presented = .toolSheet(.appControl)
    }
  }

  func isPresented(_ surface: Surface) -> Binding<Bool> {
    Binding(
      get: { self.presented == surface },
      set: { if !$0, self.presented == surface { self.presented = nil } }
    )
  }

  func run(laneId: String, syncService: SyncService) async {
    chips = []
    appleStatus = nil
    macDesktopState = nil
    lastTools = nil
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
    let (fetched, apple) = await (nextState, nextApple)
    guard !Task.isCancelled else { return }
    let tools = workToolsStateAfterRead(fetched: fetched, previous: lastTools, supported: readTools)
    lastTools = tools
    appleStatus = apple
    macDesktopState = tools?.macDesktop
    let next = workToolChips(state: tools, appleDevice: apple)
    if next != chips { chips = next }
  }

  #if DEBUG
  /// Fixture seam for previews and simulator screenshots.
  func installPreview(state: WorkToolsLaneState?, appleStatus: AppleDeviceStatus?) {
    self.appleStatus = appleStatus
    macDesktopState = state?.macDesktop
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

/// The chips' poll and the surfaces they open, on the chat view.
struct WorkLaneToolsPresenter: ViewModifier {
  @ObservedObject var model: WorkLaneToolsModel
  let laneId: String
  /// False for a personal chat, which has no lane.
  let enabled: Bool
  #if DEBUG
  var preview: WorkLaneToolsPreview?
  #endif
  @EnvironmentObject private var syncService: SyncService

  func body(content: Content) -> some View {
    content
      .task(id: laneId) {
        #if DEBUG
        if let preview {
          model.installPreview(state: preview.state, appleStatus: preview.appleStatus)
          return
        }
        #endif
        guard enabled else { return }
        await model.run(laneId: laneId, syncService: syncService)
      }
      .sheet(isPresented: model.isPresented(.toolSheet(.browser))) {
        toolSheet(.browser)
      }
      .sheet(isPresented: model.isPresented(.toolSheet(.appControl))) {
        toolSheet(.appControl)
      }
      .sheet(isPresented: model.isPresented(.toolSheet(.macDesktop))) {
        toolSheet(.macDesktop)
      }
      // Full screen, seeded with the last status so the first frame is not an empty viewer.
      .fullScreenCover(isPresented: model.isPresented(.appleDevice)) {
        AppleDeviceViewer(laneId: laneId, initialStatus: model.appleStatus)
      }
      .fullScreenCover(isPresented: model.isPresented(.macDesktop)) {
        MacDesktopViewer(laneId: laneId, initialState: model.macDesktopState)
      }
  }

  private func toolSheet(_ tool: WorkToolsSheet.Tool) -> some View {
    WorkToolsSheet(laneId: laneId, tool: tool)
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
  }
}

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
      if showsLiveDot {
        // The device is up, or the desktop is streaming: a small live dot.
        Circle()
          .fill(ADEColor.success)
          .frame(width: 6, height: 6)
          .accessibilityHidden(true)
      }
    }
  }

  private var symbol: String { chip.kind.symbolName }

  private var showsLiveDot: Bool {
    switch chip.kind {
    case .simulator: return true
    case .macDesktop(let streamLive, _): return streamLive
    case .browser, .appControl: return false
    }
  }

  /// Neutral by default; the browser and Mac Desktop chips take the accent
  /// while an agent is driving them, which is the signal the old Tools row
  /// carried as a globe.
  private var tint: Color {
    switch chip.kind {
    case .browser(_, agentUsing: true), .macDesktop(_, agentDriving: true): return ADEColor.accent
    default: return ADEColor.textSecondary
    }
  }

  private var accessibilityText: String { workToolChipAccessibilityText(chip) }
}

/// What VoiceOver reads for a chip.
func workToolChipAccessibilityText(_ chip: WorkToolChip) -> String {
  switch chip.kind {
  case .simulator:
    return "\(chip.label) running on your Mac. Tap to watch."
  case .browser(let tabCount, let agentUsing):
    let base = tabCount > 0 ? "Browser on your Mac, \(chip.label)" : "Browser on your Mac"
    return agentUsing
      ? "\(base). An agent is using the browser. Tap for details."
      : "\(base). Tap for details."
  case .appControl:
    return "App Control on your Mac, \(chip.label). Tap for details."
  case .macDesktop(let streamLive, let agentDriving):
    var text = "This lane's macOS desktop"
    if streamLive { text += ", live" }
    if agentDriving { text += ". An agent is driving it" }
    return text + ". Tap to watch."
  }
}
