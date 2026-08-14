import pin from "./pins/memory-contracts.json" with { type: "json" };

export const MEMORY_CONTRACTS_PIN = pin;

export interface MemoryContractPin {
  package: string;
  version: string;
  major: number;
  publishStatus: string;
  manifestSha256: string;
  schemaSet: string[];
  owner: string;
}

/** Typed view of the pinned memory contract (cross-repo compatibility gate). */
export function readContractPin(): MemoryContractPin {
  return {
    package: pin.package,
    version: pin.version,
    major: pin.major,
    publishStatus: pin.publishStatus,
    manifestSha256: pin.manifestSha256,
    schemaSet: [...pin.schemas],
    owner: pin.owner,
  };
}

export function memoryContractsVersion(): string {
  return `${pin.version}+${pin.publishStatus}`;
}
