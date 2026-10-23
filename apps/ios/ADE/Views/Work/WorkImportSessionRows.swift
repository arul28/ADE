import Foundation
import SwiftUI

/// One list row, desktop's anatomy: the agent's logo, the heading, and one
/// quiet meta line (lane · when · prompts) with the import state at its end.
/// No card: the selected row (wide) gets the kit's pressed plane.
struct WorkImportSessionSummaryRow: View {
  let session: ExternalSessionSummary
  let lanes: [LaneSummary]
  /// False when the lane filter already names the one lane every row is in.
  var showsLane: Bool = true
  /// The row shown in the preview beside the list.
  var selected: Bool = false
  /// Compact: the row opens the preview as a step.
  var showsChevron: Bool = false

  private var metaParts: [String] {
    var parts: [String] = []
    if !session.relativeUpdatedAt.isEmpty { parts.append(session.relativeUpdatedAt) }
    if let count = session.messageCount { parts.append("\(count) \(count == 1 ? "prompt" : "prompts")") }
    return parts
  }

  private var importState: String? {
    if session.alreadyImported { return "In ADE" }
    if session.importedBefore { return "Copied before" }
    return nil
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      WorkProviderBareLogo(
        provider: session.provider,
        fallbackSymbol: providerIcon(session.provider),
        tint: workImportProviderTint(session.provider),
        size: 16
      )
      .padding(.top, 2)
      .accessibilityLabel(workExternalSessionProviderName(session.provider))

      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(session.rowHeading)
            .font(.subheadline.weight(selected ? .semibold : .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
          if session.possiblyActive {
            WorkImportLiveDot()
          }
        }

        HStack(spacing: 4) {
          if showsLane {
            WorkImportLaneLabel(session: session, lanes: lanes)
          }
          if !metaParts.isEmpty {
            if showsLane {
              Text("·").accessibilityHidden(true)
            }
            // When and how long win over a long folder name, which
            // truncates in the middle instead.
            Text(metaParts.joined(separator: " · "))
              .lineLimit(1)
              .layoutPriority(1)
          }
          Spacer(minLength: 4)
          if let importState {
            Text(importState)
              .foregroundStyle(session.alreadyImported ? ADEColor.success : ADEColor.textMuted)
              .fixedSize()
          }
        }
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
      }

      if showsChevron {
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))
          .padding(.top, 3)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      if selected {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(ADEColor.textPrimary.opacity(0.07))
      }
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// The tint for an agent drawn as a symbol (no bundled logo): a readable
/// neutral, never a hue that disappears on the dark page (Pi's).
func workImportProviderTint(_ provider: String) -> Color {
  providerAssetName(provider) == nil ? ADEColor.textSecondary : ADEColor.providerChatAccent(for: provider)
}

/// "May be open elsewhere", as one small amber dot (the meta line says the rest).
private struct WorkImportLiveDot: View {
  var body: some View {
    Circle()
      .fill(ADEColor.warning)
      .frame(width: 7, height: 7)
      .accessibilityLabel("May be open elsewhere")
  }
}

/// The preview's header, quiet like desktop's: the agent's logo and the
/// heading, then one meta line — agent, lane, when, prompts, size — and the
/// import state when there is one.
struct WorkImportSessionHeader: View {
  let session: ExternalSessionSummary
  let lanes: [LaneSummary]

  private var metaParts: [String] {
    var parts: [String] = []
    if !session.relativeUpdatedAt.isEmpty { parts.append(session.relativeUpdatedAt) }
    if let count = session.messageCount { parts.append("\(count) \(count == 1 ? "prompt" : "prompts")") }
    if let size = session.sizeDisplay { parts.append(size) }
    return parts
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(session.rowHeading)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 0)
      }
      HStack(spacing: 5) {
        WorkProviderBareLogo(
          provider: session.provider,
          fallbackSymbol: providerIcon(session.provider),
          tint: workImportProviderTint(session.provider),
          size: 14
        )
        .accessibilityHidden(true)
        Text(workExternalSessionProviderName(session.provider))
          .foregroundStyle(ADEColor.textSecondary)
        separator
        WorkImportLaneLabel(session: session, lanes: lanes)
          .foregroundStyle(ADEColor.textSecondary)
        ForEach(metaParts, id: \.self) { part in
          separator
          Text(part)
        }
      }
      .font(.caption)
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(1)
      WorkImportStatusBadges(session: session)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var separator: some View {
    Text("·")
      .foregroundStyle(ADEColor.textMuted.opacity(0.7))
      .accessibilityHidden(true)
  }
}

/// "In ADE", "Copied before" and "May be open elsewhere", as on the desktop row.
struct WorkImportStatusBadges: View {
  let session: ExternalSessionSummary

  var body: some View {
    if session.alreadyImported || session.importedBefore || session.possiblyActive {
      HStack(spacing: 6) {
        if session.alreadyImported {
          ADEKitTag(text: "In ADE", tone: .ok)
        } else if session.importedBefore {
          ADEKitTag(text: "Copied before", tone: .neutral)
        }
        if session.possiblyActive {
          ADEKitTag(text: "May be open elsewhere", tone: .warn)
        }
      }
      .padding(.top, 2)
    }
  }
}

/// Lane dot + name for a row. Never a worktree folder: a removed lane says so,
/// and a folder outside every lane shows its last path segment.
struct WorkImportLaneLabel: View {
  let session: ExternalSessionSummary
  let lanes: [LaneSummary]

  private var liveLane: LaneSummary? {
    guard session.home?.kind == "lane", let laneId = session.home?.laneId else { return nil }
    return lanes.first(where: { $0.id == laneId })
  }

  var body: some View {
    HStack(spacing: 4) {
      if session.home?.kind == "lane" {
        Circle()
          .fill(LaneColorPalette.displayColor(
            forHex: liveLane?.color ?? session.home?.color,
            fallback: ADEColor.textSecondary
          ))
          .frame(width: 6, height: 6)
      } else if session.home != nil {
        Image(systemName: "folder")
          .font(.caption2.weight(.semibold))
          .accessibilityHidden(true)
      }
      Text(liveLane?.name ?? session.laneDisplayName)
        .lineLimit(1)
        .truncationMode(.middle)
    }
  }
}
