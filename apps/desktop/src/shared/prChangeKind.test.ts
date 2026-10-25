import { describe, expect, it } from "vitest";
import {
  classifyChangedPath,
  isPrChangeSummaryComplete,
  parseLinguistAttributes,
  summarizePrChangeKinds,
  type PrChangeKind,
} from "./prChangeKind";

const LINGUIST = parseLinguistAttributes([
  "# comment",
  "docs-site/** linguist-documentation",
  "api/schema.ts linguist-generated=true",
  "package-lock.json -linguist-generated",
  "third_party/keep/** linguist-vendored=false",
  "*.proto.ts linguist-generated",
  "*.proto.ts !linguist-generated",
  "*.sql text eol=lf",
].join("\n"));

describe("classifyChangedPath", () => {
  it.each<[string, PrChangeKind, boolean?]>([
    ["src/app/server.ts", "code"],
    ["README.md", "docs"],
    ["docs/guide/README.txt", "docs"],
    ["LICENSE", "docs"],
    ["requirements.txt", "code"],
    ["requirements-dev.txt", "code"],
    ["CMakeLists.txt", "code"],
    ["public/robots.txt", "code"],
    ["llms.txt", "code"],
    ["package-lock.json", "generated"],
    ["apps/web/pnpm-lock.yaml", "generated"],
    ["Cargo.lock", "generated"],
    ["ios/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved", "generated"],
    ["bun.lockb", "generated"],
    ["go.sum", "generated"],
    ["api/v1/service.pb.go", "generated"],
    ["proto/service_pb2.py", "generated"],
    ["dist/app.min.js", "generated"],
    ["src/schema.generated.ts", "generated"],
    ["vendor/github.com/pkg/errors/errors.go", "generated"],
    ["src/__snapshots__/view.test.tsx.snap", "mocks"],
    ["src/__mocks__/fs.ts", "mocks"],
    ["pkg/parser/testdata/input.json", "mocks"],
    ["src/api.mock.ts", "mocks"],
    ["src/view.test.tsx", "tests"],
    ["src/view.spec.ts", "tests"],
    ["pkg/parser/parser_test.go", "tests"],
    ["tools/test_cli.py", "tests"],
    ["app/src/test/java/com/acme/FooTest.java", "tests"],
    ["Sources/AppTests/LoginTests.swift", "tests"],
    ["src/main/java/com/acme/Contest.java", "code"],
    ["src/__tests__/helpers.ts", "tests"],
    ["e2e/login.ts", "tests"],
    ["tests/README.md", "tests"],
    ["src\\components\\Button.test.tsx", "tests"],
    ["C:\\repo\\node_modules\\left-pad\\index.js", "generated"],
    ["./docs/intro.MD", "docs"],
    // linguist overrides
    ["docs-site/assets/app.js", "docs", true],
    ["api/schema.ts", "generated", true],
    ["package-lock.json", "code", true],
    ["third_party/keep/lib.c", "code", true],
    ["src/user.proto.ts", "code", true],
    ["db/init.sql", "code", true],
  ])("%s -> %s", (path, kind, withLinguist) => {
    expect(classifyChangedPath(path, withLinguist ? { linguist: LINGUIST } : null)).toBe(kind);
  });
});

describe("summarizePrChangeKinds", () => {
  const files = [
    { filename: "src/a.ts", additions: 10, deletions: 2 },
    { filename: "src/a.test.ts", additions: 5, deletions: 0 },
    // A rename is judged by its new name.
    { filename: "docs/a.md", previousFilename: "src/a.ts", additions: 3, deletions: 1 },
    { filename: "yarn.lock", additions: 400, deletions: 100 },
    { filename: "assets/logo.png", additions: 0, deletions: 0 },
  ];

  it("buckets lines and adds up to the total", () => {
    const summary = summarizePrChangeKinds(files);
    expect(summary.kinds.code).toEqual({ files: 2, additions: 10, deletions: 2 });
    expect(summary.kinds.tests).toEqual({ files: 1, additions: 5, deletions: 0 });
    expect(summary.kinds.docs).toEqual({ files: 1, additions: 3, deletions: 1 });
    expect(summary.kinds.generated).toEqual({ files: 1, additions: 400, deletions: 100 });
    expect(summary.total).toEqual({ files: 5, additions: 418, deletions: 103 });
  });

  it.each([
    [{ additions: 418, deletions: 103, changedFiles: 5 }, true],
    [null, true],
    [{ additions: 420, deletions: 103 }, false],
    [{ changedFiles: 6 }, false],
  ])("is complete against %j -> %s", (expected, complete) => {
    expect(isPrChangeSummaryComplete(summarizePrChangeKinds(files), expected)).toBe(complete);
  });

  it("refuses a list at GitHub's files cap", () => {
    const capped = Array.from({ length: 3000 }, (_, index) => ({ filename: `src/f${index}.ts`, additions: 1, deletions: 0 }));
    expect(isPrChangeSummaryComplete(summarizePrChangeKinds(capped))).toBe(false);
  });
});
