'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquareText, Mic, Pencil, Play, Plus, Trash2, Upload, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import {
  MASCOT_MOODS,
  type MascotGroupDto,
  type MascotLineDto,
  type MascotLineInput,
  type MascotLocale,
  type MascotMood,
} from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, apiDelete } from '@/lib/api';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { emitMascot } from '@/lib/mascot/events';
import { useDirtyGuard } from '@/lib/use-dirty-guard';

import { GroupEditorDialog } from './group-editor';
import { AUDIO_ACCEPT, audioFileProblem, conditionSummary, maxAudioMb, patchLine, withLine, withoutLine } from './mascot-helpers';
import { GroupActiveSwitch, useDeleteGroup, type MascotStore } from './mascot-store';
import { RecorderDialog, canRecord } from './recorder-dialog';

const TEXT_MAX = 300;
const GROUP_MOOD = '__group';
const LOCALES: MascotLocale[] = ['ar', 'en'];

const lineUrl = (id: string) => `/mascot/lines/${encodeURIComponent(id)}`;

/** Makes Nouria say a line on this screen (admin preview; her bubble shows {name} filled in). */
export function previewLine(text: string, mood: MascotMood, audioUrl: string | null) {
  emitMascot({ kind: 'say', text, mood, audioUrl });
}

