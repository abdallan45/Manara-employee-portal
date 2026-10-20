'use client';

import { Smartphone } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n/context';
import { promptInstall, useInstallState, type InstallPlatform } from '@/lib/install-prompt';
import { cn } from '@/lib/utils';

function Steps({ title, steps }: { title: string; steps: readonly string[] }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ol className="text-muted-foreground list-decimal space-y-1.5 ps-5 text-sm leading-relaxed">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </section>
  );
}

function ManualSteps({ platform }: { platform: InstallPlatform }) {
  const { t } = useI18n();
  const m = t.install;
  if (platform === 'ios') {
    const safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
    return (
      <div className="space-y-3">
        <Steps title={m.iosTitle} steps={m.iosSteps} />
        {!safari && <p className="text-muted-foreground rounded-md bg-tint/[0.04] p-3 text-sm leading-relaxed">{m.iosOtherBrowser}</p>}
      </div>
    );
  }
  if (platform === 'android') return <Steps title={m.androidTitle} steps={m.androidSteps} />;
  return <Steps title={m.desktopTitle} steps={m.desktopSteps} />;
}

/**
 * "Install the app" in the side menu. Android and desktop Chrome/Edge show the browser's own install
 * dialog; iPhone has no such dialog, so the steps for "Add to Home Screen" are shown instead (also the
 * fallback when the browser has not offered its dialog). Hidden when already running as the app.
 */
export function InstallAppButton({ rail = false, className, onDone }: { rail?: boolean; className?: string; onDone?: () => void }) {
  const { t, dir } = useI18n();
  const { installed, canPrompt, platform } = useInstallState();
  const [stepsOpen, setStepsOpen] = useState(false);

  if (installed) return null;

  const onClick = async () => {
    if (canPrompt && (await promptInstall())) {
      onDone?.();
      return;
    }
    setStepsOpen(true);
  };

  const button = rail ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('text-muted-foreground', className)} onClick={() => void onClick()} aria-label={t.install.button}>
          <Smartphone aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={dir === 'rtl' ? 'left' : 'right'}>{t.install.button}</TooltipContent>
    </Tooltip>
  ) : (
    <Button variant="outline" className={cn('w-full justify-start gap-2', className)} onClick={() => void onClick()}>
      <Smartphone aria-hidden />
      {t.install.button}
    </Button>
  );

  return (
    <>
      {button}
      <Dialog open={stepsOpen} onOpenChange={setStepsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t.install.title}</DialogTitle>
            <DialogDescription>{t.install.description}</DialogDescription>
          </DialogHeader>
          <ManualSteps platform={platform} />
          <DialogFooter>
            <Button
              onClick={() => {
                setStepsOpen(false);
                onDone?.();
              }}
            >
              {t.install.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
