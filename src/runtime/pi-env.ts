import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { Result } from "@iris/pi-agent-core";
import type { SqliteSessionRepositoryEnv } from "@iris/pi-storage-sqlite-node";

export function nodeSqliteRepoEnv(root: string): SqliteSessionRepositoryEnv {
  return {
    async absolutePath(path) {
      return { ok: true, value: resolve(root, path) };
    },
    async createDir(path) {
      await mkdir(path, { recursive: true });
      return { ok: true, value: undefined } as Result<void, never>;
    },
    async exists(path) {
      try {
        await stat(path);
        return { ok: true, value: true };
      } catch {
        return { ok: true, value: false };
      }
    },
  };
}
