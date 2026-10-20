// Client-side matching for the command palette and the settings search (Arabic and Latin).

/** Tashkeel (harakat, tanween, shadda, sukun, dagger alef, Quranic marks) and tatweel. */
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/**
 * Folds text for matching: lowercase, strips tashkeel and tatweel, maps أ إ آ ٱ -> ا, ة -> ه, ى -> ي,
 * Arabic-Indic digits -> 0-9, and collapses whitespace. "إجازة" and "اجازه" fold to the same string.
 */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFC')
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(ARABIC_INDIC, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/[\s ​-‏]+/g, ' ')
    .trim();
}

/**
 * Synonym groups: a query that matches one term (as a word prefix) also searches for the others, so
 * "vacation" or "اجازه" find "Leave types", and "gps" finds "Office locations".
 */
export const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['leave', 'اجازة', 'إجازة', 'اجازات', 'vacation', 'holiday', 'time off'],
  ['holidays', 'عطل', 'عطلة رسمية', 'العطل', 'public holiday'],
  ['offices', 'office location', 'location', 'gps', 'موقع', 'موقع المكتب', 'مكاتب', 'check-in rules'],
  ['schedule', 'دوام', 'shift', 'وردية', 'working hours'],
  ['overtime', 'اضافي', 'إضافي', 'extra time'],
];

const FOLDED_GROUPS = ALIAS_GROUPS.map((group) => group.map(normalize));

const words = (text: string) => text.split(/[\s\-–—_/·,.()«»“”"'&›]+/).filter(Boolean);

/** True when `q` starts some word of `text`, or `text` contains the multi-word `q` at a word start. */
function wordPrefix(text: string, q: string): boolean {
  if (q.includes(' ')) return text.startsWith(q) || text.includes(` ${q}`);
  return words(text).some((w) => w.startsWith(q));
}

/** The query plus the other terms of every alias group it belongs to (all folded). */
export function expandQuery(query: string): string[] {
  const q = normalize(query);
  if (!q) return [];
  const out = new Set<string>([q]);
  // One or two letters would pull in half the alias table, so short queries only expand on an exact term.
  const partial = q.length >= 3;
  for (const group of FOLDED_GROUPS) {
    if (group.some((term) => term === q || (partial && (wordPrefix(term, q) || wordPrefix(q, term))))) {
      for (const term of group) out.add(term);
    }
  }
  return [...out];
}

function scoreText(text: string, q: string): number {
  if (!text || !q) return 0;
  if (text === q) return 100;
  if (text.startsWith(q)) return 80;
  if (wordPrefix(text, q)) return 60;
  // A single letter inside a word matches almost everything; only word starts count for it.
  if (q.length > 1 && text.includes(q)) return 40;
  // Every word of a multi-word query starts some word of the text ("leave bulk" -> "Leave entitlements (bulk)").
  const parts = q.split(' ');
  if (parts.length > 1 && parts.every((p) => wordPrefix(text, p))) return 30;
  return 0;
}

/**
 * Relevance of an entry for `query` (0 = no match). `primary` are the visible labels in any language
 * (weighted fully); `secondary` are descriptions and keywords (weighted lower). Matches found only via
 * an alias count a little less than direct ones.
 */
export function score(query: string, primary: readonly string[], secondary: readonly string[] = []): number {
  const expanded = expandQuery(query);
  if (expanded.length === 0) return 0;
  const [direct] = expanded;
  const prim = primary.map(normalize).filter(Boolean);
  const sec = secondary.map(normalize).filter(Boolean);
  let best = 0;
  for (const q of expanded) {
    const factor = q === direct ? 1 : 0.85;
    for (const text of prim) best = Math.max(best, scoreText(text, q) * factor);
    for (const text of sec) best = Math.max(best, scoreText(text, q) * 0.6 * factor);
  }
  return best;
}
