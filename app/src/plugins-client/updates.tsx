'use client';

import dynamic from 'next/dynamic';
import { ProductUpdateBanner } from '@/components/updates/update-banner';
import { UPDATES_BANNER_SLOT } from '@/lib/plugin-host/slots';
import { UPDATES_MODULE } from '@/lib/updates';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): only the settings dialog shows it.
const UpdatesSettings = dynamic(() => import('./updates/settings').then((m) => m.UpdatesSettings), { ssr: false });

/**
 * Client half of `@timon/updates`: the "new version" banner, as the default
 * occupant of its boot slot. A plugin's replacement keeps the slot; the host
 * (`UpdateBannerHost`, in the top bar) decides whether there is a version to show.
 * Its settings pane is filed under System › Updates (`settings-layout.ts`).
 */
export const updatesClient: BundledClientPlugin = {
  module: UPDATES_MODULE,
  apply(ctx) {
    ctx.register({ slot: UPDATES_BANNER_SLOT, fallback: true }, ProductUpdateBanner);
    ctx.register({ slot: 'settings.section' }, UpdatesSettings);
  },
};
