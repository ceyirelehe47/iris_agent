import { mkdtempSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNodeSqliteFactory,
  SqliteSessionRepository,
} from "@iris/pi-storage-sqlite-node";

import { nodeSqliteRepoEnv } from "../src/runtime/pi-env.js";

const dataRoot = mkdtempSync(join(tmpdir(), "iris-bench-smoke-"));
const repo = new SqliteSessionRepository({
  env: nodeSqliteRepoEnv(dataRoot),
  sqlite: createNodeSqliteFactory(),
  databasePath: join(dataRoot, "session.db"),
});

const session = await repo.create({ id: "bench-session", cwd: dataRoot });
const count = 200;
const started = performance.now();
for (let index = 0; index < count; index += 1) {
  await session.appendMessage({
    role: "user",
    content: `benchmark message ${index}`,
    timestamp: Date.now(),
  });
}
const elapsedMs = performance.now() - started;

console.log(
  JSON.stringify(
    {
      appends: count,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      appendMsPerMessage: Number((elapsedMs / count).toFixed(3)),
      status: "ok",
    },
    null,
    2,
  ),
);
