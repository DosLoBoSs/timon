import React from 'react'
import { createTranslator, useProviderPage, ProviderSection } from '@timon/ui'

const h = React.createElement

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: {
    title: 'Acme Gateway',
    description: 'Missions reach the gateway at {url}. Your key stays in the plugin settings.',
    models: '{count, plural, one {# model offered} other {# models offered}}',
    console: 'Open the Acme console',
    refresh: 'Check again',
  },
  fr: {
    title: 'Acme Gateway',
    description: 'Les missions joignent la passerelle à {url}. Votre clé reste dans les réglages du plugin.',
    models: '{count, plural, one {# modèle proposé} other {# modèles proposés}}',
    console: 'Ouvrir la console Acme',
    refresh: 'Vérifier à nouveau',
  },
})

const GATEWAY = 'https://gateway.example.com/v1'
const CONSOLE = 'https://console.example.com'

/**
 * The section this provider adds to its own page in Settings › AI models ›
 * Providers.
 *
 * `settings.provider.section` is a list slot declared at boot. The page paints
 * the product's common sections (Connection, API key, Program, own settings,
 * Models) and, on the page of a provider this plugin brings, the sections this
 * plugin registered — never on another provider's page.
 *
 * The component receives no props: it reads `useProviderPage()`, the provider
 * on screen as the daemon describes it. Registered with `key: 'settings'`, it
 * takes the place of the common "own settings" section on this provider's page;
 * without a key it would be added after Models, or where `order` puts it (the
 * common sections are 100, 200, 300, 400 and 500).
 *
 * What a section must respect:
 *   - render nothing when it has nothing to say (`return null`): the page
 *     leaves no gap for it;
 *   - after a change it made itself, call `refresh()` so the header and the
 *     other sections read the provider again;
 *   - never show a secret: the provider record holds vault entry names only.
 */
function AcmeGatewaySection() {
  const page = useProviderPage()
  if (!page) return null
  const { provider, refresh } = page
  return h(ProviderSection, {
    title: t('title'),
    description: t('description', { url: GATEWAY }),
    actions: h('button', {
      type: 'button',
      onClick: () => void refresh(),
      className: 'rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground',
    }, t('refresh')),
  },
  h('div', { className: 'flex items-center justify-between gap-3 text-[13px]' },
    h('span', { className: 'tabular-nums' }, t('models', { count: provider.modelCount })),
    h('a', { href: CONSOLE, target: '_blank', rel: 'noreferrer', className: 'text-primary hover:underline' }, t('console'))))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'settings.provider.section', key: 'settings', order: 400 }, AcmeGatewaySection)
}
