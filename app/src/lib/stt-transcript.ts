/**
 * Rebuilds the dictated text from the results of the Web Speech API.
 *
 * The API contract is not honoured the same way everywhere. Desktop Chrome
 * delivers DISJOINT segments and moves `resultIndex` forward; several Android
 * engines (and the PWA of 24/08) instead re-emit, on every event, the WHOLE
 * current sentence — sometimes marked `isFinal` — from index 0. A plain
 * `buffer += transcript` then produces nested copies:
 *
 *   "ok / ok I / ok I am / … / ok I am doing a new voice test"
 *
 * sent as is to the agent, which receives the same sentence thirteen times.
 *
 * Hence this merge: the segments are REBUILT on every event from
 * `event.results`, never accumulated, and a segment that extends what precedes
 * replaces it instead of being appended. Both engine behaviours give the same
 * final text, each word once.
 */

/** Comparison ignoring case, accents and punctuation: an engine adds
 *  punctuation and capitals as it goes, "ok I" then "OK, I am" are indeed the
 *  same sentence start. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Number of words shared by the end of `avant` and the start of `apres`. */
function overlap(before: string[], after: string[]): number {
  const max = Math.min(before.length, after.length);
  for (let k = max; k >= 2; k -= 1) {
    let equal = true;
    for (let i = 0; i < k; i += 1) {
      if (before[before.length - k + i] !== after[i]) {
        equal = false;
        break;
      }
    }
    if (equal) return k;
  }
  return 0;
}

/**
 * Joins transcription segments into a text where each word appears only once.
 * Empty entries are ignored; the order is kept.
 */
export function mergeSegments(segments: Array<string | null | undefined>): string {
  let out = '';
  let normalized = '';

  for (const raw of segments) {
    const seg = (raw ?? '').trim();
    if (!seg) continue;
    const n = normalize(seg);
    if (!n) continue;

    if (!normalized) {
      out = seg;
      normalized = n;
      continue;
    }
    // Rewrite: the engine delivers again everything it already said, longer.
    if (n.startsWith(normalized)) {
      out = seg;
      normalized = n;
      continue;
    }
    // Segment already fully transcribed (identical redelivery).
    if (normalized.endsWith(n)) continue;

    // Partial overlap: append only the new tail.
    const wordsA = normalized.split(' ');
    const wordsB = n.split(' ');
    const k = overlap(wordsA, wordsB);
    if (k > 0) {
      const fresh = seg.trim().split(/\s+/).slice(k).join(' ');
      if (!fresh) continue;
      out = `${out} ${fresh}`;
      normalized = `${normalized} ${wordsB.slice(k).join(' ')}`;
      continue;
    }

    out = `${out} ${seg}`;
    normalized = `${normalized} ${n}`;
  }

  return out;
}

type RawResult = { 0: { transcript: string }; isFinal: boolean };

/**
 * Reads ALL of `results` (never from `resultIndex`: the engines that rewrite
 * the sentence leave it at 0 and the rest would be lost) and returns the final
 * and the interim text of the current session.
 */
export function readResults(results: ArrayLike<RawResult>): {
  final: string;
  interim: string;
} {
  const finals: string[] = [];
  const interims: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (!r) continue;
    const t = r[0]?.transcript ?? '';
    if (!t.trim()) continue;
    (r.isFinal ? finals : interims).push(t);
  }
  return { final: mergeSegments(finals), interim: mergeSegments(interims) };
}
