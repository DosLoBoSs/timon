'use client';

/**
 * The common sections of a provider page, as the default entries of
 * `settings.provider.section` (`components/provider-page/provider-sections.ts`).
 *
 * Empty for now: each paints nothing until the step of the providers redesign
 * that fills it (Connection and API key, Program, own settings and Models).
 * Registered already so the page's order, and a plugin's way of taking the
 * place of one of them, are fixed before their content lands.
 */
import type { ComponentType } from 'react';
import type { ProviderSectionKey } from '@/components/provider-page/provider-sections';

const Empty: ComponentType = () => null;

export const COMMON_PROVIDER_SECTIONS: Readonly<Record<ProviderSectionKey, ComponentType>> = {
  connection: Empty,
  apiKey: Empty,
  program: Empty,
  settings: Empty,
  models: Empty,
};
