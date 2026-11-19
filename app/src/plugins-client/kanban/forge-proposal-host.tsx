'use client';

/**
 * Opens the "Publish on GitHub" dialog over any page when the address asks
 * for it (`?forge-proposal=<id>&forge-project=<slug>`): where the notification
 * card of a proposal leads, on this screen as in a push notification
 * (`lib/notification-href.ts`). Closing it takes the two parameters out of
 * the address and leaves the page as it was.
 *
 * The dialog is fetched on its first use, not with the layout every page loads.
 */

import type { ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const PublishDialog = dynamic(() => import('./publish-dialog').then((m) => m.PublishDialog), { ssr: false });

export const FORGE_PROPOSAL_PARAM = 'forge-proposal';
export const FORGE_PROJECT_PARAM = 'forge-project';

const ID = /^[0-9a-f-]{36}$/i;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

export function ForgeProposalDialogHost(): ReactElement | null {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const id = params.get(FORGE_PROPOSAL_PARAM);
  const project = params.get(FORGE_PROJECT_PARAM);
  if (!id || !project || !ID.test(id) || !SLUG.test(project)) return null;
  const close = () => {
    const next = new URLSearchParams(params.toString());
    next.delete(FORGE_PROPOSAL_PARAM);
    next.delete(FORGE_PROJECT_PARAM);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };
  return <PublishDialog key={`${project}:${id}`} project={project} proposalId={id} onClose={close} />;
}
