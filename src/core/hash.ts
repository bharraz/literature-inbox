/**
 * A fast, synchronous content hash for "has the user edited this note?".
 *
 * FNV-1a, not SHA-256, deliberately. Here the only question is "did these
 * bytes change", the adversary is an accidental keystroke rather than an
 * attacker, and staying synchronous avoids threading `await` through every
 * write path for no benefit. WebCrypto's digest is async-only.
 *
 * A collision would mean an edited note read as untouched and became eligible
 * for cleanup — which is why cleanup *also* requires the keep window to have
 * elapsed and, by default, moves to trash rather than deleting.
 */

export function contentHash(text: string): string {
  // 64-bit FNV-1a via two interleaved 32-bit lanes — plain 32-bit collides
  // far too readily across a few thousand notes.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
