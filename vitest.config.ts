import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 40000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "**/*.d.ts"],
      reporter: ["text", "json", "html"],
      thresholds: {
        lines: 95,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
  plugins: [swc.vite({ module: { type: "es6" }, jsc: { target: "es2022", parser: { syntax: "typescript", decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
});
