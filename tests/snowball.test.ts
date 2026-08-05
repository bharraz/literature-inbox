import { describe, expect, it } from "vitest";
import { snowball, type SnowballResolver } from "../src/core/snowball";
import { OPENALEX, DOI, makeId } from "../src/core/ids";
import { emptyWork, type Work } from "../src/core/types";

function work(id: string, references: string[] = [], doi?: string): Work {
  const item = emptyWork(id);
  item.title = id;
  item.ids = [makeId(OPENALEX, id)];
  if (doi) item.ids.push(makeId(DOI, doi));
  item.doi = doi;
  item.references = references.map((reference) => makeId(OPENALEX, reference));
  return item;
}

function resolverOf(byId: Work[], citing: Work[]): SnowballResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async worksByIds(ids) {
      calls.push(`byIds:${ids.join(",")}`);
      return byId;
    },
    async worksCiting(ids, limit) {
      calls.push(`citing:${ids.join(",")}:${limit}`);
      return citing.slice(0, limit);
    },
  };
}

describe("snowball", () => {
  it("keeps the seeds and adds both directions around them", async () => {
    const seeds = [work("W1", ["W10"])];
    const resolver = resolverOf([work("W10")], [work("W20")]);

    const report = await snowball({ seeds, resolver, limit: 10 });

    expect(report.works.map((w) => w.key)).toEqual(["W1", "W10", "W20"]);
    expect(report.seedCount).toBe(1);
    expect(report.referenceCount).toBe(1);
    expect(report.citerCount).toBe(1);
  });

  it("does not add a paper twice when it is both cited and citing", async () => {
    // The same paper reached two ways arrives as two records with different
    // keys but overlapping ids, so key comparison alone would duplicate it.
    const seeds = [work("W1", ["W10"])];
    const duplicate = work("WX", [], "10.1234/same");
    const alsoDuplicate = work("WY", [], "10.1234/same");
    const resolver = resolverOf([duplicate], [alsoDuplicate]);

    const report = await snowball({ seeds, resolver, limit: 10 });

    expect(report.works).toHaveLength(2); // the seed plus one of the pair
    expect(report.citerCount).toBe(0);
  });

  it("never returns a seed as a discovery", async () => {
    const seeds = [work("W1", ["W10"], "10.1234/seed")];
    const resolver = resolverOf([work("W1", [], "10.1234/seed")], []);

    const report = await snowball({ seeds, resolver, limit: 10 });

    expect(report.works).toHaveLength(1);
    expect(report.referenceCount).toBe(0);
  });

  it("splits the budget between the two directions", async () => {
    const seeds = [work("W1", ["W10", "W11", "W12", "W13"])];
    const resolver = resolverOf(
      [work("W10"), work("W11"), work("W12"), work("W13")],
      [work("W20"), work("W21")],
    );

    const report = await snowball({ seeds, resolver, limit: 4 });

    expect(report.referenceCount).toBe(2);
    expect(report.citerCount).toBe(2);
    expect(report.works).toHaveLength(5); // seed + 4
  });

  it("gives the whole budget to one direction when the other is off", async () => {
    const seeds = [work("W1", ["W10", "W11", "W12"])];
    const resolver = resolverOf([work("W10"), work("W11"), work("W12")], [work("W20")]);

    const report = await snowball({ seeds, resolver, limit: 3, includeCiters: false });

    expect(report.referenceCount).toBe(3);
    expect(report.citerCount).toBe(0);
    expect(resolver.calls.some((call) => call.startsWith("citing:"))).toBe(false);
  });

  it("reports a failed direction instead of losing the whole run", async () => {
    // Expansion is a bonus on top of the seeds; a dead half should still leave
    // the user with the papers they named.
    const seeds = [work("W1", ["W10"])];
    const resolver: SnowballResolver = {
      async worksByIds() {
        throw new Error("boom");
      },
      async worksCiting() {
        return [work("W20")];
      },
    };

    const report = await snowball({ seeds, resolver, limit: 10 });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("references");
    expect(report.works.map((w) => w.key)).toEqual(["W1", "W20"]);
  });

  it("does nothing without seeds", async () => {
    const resolver = resolverOf([work("W10")], [work("W20")]);
    const report = await snowball({ seeds: [], resolver, limit: 10 });
    expect(report.works).toEqual([]);
    expect(resolver.calls).toEqual([]);
  });

  it("makes no requests for a zero budget", async () => {
    const resolver = resolverOf([work("W10")], [work("W20")]);
    const report = await snowball({ seeds: [work("W1", ["W10"])], resolver, limit: 0 });
    expect(report.works).toHaveLength(1);
    expect(resolver.calls).toEqual([]);
  });

  it("asks for citers by the seeds' OpenAlex ids", async () => {
    const resolver = resolverOf([], [work("W20")]);
    await snowball({ seeds: [work("W1"), work("W2")], resolver, limit: 4 });
    expect(resolver.calls).toContain("citing:W1,W2:4");
  });
});
