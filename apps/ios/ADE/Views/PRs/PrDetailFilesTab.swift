import SwiftUI

private let prFilesInitialVisibleCount = 20

struct PrFilesTab: View {
  let snapshot: PullRequestSnapshot?
  let canOpenFiles: Bool
  let onOpenFile: (PrFile) -> Void
  let onCopyPath: (PrFile) -> Void

  @State private var showAll = false

  private var files: [PrFile] { snapshot?.files ?? [] }

  private var totals: (additions: Int, deletions: Int, renamed: Int) {
    var additions = 0
    var deletions = 0
    var renamed = 0
    for file in files {
      additions += file.additions
      deletions += file.deletions
      if file.status == "renamed" { renamed += 1 }
    }
    return (additions, deletions, renamed)
  }

  private var visibleFiles: [PrFile] {
    if showAll || files.count <= prFilesInitialVisibleCount {
      return files
    }
    return Array(files.prefix(prFilesInitialVisibleCount))
  }

  var body: some View {
    Group {
      if files.isEmpty {
        ADEEmptyStateView(
          symbol: "doc.text.magnifyingglass",
          title: "No changed files",
          message: "The host has not synced any file diff data for this PR yet."
        )
      } else {
        LazyVStack(spacing: 14) {
          PrFilesSummaryStrip(
            additions: totals.additions,
            deletions: totals.deletions,
            fileCount: files.count,
            renamed: totals.renamed
          )

          VStack(spacing: 10) {
            ForEach(visibleFiles) { file in
              PrFileDiffCard(
                file: file,
                canOpenFiles: canOpenFiles,
                onOpenFile: onOpenFile,
                onCopyPath: onCopyPath
              )
            }

            if !showAll && files.count > prFilesInitialVisibleCount {
              Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                  showAll = true
                }
              } label: {
                Text("Show all \(files.count) files")
                  .font(.system(.footnote, design: .monospaced).weight(.semibold))
                  .foregroundStyle(ADEColor.accent)
                  .frame(maxWidth: .infinity)
                  .padding(.vertical, 12)
              }
              .buttonStyle(.plain)
              .adeInsetField(cornerRadius: 14, padding: 0)
            }
          }
        }
      }
    }
  }
}

struct PrFilesSummaryStrip: View {
  let additions: Int
  let deletions: Int
  let fileCount: Int
  let renamed: Int

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 14) {
        summaryStats
        Spacer(minLength: 0)
      }

      VStack(alignment: .leading, spacing: 8) {
        summaryStats
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeGlassCard(cornerRadius: 16, padding: 14)
  }

  private var summaryStats: some View {
    Group {
      summaryStat(text: "+\(additions) additions", tint: ADEColor.success)
      summaryStat(text: "-\(deletions) deletions", tint: ADEColor.danger)
      summaryStat(
        text: renamed > 0
          ? "\(fileCount) files / \(renamed) renamed"
          : "\(fileCount) files",
        tint: ADEColor.textPrimary
      )
    }
  }

  private func summaryStat(text: String, tint: Color) -> some View {
    Text(text)
      .font(.system(.caption, design: .monospaced).weight(.medium))
      .foregroundStyle(tint)
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
  }
}

struct PrFileDiffCard: View {
  let file: PrFile
  let canOpenFiles: Bool
  let onOpenFile: (PrFile) -> Void
  let onCopyPath: (PrFile) -> Void
  @State private var expanded: Bool

  init(
    file: PrFile,
    canOpenFiles: Bool,
    onOpenFile: @escaping (PrFile) -> Void,
    onCopyPath: @escaping (PrFile) -> Void
  ) {
    self.file = file
    self.canOpenFiles = canOpenFiles
    self.onOpenFile = onOpenFile
    self.onCopyPath = onCopyPath
    _expanded = State(initialValue: prFileDiffShouldExpandByDefault(file))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          expanded.toggle()
        }
      } label: {
        PrFileRowLabel(
          file: file,
          expanded: expanded,
          canOpenFiles: canOpenFiles,
          onOpenFile: onOpenFile,
          onCopyPath: onCopyPath
        )
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityLabel)
      .accessibilityAddTraits(.isButton)

      if expanded {
        VStack(alignment: .leading, spacing: 10) {
          if let previousFilename = file.previousFilename, !previousFilename.isEmpty {
            Text("Renamed from \(previousFilename)")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }

          if let patch = file.patch, !patch.isEmpty {
            PrUnifiedDiffView(file: file, patch: patch)
          } else {
            Text("No patch was synced for this file.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        .padding(.top, 12)
        .padding(.horizontal, 2)
      }
    }
    .adeGlassCard(cornerRadius: 16, padding: 14)
  }

  private var accessibilityLabel: String {
    "\(file.filename), +\(file.additions) additions, \(file.deletions) deletions"
  }
}

