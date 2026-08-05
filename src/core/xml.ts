/**
 * Tiny XML helpers over the platform `DOMParser`.
 *
 * No XML library in the bundle: Obsidian runs in Electron, which provides
 * DOMParser natively, and the test suite runs under jsdom for the same
 * reason. A shipped parser dependency would be pure weight.
 */

export class XmlParseError extends Error {}

/** Parse XML, throwing on malformed input rather than returning a document
 * whose only content is a `<parsererror>` element (DOMParser's quiet failure
 * mode, which otherwise surfaces much later as "the feed had no items"). */
export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const failure = doc.getElementsByTagName("parsererror")[0];
  if (failure) {
    throw new XmlParseError(failure.textContent?.trim() || "malformed XML");
  }
  return doc;
}

/** Trimmed text of the first matching child element, or undefined. */
export function childText(parent: Element, tagName: string): string | undefined {
  const found = parent.getElementsByTagName(tagName)[0];
  const text = found?.textContent?.trim();
  return text ? text : undefined;
}

/** Collapse the newlines and runs of spaces that Atom/RSS payloads wrap
 * titles and abstracts in — they'd otherwise land verbatim in a note. */
export function collapseWhitespace(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed : undefined;
}
