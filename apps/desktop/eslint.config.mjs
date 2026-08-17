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
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../../state/appStore",
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
