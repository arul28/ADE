import Foundation
import SwiftUI

struct WorkImportSessionSummaryRow: View {
  let session: ExternalSessionSummary
  let lanes: [LaneSummary]
  /// False when the lane filter already names the one lane every row is in.
  var showsLane: Bool = true

  private var metaParts: [String] {
    var parts: [String] = []
    if !session.relativeUpdatedAt.isEmpty { parts.append(session.relativeUpdatedAt) }
    if let count = session.messageCount { parts.append("\(count) \(count == 1 ? "prompt" : "prompts")") }
    if let size = session.sizeDisplay { parts.append(size) }
    return parts
  }

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      WorkProviderBareLogo(
        provider: session.provider,
        fallbackSymbol: providerIcon(session.provider),
        tint: ADEColor.providerChatAccent(for: session.provider),
        size: 20
      )
      .padding(.top, 2)
      .accessibilityLabel(workExternalSessionProviderName(session.provider))

      VStack(alignment: .leading, spacing: 5) {
        Text(session.rowHeading)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)

        HStack(spacing: 5) {
          if showsLane {
            WorkImportLaneLabel(session: session, lanes: lanes)
          }
          if !metaParts.isEmpty {
            Text((showsLane ? "· " : "") + metaParts.joined(separator: " · "))
          }
        }
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)

        WorkImportStatusBadges(session: session)

        if let started = session.startedAnchorSnippet,
           let latest = session.latestAnchorMessage {
          WorkImportSessionAnchorBlock(started: started, latest: latest.text)
        } else if let started = session.startedAnchorSnippet {
          WorkImportSessionAnchorBlock(started: started, latest: nil)
        } else if let latest = session.latestAnchorMessage {
          WorkImportSessionAnchorBlock(started: nil, latest: latest.text)
        } else if !session.hasConversationAnchorData,
                  let preview = session.previewSnippet,
                  !session.previewDuplicatesHeading {
          Text(preview)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }

      Spacer(minLength: 4)
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .padding(.top, 4)
    }
    .padding(14)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    }
  }
}

private struct WorkImportSessionAnchorBlock: View {
  let started: String?
  let latest: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if let started {
        anchor(label: "started", text: started, lineLimit: 1)
      }
      if let latest {
        anchor(label: "latest", text: latest, lineLimit: 2)
      }
    }
    .padding(.leading, 9)
    .overlay(alignment: .leading) {
      Rectangle()
        .fill(ADEColor.glassBorder)
        .frame(width: 1)
    }
    .padding(.top, 2)
  }

  private func anchor(label: String, text: String, lineLimit: Int) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(label)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(text)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(lineLimit)
    }
  }
}

/// The detail header: heading, status, where the session lives, and the
/// conversation preview.
struct WorkImportSessionRow: View {
  let session: ExternalSessionSummary
  let lanes: [LaneSummary]

  private var detailParts: [String] {
    var parts: [String] = []
    if !session.relativeUpdatedAt.isEmpty { parts.append(session.relativeUpdatedAt) }
    if let count = session.messageCount { parts.append("\(count) \(count == 1 ? "prompt" : "prompts")") }
    if let size = session.sizeDisplay { parts.append(size) }
    return parts
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 7) {
        Text(session.rowHeading)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        WorkImportStatusBadges(session: session)
        HStack(spacing: 5) {
          WorkProviderBareLogo(
            provider: session.provider,
            fallbackSymbol: providerIcon(session.provider),
            tint: ADEColor.providerChatAccent(for: session.provider),
            size: 16
          )
          .accessibilityHidden(true)
          Text(workExternalSessionProviderName(session.provider))
          Text("·")
            .foregroundStyle(ADEColor.textMuted.opacity(0.7))
            .accessibilityHidden(true)
          WorkImportLaneLabel(session: session, lanes: lanes)
        }
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        if !detailParts.isEmpty {
          Text(detailParts.joined(separator: " · "))
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
      }

      WorkImportSessionPreview(session: session)
    }
    .padding(16)
    .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    }
  }
}

/// "In ADE", "Copied before" and "May be open elsewhere", as on the desktop row.
struct WorkImportStatusBadges: View {
  let session: ExternalSessionSummary

  var body: some View {
    if session.alreadyImported || session.importedBefore || session.possiblyActive {
      HStack(spacing: 6) {
        if session.alreadyImported {
          WorkImportBadge(text: "In ADE", tint: ADEColor.success)
        } else if session.importedBefore {
          WorkImportBadge(text: "Copied before", tint: ADEColor.textSecondary)
        }
        if session.possiblyActive {
          WorkImportBadge(text: "May be open elsewhere", tint: ADEColor.warning)
        }
      }
    }
  }
}

private struct WorkImportBadge: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.caption2.weight(.semibold))
      .foregroundStyle(tint)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(tint.opacity(0.12), in: Capsule())
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
