'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, CircleSlash, Play, Shuffle } from 'lucide-react';
import { MASCOT_TRIGGERS, isMascotTime, mascotSpeechLocale, selectMascotLine, type MascotContext, type MascotLocale, type MascotTrigger } from '@workforce/shared';

import { FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { ammanNow, minutesOf } from '@/lib/mascot/context';
import { cn } from '@/lib/utils';

import { previewLine } from './group-detail';
import { COMMON_ERROR_CODES, breakTypeName, mismatchReasons, sortGroups } from './mascot-helpers';
import type { MascotStore } from './mascot-store';

const NONE = '__none';
const OTHER = '__other';
const INT_RE = /^-?\d+$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** "Try it": builds a MascotContext from chosen values and shows which group and line Nouria would use. Writes nothing. */
export function TryItPanel({ store }: { store: MascotStore }) {
  const { t, locale: uiLocale } = useI18n();
  const m = t.mascotAdmin;
  const r = m.tryIt;
  const [now] = useState(() => ammanNow());
  const [trigger, setTrigger] = useState<MascotTrigger>('CHECK_IN');
  const [time, setTime] = useState(`${pad(Math.floor(now.minuteOfDay / 60))}:${pad(now.minuteOfDay % 60)}`);
  const [weekday, setWeekday] = useState(String(now.weekday));
  const [workday, setWorkday] = useState(true);
  const [late, setLate] = useState(false);
  const [work, setWork] = useState('0');
  const [breakType, setBreakType] = useState(NONE);
  const [breakExceeded, setBreakExceeded] = useState(false);
  const [errorChoice, setErrorChoice] = useState<string>(COMMON_ERROR_CODES[0]);
  const [errorOther, setErrorOther] = useState('');
  const [locale, setLocale] = useState<MascotLocale>(() => mascotSpeechLocale(store.config.language ?? 'auto', uiLocale));
  const [seed, setSeed] = useState(0);

  const ctx: MascotContext = useMemo(() => {
    const base: MascotContext = { trigger, minuteOfDay: isMascotTime(time) ? minutesOf(time) : 0, weekday: Number(weekday) };
    const bt = breakType === NONE ? null : breakType;
    switch (trigger) {
      case 'CHECK_IN':
        return { ...base, workday, isLate: late };
      case 'CHECK_OUT':
        return { ...base, workday, workMinusRequired: INT_RE.test(work.trim()) ? Number(work) : undefined };
      case 'BREAK_START':
        return { ...base, workday, breakTypeCode: bt };
      case 'BREAK_END':
        return { ...base, workday, breakTypeCode: bt, breakExceeded };
      case 'ERROR':
        return { ...base, errorCode: errorChoice === OTHER ? errorOther.trim().toUpperCase() || null : errorChoice };
      default:
        return base;
    }
  }, [trigger, time, weekday, workday, late, work, breakType, breakExceeded, errorChoice, errorOther]);

  const groups = sortGroups(store.config.groups.filter((g) => g.trigger === trigger));
  // `seed` changes on "Another line" so the random pick runs again.
  const pick = useMemo(() => {
    void seed;
    return selectMascotLine(store.config, ctx, locale);
  }, [store.config, ctx, locale, seed]);

  const showWorkday = trigger === 'CHECK_IN' || trigger === 'CHECK_OUT' || trigger === 'BREAK_START' || trigger === 'BREAK_END';
  const activeBreaks = (store.breakTypes ?? []).filter((b) => b.isActive);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <Card className="gap-0 px-4 py-4 sm:px-6">
        <div className="grid gap-4">
          <div className="flex items-center gap-1">
            <h2 className="text-base font-semibold" aria-describedby="try-body">
              {r.title}
            </h2>
            <HelpTip text={r.body} />
            <p id="try-body" className="sr-only">
              {r.body}
            </p>
          </div>
          <FormField id="try-trigger" label={r.trigger}>
            {({ id }) => (
              <Select value={trigger} onValueChange={(v) => setTrigger(v as MascotTrigger)}>
                <SelectTrigger id={id} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MASCOT_TRIGGERS.map((tr) => (
                    <SelectItem key={tr} value={tr}>
                      {m.triggers[tr]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField id="try-time" label={r.time}>
              {({ id }) => <Input id={id} type="time" dir="ltr" value={time} onChange={(e) => setTime(e.target.value)} />}
            </FormField>
            <FormField id="try-weekday" label={r.weekday}>
              {({ id }) => (
                <Select value={weekday} onValueChange={setWeekday}>
                  <SelectTrigger id={id} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {m.weekdaysShort.map((d, i) => (
                      <SelectItem key={d} value={String(i)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>
          {showWorkday && (
            <FormField id="try-workday" label={r.workday}>
              {({ id }) => (
                <Select value={workday ? 'yes' : 'no'} onValueChange={(v) => setWorkday(v === 'yes')}>
                  <SelectTrigger id={id} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">{r.workdayYes}</SelectItem>
                    <SelectItem value="no">{r.workdayNo}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
          )}
          {trigger === 'CHECK_IN' && (
            <FormField id="try-late" label={r.late} hint={r.lateHint}>
              {({ id, describedBy }) => (
                <Select value={late ? 'yes' : 'no'} onValueChange={(v) => setLate(v === 'yes')}>
                  <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no">{r.lateNo}</SelectItem>
                    <SelectItem value="yes">{r.lateYes}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
          )}
          {trigger === 'CHECK_OUT' && (
            <FormField id="try-work" label={r.workVsRequired} hint={r.workHint}>
              {({ id, describedBy }) => <Input id={id} dir="ltr" inputMode="numeric" value={work} onChange={(e) => setWork(e.target.value)} aria-describedby={describedBy} className="tabular" />}
            </FormField>
          )}
          {(trigger === 'BREAK_START' || trigger === 'BREAK_END') && (
            <FormField id="try-break" label={r.breakType}>
              {({ id }) => (
                <Select value={breakType} onValueChange={setBreakType}>
                  <SelectTrigger id={id} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{r.breakNone}</SelectItem>
                    {activeBreaks.map((b) => (
                      <SelectItem key={b.code} value={b.code}>
                        {breakTypeName(b.code, store.breakTypes, uiLocale)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          )}
          {trigger === 'BREAK_END' && (
            <label className="flex min-h-10 items-center gap-3 text-sm font-medium">
              <Switch checked={breakExceeded} onCheckedChange={setBreakExceeded} />
              {r.breakExceeded}
            </label>
          )}
          {trigger === 'ERROR' && (
            <div className="grid gap-3">
              <FormField id="try-error" label={r.errorCode}>
                {({ id }) => (
                  <Select value={errorChoice} onValueChange={setErrorChoice}>
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COMMON_ERROR_CODES.map((code) => (
                        <SelectItem key={code} value={code}>
                          {m.editor.errorLabels[code]}
                        </SelectItem>
                      ))}
                      <SelectItem value={OTHER}>{m.editor.errorCustom}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              {errorChoice === OTHER && (
                <FormField id="try-error-other" label={m.editor.errorCustom}>
                  {({ id }) => <Input id={id} dir="ltr" value={errorOther} onChange={(e) => setErrorOther(e.target.value)} placeholder={m.editor.errorCustomPlaceholder} />}
                </FormField>
              )}
            </div>
          )}
          <FormField id="try-locale" label={r.language}>
            {({ id }) => (
              <Select value={locale} onValueChange={(v) => setLocale(v as MascotLocale)}>
                <SelectTrigger id={id} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ar">{m.locales.ar}</SelectItem>
                  <SelectItem value="en">{m.locales.en}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
        </div>
      </Card>

      <div className="grid gap-4">
        <Card className="gap-0 px-4 py-4 sm:px-6" aria-live="polite">
          <h3 className="text-muted-foreground mb-2 text-sm font-semibold">{r.result}</h3>
          {pick ? (
            <div className="grid gap-3">
              <p className="text-sm">
                {r.winner}{' '}
                <Link href={`/admin/mascot?group=${encodeURIComponent(pick.group.id)}`} className="text-link font-medium underline-offset-4 hover:underline">
                  <bdi>{pick.group.name}</bdi>
                </Link>
              </p>
              <div className="rounded-2xl border border-border bg-tint/[0.03] p-3">
                <p className="text-muted-foreground mb-1 text-xs">
                  {r.chosenLine} · {m.moods[pick.mood]} · {pick.line.audioUrl ? m.lines.recorded : m.lines.textOnly}
                </p>
                <p dir={pick.line.locale === 'ar' ? 'rtl' : 'ltr'} lang={pick.line.locale}>
                  {pick.line.text.replaceAll('{name}', r.unknownName)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => previewLine(pick.line.text, pick.mood, pick.line.audioUrl)}>
                  <Play aria-hidden />
                  {r.say}
                </Button>
                <Button variant="outline" onClick={() => setSeed((s) => s + 1)}>
                  <Shuffle aria-hidden />
                  {r.again}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm">{r.noMatch}</p>
          )}
        </Card>

        <Card className="gap-0 py-0">
          <h3 className="text-muted-foreground px-4 pt-4 pb-2 text-sm font-semibold sm:px-6">{r.groupsChecked}</h3>
          {groups.length === 0 ? (
            <p className="text-muted-foreground px-4 pb-4 text-sm sm:px-6">{r.noGroups}</p>
          ) : (
            <ul className="divide-y divide-border">
              {groups.map((g) => {
                const reasons = mismatchReasons(g, ctx, t);
                const ok = reasons.length === 0;
                const winner = pick?.group.id === g.id;
                return (
                  <li key={g.id} className={cn('flex items-start gap-3 px-4 py-3 sm:px-6', winner && 'bg-primary/[0.06]')}>
                    {ok ? (
                      <CheckCircle2 className={cn('mt-0.5 size-4 shrink-0', winner ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                    ) : (
                      <CircleSlash className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <Link href={`/admin/mascot?group=${encodeURIComponent(g.id)}`} className="font-medium underline-offset-4 hover:underline">
                          {g.name}
                        </Link>
                        <span className="text-muted-foreground tabular text-xs">
                          {m.groups.priority}: {g.priority}
                        </span>
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {ok ? (winner ? r.matches : r.matchesLower) : fmt(r.whyNot, { reasons: reasons.join(uiLocale === 'ar' ? '، ' : ', ') })}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
