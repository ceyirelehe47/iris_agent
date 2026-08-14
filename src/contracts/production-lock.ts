import pin from "./pins/production-lock.json" with { type: "json" };

export const PRODUCTION_LOCK = pin;

export interface ProductionLock {
  schemaVersion: number;
  documentedAt: string;
  toolchain: {
    node: string;
    nodeCiExact: string;
    packageManager: string;
    lockfile: string;
  };
  pi: {
    currentDependencySource: string;
    packages: Record<string, string>;
    fork: {
      repository: string;
      baselineCommit: string;
      seamCommit: string;
      seamTree: string;
      acceptedRuntimeRepository: string;
      acceptedRuntimeCommit: string;
      acceptedRuntimeTree: string;
      upstreamBaseCommit: string;
      upstreamAuditBaselineCommit: string;
      adoptionStatus: string;
    };
  };
  magicContext: {
    repository: string;
    release: string;
    commit: string;
    authoritativePath: string;
    explicitlyNotAdopted: string[];
  };
  memoryContracts: {
    package: string;
    version: string;
    manifestSha256: string;
    owner: string;
  };
  graphitiNeo4j: {
    owner: string;
    agentDirectDependency: boolean;
    candidateLock: {
      graphitiCore: string;
      neo4jDriverMinimum: string;
    };
  };
}

/** 类型化视图：当前仓库的 production lock（v13 R0 Exit Gate：无 TBD）。 */
export function readProductionLock(): ProductionLock {
  return {
    schemaVersion: pin.schemaVersion,
    documentedAt: pin.documentedAt,
    toolchain: { ...pin.toolchain },
    pi: {
      currentDependencySource: pin.pi.currentDependencySource,
      packages: { ...pin.pi.packages },
      fork: { ...pin.pi.fork },
    },
    magicContext: {
      repository: pin.magicContext.repository,
      release: pin.magicContext.release,
      commit: pin.magicContext.commit,
      authoritativePath: pin.magicContext.authoritativePath,
      explicitlyNotAdopted: [...pin.magicContext.explicitlyNotAdopted],
    },
    memoryContracts: { ...pin.memoryContracts },
    graphitiNeo4j: {
      owner: pin.graphitiNeo4j.owner,
      agentDirectDependency: pin.graphitiNeo4j.agentDirectDependency,
      candidateLock: { ...pin.graphitiNeo4j.candidateLock },
    },
  };
}
