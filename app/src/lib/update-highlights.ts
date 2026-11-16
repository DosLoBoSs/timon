/**
 * The highlights that head the update window (docs/AUTO-UPDATE.md §10): the
 * maintainer writes 3 to 5 bullets under `### Highlights` in the version's
 * changelog section, and they reach the app inside the offer's notes, which
 * are plain text. Read back here as plain sentences, without the Markdown
 * marks a reader would otherwise see. No section: no highlights, and the
 * window shows the changelog link alone.
 */

export const HIGHLIGHTS_SHOWN = 5;
/** One highlight is a sentence; anything longer was not meant for the window. */
export const HIGHLIGHT_MAX = 200;

const HEADING = /^###\s+Highlights\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const BULLET = /^\s*[-*+]\s+(.*)$/;

/** Markdown marks off: links keep their text, emphasis and code their content. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=$|[^\w*])/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function bounded(text: string): string {
  return text.length <= HIGHLIGHT_MAX ? text : `${text.slice(0, HIGHLIGHT_MAX - 1).trimEnd()}…`;
}

/** The highlights of `notes`, at most `HIGHLIGHTS_SHOWN`, in their order. */
export function releaseHighlights(notes: string | null | undefined): string[] {
  const lines = String(notes ?? '').replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (ANY_HEADING.test(line)) break;
    const bullet = line.match(BULLET);
    if (bullet) {
      items.push(plain(bullet[1] ?? ''));
    } else if (items.length > 0 && /^\s+\S/.test(line)) {
      // A bullet wrapped on the next line, indented.
      items[items.length - 1] = plain(`${items[items.length - 1]} ${line}`);
    }
  }
  return items.filter((item) => item.length > 0).slice(0, HIGHLIGHTS_SHOWN).map(bounded);
}
