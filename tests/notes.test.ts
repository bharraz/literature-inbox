import { describe, expect, it } from "vitest";
import {
  CITATIONS_END,
  CITATIONS_START,
  GENERATED_END,
  mergeCitations,
  renderInboxNote,
} from "../src/core/notes";
import { emptyWork } from "../src/core/types";

function work(title: string) {
  const w = emptyWork("W1");
  w.title = title;
  return w;
}

describe("renderInboxNote citations block", () => {
  it("wraps the Citations section in its own markers when there are edges", () => {
    const content = renderInboxNote({
      work: work("A Paper"),
      cites: ["Another Paper"],
      arrivedOn: "2026-01-01",
      originIds: ["openalex:W1"],
    });
    expect(content).toContain(CITATIONS_START);
    expect(content).toContain(CITATIONS_END);
    expect(content.indexOf(CITATIONS_START)).toBeLessThan(content.indexOf("### Cites"));
    expect(content.indexOf(CITATIONS_END)).toBeGreaterThan(content.indexOf("[[Another Paper]]"));
  });

  it("has no citations block at all when there are no edges", () => {
    const content = renderInboxNote({
      work: work("A Paper"),
      arrivedOn: "2026-01-01",
      originIds: ["openalex:W1"],
    });
    expect(content).not.toContain(CITATIONS_START);
  });
});

describe("mergeCitations", () => {
  const base = renderInboxNote({
    work: work("A Paper"),
    arrivedOn: "2026-01-01",
    originIds: ["openalex:W1"],
  });

  it("creates a citations block when the note has none yet", () => {
    const updated = mergeCitations(base, ["Some Paper"], []);
    expect(updated).toContain(CITATIONS_START);
    expect(updated).toContain("[[Some Paper]]");
  });

  it("is a no-op when there is nothing new to add", () => {
    const once = mergeCitations(base, ["Some Paper"], []);
    const twice = mergeCitations(once, ["Some Paper"], []);
    expect(twice).toBe(once);
  });

  it("appends a missing link under an existing heading, keeping the one already there", () => {
    const once = mergeCitations(base, ["First Paper"], []);
    const twice = mergeCitations(once, ["First Paper", "Second Paper"], []);
    expect(twice).toContain("[[First Paper]]");
    expect(twice).toContain("[[Second Paper]]");
    // Still one Cites heading, not two.
    expect(twice.match(/### Cites/g)).toHaveLength(1);
  });

  it("adds a Cited by heading later, without disturbing an existing Cites section", () => {
    const withCites = mergeCitations(base, ["A Reference"], []);
    const withBoth = mergeCitations(withCites, [], ["A Citer"]);
    expect(withBoth).toContain("### Cites");
    expect(withBoth).toContain("[[A Reference]]");
    expect(withBoth).toContain("### Cited by");
    expect(withBoth).toContain("[[A Citer]]");
  });

  it("preserves a link the user added inside the block by hand", () => {
    const withCites = mergeCitations(base, ["First Paper"], []);
    const handEdited = withCites.replace(
      "- [[First Paper]]",
      "- [[First Paper]]\n- [[A Paper I Added Myself]]",
    );
    const merged = mergeCitations(handEdited, ["First Paper", "Second Paper"], []);
    expect(merged).toContain("[[A Paper I Added Myself]]");
    expect(merged).toContain("[[Second Paper]]");
  });

  it("never touches anything outside the citations block", () => {
    const withUserContent = `${base}\n\nMy own thoughts on this paper.\n`;
    const merged = mergeCitations(withUserContent, ["Some Paper"], []);
    expect(merged).toContain("My own thoughts on this paper.");
    // Everything up to the generated-section end marker is untouched too.
    const beforeCitations = base.slice(0, base.indexOf(GENERATED_END));
    expect(merged.startsWith(beforeCitations)).toBe(true);
  });

  it("returns the input unchanged when given no new links", () => {
    expect(mergeCitations(base, [], [])).toBe(base);
  });
});
