import React from 'react'
import { Button, createTranslator, formatBytes, formatPercent, useUpdateDialog } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { title: 'Timon {version}', changelog: 'Changelog', progress: '{percent} of {total}' },
  fr: { title: 'Timon {version}', changelog: 'Changelog', progress: '{percent} sur {total}' },
})

/**
 * A replacement of the update window: the version, its highlights on one
 * line each, the download as a percentage, and the gestures in one row.
 *
 * `updates.dialog` is a `single` slot declared at boot, whose default
 * occupant is the product's window (`fallback`). The update card and
 * Settings › System › Updates open it; removing the plugin gives the
 * product's window back.
 *
 * The component receives no props: it reads `useUpdateDialog()`. The host
 * keeps the dialog (named "Timon <version>", focus, Escape) and runs the
 * update flow; the occupant only paints. What a replacement must respect:
 *   - no `DialogTitle`: the host already names the dialog;
 *   - `highlights` are plain text, possibly none: show `notesUrl` anyway;
 *   - paint `actions` as given and call `run()` — or open `href` — on a
 *     click: at the `missions` step they are "Install anyway" and "Wait",
 *     and running missions stop only on the first.
 */
function CompactUpdateWindow() {
  const value = useUpdateDialog()
  if (!value) return null
  const { download } = value
  const progress = download && download.phase === 'downloading' && download.total > 0
    ? t('progress', { percent: formatPercent(download.received / download.total), total: formatBytes(download.total) })
    : null
  return React.createElement('div', { className: 'flex flex-col gap-3 text-sm', 'data-compact-update': value.step },
    React.createElement('p', { 'aria-hidden': true, className: 'm-0 text-base font-semibold' }, t('title', { version: value.version })),
    value.highlights.map((item, index) => React.createElement('p', { key: index, className: 'm-0' }, item)),
    React.createElement('a', { href: value.notesUrl, target: '_blank', rel: 'noopener noreferrer', className: 'text-primary' }, t('changelog')),
    progress || value.line ? React.createElement('p', { className: 'm-0 tabular-nums text-muted-foreground' }, progress || value.line) : null,
    React.createElement('div', { className: 'flex flex-wrap gap-2' },
      value.actions.map((action, index) => action.href
        ? React.createElement('a', { key: action.marker, href: action.href, target: '_blank', rel: 'noopener noreferrer', className: 'text-primary' }, action.label)
        : React.createElement(Button, { key: action.marker, size: 'sm', variant: index === 0 ? 'default' : 'ghost', onClick: action.run }, action.label))))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'updates.dialog' }, CompactUpdateWindow)
}
