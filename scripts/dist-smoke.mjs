import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAgentConfig } from "../dist/src/config/load.js";
import { initializeDataRoot } from "../dist/src/host/data-root.js";

const dataRoot = mkdtempSync(join(tmpdir(), "iris-dist-smoke-"));
const config = defaultAgentConfig();
initializeDataRoot(dataRoot, config);

const epochDb = join(dataRoot, "runtime-epochs.db");
const ingressDb = join(dataRoot, "ingress.db");
if (!existsSync(epochDb) || !existsSync(ingressDb)) {
  throw new Error("dist migration smoke failed: databases were not initialized");
}

console.log(
  JSON.stringify({
    status: "ok",
    epochDb: epochDb.endsWith("runtime-epochs.db"),
    ingressDb: ingressDb.endsWith("ingress.db"),
  }),
);
