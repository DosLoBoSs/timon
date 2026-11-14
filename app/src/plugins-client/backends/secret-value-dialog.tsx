'use client';

/**
 * The small dialog a provider page opens to take a secret: an API key, a
 * long-lived token. Write-only like the vault — the field starts empty, the
 * typed value leaves the dialog's state as soon as it closes, and nothing on
 * the page ever shows it back. The explanation a row cannot carry goes here,
 * in `description`, not on the page.
 */
import { useEffect, useId, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/lib/i18n';

export function SecretValueDialog({ open, onOpenChange, title, description, label, placeholder, submitLabel, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** The field's label (a vault entry name, "Token"). */
  label: string;
  placeholder?: string;
  submitLabel: string;
  /** Resolves once stored; a rejection keeps the dialog open with what was typed. */
  onSubmit: (value: string) => Promise<void>;
}): ReactElement {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  // Closed, by any way out: the value is forgotten.
  useEffect(() => { if (!open) setValue(''); }, [open]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      setValue('');
      onOpenChange(false);
    } catch {
      // The caller said why (a toast): the dialog stays for another try.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-w-md" data-secret-dialog>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle className="text-base">{title}</DialogTitle>
            {description ? <DialogDescription className="text-xs leading-relaxed">{description}</DialogDescription> : null}
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={id} className="text-xs">{label}</Label>
            <Input id={id} type="password" autoComplete="off" spellCheck={false} autoFocus className="h-9 text-[13px]"
              value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={busy || value.trim() === ''}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
