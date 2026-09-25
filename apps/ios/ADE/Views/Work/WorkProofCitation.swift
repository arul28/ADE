import SwiftUI
import UIKit

// MARK: - Proof inside the answer

/// What an answer's proof citations read: the chat's proof, the bytes loaded
/// so far, and the loader. Nil on surfaces with no chat (previews, the PR
/// wizard); a citation there says it cannot show the proof.
struct WorkProofCitationContext {
  let artifactsById: [String: ComputerUseArtifactSummary]
  /// Finds a cited id the chat's own list does not hold (another chat's proof
  /// in the same project). Nil where there is no database to ask.
  var lookup: ((String) -> ComputerUseArtifactSummary?)? = nil
  let content: [String: WorkLoadedArtifactContent]
  let load: WorkArtifactLoader
}

private struct WorkProofCitationEnvironmentKey: EnvironmentKey {
  static let defaultValue: WorkProofCitationContext? = nil
}

extension EnvironmentValues {
  var workProofCitations: WorkProofCitationContext? {
    get { self[WorkProofCitationEnvironmentKey.self] }
    set { self[WorkProofCitationEnvironmentKey.self] = newValue }
  }
}

/// `![caption](ade-proof://<id>)` in an answer: the picture or the video at a
/// readable size, the caption under it, and where it came from.
struct WorkProofCitationView: View {
  let artifactId: String
  let caption: String
  var compact = false

  @Environment(\.workProofCitations) private var citations
  @State private var viewerOpen = false

  private var mediaMaxHeight: CGFloat { compact ? 220 : 360 }

  var body: some View {
    if let citations, let artifact = citations.artifactsById[artifactId] ?? citations.lookup?(artifactId) {
      VStack(alignment: .leading, spacing: 6) {
        media(artifact: artifact, content: citations.content[artifactId], load: citations.load)
          .task(id: artifactId) { await citations.load(artifact, .preview) }
        captionRows(artifact)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .fullScreenCover(isPresented: $viewerOpen) {
        WorkProofViewer(
          artifacts: [artifact],
          artifactContent: citations.content,
          initialArtifactId: artifact.id,
          onLoadArtifact: citations.load
        )
      }
    } else {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "exclamationmark.triangle")
          .foregroundStyle(ADEColor.warning)
        Text(missingText)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.recessedBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }

  private var missingText: String {
    let cited = caption.isEmpty ? "" : " It was cited as \"\(caption)\"."
    return "ADE has no proof with the id \(artifactId).\(cited)"
  }

  @ViewBuilder
  private func media(
    artifact: ComputerUseArtifactSummary,
    content: WorkLoadedArtifactContent?,
    load: @escaping WorkArtifactLoader
  ) -> some View {
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    switch content {
    case .image(let image):
      Button {
        viewerOpen = true
      } label: {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxHeight: mediaMaxHeight)
          .clipShape(shape)
          .overlay(shape.strokeBorder(ADEColor.border.opacity(0.3)))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(captionText(artifact))
      .accessibilityHint("Opens the proof full screen")
    case .video(let url), .remoteURL(let url):
      WorkArtifactVideoPlayerView(url: url)
        .aspectRatio(16.0 / 10.0, contentMode: .fit)
        .frame(maxHeight: mediaMaxHeight)
        .clipShape(shape)
    case .videoOnDemand(let sizeBytes):
      WorkArtifactPlayPlaceholder(
        sizeBytes: sizeBytes,
        tint: ADEColor.textSecondary,
        onPlay: { Task { await load(artifact, .play) } }
      )
      .frame(maxWidth: .infinity, minHeight: compact ? 120 : 180)
      .background(Color.black.opacity(0.85), in: shape)
    case .text:
      Text("This proof is text. Open the proof sheet to read it.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
    case .error(let message):
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ADEColor.recessedBackground.opacity(0.6), in: shape)
    case .none:
      ProgressView()
        .frame(maxWidth: .infinity, minHeight: compact ? 120 : 180)
        .background(ADEColor.recessedBackground.opacity(0.6), in: shape)
    }
  }

  private func captionText(_ artifact: ComputerUseArtifactSummary) -> String {
    if !caption.isEmpty { return caption }
    let description = artifact.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return description.isEmpty ? WorkProofRowModel(artifact: artifact).title : description
  }

  @ViewBuilder
  private func captionRows(_ artifact: ComputerUseArtifactSummary) -> some View {
    Text(captionText(artifact))
      .font(.footnote)
      .foregroundStyle(ADEColor.textSecondary)
    // The one provenance fact worth a line in an answer: a video older than the request.
    if let older = workProofProvenanceLines(artifact.metadataJson).older {
      Text(older)
        .font(.caption2)
        .foregroundStyle(ADEColor.warning)
    }
  }
}

/// A ```proof-compare block: before and after, side by side.
struct WorkProofCompareView: View {
  let compare: WorkProofCompare

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        side("Before", compare.before)
        side("After", compare.after)
      }
      if !compare.caption.isEmpty {
        Text(compare.caption)
          .font(.footnote)
          .foregroundStyle(ADEColor.textPrimary)
      }
    }
  }

  private func side(_ title: String, _ entry: WorkProofCompareSide) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title.uppercased())
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      WorkProofCitationView(artifactId: entry.artifactId, caption: entry.label, compact: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
