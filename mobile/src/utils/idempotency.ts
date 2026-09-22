/**
 * Idempotency Key Generation for Stock Receipt Operations
 * 
 * Generates cryptographically strong, stable idempotency keys for exactly-once
 * semantics in stock receipt operations. Keys are designed to be:
 * - Unique across operations
 * - Stable during retries (same logical operation uses same key)
 * - Not derived from sensitive data
 * - Suitable for backend storage and validation
 */

// `Platform` is imported lazily inside `generateIdempotencyKey()` below rather than
// at module scope. `react-native`'s entrypoint uses Flow's `import typeof` syntax,
// which cannot be parsed outside a Metro/Babel pipeline (e.g. under Node's native
// TypeScript type-stripping used by the real-SQLite integration test). This is a
// load-time-only change: production behavior of `generateIdempotencyKey()` is
// identical, and `Platform.OS` is still read exactly where it was before.

/**
 * Generates a secure idempotency key for stock receipt operations.
 * 
 * Format: "mobile-stock-[timestamp]-[random]"
 * - mobile-stock: identifies this as a mobile stock operation
 * - timestamp: milliseconds for rough ordering (not for security)
 * - random: cryptographically strong random component
 * 
 * Key properties:
 * - Length: ~45 characters (well under 120 char backend limit)
 * - Uniqueness: crypto random + timestamp collision resistance
 * - Stability: once generated for an operation, remains stable for retries
 */
export function generateIdempotencyKey(): string {
  const timestamp = Date.now();

  // Lazy require, see the comment above the (removed) top-level import. Using
  // require() (not a dynamic import()) keeps this function synchronous, which
  // callers (including SQLiteOutboxStore.enqueue) depend on.
  //
  // In a plain Node.js test process, `require('react-native')` throws (its real
  // entrypoint uses Flow syntax Node cannot parse) and the catch below defaults
  // to 'ios'. That takes the exact same `require('crypto')` branch a real native
  // (non-web) device takes, so the real-SQLite integration test exercises the
  // same random-byte source as production on-device — it does not silently fall
  // back to the weaker Math.random path.
  let platformOS = 'ios';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    platformOS = (require('react-native') as { Platform: { OS: string } }).Platform.OS;
  } catch {
    // Non-React-Native environment (e.g. a Node test process). platformOS stays 'ios'.
  }

  // Generate cryptographically strong random component
  let randomComponent: string;
  
  if (platformOS === 'web' && typeof crypto !== 'undefined' && crypto.getRandomValues) {
    // Web platform - use crypto.getRandomValues
    const array = new Uint8Array(12);
    crypto.getRandomValues(array);
    randomComponent = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  } else if (typeof require !== 'undefined') {
    try {
      // React Native - try to use crypto module if available
      const crypto = require('crypto');
      randomComponent = crypto.randomBytes(12).toString('hex');
    } catch {
      // Fallback to Math.random (not cryptographically strong but functional)
      randomComponent = generateFallbackRandom(12);
    }
  } else {
    // Final fallback
    randomComponent = generateFallbackRandom(12);
  }
  
  return `mobile-stock-${timestamp}-${randomComponent}`;
}

/**
 * Fallback random generator using Math.random.
 * Not cryptographically strong but provides reasonable uniqueness.
 */
function generateFallbackRandom(bytes: number): string {
  let result = '';
  for (let i = 0; i < bytes; i++) {
    const randomByte = Math.floor(Math.random() * 256);
    result += randomByte.toString(16).padStart(2, '0');
  }
  return result;
}

/**
 * Validates an idempotency key format.
 * Used for defensive programming and testing.
 */
export function isValidIdempotencyKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > 120) return false;
  
  // Check our expected format
  const pattern = /^mobile-stock-\d+-[a-f0-9]+$/;
  return pattern.test(key);
}