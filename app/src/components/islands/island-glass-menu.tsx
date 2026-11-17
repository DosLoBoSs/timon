'use client';

import type { ReactElement } from 'react';
import { Droplets } from 'lucide-react';
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { GLASS_TUNING_ENABLED, readGlassScope, type GlassScope } from '@/lib/glass-scope';
import { t } from '@/lib/i18n';

/**
 * The "Glass" submenu: where one island's frost sits, or `null` to follow the
 * Appearance setting. One component for every menu that offers it, so the
 * choices (and what `GLASS_TUNING_ENABLED` hides) never drift apart.
 */
export function IslandGlassSubmenu({ value, onChange }: {
  /** The island's own choice; `null` follows the Appearance setting. */
  value: GlassScope | null;
  onChange: (scope: GlassScope | null) => void;
}): ReactElement {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-island-menu="glass">
        <Droplets className="size-4" aria-hidden />
        {t('islands.glass.menu')}
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
