import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:43179",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--enable-webgl", "--use-angle=swiftshader"],
        },
      },
    },
  ],
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 43179 --strictPort",
    url: "http://127.0.0.1:43179",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
