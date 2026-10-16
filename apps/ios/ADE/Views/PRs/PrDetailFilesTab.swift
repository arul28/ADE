import SwiftUI
import UIKit

// The Files tab on the flat base: a summary line, then the changed files
// grouped by folder. A row opens that file's diff with previous / next.

struct PrFileFolderGroup: Identifiable, Equatable {
  let id: String
  /// `(index in the PR's file list, file)`, so the diff page can step through
  /// every file in order.
  let files: [PrIndexedFile]
}

struct PrIndexedFile: Identifiable, Equatable {
  let index: Int
  let file: PrFile
  var id: String { file.filename }
}

/// Groups files by their folder, folders in order of first appearance.
func prFileFolderGroups(_ files: [PrFile]) -> [PrFileFolderGroup] {
  var order: [String] = []
  var byFolder: [String: [PrIndexedFile]] = [:]
  for (index, file) in files.enumerated() {
    let parts = file.filename.split(separator: "/")
    let folder = parts.count > 1 ? parts.dropLast().joined(separator: "/") : "/"
    if byFolder[folder] == nil { order.append(folder) }
    byFolder[folder, default: []].append(PrIndexedFile(index: index, file: file))
  }
  return order.map { PrFileFolderGroup(id: $0, files: byFolder[$0] ?? []) }
}

func prFileName(_ path: String) -> String {
  path.split(separator: "/").last.map(String.init) ?? path
}

/// The Files tab, emitted as List sections.
struct PrFilesSections: View {
  let files: [PrFile]
  let isLoading: Bool
  let canOpenFiles: Bool
  let onOpenFile: (PrFile) -> Void
  let onCopyPath: (PrFile) -> Void

  var body: some View {
    let groups = prFileFolderGroups(files)
    Group {
      Section {
        if files.isEmpty {
          if isLoading {
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              Text("Loading changed files…").font(.footnote).foregroundStyle(ADEColor.textSecondary)
            }
            .adeFlatRow(separator: .hidden)
          } else {
            PrFlatEmptyRow(title: "No changed files", message: "GitHub reported no file changes for this PR.")
              .adeFlatRow(separator: .hidden)
          }
        } else {
          HStack(spacing: 6) {
            Text(verbatim: "\(files.count.formatted(.number)) file\(files.count == 1 ? "" : "s")")
              .font(.adeMono(12, weight: .medium))
              .foregroundStyle(ADEColor.textPrimary)
            Text("·").foregroundStyle(ADEColor.textMuted)
            PrDiffStat(
              additions: files.reduce(0) { $0 + $1.additions },
              deletions: files.reduce(0) { $0 + $1.deletions },
              size: 12
            )
            Spacer(minLength: 0)
          }
          .adeFlatRow(separator: .hidden)
        }
      }
      ForEach(groups) { group in
        Section {
          ForEach(group.files) { entry in
            NavigationLink {
              PrFileDiffPage(
                files: files,
                initialIndex: entry.index,
                canOpenFiles: canOpenFiles,
                onOpenFile: onOpenFile,
                onCopyPath: onCopyPath
              )
            } label: {
              PrFileRow(file: entry.file)
            }
            .adeFlatRow(insets: EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
          }
        } header: {
          // Paths keep their case: the header is the folder, verbatim.
          HStack(spacing: 6) {
            Image(systemName: "folder")
              .font(.system(size: 10, weight: .semibold))
            Text(verbatim: group.id == "/" ? "/" : group.id)
              .font(.adeMono(11))
              .lineLimit(1)
              .truncationMode(.head)
            Text(verbatim: "\(group.files.count)")
              .font(.adeMono(10.5))
            Spacer(minLength: 0)
          }
          .foregroundStyle(ADEColor.textMuted)
          .textCase(nil)
          .frame(minHeight: 22)
        }
      }
    }
  }
}

struct PrFileRow: View {
  let file: PrFile

  var body: some View {
    HStack(spacing: 10) {
      Text(verbatim: fileStatusLabel(file.status))
        .font(.adeMono(11.5, weight: .bold))
        .foregroundStyle(fileStatusTint(file.status))
        .frame(width: 14)
      Text(prFileName(file.filename))
        .font(.subheadline)
        .foregroundStyle(file.status == "removed" ? ADEColor.textSecondary : ADEColor.textPrimary)
        .strikethrough(file.status == "removed", color: ADEColor.textMuted)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 8)
      PrDiffStat(additions: file.additions, deletions: file.deletions, size: 11)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(file.filename), \(file.status), \(file.additions) added, \(file.deletions) removed")
  }
}

/// One file's diff, with previous / next file in a glass bar.
struct PrFileDiffPage: View {
  let files: [PrFile]
  let canOpenFiles: Bool
  let onOpenFile: (PrFile) -> Void
  let onCopyPath: (PrFile) -> Void
  @State private var index: Int

  init(files: [PrFile], initialIndex: Int, canOpenFiles: Bool, onOpenFile: @escaping (PrFile) -> Void, onCopyPath: @escaping (PrFile) -> Void) {
    self.files = files
    self.canOpenFiles = canOpenFiles
    self.onOpenFile = onOpenFile
    self.onCopyPath = onCopyPath
    _index = State(initialValue: min(max(initialIndex, 0), max(files.count - 1, 0)))
  }

  private var file: PrFile? { files.indices.contains(index) ? files[index] : nil }

