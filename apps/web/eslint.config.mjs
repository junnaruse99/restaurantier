import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import base from "../../eslint.config.mjs";

export default [
  ...base,
  { ignores: ["public/**", ".next/**", "test-results/**", "playwright-report/**"] },
  nextPlugin.flatConfig.coreWebVitals,
  reactHooks.configs.flat["recommended-latest"],
  {
    settings: { next: { rootDir: "." } },
  },
];
