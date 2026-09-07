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

  @EnvironmentObject private var syncService: SyncService
  @State private var state: WorkToolsLaneState?
  @State private var toolsPresented = false

  var body: some View {
    if syncService.supportsWorkToolsState, let summary = summaryLine {
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
      .task(id: laneId) { await refresh() }
      .sheet(isPresented: $toolsPresented) {
        WorkToolsSheet(laneId: laneId)
          .presentationDetents([.medium, .large])
          .presentationDragIndicator(.visible)
      }
    } else {
      // Still probe once, so the row can appear when a desktop attaches later.
      Color.clear
        .frame(height: 0)
        .task(id: laneId) { await refresh() }
    }
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
