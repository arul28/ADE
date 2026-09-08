import SwiftUI

/// Compact disclosure above a chat transcript: "Tools · Browser active · 3 tabs".
///
/// The Work tools pane — browser, App Control, iOS simulator — runs on the
/// desktop and cannot run here. What the phone can usefully answer is *what is
/// my Mac doing right now*, so this row summarises that in one line and opens a
/// read-only sheet. It is a disclosure, not a control: nothing behind it drives
/// anything.
///
/// The row hides itself completely when the brain does not advertise
/// `workTools.getLaneState`, or when there is nothing to say. An empty "Tools ›"
/// that opens onto "nothing here" is worse than no row at all.
struct WorkToolsRow: View {
  let laneId: String

  /// Poll cadence while the row is on screen. Deliberately much slower than
  /// `WorkToolsSheet`'s 3s: the sheet is a surface the user opened to watch,
  /// whereas this row sits behind every chat transcript, so it only has to
  /// catch up within a few breaths of the Mac switching tools or closing tabs.
  private static let refreshInterval: Duration = .seconds(10)

  @EnvironmentObject private var syncService: SyncService
  @State private var state: WorkToolsLaneState?
  @State private var toolsPresented = false

  /// One root, so the probe and the sheet keep a single identity. Branching at
  /// the top level would give the two cases different identities, cancelling
  /// the poll and tearing down an open sheet every time the row appears or
  /// disappears.
  var body: some View {
    Group {
      if syncService.supportsWorkToolsState, let summary = summaryLine {
        summaryButton(summary)
      }
    }
    .task(id: laneId) { await refresh() }
    .task(id: laneId) {
      // The desktop's state is not table-backed, so there is nothing to
      // subscribe to; poll while the row is alive and stop when it is not.
      // The poll lives beside the initial load rather than inside it — the
      // same two-`.task` shape `WorkToolsSheet` uses — so a slow first
      // response cannot delay the cadence.
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.refreshInterval)
        guard !Task.isCancelled else { return }
        // The sheet is presented *from* this row, so the row stays mounted and
        // this loop keeps running underneath it. Skip while it is up: the
        // sheet polls the same `workTools.getLaneState` every 3s and is the
        // authoritative view, so a second read here is a duplicate RPC and a
        // duplicate decode for a summary line nobody can see. The row catches
        // up on the next tick after dismissal.
        guard !toolsPresented else { continue }
        await refresh()
      }
    }
    .sheet(isPresented: $toolsPresented) {
      WorkToolsSheet(laneId: laneId)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
  }

  private func summaryButton(_ summary: String) -> some View {
    Button {
      ADEHaptics.light()
      toolsPresented = true
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "wrench.and.screwdriver")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
        Text(summary)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
        Image(systemName: "chevron.right")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .frame(minHeight: 32)
      .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Tools on your Mac. \(summary)")
    .accessibilityHint("Opens a read-only view of this lane's tools")
  }

  /// One line, most-specific-first: the pane the desktop has open, then what is
  /// actually in it. Returns nil when there is genuinely nothing to report.
  private var summaryLine: String? {
    guard let state else { return nil }
    var parts: [String] = []
    if let label = workToolsDisplayName(state.activeTool) {
      parts.append("\(label) active")
    }
    if let tabCount = state.browser?.tabs.count, tabCount > 0 {
      parts.append(tabCount == 1 ? "1 tab" : "\(tabCount) tabs")
    }
    if let appControl = state.appControl {
      parts.append(appControl.appName)
    }
    guard !parts.isEmpty else { return nil }
    return (["Tools"] + parts).joined(separator: " · ")
  }

  private func refresh() async {
    guard syncService.supportsWorkToolsState else { return }
    let next = try? await syncService.fetchWorkToolsLaneState(laneId: laneId)
    guard !Task.isCancelled else { return }
    state = next
  }
}

/// Human label for a `WorkToolId`. Unknown ids come from a newer desktop, so
/// they are shown verbatim rather than dropped — the phone should not decide a
/// tool does not exist because it has not shipped a name for it yet.
func workToolsDisplayName(_ toolId: String?) -> String? {
  guard let toolId, !toolId.isEmpty else { return nil }
  switch toolId {
  case "terminal": return "Terminal"
  case "git": return "Git"
  case "files": return "Files"
  case "ios": return "iOS Simulator"
  case "app-control": return "App Control"
  case "browser": return "Browser"
  case "pr": return "PR"
  default: return toolId
  }
}
