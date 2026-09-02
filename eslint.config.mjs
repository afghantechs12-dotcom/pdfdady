import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat-config ESLint setup. Replaces the deprecated `next lint` (which Next 16
 * no longer supports — it treats "lint" as a positional directory argument).
 *
 * The ruleset is a pragmatic baseline: `@eslint/js` recommended +
 * `typescript-eslint` recommended (syntax-only, no type-checking pass — fast),
 * with a small number of rules tuned to the existing codebase conventions so
 * that lint passes without a codebase-wide refactor. Tightening individual
 * rules from warn→error, and adding react-hooks / Next-specific plugins, is
 * tracked as follow-up hardening (not Milestone 1 scope).
 */
export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      ".kiro/**",
      "next-env.d.ts",
      "vitest.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs,jsx}"],
    rules: {
      // Unused vars/args: WARN for the baseline adoption (the codebase
      // predates ESLint and has a handful of pre-existing unused imports in
      // admin components). Warnings keep `npm run lint` green (exit 0) while
      // keeping the signal visible; tightening to "error" + cleaning those up
      // is follow-up work, not Milestone 1 scope.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // The codebase has a few deliberate `any` uses (data-layer partials);
      // tsc already catches real type errors. Keep this off rather than mass-
      // flag legitimate uses.
      "@typescript-eslint/no-explicit-any": "off",
      // `AdminBlogAuthor extends BlogAuthor {}` and similar empty types are
      // intentional re-exports of opaque library types.
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-empty-interface": "off",
      // Allow best-effort `catch {}` (cleanup paths) and intentional empty
      // blocks; disallow genuinely useless empty function bodies elsewhere.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // ts-comment / require-imports: not used in app code, but off to avoid
      // false positives on tooling-adjacent files.
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-require-imports": "off",
      // The WinAnsi guard regex (lib/pdf/winAnsi.ts) intentionally matches
      // control characters (\r\n\t) and includes literal extended-whitespace
      // code points as part of the encodable set. Both rules are false
      // positives there; turn them off rather than weaken the guard.
      "no-control-regex": "off",
      "no-irregular-whitespace": "off",
    },
  },
);
