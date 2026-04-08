import { executableTool as tool } from "./executableTool";
import { z } from "zod";
import fs from "node:fs";

export const editFileTool = tool({
  description:
    "Make a targeted edit to a file by replacing an exact string match with new content. " +
    "The old_string must appear exactly once in the file unless replace_all is true.",
  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file to edit"),
    old_string: z.string().describe("The exact string to find and replace"),
    new_string: z.string().describe("The replacement string"),
    replace_all: z
      .boolean()
      .optional()
      .default(false)
      .describe("Replace all occurrences instead of requiring a unique match"),
  }),
  execute: async ({ file_path, old_string, new_string, replace_all }) => {
    try {
      let content: string;
      try {
        content = await fs.promises.readFile(file_path, "utf-8");
      } catch {
        return { success: false, message: `File not found: ${file_path}` };
      }

      if (!content.includes(old_string)) {
        return {
          success: false,
          message: `The old_string was not found in ${file_path}`,
        };
      }

      if (!replace_all) {
        const firstIdx = content.indexOf(old_string);
        const secondIdx = content.indexOf(old_string, firstIdx + 1);
        if (secondIdx !== -1) {
          return {
            success: false,
            message:
              `old_string appears multiple times in ${file_path}. ` +
              "Provide more context to make the match unique, or set replace_all to true.",
          };
        }
      }

      const updated = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string);

      await fs.promises.writeFile(file_path, updated, "utf-8");

      return { success: true, message: `Successfully edited ${file_path}` };
    } catch (err) {
      return {
        success: false,
        message: `Error editing file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
