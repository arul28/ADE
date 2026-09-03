import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Markdown,
  SAFE_PREVIEW_SCHEMA,
  isWindowsAbsolutePath,
  markdownUrlTransform,
} from "../src/markdown";

afterEach(cleanup);

describe("sanitize schema", () => {
  it("allows file: and single-letter drive schemes for href", () => {
    const href = SAFE_PREVIEW_SCHEMA.protocols?.href ?? [];
    expect(href).toContain("file");
    expect(href).toContain("c");
    expect(href).toContain("C");
    expect(href).toContain("https");
  });

  it("still blocks the dangerous schemes", () => {
    const href = SAFE_PREVIEW_SCHEMA.protocols?.href ?? [];
    expect(href).not.toContain("javascript");
    expect(href).not.toContain("data");
    expect(href).not.toContain("vbscript");
  });

  it("allows no tag that can execute or embed", () => {
    for (const tag of ["script", "iframe", "object", "embed", "style", "img", "form"]) {
      expect(SAFE_PREVIEW_SCHEMA.tagNames, tag).not.toContain(tag);
    }
  });
});

describe("markdownUrlTransform", () => {
  it("keeps a Windows drive path, encoded or not", () => {
    expect(markdownUrlTransform("C:\\repo\\x.ts")).toBe("C:\\repo\\x.ts");
    expect(markdownUrlTransform("C:%5Crepo%5Cx.ts")).toBe("C:%5Crepo%5Cx.ts");
    expect(markdownUrlTransform("file:///tmp/a")).toBe("file:///tmp/a");
  });

  it("hands everything else to the default transform", () => {
    expect(markdownUrlTransform("https://linear.app/x")).toBe("https://linear.app/x");
    expect(markdownUrlTransform("javascript:alert(1)")).toBe("");
  });

  it("recognises drive and UNC paths", () => {
    expect(isWindowsAbsolutePath("C:\\a")).toBe(true);
    expect(isWindowsAbsolutePath("C:")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isWindowsAbsolutePath("/usr/local")).toBe(false);
  });
});

describe("Markdown", () => {
  it("renders gfm markdown with the kit's classes", () => {
    const { container } = render(
      <Markdown>{"# Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n`code`"}</Markdown>,
    );
    expect(screen.getByRole("heading", { name: "Title" }).className).toBe("ade-markdown-h1");
    expect(container.querySelectorAll(".ade-markdown-li")).toHaveLength(2);
    // remark-gfm is what turns the pipe block into a table.
    expect(container.querySelector(".ade-markdown-table")).toBeTruthy();
    expect(container.querySelector(".ade-markdown-code")?.textContent).toBe("code");
  });

  it("strips a script tag and a javascript: href", () => {
    const { container } = render(
      <Markdown>{"<script>alert(1)</script>\n\n[x](javascript:alert(1))"}</Markdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("accepts component overrides so a page can route its own links", () => {
    render(
      <Markdown componentOverrides={{ a: ({ children }) => <b data-testid="own">{children}</b> }}>
        {"[go](https://linear.app)"}
      </Markdown>,
    );
    expect(screen.getByTestId("own").textContent).toBe("go");
  });
});
