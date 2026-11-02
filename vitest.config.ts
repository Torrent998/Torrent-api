import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 20000 },
  plugins: [swc.vite({ module: { type: "es6" }, jsc: { target: "es2022", parser: { syntax: "typescript", decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
});
