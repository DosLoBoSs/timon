'use client';

/**
 * The common sections of a provider page, as the default entries of
 * `settings.provider.section` (`components/provider-page/provider-sections.ts`).
 *
 * Some still paint nothing: each is filled by the step of the providers
 * redesign that brings its content (Connection and API key, own settings and
 * Models). Registered already so the page's order, and a plugin's way of
 * taking the place of one of them, are fixed before their content lands.
 */
import type { ComponentType } from 'react';
import type { ProviderSectionKey } from '@/components/provider-page/provider-sections';
import { ProgramSection } from './program-section';

const Empty: ComponentType = () => null;

export const COMMON_PROVIDER_SECTIONS: Readonly<Record<ProviderSectionKey, ComponentType>> = {
  connection: Empty,
  apiKey: Empty,
  program: ProgramSection,
  settings: Empty,
  models: Empty,
};
