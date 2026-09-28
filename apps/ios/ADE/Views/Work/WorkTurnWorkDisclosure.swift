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

/// Central-expansion id of a turn-end line's proof filmstrip.
func workTurnProofExpansionId(turnId: String) -> String {
  "turn-proof:\(turnId)"
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

// MARK: - Turn proof filmstrip

/// The proof a turn captured, as a row of thumbnails under its turn-end line
/// (desktop `ChatProofFilmstrip`, opened by the `N proof` chip). A thumbnail or
/// "open all" opens the proof drawer.
struct WorkTurnProofFilmstrip: View {
  let artifacts: [ComputerUseArtifactSummary]
  let content: [String: WorkLoadedArtifactContent]
  let onLoad: (ComputerUseArtifactSummary) -> Void
  let onOpen: (() -> Void)?

  @State private var open = true

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Button {
          open.toggle()
        } label: {
          HStack(spacing: 5) {
            Image(systemName: "cube").font(.system(size: 10, weight: .bold))
            Text("Proof").font(.caption.weight(.semibold))
            Text("· \(artifacts.count)").font(.caption.monospacedDigit())
              .foregroundStyle(ADEColor.textMuted)
          }
          .foregroundStyle(ADEColor.textSecondary)
          .frame(minHeight: 32)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Proof, \(artifacts.count). \(open ? "Hide" : "Show") thumbnails.")
        Spacer(minLength: 0)
        if let onOpen {
          Button("open all", action: onOpen)
            .font(.caption2.weight(.medium))
            .foregroundStyle(ADEColor.textMuted)
            .frame(minHeight: 32)
            .buttonStyle(.plain)
        }
      }
      if open {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(artifacts) { artifact in
              Button {
                onOpen?()
              } label: {
                thumbnail(artifact)
                  .frame(width: 96, height: 60)
                  .background(Color.black.opacity(0.25))
                  .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                  .overlay(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                      .stroke(ADEColor.glassBorder, lineWidth: 0.6)
                  )
              }
              .buttonStyle(.plain)
              .accessibilityLabel(artifact.title.isEmpty ? "Proof" : artifact.title)
              .task { onLoad(artifact) }
            }
          }
        }
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(ADEColor.surfaceBackground.opacity(0.4), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .padding(.bottom, 6)
  }

  @ViewBuilder
  private func thumbnail(_ artifact: ComputerUseArtifactSummary) -> some View {
    switch content[artifact.id] {
    case .image(let image):
      Image(uiImage: image).resizable().scaledToFill()
    case .remoteURL(let url) where workArtifactIsImage(artifact):
      AsyncImage(url: url) { image in
        image.resizable().scaledToFill()
      } placeholder: {
        Color.clear
      }
    case .video, .videoOnDemand, .remoteURL:
      Image(systemName: "play.rectangle.fill")
        .foregroundStyle(ADEColor.accent)
    default:
      Text(workArtifactKindLabel(artifact.artifactKind))
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .multilineTextAlignment(.center)
        .padding(4)
    }
  }
}
