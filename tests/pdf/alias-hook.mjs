// Node module resolution hook so tests can import "@/..." (tsconfig path alias)
// the same way the app does. Registered via node:module register() in tests.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = pathToFileURL(process.cwd() + "/");

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = specifier.slice(2);
    for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
      const candidate = new URL(base + ext, root);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
