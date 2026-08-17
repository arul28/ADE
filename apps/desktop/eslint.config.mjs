import path from "node:path";
import { fileURLToPath } from "node:url";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  {
    ignores: [
      "dist/**",
      "release/**",
      "coverage/**",
      "node_modules/**",
      "src/renderer/.vite/**",
      "src/renderer/generated/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },
  {
    // A chat is bound to the machine its lane lives on, which is frequently NOT
    // the machine the project tab is bound to. Global store reads answer the
    // tab's question, so inside chat-scoped surfaces they are the wrong answer
    // by construction. `AgentChatPane` is exempt because it OWNS the tab-vs-chat
    // distinction (the machine router, draft launch targets, the scope it
    // provides); `ChatRuntimeScope` is exempt because it is the derivation.
    //
    // KNOWN UNGUARDED SURFACES: pin-taking components outside components/chat
    // carry the same invariant but are not covered here yet, because each still
    // makes deliberate tab-scoped reads that the selectors below would flag —
    // `lanes/LaneGitActionsPane.tsx` (reads `s.lanes` and `s.projectBinding`
    // directly alongside its pinned reads), `lanes/LaneDiffPane.tsx`,
    // `lanes/CommitTimeline.tsx` and `terminals/WorkSidebar.tsx`. Extending
    // `files` to them means auditing each read and marking the intentional ones;
    // until then, treat their pin handling as unenforced by lint.
    files: ["src/renderer/components/chat/**/*.{ts,tsx}"],
    ignores: [
      "src/renderer/components/chat/AgentChatPane.tsx",
      "src/renderer/components/chat/ChatRuntimeScope.tsx",
      "src/renderer/components/chat/**/*.test.{ts,tsx}",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name=/^(useAppStore|useRootAppStore)$/] MemberExpression[property.name=/^(projectBinding|lanes)$/]",
          message:
            "This is the project tab's machine, not the chat's. Use `useChatRuntimeScope()` (binding/isRemote/machineName/lane/laneWorktreePath) from components/chat/ChatRuntimeScope.",
        },
        {
          selector:
            "CallExpression[callee.name=/^(useAppStore|useRootAppStore)$/] MemberExpression[object.property.name='project'][property.name='rootPath']",
          message:
            "This is the project tab's root, not the chat's. Use `useChatRuntimeScope().rootPath`.",
        },
        {
          // Imperative reads escape the hook selectors above entirely, and a
          // `getState()` read of the tab's binding is the same wrong answer as
          // a subscribed one.
          selector:
            "MemberExpression[object.callee.property.name='getState'][property.name=/^(projectBinding|lanes)$/]",
          message:
            "This is the project tab's machine, not the chat's. Use `useChatRuntimeScope()` (or the scope's binding captured in a ref) instead of a global store read.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          // A pattern, not a literal path: files in `chat/codex`, `chat/hooks`
          // and `chat/usage` reach the same module as `../../../state/appStore`
          // and slipped straight past a single-depth path entry.
          patterns: [
            {
              group: ["**/state/appStore"],
              importNames: ["selectActiveProjectRoot"],
              message:
                "`selectActiveProjectRoot` is the project tab's root. Use `useChatRuntimeScope().rootPath`.",
            },
          ],
        },
      ],
    },
  },
];
