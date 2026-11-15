import eslint from "@eslint/js"
import gitignore from "eslint-config-flat-gitignore"
import prettier from "eslint-plugin-prettier/recommended"
import unusedImports from "eslint-plugin-unused-imports"
import { defineConfig } from "eslint/config"
import globals from "globals"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import tseslint from "typescript-eslint"

const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig(
  {
    ignores: [
      "plugin/**",
      "desktop/**",
      ".claude/**",
      ".omx/**",
      ".agents/**",
      ".scratch/**",
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  gitignore(),
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: configDir,
      },
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
      "prettier/prettier": [
        "error",
        {
          experimentalOperatorPosition: "start",
          experimentalTernaries: true,
          plugins: ["prettier-plugin-packagejson"],
          semi: false,
        },
      ],
      "unused-imports/no-unused-imports": "error",
    },
  },
  {
    files: ["src/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            ":matches(:matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression)[generator=true][async=true], CallExpression[callee.name='streamSSE'] > :matches(FunctionExpression, ArrowFunctionExpression), NewExpression[callee.name='ReadableStream'] :matches(Property, MethodDefinition) > :matches(FunctionExpression, ArrowFunctionExpression)) :matches(CallExpression[callee.object.name='requestContext'][callee.property.name='getStore'], CallExpression[callee.name='getResponsesContinuationSession'])",
          message:
            "Capture requestContext values before entering async generators, streamSSE callbacks, or ReadableStream callbacks; AsyncLocalStorage context may be lost when the stream is consumed outside requestContext.run().",
        },
        {
          selector:
            "FunctionDeclaration[id.name='prepareResponsesContinuation'] CallExpression[callee.name='getResponsesContinuationSession']",
          message:
            "Pass the captured sessionId into prepareResponsesContinuation() instead of reading getResponsesContinuationSession() during stream iteration.",
        },
      ],
    },
  },
)
