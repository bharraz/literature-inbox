import { describe, expect, it } from "vitest";
import { collectSubjects, renderInboxNote, tagify } from "../src/core/notes";
import { workFromOpenAlex } from "../src/core/openalex";
import { emptyWork, type Work } from "../src/core/types";

function taggedWork(): Work {
  const item = emptyWork("W1");
  item.title = "A Paper";
  item.topics = ["Quantum Error Correction"];
  item.keywords = ["surface code"];
  item.concepts = ["Physics"];
  return item;
}

describe("tagify", () => {
  it("makes a term usable as an Obsidian tag", () => {
    // Tags cannot contain spaces.
    expect(tagify("Quantum Error Correction")).toBe("quantum-error-correction");
  });

  it("collapses punctuation rather than emitting a broken tag", () => {
    expect(tagify("Bose–Einstein  condensate!")).toBe("bose-einstein-condensate");
    expect(tagify("Alzheimer's disease")).toBe("alzheimers-disease");
  });

  it("drops a purely numeric term, which is not a valid tag", () => {
    expect(tagify("2024")).toBeUndefined();
    expect(tagify("---")).toBeUndefined();
  });

  it("drops a term with nothing left after folding", () => {
    expect(tagify("   ")).toBeUndefined();
  });
});

describe("collectSubjects", () => {
  it("takes only the vocabularies that are switched on", () => {
    const terms = collectSubjects(taggedWork(), {
      placement: "property",
      topics: true,
      keywords: true,
    });
    expect(terms).toEqual(["Quantum Error Correction", "surface code"]);
  });

  it("orders most-curated first", () => {
    const terms = collectSubjects(taggedWork(), {
      placement: "property",
      topics: true,
      keywords: true,
      concepts: true,
    });
    expect(terms[0]).toBe("Quantum Error Correction");
    expect(terms[terms.length - 1]).toBe("Physics");
  });

  it("de-duplicates across vocabularies", () => {
    const item = taggedWork();
    item.keywords = ["Quantum Error Correction"];
    const terms = collectSubjects(item, { placement: "property", topics: true, keywords: true });
    expect(terms).toEqual(["Quantum Error Correction"]);
  });
});

describe("subject terms in a note", () => {
  const render = (subjects: Parameters<typeof renderInboxNote>[0]["subjects"]) =>
    renderInboxNote({
      work: taggedWork(),
      arrivedOn: "2026-08-06",
      originIds: ["openalex:W1"],
      subjects,
    });

  it("writes nothing at all when switched off", () => {
    const note = render({ placement: "off", topics: true, keywords: true });
    expect(note).not.toContain("subjects:");
    expect(note).not.toContain("tags:");
  });

  it("defaults to writing nothing, so a caller must opt in", () => {
    const note = renderInboxNote({
      work: taggedWork(),
      arrivedOn: "2026-08-06",
      originIds: ["openalex:W1"],
    });
    expect(note).not.toContain("subjects:");
    expect(note).not.toContain("tags:");
  });

  it("writes a property without touching tags", () => {
    const note = render({ placement: "property", topics: true, keywords: true });
    expect(note).toContain("subjects:");
    expect(note).toContain("  - Quantum Error Correction");
    // The whole point of the property placement: nothing lands in the tag pane.
    expect(note).not.toContain("tags:");
  });

  it("writes tags folded into valid form", () => {
    const note = render({ placement: "tags", topics: true, keywords: true });
    expect(note).toContain("tags:");
    expect(note).toContain("  - quantum-error-correction");
    expect(note).toContain("  - surface-code");
    expect(note).not.toContain("subjects:");
  });

  it("omits the key entirely when the chosen vocabularies are empty", () => {
    const bare = emptyWork("W2");
    bare.title = "No Terms Here";
    const note = renderInboxNote({
      work: bare,
      arrivedOn: "2026-08-06",
      originIds: ["openalex:W2"],
      subjects: { placement: "property", topics: true, keywords: true },
    });
    // Never a blank `subjects:` key sitting in frontmatter.
    expect(note).not.toContain("subjects:");
  });
});

describe("reading subject terms from OpenAlex", () => {
  it("takes display names from each vocabulary", () => {
    const work = workFromOpenAlex({
      id: "https://openalex.org/W1",
      title: "A Paper",
      type: "article",
      topics: [{ display_name: "Quantum Error Correction" }],
      keywords: [{ display_name: "surface code" }],
      concepts: [{ display_name: "Physics" }],
    });
    expect(work.topics).toEqual(["Quantum Error Correction"]);
    expect(work.keywords).toEqual(["surface code"]);
    expect(work.concepts).toEqual(["Physics"]);
  });

  it("caps a long list, since concepts tails off into useless breadth", () => {
    const work = workFromOpenAlex({
      id: "https://openalex.org/W1",
      title: "A Paper",
      type: "article",
      concepts: Array.from({ length: 30 }, (_, i) => ({ display_name: `Concept ${i}` })),
    });
    expect(work.concepts).toHaveLength(8);
  });

  it("survives the fields being absent or malformed", () => {
    const work = workFromOpenAlex({
      id: "https://openalex.org/W1",
      title: "A Paper",
      type: "article",
      keywords: [{ nothing: true }, { display_name: "  " }, { display_name: "real" }],
    });
    expect(work.topics).toEqual([]);
    expect(work.keywords).toEqual(["real"]);
  });
});
