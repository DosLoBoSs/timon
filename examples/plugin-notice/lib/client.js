import React from 'react'
import { createTranslator, useNotice } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { welcome: 'Compact notices are on', docs: 'Read more', close: 'Close' },
  fr: { welcome: 'Les annonces compactes sont actives', docs: 'En savoir plus', close: 'Fermer' },
})

/**
 * A replacement of the notice card: one compact line per card instead of the
 * product's card with its icon and buttons.
 *
 * `notices.card` is a `single` slot declared at boot, whose default occupant
 * is the product's card (`fallback`). The host paints it once per visible
 * card, in the bottom-left stack it keeps (at most three, warnings first).
 *
 * The component receives no props: it reads `useNotice()`. What a
 * replacement must respect:
 *   - `title` and `body` are plain text: render them as text, never as HTML;
 *   - offer `dismiss()` only when `notice.dismissible` — closing is
 *     remembered for the account, on every client;
 *   - a click on `notice.actions[i]` calls `act(i)`, which runs its
 *     `onSelect`, opens its `href` and closes the card when it says `dismiss`.
 */
function CompactNotice() {
  const value = useNotice()
  if (!value) return null
  const { notice, dismiss, act } = value
  return React.createElement('div', { className: 'flex items-center gap-2 px-3 py-2 text-xs', 'data-compact-notice': notice.id },
    React.createElement('span', { className: 'min-w-0 flex-1 truncate font-medium' }, notice.title),
    notice.actions.map((action, index) => React.createElement('button', {
      key: index, type: 'button', className: 'underline', onClick: () => act(index), 'data-compact-action': index,
    }, action.label)),
    notice.dismissible
      ? React.createElement('button', { type: 'button', 'aria-label': t('close'), onClick: dismiss, 'data-compact-dismiss': '' }, '×')
      : null)
}

export function apply(ctx) {
  // A card pushed once, from `apply`: nothing to watch, so no `notices` entry is
  // needed. Closed, it stays closed for this account; it leaves with the plugin.
  ctx.notices.push({
    id: 'welcome',
    tone: 'success',
    title: t('welcome'),
    actions: [{ label: t('docs'), href: 'https://docs.timon-ai.com/plugins/slots' }],
  })
  return ctx.slots.register({ slot: 'notices.card' }, CompactNotice)
}
