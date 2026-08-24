/**
 * Filename sanitization and collision resolution — docs/interop-spec.md §5.3.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LENGTH,
  FilenameAllocator,
  baseNameFor,
  sanitizeFilename,
} from "../src/core/filenames";
import { emptyWork } from "../src/core/types";

describe("sanitizeFilename parity", () => {
  it("uses the same max length", () => {
    expect(DEFAULT_MAX_LENGTH).toBe(150);
  });

  it("replaces every illegal character with a space", () => {
    expect(sanitizeFilename('A:B/C*D?E<F>G"H|I\\J')).toBe("A B C D E F G H I J");
  });

  it("leaves legal punctuation alone", () => {
    // Regression: an over-broad character class would eat spaces and hyphens,
    // which are legal and extremely common in real titles.
    expect(sanitizeFilename("State-of-the-Art Deep Learning")).toBe(
      "State-of-the-Art Deep Learning",
    );
  });

  it("strips control characters", () => {
    expect(sanitizeFilename("a\u0000b\u001fc")).toBe("a b c");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeFilename("  collapsed   spaces  ")).toBe("collapsed spaces");
  });

  it("strips trailing dots", () => {
    expect(sanitizeFilename("trailing dots...")).toBe("trailing dots");
  });

  it("falls back to Untitled for empty input", () => {
    expect(sanitizeFilename("")).toBe("Untitled");
    expect(sanitizeFilename("   ")).toBe("Untitled");
  });

  it("escapes Windows reserved device names", () => {
    expect(sanitizeFilename("CON")).toBe("_CON");
    expect(sanitizeFilename("com1")).toBe("_com1");
  });

  it("truncates to the max length", () => {
    expect(sanitizeFilename("x".repeat(500))).toHaveLength(DEFAULT_MAX_LENGTH);
  });
});

describe("baseNameFor fallback chain", () => {
  it("prefers the title", () => {
    const work = emptyWork("K");
    work.title = "Attention Is All You Need";
    expect(baseNameFor(work)).toBe("Attention Is All You Need");
  });

  it("falls back to author and year", () => {
    const work = emptyWork("K");
    work.authors = [{ firstName: "Ashish", lastName: "Vaswani" }];
    work.date = "2017-06-12";
    expect(baseNameFor(work)).toBe("Vaswani 2017");
  });

  it("uses n.d. when there is no year", () => {
    const work = emptyWork("K");
    work.authors = [{ lastName: "Vaswani" }];
    expect(baseNameFor(work)).toBe("Vaswani n.d.");
  });

  it("falls back to the key when there is nothing else", () => {
    expect(baseNameFor(emptyWork("KEY123"))).toBe("KEY123");
  });
});

describe("collision resolution parity", () => {
  it("resolves in the documented order", () => {
    const allocator = new FilenameAllocator();
    expect(allocator.allocateName("Same Title", "K1").filename).toBe("Same Title");

    const second = allocator.allocateName("Same Title", "K2", "2020");
    expect(second.filename).toBe("Same Title (2020)");
    expect(second.collidedWith).toBe("K1");

    expect(allocator.allocateName("Same Title", "K3").filename).toBe("Same Title (K3)");
    expect(allocator.allocateName("Same Title", "K3").filename).toBe("Same Title (K3-2)");
  });

  it("matches case-insensitively, like the filesystems it targets", () => {
    const allocator = new FilenameAllocator();
    allocator.allocateName("Same Title", "K1");
    expect(allocator.allocateName("SAME TITLE", "K2").collidedWith).toBe("K1");
  });

  it("honours reserved names so inbox notes never collide with Papers/", () => {
    const allocator = new FilenameAllocator();
    allocator.reserve("Attention Is All You Need");
    const result = allocator.allocateName("Attention Is All You Need", "W1", "2017");
    expect(result.filename).toBe("Attention Is All You Need (2017)");
    expect(result.collidedWith).toBe("reserved");
  });
});
