import SwiftUI

struct PrFilesTab: View {
  let snapshot: PullRequestSnapshot?
  let canOpenFiles: Bool
  let onOpenFile: (PrFile) -> Void
  let onCopyPath: (PrFile) -> Void

  var body: some View {
    Group {
      if let files = snapshot?.files, !files.isEmpty {
        LazyVStack(spacing: 12) {
          ForEach(files) { file in
            PrFileDiffCard(
              file: file,
              canOpenFiles: canOpenFiles,
              onOpenFile: onOpenFile,
              onCopyPath: onCopyPath
            )
          }
        }
      } else {
        ADEEmptyStateView(
          symbol: "doc.text.magnifyingglass",
          title: "No changed files",
          message: "The host has not synced any file diff data for this PR yet."
        )
      }
    }
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
    DisclosureGroup(isExpanded: $expanded) {
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
      .padding(.top, 8)
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 10) {
          ADEStatusPill(text: fileStatusLabel(file.status), tint: fileStatusTint(file.status))
          VStack(alignment: .leading, spacing: 4) {
            Text(file.filename)
              .font(.system(.body, design: .monospaced))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(2)
            Text("+\(file.additions) -\(file.deletions)")
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
          }
          Spacer(minLength: 0)
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
            Image(systemName: "ellipsis.circle")
              .font(.system(size: 18, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .frame(width: 32, height: 32)
          }
          .accessibilityLabel("File actions for \(file.filename)")
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
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
