/**
 * Core hash chain logic.
 *
 * SHA-256(prev_hash_bytes + record_bytes) forms the chain link.
 * Uses the Web Crypto API -- zero external dependencies.
 */

/**
 * Compute a SHA-256 chain link.
 *
 * Concatenates the UTF-8 bytes of `prevHash` with `recordBytes`,
 * then returns the hex-encoded SHA-256 digest.
 */
export async function computeHash(
  prevHash: string,
  recordBytes: Uint8Array
): Promise<string> {
  const encoder = new TextEncoder();
  const prevBytes = encoder.encode(prevHash);

  const combined = new Uint8Array(prevBytes.length + recordBytes.length);
  combined.set(prevBytes, 0);
  combined.set(recordBytes, prevBytes.length);

  const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
