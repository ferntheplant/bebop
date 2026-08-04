import { defineConfig } from "vite-plus";

export default defineConfig({
  root: ".",
  logLevel: "error",
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      "**/*.gen.ts",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.sqlite*",
      "**/fixtures/**/worktrees/**",
      ".tanstack/**",
      ".wrangler/**",
    ],
    useTabs: false,
    tabWidth: 2,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    printWidth: 120,
    insertFinalNewline: true,
    sortImports: true,
    sortPackageJson: true,
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    ignorePatterns: [
      "**/*.gen.ts",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/fixtures/**/worktrees/**",
      ".tanstack/**",
      ".wrangler/**",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      maxWarnings: 0,
    },
    categories: {
      correctness: "error",
    },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "typescript/no-explicit-any": "error",
      "react/no-array-index-key": "error",
      "no-console": ["error", { allow: ["debug", "time", "timeEnd", "assert"] }],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          fix: {
            imports: "safe-fix",
            variables: "fix",
          },
        },
      ],
      "typescript/consistent-type-imports": "error",
      "typescript/no-non-null-assertion": "error",
      "no-param-reassign": "error",
      "typescript/prefer-as-const": "error",
      "default-param-last": "error",
      "react/self-closing-comp": "error",
      "react/rules-of-hooks": "error",
      "typescript/no-unnecessary-template-expression": "error",
      "eslint/prefer-template": "error",
      "unicorn/prefer-number-properties": "error",
      "typescript/no-inferrable-types": "error",
      "eslint/no-else-return": "error",
      "eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../**/*"],
              message: "Use absolute imports (unless import is sibling)",
            },
          ],
        },
      ],
      "typescript/no-floating-promises": "error",
    },
    env: {
      builtin: true,
    },
  },
  run: {
    cache: true,
    tasks: {
      // Names each package build explicitly rather than `vp run -r build`. A nested `vp run`
      // is *inlined* by Vite Task as fresh task nodes, which do not dedupe against the same
      // builds reached through a `dependsOn: { task: "build", from: [...] }` closure — so
      // `ready` scheduled every package's build twice, and two `vp pack` processes running
      // concurrently in one directory would empty `dist` under each other (surfacing as
      // `Cannot find module '@bebop/contracts'` inside a smoke). Listing the task IDs keeps
      // one node per build. Do not collapse this back into `vp run -r build`.
      build: {
        command: "echo 'build: all packages packed'",
        dependsOn: [
          "@bebop/contracts#build",
          "@bebop/workflow#build",
          "@bebop/testkit#build",
          "@bebop/server#build",
          "@bebop/swordfish#build",
          "@bebop/opencode-plugin#build",
        ],
      },
      dev: { command: "vp run @bebop/server#dev", cache: false },
      // `check` and the test tasks type-check and import `@bebop/contracts`, which
      // resolves through its built `dist`, so every one of them needs a build first.
      check: { command: "vp check", dependsOn: ["build"] },
      // Vitest is launched by **Bun**, not by the Node runtime Vite+ manages, because the
      // code under test targets Bun: the API serves on `BunHttpServer`, and a worker without
      // the Bun runtime cannot start one. Launched this way the workers are Bun workers, so
      // every test — unit, component, and process-level — runs on the runtime production
      // uses. `vp test` remains the right command for an ad-hoc run of the pure tests.
      test: {
        command: "bun node_modules/vitest/vitest.mjs run --reporter=minimal apps packages",
        dependsOn: ["build"],
        // The component suites read this to decide whether a database is available, so it
        // belongs in the cache key: a run with a database and a run without are not the same
        // run, and caching the second over the first would report a green gate for tests
        // that never executed.
        env: ["BEBOP_TEST_DATABASE_URL"],
      },
      "test:integration": {
        command: "bun node_modules/vitest/vitest.mjs run --reporter=minimal test/integration",
        dependsOn: ["build"],
        env: ["BEBOP_TEST_DATABASE_URL"],
      },
      // The maintained local system harness: packed Bebop + Swordfish processes over loopback
      // with disposable Postgres (`.scratch/local-system-harness/brief.md`). Gated on the
      // database URL exactly like the other Postgres-backed suites.
      "local-system": {
        command: "bun node_modules/vitest/vitest.mjs run --reporter=minimal test/local-system",
        dependsOn: ["build"],
        env: ["BEBOP_TEST_DATABASE_URL"],
      },
      "test:e2e": {
        command: "bun node_modules/vitest/vitest.mjs run --reporter=minimal  --passWithNoTests test/e2e",
        dependsOn: ["build"],
        env: ["BEBOP_TEST_DATABASE_URL"],
      },
      smoke: {
        command: "echo 'smoke: artifacts started'",
        dependsOn: ["@bebop/server#smoke", "@bebop/swordfish#smoke", "@bebop/opencode-plugin#smoke"],
      },
      // Aggregator: the gate is its dependencies, not its command.
      ready: {
        command: "echo 'ready: check, tests, and artifact smokes passed'",
        dependsOn: ["check", "test", "test:integration", "local-system", "smoke"],
      },
    },
  },
  test: {
    passWithNoTests: false,
  },
});
