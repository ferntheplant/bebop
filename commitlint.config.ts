export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "deps", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert", "misc"],
    ],

    // keep subject-case strict, but allow uppercase prefixes
    "subject-case": [0],
  },
};
