import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The generated validators require() JSON Schema assets relative to
// themselves at runtime; tsc does not copy .json, so mirror them into dist.
const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "contracts", "generated", "json-schemas");
const target = join(root, "dist", "contracts", "generated", "json-schemas");
if (!existsSync(source)) {
  throw new Error(`generated json-schemas missing: ${source} (run codegen first)`);
}
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`copied ${source} -> ${target}`);
