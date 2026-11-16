'use client';

/**
 * What the product's notice card shows at its head and in its corner: a brand
 * logo when the notice names one (`icon`), the tone's icon otherwise, and the
 * accent colour its pastille and corner gradient are mixed from.
 *
 * The logos are drawn from paths the app carries (simple-icons, CC0, in
 * `brand-icons.tsx`; the Timon mark from `brand-mark.ts`): a notice names one,
 * it never brings an image. A warning keeps the amber accent whatever its
 * logo, so urgency reads first.
 */

import type { ComponentType } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { DiscordIcon, GithubIcon, XIcon, YoutubeIcon } from '@/components/brand-icons';
import { TIMON_MARK } from '@/lib/brand-mark';
import type { Notice, NoticeIcon, NoticeTone } from '@/lib/notices';

type Glyph = ComponentType<{ className?: string }>;

export type NoticeVisual = {
  /** `github`, `discord`… or the tone (`info`, `warning`, `success`): a hook for tests and themes. */
  key: NoticeIcon | NoticeTone;
  Glyph: Glyph;
  /** A CSS colour: the pastille, the corner gradient. */
  accent: string;
  /** The glyph's own colour: a brand's, or the text colour for a black-and-white logo. */
  glyphColor: string;
  /** The Timon mark is wider than tall: it is sized by its width. */
  wide: boolean;
};

function TimonGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox={TIMON_MARK.viewBox} className={className} style={{ aspectRatio: TIMON_MARK.ratio }} aria-hidden>
      <path fill="currentColor" d={TIMON_MARK.d} />
    </svg>
  );
}

const PRIMARY = 'hsl(var(--primary))';
const FOREGROUND = 'hsl(var(--foreground))';
const AMBER = '#f59e0b';

const ICONS: Record<NoticeIcon, Omit<NoticeVisual, 'key'>> = {
  github: { Glyph: GithubIcon, accent: '#8957e5', glyphColor: FOREGROUND, wide: false },
  discord: { Glyph: DiscordIcon, accent: '#5865f2', glyphColor: '#5865f2', wide: false },
  timon: { Glyph: TimonGlyph, accent: PRIMARY, glyphColor: PRIMARY, wide: true },
  x: { Glyph: XIcon, accent: FOREGROUND, glyphColor: FOREGROUND, wide: false },
  youtube: { Glyph: YoutubeIcon, accent: '#ff0033', glyphColor: '#ff0033', wide: false },
};

const TONES: Record<NoticeTone, Omit<NoticeVisual, 'key'>> = {
  info: { Glyph: Info, accent: PRIMARY, glyphColor: PRIMARY, wide: false },
  warning: { Glyph: AlertTriangle, accent: AMBER, glyphColor: AMBER, wide: false },
  success: { Glyph: CheckCircle2, accent: '#10b981', glyphColor: '#10b981', wide: false },
};

export function noticeVisual(notice: Pick<Notice, 'icon' | 'tone'>): NoticeVisual {
  if (!notice.icon) return { key: notice.tone, ...TONES[notice.tone] };
  const brand = ICONS[notice.icon];
  return { key: notice.icon, ...brand, accent: notice.tone === 'warning' ? AMBER : brand.accent };
}
