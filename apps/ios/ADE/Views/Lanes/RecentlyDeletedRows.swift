import SwiftUI

// Recently deleted's rows: a deleted lane (with the chats that went with it)
// and a chat deleted on its own.

/// The square at the start of a lane row.
struct DeletedLaneMark: View {
  @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 30

  var body: some View {
    Image(systemName: "arrow.triangle.branch")
      .font(.system(size: size * 0.47, weight: .semibold))
      .foregroundStyle(ADEColor.textSecondary)
      .frame(width: size, height: size)
      .background(ADEKit.track, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// A deleted lane, with the chats that went with it under it.
struct DeletedLaneRow: View {
  let entry: DeletedLaneEntry
  /// Shown when the list holds more than one machine.
  let machineName: String?
  let restoring: Bool
  let disabled: Bool
  let onRestore: () -> Void
  let onOpenChat: (DeletedChat) -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private var lane: DeletedLaneSnapshot { entry.lane }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 8) {
          text
          restoreButton
        }
      } else {
        HStack(alignment: .center, spacing: 12) {
          DeletedLaneMark()
          text
          Spacer(minLength: 8)
          restoreButton
        }
      }
      if !entry.chats.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(entry.chats) { chat in
            Button { onOpenChat(chat) } label: {
              DeletedNestedChatLine(chat: chat)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(deletedChatTitle(chat))")
          }
        }
        .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 0 : 42)
      }
    }
  }

  private var text: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(lane.laneName)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
      if let branch = lane.branchName, !branch.isEmpty {
        Text(branch)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      ADEMetaLine(parts: deletedLaneMetaParts(lane) + (machineName.map { [$0] } ?? []))
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
    }
  }

  private var restoreButton: some View {
    Button(action: onRestore) {
      if restoring {
        ProgressView().controlSize(.small)
      } else {
        Text(lane.isFreed ? "Put back" : "Restore")
      }
    }
    .buttonStyle(ADEKitButtonStyle(tone: .neutral))
    .disabled(disabled)
    .accessibilityLabel(restoreAccessibilityLabel)
  }

  private var restoreAccessibilityLabel: String {
    if lane.isFreed { return "Put back \(lane.laneName)'s files" }
    switch entry.chats.count {
    case 0: return "Restore \(lane.laneName)"
    case 1: return "Restore \(lane.laneName) and its chat"
    default: return "Restore \(lane.laneName) and its \(entry.chats.count) chats"
    }
  }
}

/// A chat under its deleted lane: logo, title, model.
private struct DeletedNestedChatLine: View {
  let chat: DeletedChat
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    HStack(spacing: 8) {
      DeletedChatLogo(chat: chat, size: 18)
      // At accessibility sizes the model goes under the title, whole,
      // instead of being cut to a letter beside it.
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 2) {
          title.lineLimit(2)
          if let model = deletedChatModelLabel(chat) { modelText(model) }
        }
      } else {
        title.lineLimit(1)
        if let model = deletedChatModelLabel(chat) {
          modelText(model).layoutPriority(-1)
        }
      }
      Spacer(minLength: 4)
      Image(systemName: "chevron.right")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityHidden(true)
    }
    .frame(minHeight: 34)
    .contentShape(Rectangle())
  }

  private var title: some View {
    Text(deletedChatTitle(chat))
      .font(.footnote)
      .foregroundStyle(ADEColor.textPrimary)
  }

  private func modelText(_ model: String) -> some View {
    Text(model)
      .font(.caption)
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(1)
  }
}

/// A deleted chat's mark: the provider logo the Work rows draw.
struct DeletedChatLogo: View {
  let chat: DeletedChat
  var size: CGFloat = 30

  var body: some View {
    let provider = deletedChatLogoProvider(chat)
    WorkProviderLogo(
      provider: provider,
      fallbackSymbol: chat.isCli ? "terminal.fill" : providerIcon(provider),
      tint: providerTint(provider),
      size: size
    )
    .accessibilityHidden(true)
  }
}

/// A chat deleted on its own (or, under Chats, one that went with its lane).
struct DeletedChatRow: View {
  let entry: DeletedChatEntry
  let machineName: String?
  let reopening: Bool
  let disabled: Bool
  let onOpen: () -> Void
  let onReopen: () -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .subheadline) private var logoSize: CGFloat = 30

  private var chat: DeletedChat { entry.chat }

  var body: some View {
    if dynamicTypeSize.isAccessibilitySize {
      VStack(alignment: .leading, spacing: 8) {
        openButton
        reopenButton
      }
    } else {
      HStack(alignment: .center, spacing: 12) {
        openButton
        Spacer(minLength: 8)
        reopenButton
      }
    }
  }

  private var openButton: some View {
    Button(action: onOpen) {
      HStack(alignment: .center, spacing: 12) {
        if !dynamicTypeSize.isAccessibilitySize {
          DeletedChatLogo(chat: chat, size: logoSize)
        }
        VStack(alignment: .leading, spacing: 3) {
          Text(deletedChatTitle(chat))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
          ADEMetaLine(parts: metaParts)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(deletedChatTitle(chat)). \(metaLine)")
    .accessibilityHint("Shows the conversation")
  }

  private var metaParts: [String] {
    deletedChatMetaParts(chat) + (machineName.map { [$0] } ?? [])
  }

  private var metaLine: String { metaParts.joined(separator: " · ") }

  private var reopenButton: some View {
    Button(action: onReopen) {
      if reopening {
        ProgressView().controlSize(.small)
      } else {
        Text(chat.laneExists ? "Reopen" : "Reopen…")
      }
    }
    .buttonStyle(ADEKitButtonStyle(tone: .neutral))
    .disabled(disabled)
    .accessibilityLabel("Reopen \(deletedChatTitle(chat))")
  }
}
