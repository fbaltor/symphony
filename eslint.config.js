import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    // A-5: lint the infra/ Pulumi sub-stack alongside src/. Previously
    // ignored — but the only file in infra/ (index.ts) already carries an
    // explicit eslint-disable comment for one `as any` cast, which means
    // someone expected ESLint to apply there and worked around a violation.
    // Now the disable comment is actually load-bearing, and any future
    // infra/ TypeScript gets the same rule baseline as src/.
    //
    // infra/node_modules/ stays ignored (it's a separate npm install).
    ignores: ["dist/**", "node_modules/**", "coverage/**", "infra/node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
];
