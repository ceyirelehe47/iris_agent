import type { Session } from "@iris/pi-agent-core";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@iris/pi-storage-sqlite-node";

import type { AgentConfigV3 } from "../../src/config/schema.js";
import { resolveDataRootPaths } from "../../src/host/data-root.js";
import { nodeSqliteRepoEnv } from "../../src/runtime/pi-env.js";

export async function openOrCreateSessionHelper(
  dataRoot: string,
  config: AgentConfigV3,
  runtimeSessionId: string,
): Promise<{ repo: SqliteSessionRepository; session: Session }> {
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepository({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadata = list.find((candidate) => candidate.id === runtimeSessionId);
  if (metadata !== undefined) {
    return { repo, session: await repo.open(metadata) };
  }
  return { repo, session: await repo.create({ id: runtimeSessionId, cwd: dataRoot }) };
}

export async function closeSessionStorageHelper(repo: {
  [Symbol.asyncDispose](): Promise<void>;
}): Promise<void> {
  await repo[Symbol.asyncDispose]();
}
