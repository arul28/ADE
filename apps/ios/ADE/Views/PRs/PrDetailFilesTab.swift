import SwiftUI

struct PrFilesTab: View {
  let snapshot: PullRequestSnapshot?

  var body: some View {
    Group {
      if let files = snapshot?.files, !files.isEmpty {
        VStack(spacing: 12) {
          ForEach(files) { file in
            PrFileDiffCard(file: file)
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
  @State private var expanded = true

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
    parsePullRequestPatch(patch)
  }

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      VStack(alignment: .leading, spacing: 2) {
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
    .adeInsetField(cornerRadius: 14, padding: 10)
  }

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
