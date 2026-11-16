'use client';

import { FeedNotices } from '@/components/updates/feed-notices';
import { ProductUpdateBanner } from '@/components/updates/update-banner';
import { NOTICES_SLOT, UPDATES_BANNER_SLOT } from '@/lib/plugin-host/slots';
import { UPDATES_MODULE } from '@/lib/updates';
import type { BundledClientPlugin } from './types';

/**
 * Client half of `@timon/updates`: the "new version" banner, as the default
 * occupant of its boot slot. A plugin's replacement keeps the slot; the host
 * (`UpdateBannerHost`, in the top bar) decides whether there is a version to show.
 * And the announcements of the signed notice feed, as a source of the
 * bottom-left notice cards.
 */
export const updatesClient: BundledClientPlugin = {
  module: UPDATES_MODULE,
  apply(ctx) {
    ctx.register({ slot: UPDATES_BANNER_SLOT, fallback: true }, ProductUpdateBanner);
    ctx.register({ slot: NOTICES_SLOT, key: 'feed' }, FeedNotices);
  },
};
