/**
 * Filename sanitization and collision resolution.
 *
 * Consistency matters here for its own sake: the same paper must always
 * resolve to the same filename, so a kept note and a later-arriving
 * duplicate never end up as two competing files for one paper.
 */

import { firstAuthorLastName, workYear, type Work } from "./types";

// Illegal or awkward on Windows/macOS/Linux.
const ILLEGAL_CHARS = /[<>:"\/\\|?*\u0000-\u001f]/g;
const WHITESPACE = /\s+/g;
export const DEFAULT_MAX_LENGTH = 150;

const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Trailing dots and spaces are rejected by Windows, so they're stripped at
 * every step that can produce them (including after truncation). */
function stripTrailingDotsAndSpaces(value: string): string {
  return value.replace(/[. ]+$/, "");
}

export function sanitizeFilename(name: string, maxLength = DEFAULT_MAX_LENGTH): string {
  let cleaned = name.replace(ILLEGAL_CHARS, " ");
  cleaned = cleaned.replace(WHITESPACE, " ").trim();
  cleaned = stripTrailingDotsAndSpaces(cleaned);
  if (!cleaned) cleaned = "Untitled";
  if (cleaned.length > maxLength) {
    cleaned = stripTrailingDotsAndSpaces(cleaned.slice(0, maxLength));
  }
  if (RESERVED_NAMES.has(cleaned.toUpperCase())) cleaned = `_${cleaned}`;
  return cleaned;
}

/** Fallback chain: title -> "<LastName> <year>" -> the work key. */
export function baseNameFor(work: Work): string {
  if (work.title) return work.title;
  const lastName = firstAuthorLastName(work);
  if (lastName) return `${lastName} ${workYear(work) ?? "n.d."}`;
  return work.key;
}

export interface AllocationResult {
  filename: string;
  /** The unique key of whatever already held the base name, when this
   * allocation had to be disambiguated. */
  collidedWith?: string;
}

/**
 * Assigns unique, sanitized filenames across a batch.
 *
 * Stateful by design: create one per run and allocate in a stable order, so
 * collisions resolve deterministically rather than depending on iteration
 * order. Matching is case-insensitive because Windows and macOS filesystems
 * are.
 */
export class FilenameAllocator {
  private readonly assigned = new Map<string, string>(); // lowercased name -> owning key

  constructor(private readonly maxLength: number = DEFAULT_MAX_LENGTH) {}

  /** Seed names that already exist and must not be reused — e.g. everything
   * already in `Papers/`, so an inbox note can never collide with one. */
  reserve(filename: string, owner = "reserved"): void {
    this.assigned.set(filename.toLowerCase(), owner);
  }

  allocate(work: Work): AllocationResult {
    return this.allocateName(baseNameFor(work), work.key, workYear(work));
  }

  allocateName(base: string, uniqueKey: string, disambiguator?: string): AllocationResult {
    const sanitized = sanitizeFilename(base, this.maxLength);
    const key = sanitized.toLowerCase();
    if (!this.assigned.has(key)) {
      this.assigned.set(key, uniqueKey);
      return { filename: sanitized };
    }

    const collidedWith = this.assigned.get(key) as string;

    if (disambiguator) {
      const withDisambiguator = sanitizeFilename(
        `${sanitized} (${disambiguator})`, this.maxLength,
      );
      if (!this.assigned.has(withDisambiguator.toLowerCase())) {
        this.assigned.set(withDisambiguator.toLowerCase(), uniqueKey);
        return { filename: withDisambiguator, collidedWith };
      }
    }

    let candidate = sanitizeFilename(`${sanitized} (${uniqueKey})`, this.maxLength);
    let suffix = 2;
    while (this.assigned.has(candidate.toLowerCase())) {
      candidate = sanitizeFilename(`${sanitized} (${uniqueKey}-${suffix})`, this.maxLength);
      suffix += 1;
    }
    this.assigned.set(candidate.toLowerCase(), uniqueKey);
    return { filename: candidate, collidedWith };
  }
}
