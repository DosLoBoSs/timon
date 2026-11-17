'use client';

import type { ReactElement } from 'react';
import { Droplets } from 'lucide-react';
import { useGlassScope } from '@/components/glass-scope';
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { GLASS_TUNING_ENABLED, readGlassScope, type GlassScope } from '@/lib/glass-scope';
import { t } from '@/lib/i18n';
import { usePageGlass } from './page-glass';

/**
 * The "Glass" submenu: where one island's frost sits, or `null` to follow the
 * Appearance setting. One component for every menu that offers it, so the
 * choices (and what `GLASS_TUNING_ENABLED` hides) never drift apart.
 */
export function IslandGlassSubmenu({ value, onChange, label, triggerClassName }: {
  /** The island's own choice; `null` follows the Appearance setting. */
  value: GlassScope | null;
  onChange: (scope: GlassScope | null) => void;
  /** Where "Glass" alone would not say whose (the top bar's Appearance menu). */
  label?: string;
  /** The host menu's own item look, for a trigger that sits among its items. */
  triggerClassName?: string;
}): ReactElement {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-island-menu="glass" className={triggerClassName}>
        <Droplets className="size-4" aria-hidden />
        {label ?? t('islands.glass.menu')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={value ?? 'follow'}
          onValueChange={(next) => { onChange(readGlassScope(next)); }}
        >
          <DropdownMenuRadioItem value="follow" data-island-glass="follow">{t('islands.glass.follow')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="island" data-island-glass="island">{t('islands.glass.island')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="widgets" data-island-glass="widgets">{t('islands.glass.widgets')}</DropdownMenuRadioItem>
          {GLASS_TUNING_ENABLED && <DropdownMenuRadioItem value="both" data-island-glass="both">{t('islands.glass.both')}</DropdownMenuRadioItem>}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * The same submenu for the page on screen, when no island header offers it:
 * the page alone, or alone under popups (TODO #806). Nothing while the glass
 * is off, or while the page has a header of its own.
 */
export function PageGlassSubmenu({ triggerClassName }: { triggerClassName?: string }): ReactElement | null {
  const page = usePageGlass();
  const glassOn = useGlassScope() !== null;
  if (!page || !glassOn) return null;
  return <IslandGlassSubmenu value={page.scope} onChange={page.set} label={t('islands.glass.page')} triggerClassName={triggerClassName} />;
}
