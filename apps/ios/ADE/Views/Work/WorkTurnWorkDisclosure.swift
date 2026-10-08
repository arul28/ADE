import SwiftUI

// MARK: - Turn work disclosure (tools / files toggles)

/// Which list a turn line's toggle opened. Desktop `ChatTurnWorkSummary` keeps
/// one open at a time.
enum WorkTurnWorkSection: String, Equatable {
  case tools
  case files
}

/// Central-expansion id of a turn line's tools or files list. The turn-end
/// line and the open fold's work line never both carry toggles for one turn
/// (a folded turn's line drops them), so one id per turn serves both.
func workTurnWorkExpansionId(_ section: WorkTurnWorkSection, turnKey: String) -> String {
  "turn-work:\(section.rawValue):\(turnKey)"
}

/// Prefix of the ids a turn's inline lists use for their own rows (a tool
/// call's output, a file's diff), namespaced so a turn row can find them.
func workTurnWorkItemExpansionPrefix(turnKey: String) -> String {
  "turn-work:item:\(turnKey):"
}

/// What a turn line's work toggles show and what they reveal inline.
struct WorkTurnWorkDisclosure {
  var activity: WorkToolGroupModel?
  var files: WorkChangedFilesGroupModel?
  var open: WorkTurnWorkSection?
  /// Tool-call / file ids (un-namespaced) the reader opened inside the lists.
  var expandedItemIds: Set<String> = []

  static let none = WorkTurnWorkDisclosure(activity: nil, files: nil, open: nil)

  var toolCount: Int { activity?.count ?? 0 }
  var fileStat: (count: Int, additions: Int, deletions: Int)? { workTurnFileStat(files) }
  var hasToggles: Bool { toolCount > 0 || (fileStat?.count ?? 0) > 0 }
}

/// `🔧 18 tools ›  ± 3 files changed +a −d ›` — the toggles that open the
/// turn's tools or files list inline (desktop `ChatTurnWorkSummary`).
struct WorkTurnWorkToggles: View {
  let disclosure: WorkTurnWorkDisclosure
  /// `files changed` (fold work line, desktop wording) or `files` (turn-end
  /// line, where the phone has less room).
  var filesLabelSuffix = " changed"
  let onToggle: (WorkTurnWorkSection) -> Void

  var body: some View {
    HStack(spacing: 10) {
      if disclosure.toolCount > 0 {
        toggle(.tools, accessibility: workPluralCount(disclosure.toolCount, "tool")) {
          Image(systemName: "wrench.fill").font(.system(size: 9, weight: .bold))
          Text("\(disclosure.toolCount)").monospacedDigit()
          Text(disclosure.toolCount == 1 ? "tool" : "tools")
        }
      }
      if let fileStat = disclosure.fileStat, fileStat.count > 0 {
        toggle(.files, accessibility: "files changed") {
          Image(systemName: "plusminus").font(.system(size: 9, weight: .bold))
          Text(workPluralCount(fileStat.count, "file") + filesLabelSuffix)
          if fileStat.additions > 0 { Text("+\(fileStat.additions)").monospacedDigit().foregroundStyle(ADEColor.success.opacity(0.85)) }
          if fileStat.deletions > 0 { Text("−\(fileStat.deletions)").monospacedDigit().foregroundStyle(ADEColor.danger.opacity(0.85)) }
        }
      }
    }
    .fixedSize()
  }

  private func toggle<Label: View>(
    _ section: WorkTurnWorkSection,
    accessibility: String,
    @ViewBuilder label: () -> Label
  ) -> some View {
    let isOpen = disclosure.open == section
    return Button {
      onToggle(section)
    } label: {
      HStack(spacing: 3) {
        label()
        Image(systemName: isOpen ? "chevron.down" : "chevron.right")
          .font(.system(size: 7, weight: .bold))
          .opacity(0.7)
      }
      .font(.caption2)
      .foregroundStyle(ADEColor.textSecondary)
      .lineLimit(1)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(isOpen ? "Hide" : "Show") \(accessibility) from this turn")
  }
}

/// The list a turn toggle opened, inline under the line with a left rule
/// (desktop `ChatToolActivityDetails` / `ChatTurnFilesChangedSummary`).
struct WorkTurnWorkInlineDetails: View {
  let disclosure: WorkTurnWorkDisclosure
  let onToggleItem: (String) -> Void

  var body: some View {
    Group {
      switch disclosure.open {
      case .tools:
        if let activity = disclosure.activity {
          WorkToolCallsPanelView(
            group: activity,
            isExpanded: true,
            onToggle: {},
            expandedMemberIds: disclosure.expandedItemIds,
            onToggleMember: onToggleItem,
            showsHeader: false
          )
        }
      case .files:
        if let files = disclosure.files {
          WorkChangedFilesPanelView(
            group: files,
            isExpanded: true,
            onToggle: {},
            expandedFileIds: disclosure.expandedItemIds,
            onToggleFile: onToggleItem,
            onUndo: nil,
            showsHeader: false
          )
        }
      case nil:
        EmptyView()
      }
    }
    .padding(.leading, 12)
    .overlay(alignment: .leading) {
      Rectangle().fill(ADEColor.glassBorder).frame(width: 0.6)
    }
    .padding(.bottom, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - Proof count

/// Proof in the thread is a count, not a strip of pictures: "3 proof filed ›"
/// (desktop `ChatProofCount`). The pictures live on the rows that filed them
/// and in the proof drawer, which this opens narrowed to the same records.
/// `compact` drops the word for a line with little room (the turn fold); the
/// count never truncates or wraps.
struct WorkProofCountLink: View {
  let count: Int
  var compact = false
  let onOpen: (() -> Void)?

  var body: some View {
    if count > 0 {
      Button {
        onOpen?()
      } label: {
        HStack(spacing: 3) {
          Image(systemName: "cube")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(ADEColor.textMuted.opacity(0.8))
          Text(compact ? "\(count) proof" : "\(count) proof filed")
            .font(.caption2.monospacedDigit())
          if onOpen != nil {
            Image(systemName: "chevron.right")
              .font(.system(size: 7, weight: .bold))
          }
        }
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
        .fixedSize()
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(onOpen == nil)
      .layoutPriority(2)
      .accessibilityLabel("\(count) proof filed")
      .accessibilityHint("Shows this proof in the proof drawer")
    }
  }
}
