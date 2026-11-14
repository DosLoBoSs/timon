'use client';

/**
 * The 3D / 2D switch the onboarding paints above the mascot configurator
 * (through `LookStylerHost`'s `header`). It is the very preference of
 * Settings → Appearance → Mascot style (`mascotStylePref`): a choice made here
 * shows there, and the other way round, on every mascot of the account.
 *
 * Without WebGL2 the browser cannot draw the 3D head: the switch shows 2D,
 * cannot be changed, and says why. The stored choice is left as it is, so a
 * browser that can draw 3D later still finds it.
 */
import { useId, type ReactElement } from 'react';
import { MASCOT_STYLES, mascotStylePref, useMascotStyle, useWebGL2, type MascotStyle, type MascotStylePref } from '@/components/mascot/mascot-style-pref';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const LABEL_KEYS: Record<MascotStyle, string> = {
  '3d': 'appearance.mascotsStyle3d',
  '2d': 'appearance.mascotsStyle2d',
};

export function MascotStyleSwitch({ pref = mascotStylePref() }: { pref?: MascotStylePref }): ReactElement {
  const chosen = useMascotStyle(pref);
  const webgl2 = useWebGL2();
  const labelId = useId();
  const shown: MascotStyle = webgl2 ? chosen : '2d';
  const choose = (next: MascotStyle): void => {
    if (!webgl2 || next === chosen) return;
    void pref.set(next).then(async (ok) => {
      if (ok) return;
      // Loaded on failure only: the onboarding's steps stay free of the toaster
      // (and of the react-dom it pulls in) until there is something to say.
      const { toast } = await import('sonner');
      toast.error(t('appearance.saveError'));
    });
  };
  return (
    <div className="flex flex-col gap-1.5" data-mascot-style-switch="">
      <div className="flex items-center gap-3">
        <span id={labelId} className="text-xs font-semibold text-muted-foreground">{t('appearance.mascotsStyle')}</span>
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-disabled={!webgl2 || undefined}
          className="grid grid-cols-2 gap-1 rounded-xl bg-background/70 p-1"
        >
          {MASCOT_STYLES.map((option) => {
            const on = shown === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!webgl2}
                data-mascot-style={option}
                onClick={() => choose(option)}
                className={cn(
                  'h-8 min-w-[52px] rounded-lg px-3 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed',
                  on ? 'bg-muted ring-[1.5px] ring-inset ring-foreground/55' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent',
                )}
              >
                {t(LABEL_KEYS[option])}
              </button>
            );
          })}
        </div>
      </div>
      <p className="px-0.5 text-[11.5px] text-muted-foreground" data-mascot-style-note={webgl2 ? 'shared' : 'no-webgl'}>
        {t(webgl2 ? 'appearance.mascotsStyleShared' : 'appearance.mascotsStyleNoWebgl')}
      </p>
    </div>
  );
}
