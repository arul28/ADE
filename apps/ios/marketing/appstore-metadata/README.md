# App Store metadata for Daex (main app, `com.ade.ios`, App Store Connect id 6762759870)

Ready to push with the first rebranded build. Canonical `asc metadata` layout.

- `app-info/en-US.json`: store name (30 chars max: "Daex - Agentic Dev Environment" is exactly 30), subtitle, privacy URL.
- `version/NEXT/en-US.json`: description, keywords (keeps "ade" so old searches still find the app), promotional text, URLs.
- `review-notes.txt`: App Review notes with the product renamed (the sign-in steps are unchanged).

URLs still point at ade-app.dev; switch them to daex.dev when the site moves.

Push (on the Mac with `~/.asc/config.json`), after the app's version is editable:

```sh
cp -R apps/ios/marketing/appstore-metadata /tmp/daexmeta && mv /tmp/daexmeta/version/NEXT /tmp/daexmeta/version/<version>
asc metadata push --app 6762759870 --version <version> --platform IOS --dir /tmp/daexmeta --dry-run
asc metadata push --app 6762759870 --version <version> --platform IOS --dir /tmp/daexmeta
asc review details-update --id <review-detail-id> --notes "$(cat apps/ios/marketing/appstore-metadata/review-notes.txt)"
```

Screenshots still show the old app; re-capture them from the rebranded build (`apps/ios/marketing/appstore-screenshots`).
The Beta app (id 6829373114) is already renamed "Daex Beta", and both apps' TestFlight descriptions already say Daex (2026-11-27).
