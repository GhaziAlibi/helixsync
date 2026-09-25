// Fractional indexing for bookmark/tab ordering (docs/protocol.md §8.2):
// generates a string key strictly between two existing keys so concurrent
// inserts at the same location never require renumbering siblings.
//
// Keys are strings over `DIGITS`. The only contract that matters is: given
// lo < hi (or an open bound represented by null), `keyBetween` returns a
// key k with lo < k < hi under plain lexicographic string comparison.
// Ordered to match plain UTF-16 code-unit order ('0'-'9' < 'A'-'Z' < 'a'-'z'),
// since `keyBetween`'s correctness depends on array index order agreeing
// with JS string comparison (`<`/`>`) order.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

function digitIndex(c: string): number {
  const v = DIGITS.indexOf(c);
  if (v === -1) throw new Error(`invalid fractional-index character: ${c}`);
  return v;
}

/** First key ever generated (both bounds open). */
const START_KEY = DIGITS[Math.floor(BASE / 2)];

export function keyBetween(lo: string | null, hi: string | null): string {
  if (lo === null && hi === null) return START_KEY;
  if (lo !== null && hi !== null && lo >= hi) {
    throw new Error(`keyBetween requires lo < hi, got lo=${lo} hi=${hi}`);
  }

  let prefix = "";
  let i = 0;
  for (;;) {
    const loDigit = lo !== null && i < lo.length ? digitIndex(lo[i]) : -1;
    const hiDigit = hi !== null && i < hi.length ? digitIndex(hi[i]) : hi === null ? BASE : -1;

    if (loDigit === -1 && hiDigit === -1) {
      // Both bounds have ended exactly at this shared prefix (only
      // possible if lo === hi, which the precondition above rules out).
      return prefix + START_KEY;
    }

    if (loDigit === -1) {
      // lo has ended (prefix already satisfies "> lo"); pick a digit that
      // keeps us "< hi". DIGITS[0] is the alphabet's true floor and has no
      // predecessor, so a bare terminal DIGITS[0] would trap any *later*
      // attempt to insert before this key — never return one standalone.
      // Whenever the halved digit would be 0 (i.e. hiDigit === 1), still
      // pick 0 (0 < 1 already satisfies "< hi" at this position) but keep
      // going for one more digit so the key ends in a non-zero buffer
      // instead of a bare, unprependable 0.
      if (hiDigit > 1) {
        return prefix + DIGITS[Math.floor(hiDigit / 2)];
      }
      if (hiDigit === 1) {
        return prefix + DIGITS[0] + START_KEY;
      }
      // hiDigit === 0: no digit here is even <= hi's digit except 0 itself
      // (equality) — no room to be strictly less at this position, must
      // match and go deeper into hi's remaining digits.
      prefix += DIGITS[0];
      i += 1;
      continue;
    }

    if (hiDigit === -1) {
      // hi has ended — impossible while lo is still real given lo < hi,
      // but guard defensively by treating it as unbounded above.
      const chosen = loDigit + 1 < BASE ? Math.floor((loDigit + 1 + BASE) / 2) : loDigit;
      if (chosen > loDigit) return prefix + DIGITS[chosen];
      prefix += DIGITS[loDigit];
      i += 1;
      continue;
    }

    if (hiDigit - loDigit > 1) {
      const mid = loDigit + Math.floor((hiDigit - loDigit) / 2);
      return prefix + DIGITS[mid];
    }

    if (hiDigit - loDigit === 1) {
      // Adjacent digits: fix this digit to loDigit and recurse deeper,
      // now unbounded above (since anything after lo+loDigit... is > lo,
      // and lo+loDigit+anything < lo+hiDigit = hi's prefix bound).
      prefix += DIGITS[loDigit];
      lo = lo!.slice(i + 1);
      hi = null;
      i = 0;
      continue;
    }

    // hiDigit === loDigit: shared prefix digit, go deeper on both.
    prefix += DIGITS[loDigit];
    i += 1;
  }
}

/** Generate `n` evenly-ish spaced keys between lo and hi, e.g. for bulk
 * import of existing bookmarks preserving their order. */
export function keysBetween(lo: string | null, hi: string | null, n: number): string[] {
  if (n <= 0) return [];
  const keys: string[] = [];
  let currentLo = lo;
  for (let i = 0; i < n; i++) {
    // Split the remaining [currentLo, hi) range roughly evenly by
    // repeatedly bisecting toward hi.
    const key = keyBetween(currentLo, hi);
    keys.push(key);
    currentLo = key;
  }
  return keys;
}