private struct PrFileRowLabel: View {
  let file: PrFile
  let expanded: Bool
  let canOpenFiles: Bool
  let onOpenFile: (PrFile) -> Void
  let onCopyPath: (PrFile) -> Void

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "doc.text")
        .font(.system(size: 13, weight: .regular))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 16, alignment: .center)

      Text(file.filename)
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
        .frame(maxWidth: .infinity, alignment: .leading)

      statusChip(for: file.status)

      Text("+\(file.additions)")
        .font(.system(size: 10, design: .monospaced).weight(.medium))
        .foregroundStyle(ADEColor.success)
        .monospacedDigit()

      Text("−\(file.deletions)")
        .font(.system(size: 10, design: .monospaced).weight(.medium))
        .foregroundStyle(ADEColor.danger)
        .monospacedDigit()

      Menu {
        Button {
          onOpenFile(file)
        } label: {
          Label("Open in Files", systemImage: "folder")
        }
        .disabled(!canOpenFiles)

        Button {
          onCopyPath(file)
        } label: {
          Label("Copy path", systemImage: "doc.on.doc")
        }
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 20, height: 20)
      }
      .accessibilityLabel("File actions for \(file.filename)")

      Image(systemName: "chevron.right")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .rotationEffect(.degrees(expanded ? 90 : 0))
        .animation(.easeInOut(duration: 0.18), value: expanded)
    }
    .contentShape(Rectangle())
  }

  @ViewBuilder
  private func statusChip(for status: String) -> some View {
    switch status {
    case "added":
      PrTagChip(label: "new", color: ADEColor.success)
    case "removed":
      PrTagChip(label: "del", color: ADEColor.danger)
    case "renamed":
      PrTagChip(label: "ren", color: ADEColor.warning)
    default:
      EmptyView()
    }
  }
}

struct PrUnifiedDiffView: View {
  let file: PrFile
  let patch: String

  private var language: FilesLanguage {
    FilesLanguage.detect(languageId: nil, filePath: file.filename)
  }

  private var lines: [PrDiffDisplayLine] {
    PrDiffRenderingCache.shared.lines(for: patch)
  }

  var body: some View {
    if let limit = prPatchPreviewLimit(for: patch) {
      PrDiffPreviewLimitNotice(limit: limit)
    } else {
      ScrollView([.horizontal, .vertical], showsIndicators: true) {
        LazyVStack(alignment: .leading, spacing: 2) {
          ForEach(lines) { line in
            HStack(alignment: .top, spacing: 8) {
              Text(line.oldLineNumber.map(String.init) ?? "")
                .frame(width: 34, alignment: .trailing)
                .foregroundStyle(ADEColor.textMuted)
              Text(line.newLineNumber.map(String.init) ?? "")
                .frame(width: 34, alignment: .trailing)
                .foregroundStyle(ADEColor.textMuted)

              if line.kind == .hunk || line.kind == .note {
                Text(line.text)
                  .font(.system(.caption, design: .monospaced))
                  .foregroundStyle(line.kind == .hunk ? ADEColor.accent : ADEColor.textSecondary)
              } else {
                HStack(spacing: 0) {
                  Text(verbatim: line.prefix)
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                    .foregroundStyle(diffPrefixTint(line.kind))
                  Text(SyntaxHighlighter.highlightedAttributedString(line.text.isEmpty ? " " : line.text, as: language))
                    .font(.system(.caption, design: .monospaced))
                }
              }
              Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(diffBackground(line.kind), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
          }
        }
      }
      .frame(maxHeight: 420)
      .adeInsetField(cornerRadius: 14, padding: 10)
    }
  }
}

struct PrDiffPreviewLimitNotice: View {
  let limit: PrPatchPreviewLimit

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "doc.text.magnifyingglass")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(ADEColor.warning)
      VStack(alignment: .leading, spacing: 4) {
        Text(limit.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(limit.message)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeInsetField(cornerRadius: 14, padding: 12)
  }
}

extension PrUnifiedDiffView {
  private func diffBackground(_ kind: PrDiffDisplayLineKind) -> Color {
    switch kind {
    case .added:
      return ADEColor.success.opacity(0.12)
    case .removed:
      return ADEColor.danger.opacity(0.12)
    case .hunk:
      return ADEColor.accent.opacity(0.08)
    case .context, .note:
      return Color.clear
    }
  }

  private func diffPrefixTint(_ kind: PrDiffDisplayLineKind) -> Color {
    switch kind {
    case .added:
      return ADEColor.success
    case .removed:
      return ADEColor.danger
    case .hunk:
      return ADEColor.accent
    case .context, .note:
      return ADEColor.textSecondary
    }
  }
}
