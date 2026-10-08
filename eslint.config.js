import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "./scripts/eslint-globals.js";

export default tseslint.config(
  { ignores: ["dist/", "dist-e2e/", "node_modules/", "test-results/", "playwright-report/", "tests/fixtures/", "gateway/data/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
);
