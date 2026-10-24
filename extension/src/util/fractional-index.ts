// Fractional indexing for bookmark/tab ordering (docs/protocol.md §8.2):
// `keyBetween(lo, hi)` returns a key k with lo < k < hi under plain string
// comparison, so concurrent inserts never require renumbering siblings.
// DIGITS must stay in UTF-16 code-unit order ('0'-'9' < 'A'-'Z' < 'a'-'z')
// so array index order agrees with JS string comparison.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

function digitIndex(c: string): number {
  const v = DIGITS.indexOf(c);
  if (v === -1) throw new Error(`invalid fractional-index character: ${c}`);
  return v;
}

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
      // Only reachable if lo === hi, which the precondition rules out.
      return prefix + START_KEY;
    }

    if (loDigit === -1) {
      // lo has ended, so any digit < hi's works. A key must never end in a
      // bare DIGITS[0]: it has no predecessor, so nothing could ever be
      // inserted before it. When halving would give 0, append START_KEY.
      if (hiDigit > 1) {
        return prefix + DIGITS[Math.floor(hiDigit / 2)];
      }
      if (hiDigit === 1) {
        return prefix + DIGITS[0] + START_KEY;
      }
      // hiDigit === 0: no room at this position, match it and go deeper.
      prefix += DIGITS[0];
      i += 1;
      continue;
    }

    if (hiDigit === -1) {
      // Unreachable given lo < hi; treated as unbounded above defensively.
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
      // Adjacent digits: fix loDigit here; everything after it is already
      // below hi, so continue against lo's remainder with no upper bound.
      prefix += DIGITS[loDigit];
      lo = lo!.slice(i + 1);
      hi = null;
      i = 0;
      continue;
    }

    prefix += DIGITS[loDigit];
    i += 1;
  }
}
