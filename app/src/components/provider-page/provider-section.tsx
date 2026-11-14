'use client';

import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The frame of one section of a provider page: a title, a line of help, and
 * its content on a raised surface. The common sections and a plugin's own use
 * it, so the page reads as one, whoever wrote each part.
 */
export function ProviderSection({ title, description, actions, children, className }: {
  title: string;
  description?: ReactNode;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <section className={cn('space-y-2', className)} aria-label={title}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h4 className="m-0 text-sm font-semibold">{title}</h4>
          {description ? <p className="m-0 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="rounded-lg bg-muted/40 p-4">{children}</div> : null}
    </section>
  );
}
