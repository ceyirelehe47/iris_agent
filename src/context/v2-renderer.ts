import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { validateGenerationV2 } from "../contracts/context-v27.js";
import type { ContextGenerationV2 } from "../contracts/context-v27.js";
import { verifyGenerationHashesV2 } from "./v2-generation.js";

/**
 * Roadmap v27 V2 Provider Renderer.
 *
 * Consumes ONLY a validated ContextGenerationV2 and projects it to
 * provider-visible messages in P0→P5 order:
 *
 *   - P0 (iris.system.v1)      → systemPrompt
 *   - P1..P4 (persona/declarations/compartment/memory) → synthetic user
 *     messages (deterministic timestamp 0)
 *   - P5 (iris.message.*.v1)   → the canonical payload restored from its
 *     deterministic JSON serialization (structured messages preserved)
 *
 * The renderer never re-scans layer sources — everything it needs is in the
 * generation. Fail-closed: an invalid or tampered generation throws before
 * any message is produced.
 */

/** Deterministic timestamp for synthetic (non-Session) messages. */
export const SYNTHETIC_MESSAGE_TIMESTAMP = 0;

export interface RenderedGenerationV2 {
  systemPrompt: string;
  messages: AgentMessage[];
}

function restorePayload(semanticContent: string): AgentMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(semanticContent);
  } catch {
    throw new Error("v2-renderer: P5 semanticContent is not valid JSON — generation is corrupt");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("v2-renderer: P5 semanticContent did not restore a message object");
  }
  return parsed as AgentMessage;
}

export function renderGenerationV2(generation: ContextGenerationV2): RenderedGenerationV2 {
  if (!validateGenerationV2(generation)) {
    throw new Error("v2-renderer: generation failed layerEnds/schema validation");
  }
  if (!verifyGenerationHashesV2(generation)) {
    throw new Error(
      "v2-renderer: generation hash mismatch — content or ordering was tampered with",
    );
  }

  const units = generation.units;
  const p0End = generation.header.layerEnds[0];
  const systemPrompt = p0End > 0 ? (units[0]?.semanticContent ?? "") : "";

  const messages: AgentMessage[] = [];
  for (let index = p0End; index < units.length; index += 1) {
    const unit = units[index];
    if (unit === undefined) {
      continue;
    }
    if (unit.header.semanticSchemaId.startsWith("iris.message.")) {
      messages.push(restorePayload(unit.semanticContent));
    } else {
      messages.push({
        role: "user",
        content: unit.semanticContent,
        timestamp: SYNTHETIC_MESSAGE_TIMESTAMP,
      });
    }
  }
  return { systemPrompt, messages };
}