/** /admin/mascot?group=<id>: one group's lines. */
export function GroupDetail({ groupId, store }: { groupId: string; store: MascotStore }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const m = t.mascotAdmin;
  const group = store.config.groups.find((g) => g.id === groupId);
  const [editing, setEditing] = useState(false);
  const del = useDeleteGroup(store, () => router.push('/admin/mascot'));
  const [dirtyLines, setDirtyLines] = useState<Set<string>>(() => new Set());
  const [recordOk, setRecordOk] = useState(true);
  useEffect(() => setRecordOk(canRecord()), []);
  useDirtyGuard(dirtyLines.size > 0);

  const setLineDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyLines((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const crumbs = [{ label: m.title, href: '/admin/mascot' }, { label: group?.name ?? m.lines.title }];

  if (!group) {
    return (
      <div className="space-y-6">
        <PageHeader title={m.lines.title} breadcrumbs={crumbs} />
        <Card className="py-0">
          <EmptyState
            title={m.lines.notFound}
            action={
              <Button asChild variant="outline">
                <Link href="/admin/mascot">{m.lines.back}</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const lines = [...group.lines].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="space-y-6">
      <PageHeader
        title={group.name}
        subtitle={`${m.triggers[group.trigger]} · ${conditionSummary(group.conditions ?? {}, t, locale, store.breakTypes)}`}
        breadcrumbs={crumbs}
        documentTitle={`${group.name} · ${m.title}`}
        actions={
          <>
            <label className="flex min-h-10 items-center gap-2 text-sm font-medium">
              <GroupActiveSwitch group={group} store={store} />
              {m.groups.active}
            </label>
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              {m.lines.editGroup}
            </Button>
            <Button variant="outline" onClick={() => del.ask(group)}>
              <Trash2 className="text-[color:var(--status-absent)]" aria-hidden />
              {m.lines.deleteGroup}
            </Button>
          </>
        }
      />

      {!group.isActive && (
        <p className="rounded-xl border border-[color:var(--status-missing)]/40 bg-[color:var(--status-missing)]/10 px-3 py-2 text-sm">{m.lines.groupInactive}</p>
      )}

      {!recordOk && <p className="text-muted-foreground text-sm">{m.recorder.unavailable}</p>}

      <section aria-labelledby="mascot-lines-title" className="space-y-3">
        <div className="flex items-center gap-1">
          <h2 id="mascot-lines-title" className="text-base font-semibold" aria-describedby="mascot-lines-hint">
            {m.lines.title} <span className="text-muted-foreground tabular text-sm font-normal">({fmt(m.lines.count, { n: lines.length })})</span>
          </h2>
          <HelpTip text={m.lines.nameHint} />
        </div>
        <p id="mascot-lines-hint" className="sr-only">
          {m.lines.nameHint}
        </p>
        <Card className="gap-0 py-0">
          {lines.length === 0 ? (
            <EmptyState icon={MessageSquareText} title={m.lines.empty} description={m.lines.emptyBody} />
          ) : (
            <ul className="divide-y divide-border">
              {lines.map((line, i) => (
                <li key={line.id}>
                  <LineRow line={line} index={i + 1} group={group} store={store} recordOk={recordOk} onDirtyChange={setLineDirty} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <AddLine group={group} store={store} />

      <GroupEditorDialog store={store} editing={editing ? group : null} onClose={() => setEditing(false)} />
      {del.dialog}
    </div>
  );
}

function LineRow({ line, index, group, store, recordOk, onDirtyChange }: {
  line: MascotLineDto;
  index: number;
  group: MascotGroupDto;
  store: MascotStore;
  recordOk: boolean;
  onDirtyChange: (id: string, dirty: boolean) => void;
}) {
  const { t, errorMessage } = useI18n();
  const m = t.mascotAdmin;
  const l = m.lines;
  const [text, setText] = useState(line.text);
  const [savingText, setSavingText] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'meta' | 'upload' | null>(null);
  const [recording, setRecording] = useState(false);
  const [confirm, setConfirm] = useState<'audio' | 'line' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textId = `line-${line.id}-text`;

  // A save from elsewhere (or a reload) moves the saved text; follow it unless the admin is typing.
  const savedText = useRef(line.text);
  useEffect(() => {
    if (line.text !== savedText.current) {
      setText((current) => (current === savedText.current ? line.text : current));
      savedText.current = line.text;
    }
  }, [line.text]);

  const dirty = text !== line.text;
  useEffect(() => onDirtyChange(line.id, dirty), [dirty, line.id, onDirtyChange]);
  useEffect(() => () => onDirtyChange(line.id, false), [line.id, onDirtyChange]);

  const moodFor = (): MascotMood => line.mood ?? group.moods[0] ?? 'happy';

  const saveText = async () => {
    const value = text.trim();
    if (!value) {
      setTextError(l.textRequired);
      return;
    }
    setSavingText(true);
    setTextError(null);
    try {
      const saved = await api<MascotLineDto>(lineUrl(line.id), { method: 'PATCH', body: { text: value } satisfies Partial<MascotLineInput> });
      savedText.current = saved.text;
      setText(saved.text);
      store.update((c) => withLine(c, saved));
      toast.success(l.saved);
    } catch (err) {
      setTextError(errorMessage(err));
    } finally {
      setSavingText(false);
    }
  };

  /** Locale, mood and active: shown at once, rolled back if the server refuses. */
  const patchMeta = async (patch: Partial<MascotLineInput>) => {
    const before: Partial<MascotLineDto> = { locale: line.locale, mood: line.mood, isActive: line.isActive };
    setBusy('meta');
    store.update((c) => patchLine(c, line.id, patch));
    try {
      const saved = await api<MascotLineDto>(lineUrl(line.id), { method: 'PATCH', body: patch });
      store.update((c) => withLine(c, saved));
    } catch (err) {
      store.update((c) => patchLine(c, line.id, before));
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File): Promise<boolean> => {
    const problem = audioFileProblem(file);
    if (problem) {
      toast.error(problem === 'size' ? fmt(l.tooBig, { mb: maxAudioMb() }) : l.badType);
      return false;
    }
    setBusy('upload');
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const saved = await api<MascotLineDto>(`${lineUrl(line.id)}/audio`, { method: 'PUT', body });
      store.update((c) => withLine(c, saved));
      toast.success(l.uploaded);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const deleteAudio = async () => {
    try {
      const saved = await api<MascotLineDto | undefined>(`${lineUrl(line.id)}/audio`, { method: 'DELETE' });
      store.update((c) => (saved ? withLine(c, saved) : patchLine(c, line.id, { audioUrl: null, audioMime: null })));
      toast.success(l.recordingDeleted);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const deleteLine = async () => {
    try {
      await apiDelete<void>(lineUrl(line.id));
      store.update((c) => withoutLine(c, line.id));
      toast.success(t.common.deletedToast);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const label = fmt(l.lineLabel, { n: index });

  return (
    <div className={`grid gap-3 p-4 ${line.isActive ? '' : 'bg-tint/[0.02]'}`}>
      <div className="grid gap-1.5">
        <label htmlFor={textId} className="sr-only">
          {label}
        </label>
        <Textarea
          id={textId}
          rows={2}
          dir={line.locale === 'ar' ? 'rtl' : 'ltr'}
          lang={line.locale}
          value={text}
          maxLength={TEXT_MAX}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && dirty) {
              e.preventDefault();
              void saveText();
            }
          }}
          aria-invalid={textError ? true : undefined}
          aria-describedby={textError ? `${textId}-error` : undefined}
          className={line.isActive ? undefined : 'opacity-70'}
        />
        {textError && (
          <p id={`${textId}-error`} role="alert" className="text-xs text-[color:var(--status-absent)]">
            {textError}
          </p>
        )}
        {dirty && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void saveText()} disabled={savingText}>
              {savingText && <Loader2 className="animate-spin" aria-hidden />}
              {savingText ? t.common.saving : t.common.save}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setText(line.text); setTextError(null); }} disabled={savingText}>
              {t.common.cancel}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Select value={line.locale} onValueChange={(v) => void patchMeta({ locale: v as MascotLocale })} disabled={busy === 'meta'}>
          <SelectTrigger size="sm" className="w-28" aria-label={`${l.language}: ${label}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCALES.map((x) => (
              <SelectItem key={x} value={x}>
                {m.locales[x]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={line.mood ?? GROUP_MOOD} onValueChange={(v) => void patchMeta({ mood: v === GROUP_MOOD ? null : (v as MascotMood) })} disabled={busy === 'meta'}>
          <SelectTrigger size="sm" className="w-36" aria-label={`${l.mood}: ${label}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={GROUP_MOOD}>{l.moodGroup}</SelectItem>
            {MASCOT_MOODS.map((x) => (
              <SelectItem key={x} value={x}>
                {m.moods[x]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <Switch checked={line.isActive} disabled={busy === 'meta'} onCheckedChange={(v) => void patchMeta({ isActive: v })} aria-label={`${l.active}: ${label}`} />
          <span aria-hidden>{l.active}</span>
        </label>
        {line.audioUrl ? <Badge variant="secondary">{l.recorded}</Badge> : <Badge variant="outline">{l.textOnly}</Badge>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => previewLine(text, moodFor(), line.audioUrl)} title={l.playHint}>
          {line.audioUrl ? <Play aria-hidden /> : <MessageSquareText aria-hidden />}
          {line.audioUrl ? l.play : l.sayText}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept={AUDIO_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy === 'upload'}>
          {busy === 'upload' ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
          {busy === 'upload' ? l.uploading : line.audioUrl ? l.replace : l.upload}
        </Button>
        {recordOk && (
          <Button size="sm" variant="outline" onClick={() => setRecording(true)} disabled={busy === 'upload'}>
            <Mic aria-hidden />
            {l.record}
          </Button>
        )}
        {line.audioUrl && (
          <Button size="sm" variant="ghost" onClick={() => setConfirm('audio')}>
            <VolumeX aria-hidden />
            {l.deleteRecording}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setConfirm('line')} className="ms-auto">
          <Trash2 className="text-[color:var(--status-absent)]" aria-hidden />
          {l.deleteLine}
        </Button>
      </div>

      {recordOk && <RecorderDialog open={recording} onOpenChange={setRecording} onSave={upload} />}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        destructive
        title={confirm === 'audio' ? l.deleteRecordingTitle : l.deleteLineTitle}
        description={confirm === 'audio' ? l.deleteRecordingBody : l.deleteLineBody}
        confirmLabel={confirm === 'audio' ? l.deleteRecording : l.deleteLine}
        onConfirm={() => (confirm === 'audio' ? deleteAudio() : deleteLine())}
      />
    </div>
  );
}

function AddLine({ group, store }: { group: MascotGroupDto; store: MascotStore }) {
  const { t, locale: uiLocale, errorMessage } = useI18n();
  const m = t.mascotAdmin;
  const l = m.lines;
  const [locale, setLocale] = useState<MascotLocale>(uiLocale);
  const [mood, setMood] = useState<string>(GROUP_MOOD);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  useDirtyGuard(text.trim() !== '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) {
      setError(l.textRequired);
      document.getElementById('mascot-new-line')?.focus();
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const body: MascotLineInput = { locale, text: value, mood: mood === GROUP_MOOD ? null : (mood as MascotMood), isActive: true };
      const saved = await api<MascotLineDto>(`/mascot/groups/${encodeURIComponent(group.id)}/lines`, { method: 'POST', body });
      store.update((c) => withLine(c, saved));
      setText('');
      toast.success(l.added);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="gap-0 px-4 py-4 sm:px-6">
      <form onSubmit={submit} className="grid gap-3" noValidate>
        <h2 className="text-base font-semibold">{l.addTitle}</h2>
        <FormField id="mascot-new-line" label={l.text} error={error} announceError hint={l.nameHint}>
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              rows={2}
              dir={locale === 'ar' ? 'rtl' : 'ltr'}
              lang={locale}
              value={text}
              maxLength={TEXT_MAX}
              placeholder={l.newPlaceholder}
              onChange={(e) => setText(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
        <div className="flex flex-wrap items-end gap-3">
          <FormField id="mascot-new-locale" label={l.language}>
            {({ id }) => (
              <Select value={locale} onValueChange={(v) => setLocale(v as MascotLocale)}>
                <SelectTrigger id={id} className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCALES.map((x) => (
                    <SelectItem key={x} value={x}>
                      {m.locales[x]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField id="mascot-new-mood" label={l.mood}>
            {({ id }) => (
              <Select value={mood} onValueChange={setMood}>
                <SelectTrigger id={id} className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={GROUP_MOOD}>{l.moodGroup}</SelectItem>
                  {MASCOT_MOODS.map((x) => (
                    <SelectItem key={x} value={x}>
                      {m.moods[x]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <Button type="submit" disabled={saving} className="ms-auto">
            {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
            {l.add}
          </Button>
        </div>
      </form>
    </Card>
  );
}
