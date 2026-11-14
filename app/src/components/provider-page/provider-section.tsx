'use client';

import type { ReactElement, ReactNode } from 'react';
import { Info, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * The frame of one section of a provider page: a short label, then a card of
 * rows (`ProviderSettingRow`) on a surface raised above the page. The common
 * sections and a plugin's own use it, so the page reads as one, whoever wrote
 * each part.
 *
 * No paragraph under the label: what a section is for shows in its rows. A
 * `description` is kept for the plugins that pass one, folded behind an
 * information mark at the end of the label.
 */
export function ProviderSection({ title, description, actions, children, className }: {
  title: string;
  description?: ReactNode;
  /** Small controls at the right of the label (a discreet link). */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <section className={cn('space-y-2', className)} aria-label={title}>
      <div className="flex min-h-7 items-center gap-3">
        <h4 className="m-0 flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
          <span className="truncate">{title}</span>
          {description ? <SectionHelp description={description} /> : null}
        </h4>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="flex flex-col gap-0.5 rounded-xl bg-muted p-1">{children}</div> : null}
    </section>
  );
}

/** The section's help, out of the way: a hover title, and the words for a screen reader. */
function SectionHelp({ description }: { description: ReactNode }): ReactElement {
  return (
    <span className="inline-flex shrink-0 items-center" title={typeof description === 'string' ? description : undefined}>
      <Info aria-hidden className="size-3.5 text-muted-foreground/70" />
      <span className="sr-only">{description}</span>
    </span>
  );
}

/**
 * One row of a provider section's card: at the left a title and one line of
 * status or value, at the right ONE main action, the others in a "…" menu.
 * What a row unfolds after a gesture (sign-in steps, a form) goes in
 * `children`, under it, never in permanence.
 */
export function ProviderSettingRow({ title, status, leading, action, menu, menuLabel, children, className, ...data }: {
  title: ReactNode;
  /** One line under the title, muted: a state, a value. */
  status?: ReactNode;
  /** Before the title: a logo, an icon. */
  leading?: ReactNode;
  /** The row's main action: one button, a switch. */
  action?: ReactNode;
  /** The secondary actions, as `DropdownMenuItem`s: painted in the "…" menu. */
  menu?: ReactNode;
  /** The "…" button's accessible name; "More actions" by default. */
  menuLabel?: string;
  /** Unfolded under the row. */
  children?: ReactNode;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}): ReactElement {
  return (
    <div className={cn('rounded-lg px-3 py-2.5', className)} {...data}>
      <div className="flex min-w-0 items-center gap-3">
        {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] font-medium">{title}</div>
          {status ? <div className="min-w-0 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {action || menu ? (
          <div className="flex shrink-0 items-center gap-1">
            {action}
            {menu ? <ProviderSettingMenu label={menuLabel}>{menu}</ProviderSettingMenu> : null}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-3 space-y-3">{children}</div> : null}
    </div>
  );
}

/**
 * The "…" of a row. Non-modal: an item that opens a dialog would otherwise
 * leave the page unclickable while the menu closes (`menu-opens-dialog.test.ts`).
 */
export function ProviderSettingMenu({ label, children }: { label?: string; children: ReactNode }): ReactElement {
  const name = label ?? t('providerPage.more');
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label={name} title={name} data-row-menu>
          <MoreHorizontal aria-hidden className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
