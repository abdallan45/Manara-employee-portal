'use client';

import { useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { addDays, daysBetween, endOfMonth, startOfMonth, todayInAmman } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';

export interface DateRange {
  from: string;
  to: string;
}

export const MAX_RANGE_DAYS = 62;

export function currentMonthRange(): DateRange {
  const today = todayInAmman();
  return { from: startOfMonth(today), to: endOfMonth(today) };
}

export function validateRange(range: DateRange, maxDays: number | null = MAX_RANGE_DAYS): 'invalid' | 'tooLong' | null {
  if (!range.from || !range.to || range.from > range.to) return 'invalid';
  if (maxDays !== null && daysBetween(range.from, range.to) > maxDays) return 'tooLong';
  return null;
}

export type DateRangePreset = 'thisMonth' | 'lastMonth' | 'last30';
export const DATE_RANGE_PRESETS: readonly DateRangePreset[] = ['thisMonth', 'lastMonth', 'last30'];

/** The range a preset stands for, in Amman dates. 'last30' = the 30 days ending today. */
export function presetRange(preset: DateRangePreset, today: string = todayInAmman()): DateRange {
  if (preset === 'thisMonth') return { from: startOfMonth(today), to: endOfMonth(today) };
  if (preset === 'lastMonth') {
    const anchor = addDays(startOfMonth(today), -1);
    return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
  }
  return { from: addDays(today, -29), to: today };
}

/** Last 30 days including today. */
export function last30DaysRange(): DateRange {
  return presetRange('last30');
}

/** From/To date inputs with presets (this month, last month, last 30 days); applies only valid ranges. Ids are unique per instance. */
export function DateRangePicker({ value, onChange, maxDays = MAX_RANGE_DAYS, presets = true, tooLongMessage }: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  maxDays?: number | null;
  /** true (default) = all presets; false = none; or the presets to show, in order. */
  presets?: boolean | readonly DateRangePreset[];
  /** Shown when the range exceeds maxDays (default: the 62-day message). */
  tooLongMessage?: string;
}) {
  const { t } = useI18n();
  const uid = useId();
  const fromId = `${uid}-from`;
  const toId = `${uid}-to`;
  const problemId = `${uid}-problem`;
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const problem = validateRange(draft, maxDays);

  const update = (next: DateRange) => {
    setDraft(next);
    if (!validateRange(next, maxDays)) onChange(next);
  };

  const today = todayInAmman();
  const shown: readonly DateRangePreset[] = presets === true ? DATE_RANGE_PRESETS : presets === false ? [] : presets;
  const presetLabel: Record<DateRangePreset, string> = {
    thisMonth: t.myAttendance.thisMonth,
    lastMonth: t.myAttendance.lastMonth,
    last30: t.uiFoundation.last30,
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={fromId} className="text-xs">
            {t.common.from}
          </Label>
          <Input
            id={fromId}
            type="date"
            className="w-[10.5rem]"
            value={draft.from}
            max={draft.to || undefined}
            onChange={(e) => update({ ...draft, from: e.target.value })}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? problemId : undefined}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={toId} className="text-xs">
            {t.common.to}
          </Label>
          <Input
            id={toId}
            type="date"
            className="w-[10.5rem]"
            value={draft.to}
            min={draft.from || undefined}
            onChange={(e) => update({ ...draft, to: e.target.value })}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? problemId : undefined}
          />
        </div>
        {shown.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {shown.map((preset) => {
              const range = presetRange(preset, today);
              const active = draft.from === range.from && draft.to === range.to;
              return (
                <Button
                  key={preset}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={active}
                  className={active ? 'border-tint/40 bg-tint/[0.1]' : undefined}
                  onClick={() => update(range)}
                >
                  {presetLabel[preset]}
                </Button>
              );
            })}
          </div>
        )}
      </div>
      {problem && (
        <p id={problemId} role="alert" className="text-xs text-[color:var(--status-absent)]">
          {problem === 'tooLong' ? (tooLongMessage ?? t.myAttendance.rangeTooLong) : t.myAttendance.rangeInvalid}
        </p>
      )}
    </div>
  );
}
