/**
 * Using OpenAlex and Crossref together.
 *
 * Neither replaces the other, and the split is not arbitrary — it follows
 * directly from what each costs and what each holds (docs/openalex-dependency.md):
 *
 *   - **Titles go to Crossref first.** OpenAlex bills a title search as its
 *     most expensive call; Crossref answers free. Same question, same guard
 *     against a wrong match, a tenth of the cost.
 *   - **References go to OpenAlex first.** It returns them inline with the
 *     record, and every entry is an id we can match. Crossref only yields the
 *     references a publisher deposited *with* DOIs — roughly half — so it is
 *     the fallback, not the default.
 *
 * Composed here rather than inside either client so both stay single-purpose
 * and independently testable, and so turning one off is a matter of not
 * passing it in.
 */

import type { Work } from "./types";

export interface TitleLookup {
  workByTitle(title: string): Promise<Work | undefined>;
}

export interface DoiLookup {
  worksByDois(dois: string[]): Promise<Work[]>;
}

/** Merge *extra* into *base* without overwriting anything already known —
 * whichever source answered first is the more trusted one. */
function enrich(base: Work, extra: Work): Work {
  if (base.references.length === 0 && extra.references.length > 0) {
    base.references = extra.references;
  }
  if (!base.abstract && extra.abstract) base.abstract = extra.abstract;
  if (!base.publication && extra.publication) base.publication = extra.publication;
  if (base.authors.length === 0 && extra.authors.length > 0) base.authors = extra.authors;
  for (const id of extra.ids) {
    if (!base.ids.some((held) => held.namespace === id.namespace && held.value === id.value)) {
      base.ids.push(id);
    }
  }
  return base;
}

/**
 * Ask *primary*, then *fallback*, for a title.
 *
 * A failure in either is not a failure of the lookup: an unresolved title
 * means "this arrival stays edge-less for now", which the caller already
 * handles, whereas a thrown error would abort a whole run.
 */
export function titleResolver(
  primary: TitleLookup | undefined,
  fallback: TitleLookup | undefined,
): TitleLookup {
  return {
    async workByTitle(title: string): Promise<Work | undefined> {
      for (const source of [primary, fallback]) {
        if (!source) continue;
        try {
          const hit = await source.workByTitle(title);
          if (hit) return hit;
        } catch {
          // Try the next source rather than losing the lookup.
        }
      }
      return undefined;
    },
  };
}

/**
 * Ask *primary* for a batch of DOIs, then top up from *fallback*.
 *
 * The fallback is only asked about DOIs the primary either missed entirely or
 * returned without references — which is the case that matters, since a record
 * with no reference list produces no edges and is indistinguishable from not
 * being found.
 */
export function doiResolver(
  primary: DoiLookup | undefined,
  fallback: DoiLookup | undefined,
): DoiLookup {
  return {
    async worksByDois(dois: string[]): Promise<Work[]> {
      const found = new Map<string, Work>();

      if (primary) {
        try {
          for (const work of await primary.worksByDois(dois)) {
            if (work.doi) found.set(work.doi, work);
          }
        } catch {
          // Fall through: the fallback may still answer.
        }
      }

      const unresolved = dois.filter((doi) => {
        const hit = found.get(doi);
        return !hit || hit.references.length === 0;
      });

      if (fallback && unresolved.length > 0) {
        try {
          for (const work of await fallback.worksByDois(unresolved)) {
            if (!work.doi) continue;
            const existing = found.get(work.doi);
            found.set(work.doi, existing ? enrich(existing, work) : work);
          }
        } catch {
          // Partial results are still results.
        }
      }

      return [...found.values()];
    },
  };
}
