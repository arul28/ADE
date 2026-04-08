import { executableTool as tool } from "./executableTool";
import { z } from "zod";

export const webFetchTool = tool({
  description:
    "Fetch content from a URL and return it as text. Useful for reading documentation, API responses, etc.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch"),
    max_chars: z
      .number()
      .optional()
      .default(10000)
      .describe("Maximum characters to return"),
  }),
  execute: async ({ url, max_chars }) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "ADE-Agent/1.0" },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return {
          content: "",
          url,
          contentType: null,
          truncated: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      let text = await response.text();

      // Strip HTML tags for HTML content
      if (contentType.includes("text/html")) {
        text = stripHtml(text);
      }

      const truncated = text.length > max_chars;
      if (truncated) {
        text = text.slice(0, max_chars);
      }

      return { content: text, url, contentType, truncated };
    } catch (err) {
      return {
        content: "",
        url,
        contentType: null,
        truncated: false,
        error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

function stripHtml(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
