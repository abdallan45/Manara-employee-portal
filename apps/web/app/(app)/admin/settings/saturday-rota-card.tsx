'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { isSaturdayDate, saturdaysFrom, saturdayWorkingGroup, type SettingDto } from '@workforce/shared';

import { FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatWeekday, formatWorkDate, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';

const KEY = 'attendance.saturdayRotaStart';
const PREVIEW_COUNT = 6;

/** Start date of the alternating-Saturday rota (group A's first working Saturday) and the next Saturdays. */
export function SaturdayRotaCard({ setting, onSaved }: { setting: SettingDto | undefined; onSaved: (saved: SettingDto[]) => void }) {
  const { t, locale, errorMessage } = useI18n();
  const r = t.saturdayRota;
  const saved = typeof setting?.value === 'string' ? setting.value : null;
  const [start, setStart] = useState(saved ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (value: string | null) => {
    setSaving(true);
    try {
      const row = await api<SettingDto>(`/settings/${encodeURIComponent(KEY)}`, { method: 'PATCH', body: { value } });
      toast.success(value ? r.saved : r.turnedOff);
      onSaved([row]);
      if (!value) setStart('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = start.trim();
    if (value && !isSaturdayDate(value)) {
      setError(r.startInvalid);
      document.getElementById('rota-start')?.focus();
      return;
    }
    setError(null);
    void save(value || null);
  };

  const today = todayInAmman();
  const preview = saved ? saturdaysFrom(today, PREVIEW_COUNT) : [];
  const group = (g: 'A' | 'B') => r.groupNames[g];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1 text-base">
          {r.title}
          <HelpTip text={r.help} />
        </CardTitle>
        <p className="sr-only">{r.help}</p>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={onSubmit} noValidate className="grid content-start gap-4">
          <FormField id="rota-start" label={r.startDate} hint={r.startHint} error={error ?? undefined} announceError>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="date"
                dir="ltr"
                className="w-44"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="min-h-10 md:min-h-8" disabled={saving || start === (saved ?? '')}>
              {saving && <Loader2 className="animate-spin" aria-hidden />}
              {r.save}
            </Button>
            {saved && (
              <Button type="button" variant="outline" size="sm" className="min-h-10 md:min-h-8" disabled={saving} onClick={() => void save(null)}>
                {r.turnOff}
              </Button>
            )}
          </div>
        </form>

        <div className="grid content-start gap-2">
          <p className="text-sm font-medium">{r.preview}</p>
          {!saved ? (
            <p className="text-muted-foreground text-sm">{r.isOff}</p>
          ) : (
            <ul className="divide-tint/10 divide-y rounded-xl border border-tint/10">
              {preview.map((d) => {
                const g = saturdayWorkingGroup(d, saved);
                return (
                  <li key={d} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="min-w-36">
                      <span className="text-muted-foreground">{formatWeekday(d, locale)}</span>{' '}
                      <span className="tabular">{formatWorkDate(d, locale)}</span>
                    </span>
                    {g ? (
                      <Badge variant={g === 'A' ? 'default' : 'outline'} className="ms-auto">{fmt(r.groupWorks, { group: group(g) })}</Badge>
                    ) : (
                      <span className="text-muted-foreground ms-auto text-xs">{r.beforeStart}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
