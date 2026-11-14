'use client';

import dynamic from 'next/dynamic';
import { ProductModelPicker } from '@/components/model-picker';
import { ProductProviderCliCards } from '@/components/provider-cli/provider-cli-cards';
import { MODEL_PICKER_SLOT, PROVIDER_CLI_SLOT } from '@/lib/plugin-host/slots';
import { PROVIDER_SECTION_KEYS, PROVIDER_SECTION_ORDER, PROVIDER_SECTION_SLOT } from '@/components/provider-page/provider-sections';
import { COMMON_PROVIDER_SECTIONS } from './backends/provider-common-sections';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const ProvidersSettings = dynamic(() => import('./backends/providers-settings').then((m) => m.ProvidersSettings), { ssr: false });

export const coreBackendsClient: BundledClientPlugin = {
  module: '@timon/backends',
  apply(ctx) {
    // Own Settings category: the providers list, and the page of one provider (`provider=<id>`).
    ctx.register({ slot: 'settings.section' }, ProvidersSettings);
    // The common sections of a provider page, as defaults of `settings.provider.section` (a list
    // declared at boot): a provider plugin adds its own, or takes one's place by its key.
    for (const key of PROVIDER_SECTION_KEYS) {
      ctx.register({ slot: PROVIDER_SECTION_SLOT, key, order: PROVIDER_SECTION_ORDER[key], fallback: true }, COMMON_PROVIDER_SECTIONS[key]);
    }
    // Default occupant of `model.picker` (a boot slot): the selector of every
    // model field. A core module, so it is never switched off; a plugin that
    // takes the slot replaces it on every surface at once.
    ctx.register({ slot: MODEL_PICKER_SLOT, fallback: true }, ProductModelPicker);
    // Default occupant of `providers.cli` (a boot slot): the provider cards of the onboarding
    // and of Settings › AI models. A plugin that takes the slot replaces them on every screen.
    ctx.register({ slot: PROVIDER_CLI_SLOT, fallback: true }, ProductProviderCliCards);
  },
};
