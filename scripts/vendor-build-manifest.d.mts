/** Type declarations for scripts/vendor-build-manifest.mjs (A6). */
export interface VendorBuildPin {
  repository: string;
  commit: string;
  tree: string;
}
export interface BuildStamp {
  schemaVersion: number;
  name: string;
  repository: string;
  commit: string;
  tree: string;
  lockHash: string;
  node: string;
  npm: string;
  buildProfile: string;
  builtAt: string;
  artifacts: Record<string, string>;
}
export const BUILD_STAMP_SCHEMA_VERSION: number;
export function sha256(text: string): string;
export function sha256File(filePath: string): string;
export function walkFiles(dir: string, out?: string[], base?: string): string[];
export function artifactManifest(dir: string, artifactDirs?: string[]): Record<string, string>;
export function computeLockHash(dir: string): string;
export function readBuildStamp(name: string, stampDir: string): BuildStamp | undefined;
export function artifactsMatch(
  stamp: BuildStamp | undefined,
  dir: string,
  artifactDirs?: string[],
): boolean;
export function buildStampValid(
  name: string,
  dir: string,
  pin: VendorBuildPin,
  stampDir: string,
  artifactDirs?: string[],
): { valid: boolean; reason?: string };
export function verifyBuildStamp(
  name: string,
  dir: string,
  pin: VendorBuildPin,
  stampDir: string,
  artifactDirs?: string[],
): string[];
export function writeBuildStamp(input: {
  name: string;
  dir: string;
  pin: VendorBuildPin;
  stampDir: string;
  buildProfile?: string;
  artifactDirs?: string[];
}): BuildStamp;
export function cleanVendorBuild(dir: string, name: string, stampDir: string): void;
