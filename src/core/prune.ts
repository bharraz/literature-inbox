/**
 * Cleanup of untouched arrivals — the half of the loop that keeps the inbox
 * from becoming another pile.
 *
 * Three independent guards, all of which must pass before anything is removed:
 *   1. the note is still **in the inbox folder** — moving it out is the keep
 *      signal, and a note that has left is no longer this plugin's business;
 *   2. it is **untouched**, i.e. still byte-identical to what was generated
 *      (ticking a checkbox inside it counts as touching it);
 *   3. it is **past the keep window**.
 *
 * And even then the default is Obsidian's trash, not deletion. A file this
 * plugin didn't generate has no record here and is invisible to all of it.
 */

import { contentHash } from "./hash";
import type { InboxRecord, VaultAdapter } from "./update";

export type PruneVerdict =
  | "gone"        // file no longer at that path: kept by moving, or user-deleted
  | "kept-moved"  // path is outside the inbox folder now
  | "touched"     // user edited it
  | "manual"      // added by hand; intentional, never auto-pruned
  | "too-recent"  // still inside the keep window
  | "prunable";

export interface PruneCandidate {
  record: InboxRecord;
  verdict: PruneVerdict;
  ageDays: number;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.floor((to - from) / (24 * 60 * 60 * 1000));
}

export async function classify(
  record: InboxRecord,
  adapter: VaultAdapter,
  inboxFolder: string,
  keepWindowDays: number,
  today: string,
): Promise<PruneCandidate> {
  const ageDays = daysBetween(record.arrivedOn, today);
  const verdict = await classifyVerdict(record, adapter, inboxFolder, keepWindowDays, ageDays);
  return { record, verdict, ageDays };
}

async function classifyVerdict(
  record: InboxRecord,
  adapter: VaultAdapter,
  inboxFolder: string,
  keepWindowDays: number,
  ageDays: number,
): Promise<PruneVerdict> {
  if (!record.notePath.startsWith(`${inboxFolder}/`)) return "kept-moved";
  const current = await adapter.read(record.notePath);
  if (current === undefined) return "gone";
  if (record.manual) return "manual";
  if (contentHash(current) !== record.contentHash) return "touched";
  if (ageDays < keepWindowDays) return "too-recent";
  return "prunable";
}

export interface PrunePlan {
  prunable: PruneCandidate[];
  /** Records to drop from state without touching any file: the note was moved
   * out (kept) or deleted by hand, so tracking it further would be wrong —
   * and would let a later run recreate it. */
  forget: PruneCandidate[];
  retained: PruneCandidate[];
}

export async function planPrune(
  inbox: readonly InboxRecord[],
  adapter: VaultAdapter,
  inboxFolder: string,
  keepWindowDays: number,
  today: string,
): Promise<PrunePlan> {
  const plan: PrunePlan = { prunable: [], forget: [], retained: [] };
  for (const record of inbox) {
    const candidate = await classify(record, adapter, inboxFolder, keepWindowDays, today);
    if (candidate.verdict === "prunable") plan.prunable.push(candidate);
    else if (candidate.verdict === "gone" || candidate.verdict === "kept-moved") {
      plan.forget.push(candidate);
    } else plan.retained.push(candidate);
  }
  return plan;
}

/** Apply a plan, returning the records that should remain in plugin state.
 * `remove` is injected (Obsidian's trash in practice) so this stays testable
 * and so the destructive call has exactly one implementation. */
export async function applyPrune(
  plan: PrunePlan,
  remove: (path: string) => Promise<void>,
): Promise<InboxRecord[]> {
  for (const candidate of plan.prunable) {
    await remove(candidate.record.notePath);
  }
  return plan.retained.map((candidate) => candidate.record);
}
