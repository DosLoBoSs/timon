'use client';

import dynamic from 'next/dynamic';
import { FeedNotices } from '@/components/updates/feed-notices';
import { UpdateNotice } from '@/components/updates/update-notice';
import { ProductUpdateDialog } from '@/components/updates/update-dialog';
import { NOTICES_SLOT, UPDATE_DIALOG_SLOT } from '@/lib/plugin-host/slots';
import { UPDATES_MODULE } from '@/lib/updates';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): only the settings dialog shows it.
const UpdatesSettings = dynamic(() => import('./updates/settings').then((m) => m.UpdatesSettings), { ssr: false });

/**
 * Client half of `@timon/updates`: a newer version and the end of this build,
 * as a bottom-left notice card (a source of the `notices` slot), plus the
 * announcements of the signed notice feed. "Update" opens the update window,
 * whose product's version is the default occupant of `updates.dialog`. The
 * `updates.banner` slot is no longer painted (docs/SDK-COMPAT.md §115). Its
 * settings pane is filed under System › Updates (`settings-layout.ts`).
 */
export const updatesClient: BundledClientPlugin = {
  module: UPDATES_MODULE,
  apply(ctx) {
    ctx.register({ slot: 'settings.section' }, UpdatesSettings);
    ctx.register({ slot: NOTICES_SLOT, key: 'update' }, UpdateNotice);
    ctx.register({ slot: NOTICES_SLOT, key: 'feed' }, FeedNotices);
    // Not loaded on demand: the card's source already imports it, for the empty slot.
    ctx.register({ slot: UPDATE_DIALOG_SLOT, fallback: true }, ProductUpdateDialog);
  },
};
