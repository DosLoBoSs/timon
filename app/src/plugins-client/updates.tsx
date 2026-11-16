'use client';

import { UpdateNotice } from '@/components/updates/update-notice';
import { NOTICES_SLOT } from '@/lib/plugin-host/slots';
import { UPDATES_MODULE } from '@/lib/updates';
import type { BundledClientPlugin } from './types';

/**
 * Client half of `@timon/updates`: a newer version and the end of this build,
 * as a bottom-left notice card (a source of the `notices` slot). The
 * `updates.banner` slot is no longer painted (docs/SDK-COMPAT.md §115).
 */
export const updatesClient: BundledClientPlugin = {
  module: UPDATES_MODULE,
  apply(ctx) {
    ctx.register({ slot: NOTICES_SLOT, key: 'update' }, UpdateNotice);
  },
};