  var body: some View {
    Group {
      if let file {
        ScrollView(.vertical) {
          VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
              HStack(spacing: 8) {
                Text(verbatim: fileStatusLabel(file.status))
                  .font(.adeMono(12, weight: .bold))
                  .foregroundStyle(fileStatusTint(file.status))
                Text(prFileName(file.filename))
                  .font(.headline)
                  .foregroundStyle(ADEColor.textPrimary)
                  .lineLimit(2)
                Spacer(minLength: 8)
                PrDiffStat(additions: file.additions, deletions: file.deletions, size: 12)
              }
              Text(verbatim: file.previousFilename.map { "\($0) → \(file.filename)" } ?? file.filename)
                .font(.adeMono(11))
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(2)
                .truncationMode(.middle)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            Rectangle().fill(ADEFlat.hairline).frame(height: 0.5)
            PrFlatDiffBody(file: file)
          }
          .padding(.bottom, 80)
        }
        .id(file.filename)
      } else {
        PrFlatEmptyRow(title: "No file")
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle(file.map { prFileName($0.filename) } ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        if let file {
          Menu {
            if canOpenFiles {
              Button { onOpenFile(file) } label: { Label("Open in Files", systemImage: "folder") }
            }
            Button { onCopyPath(file) } label: { Label("Copy path", systemImage: "doc.on.doc") }
          } label: {
            Image(systemName: "ellipsis")
          }
          .accessibilityLabel("File actions")
        }
      }
    }
    .safeAreaInset(edge: .bottom) {
      if files.count > 1 {
        HStack(spacing: 12) {
          Button { step(-1) } label: {
            Label("Previous", systemImage: "chevron.left").labelStyle(.iconOnly)
              .frame(width: 44, height: 36)
          }
          .disabled(index == 0)
          Text(verbatim: "\(index + 1) of \(files.count)")
            .font(.adeMono(12, weight: .medium))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(minWidth: 90)
          Button { step(1) } label: {
            Label("Next", systemImage: "chevron.right").labelStyle(.iconOnly)
              .frame(width: 44, height: 36)
          }
          .disabled(index >= files.count - 1)
        }
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .padding(.horizontal, 8)
        .glassEffect(in: Capsule(style: .continuous))
        .padding(.bottom, 8)
      }
    }
  }

  private func step(_ delta: Int) {
    let next = index + delta
    guard files.indices.contains(next) else { return }
    ADEHaptics.light()
    index = next
  }
}

/// A unified diff, edge to edge: line numbers, then the line on a tinted band.
struct PrFlatDiffBody: View {
  let file: PrFile

  private var language: FilesLanguage {
    FilesLanguage.detect(languageId: nil, filePath: file.filename)
  }

  var body: some View {
    if let patch = file.patch, !patch.isEmpty {
      if let limit = prPatchPreviewLimit(for: patch) {
        ADEFlatInlineNotice(message: "\(limit.title). \(limit.message)", tint: ADEColor.textMuted)
          .padding(16)
      } else {
        ScrollView(.horizontal, showsIndicators: false) {
          LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(PrDiffRenderingCache.shared.lines(for: patch)) { line in
              diffLine(line)
            }
          }
          .padding(.vertical, 6)
        }
      }
    } else {
      ADEFlatInlineNotice(
        message: file.status == "renamed" ? "Renamed with no content changes." : "GitHub sent no diff for this file (binary or too large).",
        tint: ADEColor.textMuted
      )
      .padding(16)
    }
  }

  @ViewBuilder
  private func diffLine(_ line: PrDiffDisplayLine) -> some View {
    HStack(alignment: .top, spacing: 6) {
      Text(line.oldLineNumber.map(String.init) ?? "")
        .frame(width: 30, alignment: .trailing)
      Text(line.newLineNumber.map(String.init) ?? "")
        .frame(width: 30, alignment: .trailing)
      if line.kind == .hunk || line.kind == .note {
        Text(line.text)
          .foregroundStyle(ADEColor.accent)
          .padding(.leading, 4)
      } else {
        Text(verbatim: line.prefix)
          .foregroundStyle(tint(line.kind))
          .frame(width: 10)
        Text(highlighted(line.text))
      }
    }
    .font(.adeMono(11.5))
    .foregroundStyle(ADEColor.textMuted)
    .fixedSize(horizontal: true, vertical: false)
    .padding(.horizontal, 10)
    .padding(.vertical, 1.5)
    .frame(minWidth: UIScreen.main.bounds.width, alignment: .leading)
    .background(background(line.kind))
  }

  /// The highlighter sets its own font; the diff keeps one size.
  private func highlighted(_ text: String) -> AttributedString {
    var attributed = SyntaxHighlighter.highlightedAttributedString(text.isEmpty ? " " : text, as: language)
    attributed.font = .adeMono(11.5)
    return attributed
  }

  private func background(_ kind: PrDiffDisplayLineKind) -> Color {
    switch kind {
    case .added: return prDiffAddColor().opacity(0.12)
    case .removed: return prDiffDeleteColor().opacity(0.12)
    case .hunk: return ADEColor.accent.opacity(0.08)
    case .context, .note: return .clear
    }
  }

  private func tint(_ kind: PrDiffDisplayLineKind) -> Color {
    switch kind {
    case .added: return prDiffAddColor()
    case .removed: return prDiffDeleteColor()
    default: return ADEColor.textMuted
    }
  }
}
