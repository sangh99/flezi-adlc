import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", ".sandcastle/factory/**/*.test.ts"],
    setupFiles: ["src/testSetup.ts"],
  },
});
