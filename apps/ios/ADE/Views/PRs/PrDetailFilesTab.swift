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
              PrShowAllFilesButton(count: files.count) {
                withAnimation(.easeInOut(duration: 0.2)) {
                  showAll = true
                }
              }
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
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        PrEyebrow(text: "Files changed")
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text("\(fileCount)")
            .font(.system(size: 22, weight: .heavy, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
            .tracking(-0.3)
          Text(fileCount == 1 ? "file" : "files")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
          if renamed > 0 {
            Text("· \(renamed) renamed")
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
      }

      Spacer(minLength: 8)

      HStack(spacing: 6) {
        summaryPill(text: "+\(additions)", tint: PrGlassPalette.success)
        summaryPill(text: "−\(deletions)", tint: PrGlassPalette.danger)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 18)
  }

  private func summaryPill(text: String, tint: Color) -> some View {
    Text(text)
      .font(.system(size: 11, design: .monospaced).weight(.bold))
      .monospacedDigit()
      .foregroundStyle(tint)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(
        Capsule().fill(tint.opacity(0.14))
      )
      .overlay(
        Capsule().strokeBorder(tint.opacity(0.32), lineWidth: 0.5)
      )
  }
}

// MARK: - Show-all CTA

private struct PrShowAllFilesButton: View {
  let count: Int
  let action: () -> Void
  @State private var pressed = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: "chevron.down.circle.fill")
          .font(.system(size: 12, weight: .bold))
        Text("Show all \(count) files")
          .font(.system(.footnote, design: .monospaced).weight(.semibold))
      }
      .foregroundStyle(.white)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 13)
      .background(
        PrGlassPalette.accentGradient,
        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 13, style: .continuous)
          .inset(by: 1)
          .stroke(Color.white.opacity(0.18), lineWidth: 0.5)
          .blendMode(.plusLighter)
      )
      .shadow(color: PrGlassPalette.purpleDeep.opacity(0.55), radius: 16, y: 6)
      .scaleEffect(pressed ? 0.97 : 1.0)
      .animation(.easeOut(duration: 0.12), value: pressed)
    }
    .buttonStyle(.plain)
    .simultaneousGesture(
      DragGesture(minimumDistance: 0)
        .onChanged { _ in pressed = true }
        .onEnded { _ in pressed = false }
    )
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
            HStack(spacing: 4) {
              Image(systemName: "arrow.turn.up.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(PrGlassPalette.warning)
              Text("Renamed from ")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
              +
              Text(previousFilename)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEColor.textPrimary)
            }
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
    .padding(14)
    .prGlassCard(cornerRadius: 18)
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

  private var fileIcon: String {
    let ext = (file.filename as NSString).pathExtension.lowercased()
    switch ext {
    case "swift", "kt", "java", "m", "mm", "cpp", "c", "h", "hpp", "rs", "go":
      return "curlybraces"
    case "ts", "tsx", "js", "jsx", "mjs", "cjs":
      return "chevron.left.forwardslash.chevron.right"
    case "json", "yaml", "yml", "toml", "xml", "plist":
      return "doc.badge.gearshape"
    case "md", "markdown", "txt", "rst":
      return "doc.text"
    case "png", "jpg", "jpeg", "gif", "svg", "webp", "heic":
      return "photo"
    case "css", "scss", "sass", "less":
      return "paintbrush"
    case "sh", "bash", "zsh", "fish":
      return "terminal"
    case "html", "htm":
      return "globe"
    case "py", "rb":
      return "chevron.left.forwardslash.chevron.right"
    case "sql":
      return "cylinder.split.1x2"
    default:
      return "doc"
    }
  }

  private var iconTint: Color {
    switch file.status {
    case "added": return PrGlassPalette.success
    case "removed": return PrGlassPalette.danger
    case "renamed": return PrGlassPalette.warning
    default: return PrGlassPalette.purple
    }
  }

  private var railGradient: LinearGradient {
    LinearGradient(
      colors: [iconTint.opacity(0.95), iconTint.opacity(0.35)],
      startPoint: .top,
      endPoint: .bottom
    )
  }

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      RoundedRectangle(cornerRadius: 2, style: .continuous)
        .fill(railGradient)
        .frame(width: 4, height: 28)
        .shadow(color: iconTint.opacity(0.5), radius: 4)

      ZStack {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(
            LinearGradient(
              colors: [iconTint.opacity(0.28), iconTint.opacity(0.12)],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            )
          )
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(iconTint.opacity(0.4), lineWidth: 0.5)
        Image(systemName: fileIcon)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(iconTint)
      }
      .frame(width: 28, height: 28)

      Text(file.filename)
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
        .frame(maxWidth: .infinity, alignment: .leading)

      HStack(spacing: 4) {
        countPill(text: "+\(file.additions)", tint: PrGlassPalette.success)
        countPill(text: "−\(file.deletions)", tint: PrGlassPalette.danger)
      }

      statusChip(for: file.status)

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
        ZStack {
          Circle()
            .fill(Color.white.opacity(0.06))
          Circle()
            .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
          Image(systemName: "ellipsis")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(width: 24, height: 24)
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

  private func countPill(text: String, tint: Color) -> some View {
    Text(text)
      .font(.system(size: 10, design: .monospaced).weight(.bold))
      .monospacedDigit()
      .foregroundStyle(tint)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(Capsule().fill(tint.opacity(0.14)))
      .overlay(Capsule().strokeBorder(tint.opacity(0.3), lineWidth: 0.5))
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
                  .foregroundStyle(line.kind == .hunk ? PrGlassPalette.purple : ADEColor.textSecondary)
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
            .background(diffBackground(line.kind), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
          }
        }
        .padding(10)
      }
      .frame(maxHeight: 420)
      .background(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(PrGlassPalette.ink.opacity(0.55))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .strokeBorder(Color.white.opacity(0.06), lineWidth: 0.5)
      )
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
      return PrGlassPalette.success.opacity(0.14)
    case .removed:
      return PrGlassPalette.danger.opacity(0.14)
    case .hunk:
      return PrGlassPalette.purple.opacity(0.10)
    case .context, .note:
      return Color.clear
    }
  }

  private func diffPrefixTint(_ kind: PrDiffDisplayLineKind) -> Color {
    switch kind {
    case .added:
      return PrGlassPalette.success
    case .removed:
      return PrGlassPalette.danger
    case .hunk:
      return PrGlassPalette.purple
    case .context, .note:
      return ADEColor.textSecondary
    }
  }
}
