import { describe, expect, it } from "vitest";
import { collectSubjects, MAX_NOTE_SUBJECTS, renderInboxNote } from "../src/core/notes";
import { emptyWork } from "../src/core/types";

function paper() {
  const work = emptyWork("W1");
  work.title = "A Paper";
  work.topics = ["Machine learning", "Natural language processing", "Machine learning"];
  work.keywords = ["ignored keyword"];
  work.concepts = ["Ignored concept"];
  return work;
}

describe("subject terms", () => {
  it("uses only de-duplicated OpenAlex Topics", () => {
    expect(collectSubjects(paper())).toEqual([
      "Machine learning",
      "Natural language processing",
    ]);
  });

  it("caps the property", () => {
    const work = paper();
    work.topics = Array.from({ length: MAX_NOTE_SUBJECTS + 5 }, (_, index) => `Topic ${index}`);
    expect(collectSubjects(work)).toHaveLength(MAX_NOTE_SUBJECTS);
  });

  it("includes Topics when enabled and omits every subject field when disabled", () => {
    const enabled = renderInboxNote({
      work: paper(),
      arrivedOn: "2026-01-01",
      originIds: ["openalex:W1"],
      includeSubjects: true,
    });
    expect(enabled).toContain("subjects:\n  - Machine learning");
    expect(enabled).not.toContain("ignored keyword");
    expect(enabled).not.toContain("Ignored concept");
    expect(enabled).not.toContain("tags:");

    const disabled = renderInboxNote({
      work: paper(),
      arrivedOn: "2026-01-01",
      originIds: ["openalex:W1"],
      includeSubjects: false,
    });
    expect(disabled).not.toContain("subjects:");
  });
});
