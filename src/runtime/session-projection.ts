import type { AgentMessage, SessionTreeEntry } from "@iris/pi-agent-core";

/**
 * Identity-preserving projection of a raw Pi Session entry that carries a
 * model-visible message. The projection keeps the RAW entry identity so
 * pairing and reconciliation never infer an entry ID from a position in a
 * filtered/compressed array (iris_agent#6).
 *
 * Only `message` and `custom_message` entries project here; every other
 * SessionTreeEntry type (`model_change`, `active_tools_change`, `compaction`,
 * `branch_summary`, `label`, `session_info`, `leaf`, ...) is skipped, but its
 * position is NOT erased — `rawIndex` always refers to the index in the
 * original `SessionTreeEntry[]`, so raw adjacency can still be verified.
 */
export interface ProjectedSessionMessage {
  /** Index of this entry in the ORIGINAL raw `SessionTreeEntry[]`. */
  rawIndex: number;
  /** Real Pi entry id (`entry.id`) — never derived from an array position. */
  entryId: string;
  /** Real Pi parent id (`entry.parentId`), used for authoritative pairing. */
  parentId: string | null;
  /** Raw entry type: Pi `message` or Pi `custom_message`. */
  entryType: "message" | "custom_message";
  /** Model-visible message (a `custom_message` entry is lifted to a
   *  `role: "custom"` AgentMessage so existing detection logic applies). */
  message: AgentMessage;
}

export function isMessageEntry(
  entry: SessionTreeEntry,
): entry is Extract<SessionTreeEntry, { type: "message" }> {
  return entry.type === "message";
}

export function isCustomMessageEntry(
  entry: SessionTreeEntry,
): entry is Extract<SessionTreeEntry, { type: "custom_message" }> {
  return entry.type === "custom_message";
}

/**
 * Build the identity-preserving projection directly from raw Pi entries.
 * Never maps a filtered-array index back into the raw array (iris_agent#6).
 */
export function projectSessionMessages(entries: SessionTreeEntry[]): ProjectedSessionMessage[] {
  const projected: ProjectedSessionMessage[] = [];
  for (let rawIndex = 0; rawIndex < entries.length; rawIndex += 1) {
    const entry = entries[rawIndex];
    if (entry === undefined) {
      continue;
    }
    if (isMessageEntry(entry)) {
      projected.push({
        rawIndex,
        entryId: entry.id,
        parentId: entry.parentId,
        entryType: "message",
        message: entry.message,
      });
      continue;
    }
    if (isCustomMessageEntry(entry)) {
      // A Pi custom_message entry is a first-class raw entry. Lift it into
      // the AgentMessage shape the companion detector expects so the
      // iris_input_meta companion is recognized whether it was persisted via
      // appendMessage (type "message") or appendCustomMessageEntry (type
      // "custom_message").
      projected.push({
        rawIndex,
        entryId: entry.id,
        parentId: entry.parentId,
        entryType: "custom_message",
        message: {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          ...(entry.details === undefined ? {} : { details: entry.details }),
          timestamp: new Date(entry.timestamp).getTime(),
        },
      });
    }
  }
  return projected;
}
