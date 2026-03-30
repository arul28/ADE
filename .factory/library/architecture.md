# Architecture

Architectural decisions, patterns discovered, and conventions.

**What belongs here:** Architectural patterns, component relationships, design decisions.

---

## iOS App Structure

```
apps/ios/ADE/
├── App/
│   ├── ADEApp.swift          # @main entry, scene setup
│   └── ContentView.swift     # TabView with 5 tabs: Lanes, Files, Work, PRs, Settings
├── Models/
│   └── RemoteModels.swift    # All data models for WebSocket communication
├── Services/
│   ├── SyncService.swift     # WebSocket client, all API calls to desktop
│   ├── Database.swift        # CRSQLite local database
│   └── KeychainService.swift # Secure credential storage
├── Views/
│   ├── Components/
│   │   ├── ADEDesignSystem.swift   # Glass morphism, semantic colors, motion system
│   │   └── FilesCodeSupport.swift  # Syntax highlighting (13 languages), language detection
│   ├── Files/
│   │   ├── FilesTabView.swift              # Root tab: workspace picker, navigation shell
│   │   ├── FileTreeView.swift              # Directory screen, tree rows, breadcrumbs
│   │   ├── FileTreeViewModel.swift         # Tree state, expand/collapse, child loading
│   │   ├── FileOperationsHelper.swift      # Shared types, path helpers, validation
│   │   ├── FileSearchView.swift            # Search sheet UI, result rows
│   │   ├── FileSearchViewModel.swift       # Debounced quick-open and text search
│   │   ├── FileViewerView.swift            # File editor/viewer screen
│   │   ├── FileViewerViewModel.swift       # Load, save, diff, find/replace state
│   │   ├── FileViewerChromeViews.swift     # Header, mode control, info sheet
│   │   ├── FileViewerCodeEditorView.swift  # UITextView code editor with gutter
│   │   ├── FileViewerHelpers.swift         # Pure functions: line numbers, find/replace
│   │   └── FileViewerRenderingViews.swift  # Binary preview, syntax view, diff, image
│   ├── LanesTabView.swift
│   ├── PRsTabView.swift
│   └── WorkTabView.swift
├── Resources/
│   └── DatabaseBootstrap.sql
├── Assets.xcassets
└── Info.plist
```

## Communication Architecture

The iOS app communicates with the desktop over WebSocket using a typed envelope protocol:

1. **file_request / file_response** — File operations (listTree, readFile, writeText, createFile, createDirectory, rename, deletePath, quickOpen, searchText)
2. **command / command_ack / command_result** — Git operations and atomic writes

All API calls go through `SyncService.swift` methods. Workers must NOT create new API calls — only use existing methods.

## Key Data Models (RemoteModels.swift)

- `FileTreeNode` — { name, path, type, hasChildren, children, changeStatus, size }
- `SyncFileBlob` — { path, size, mimeType, encoding, isBinary, content, languageId }
- `FilesWorkspace` — { id, kind, laneId, name, rootPath, isReadOnlyByDefault }
- `FilesQuickOpenItem` — { path, score }
- `FilesSearchTextMatch` — { path, line, column, preview }

## Design System (ADEDesignSystem.swift)

- iOS 26 liquid glass effects via `.glassEffect()` modifiers
- Semantic color tokens: `adeAccent`, `adeSecondaryText`, `adeBackground`, etc.
- Motion system with spring animations
- Glass card component for grouped content
- Workers should use these tokens, not hard-coded colors
