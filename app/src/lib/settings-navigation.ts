'use client';

/**
 * Settings is a dialog over whatever page is on screen, addressed by the
 * `?settings=<category>[/<tab>]` query parameter. The page underneath keeps
 * its own parameters (a chat's `?mission=`…), which is why every move starts
 * from the live URL instead of rebuilding one from the pathname.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { formatSettingsParam, type SettingsAccountView, type SettingsTarget } from './settings-layout';
import { ADD_PROVIDER_PARAM, PROVIDER_PARAM, type AddProviderChoice } from './providers';

export const SETTINGS_PARAM = 'settings';

/** The tab that lists the providers and opens the page of one (`provider=<id>`). */
export const PROVIDERS_TARGET: SettingsTarget = { category: 'models', tab: 'backends' };

const DEFAULT_TARGET: SettingsTarget = { category: 'interface', tab: null };

function currentUrl(): URL {
  return new URL(window.location.href);
}

function relative(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Href of the page on screen with the dialog opened on `target`. The page of
 * one provider belongs to the providers tab: any move of the dialog leaves it.
 */
export function settingsHref(target: SettingsTarget = DEFAULT_TARGET): string {
  const url = currentUrl();
  url.searchParams.set(SETTINGS_PARAM, formatSettingsParam(target));
  url.searchParams.delete(PROVIDER_PARAM);
  url.searchParams.delete(ADD_PROVIDER_PARAM);
  return relative(url);
}

/** Href of the page of one provider, over the page on screen (`docs/PLUGINS.md`, `settings.provider.section`). */
export function providerPageHref(id: string): string {
  const url = currentUrl();
  url.searchParams.set(SETTINGS_PARAM, formatSettingsParam(PROVIDERS_TARGET));
  url.searchParams.set(PROVIDER_PARAM, id);
  url.searchParams.delete(ADD_PROVIDER_PARAM);
  return relative(url);
}

/** Href of the "Add a provider" page, on the way chosen or before a choice. */
export function addProviderHref(choice: AddProviderChoice | null): string {
  const url = currentUrl();
  url.searchParams.set(SETTINGS_PARAM, formatSettingsParam(PROVIDERS_TARGET));
  url.searchParams.delete(PROVIDER_PARAM);
  url.searchParams.set(ADD_PROVIDER_PARAM, choice ?? '');
  return relative(url);
}

/** The providers list again, the dialog left where it is. */
export function providersListHref(): string {
  const url = currentUrl();
  url.searchParams.delete(PROVIDER_PARAM);
  url.searchParams.delete(ADD_PROVIDER_PARAM);
  return relative(url);
}

/**
 * Opens the dialog on `target` from where no router is at hand (a toast, a
 * surface rendered outside the app router): Next keeps `useSearchParams` in
 * step with `history.pushState`, which is what the dialog reads.
 */
export function openSettingsFromAnywhere(target: SettingsTarget = DEFAULT_TARGET): void {
  if (typeof window === 'undefined') return;
  window.history.pushState(window.history.state, '', settingsHref(target));
}

export function useSettingsNavigation(): {
  open: (target?: SettingsTarget) => void;
  select: (target: SettingsTarget) => void;
  selectAccount: (view: SettingsAccountView) => void;
  close: () => void;
} {
  const router = useRouter();
  // Opening pushes, so Back closes the dialog; switching tabs replaces, so
  // Back does not replay every tab visited.
  const open = useCallback((target: SettingsTarget = DEFAULT_TARGET) => {
    router.push(settingsHref(target), { scroll: false });
  }, [router]);
  const select = useCallback((target: SettingsTarget) => {
    router.replace(settingsHref(target), { scroll: false });
  }, [router]);
  const selectAccount = useCallback((view: SettingsAccountView) => {
    const url = currentUrl();
    url.searchParams.set(SETTINGS_PARAM, view);
    url.searchParams.delete(PROVIDER_PARAM);
    url.searchParams.delete(ADD_PROVIDER_PARAM);
    router.replace(relative(url), { scroll: false });
  }, [router]);
  const close = useCallback(() => {
    const url = currentUrl();
    url.searchParams.delete(SETTINGS_PARAM);
    url.searchParams.delete(PROVIDER_PARAM);
    url.searchParams.delete(ADD_PROVIDER_PARAM);
    router.replace(relative(url), { scroll: false });
  }, [router]);
  return { open, select, selectAccount, close };
}

/**
 * List ↔ page of one provider, and list ↔ "Add a provider". Opening pushes,
 * so Back returns to the list; the breadcrumb's way back replaces, like a tab
 * switch, and so do `show`, which only rewrites the address of the page on
 * screen, and `choose`, which switches the way of adding.
 */
export function useProviderNavigation(): {
  open: (id: string) => void;
  show: (id: string) => void;
  back: () => void;
  add: () => void;
  choose: (choice: AddProviderChoice | null) => void;
} {
  const router = useRouter();
  const open = useCallback((id: string) => {
    router.push(providerPageHref(id), { scroll: false });
  }, [router]);
  const show = useCallback((id: string) => {
    router.replace(providerPageHref(id), { scroll: false });
  }, [router]);
  const back = useCallback(() => {
    router.replace(providersListHref(), { scroll: false });
  }, [router]);
  const add = useCallback(() => {
    router.push(addProviderHref(null), { scroll: false });
  }, [router]);
  const choose = useCallback((choice: AddProviderChoice | null) => {
    router.replace(addProviderHref(choice), { scroll: false });
  }, [router]);
  return { open, show, back, add, choose };
}
