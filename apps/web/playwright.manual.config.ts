import { defineConfig } from "@playwright/test";

// Capturas del manual de usuario (docs/manual): recorre la PWA por rol contra el stack local con la
// semilla de desarrollo y guarda las imágenes. No es una prueba del CI: `pnpm manual`.
export default defineConfig({
  testDir: "./manual",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    locale: "es-PE",
    timezoneId: "America/Lima",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm start",
        url: "http://127.0.0.1:3000",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
