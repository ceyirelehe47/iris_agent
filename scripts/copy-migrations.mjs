import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "src", "db", "migrations");
const target = join(root, "dist", "src", "db", "migrations");
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
