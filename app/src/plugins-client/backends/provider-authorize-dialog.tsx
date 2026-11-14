'use client';

/**
 * The confirmation a provider plugin's programs are allowed through: it names
 * every path the DAEMON resolved (never one typed here) and what the plugin
 * reads, and nothing is authorized before its confirm button. Shared by the
 * Providers settings and the Program section of a provider page.
 */
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { ConsentLines } from '@/components/provider-consent';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { authorizeProvider, pathsToAuthorize, type ProviderPlugin } from '@/lib/providers';
import { t } from '@/lib/i18n';

export function ProviderAuthorizeDialog({ provider, onClose, onAuthorized }: {
  /** The provider to review; `null` keeps the dialog closed. */
  provider: ProviderPlugin | null;
  onClose: () => void;
  /** After the daemon granted the paths: read the provider again. */
  onAuthorized: () => void | Promise<void>;
}): ReactElement {
  const [busy, setBusy] = useState(false);

  const authorize = async (target: ProviderPlugin): Promise<void> => {
    setBusy(true);
    try {
      await authorizeProvider(target.id, pathsToAuthorize(target.binaries));
      onClose();
      toast.success(t('providersSettings.plugins.authorized', { name: target.label }));
      await onAuthorized();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={provider !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        {provider && (
          <>
            <DialogHeader>
              <DialogTitle>{t('providersSettings.plugins.authorizeTitle', { name: provider.label })}</DialogTitle>
              <DialogDescription>{t('providersSettings.plugins.authorizeBody')}</DialogDescription>
            </DialogHeader>
            <ConsentLines binaries={pathsToAuthorize(provider.binaries)} osCredentials={provider.osCredentials ?? []} credentialDirs={provider.credentialDirs ?? []} />
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={onClose}>{t('providersSettings.cancel')}</Button>
              <Button disabled={busy} onClick={() => void authorize(provider)}>{t('providersSettings.plugins.authorizeConfirm')}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
