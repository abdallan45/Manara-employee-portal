'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, RotateCcw, Square } from 'lucide-react';
import { MASCOT_AUDIO_MAX_BYTES } from '@workforce/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';

import { maxAudioMb } from './mascot-helpers';

const MAX_SECONDS = 30;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };

/** Microphone recording works only in a secure context (HTTPS or localhost) with MediaRecorder. */
export function canRecord(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
}

type Phase = 'idle' | 'starting' | 'recording' | 'done';

/** Records a line from the microphone, lets the admin listen, then hands the file to `onSave` (which uploads it). */
export function RecorderDialog({ open, onOpenChange, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; onSave: (file: File) => Promise<boolean> }) {
  const { t } = useI18n();
  const r = t.mascotAdmin.recorder;
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState<{ blob: Blob; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const stopTracks = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };

  const reset = useCallback(() => {
    window.clearInterval(timer.current);
    if (recorder.current && recorder.current.state !== 'inactive') {
      recorder.current.onstop = null;
      recorder.current.stop();
    }
    recorder.current = null;
    stopTracks();
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setPhase('idle');
    setSeconds(0);
    setError(null);
  }, []);

  // Closing the dialog (or leaving the page) releases the microphone and the preview.
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);
  useEffect(() => () => reset(), [reset]);

  const stop = () => {
    window.clearInterval(timer.current);
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  };

  const start = async () => {
    reset();
    setPhase('starting');
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = media;
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported?.(m));
      const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      rec.onstop = () => {
        stopTracks();
        const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
        setResult({ blob, url: URL.createObjectURL(blob) });
        setPhase('done');
      };
      recorder.current = rec;
      rec.start();
      setPhase('recording');
      const startedAt = Date.now();
      timer.current = window.setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(s);
        if (s >= MAX_SECONDS) stop();
      }, 250);
    } catch (err) {
      stopTracks();
      setPhase('idle');
      setError(err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? r.denied : r.failed);
    }
  };

  const save = async () => {
    if (!result) return;
    if (result.blob.size > MASCOT_AUDIO_MAX_BYTES) {
      setError(fmt(t.mascotAdmin.lines.tooBig, { mb: maxAudioMb() }));
      return;
    }
    const type = result.blob.type.split(';')[0]?.trim() || 'audio/webm';
    const file = new File([result.blob], `nouria-${Date.now()}.${EXT[type] ?? 'webm'}`, { type });
    setSaving(true);
    try {
      if (await onSave(file)) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent closeLabel={t.common.close} dirty={phase === 'recording' || phase === 'done'}>
        <DialogHeader>
          <DialogTitle>{r.title}</DialogTitle>
          <DialogDescription>{r.body}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {phase === 'recording' ? (
              <Button type="button" variant="destructive" onClick={stop}>
                <Square aria-hidden />
                {r.stop}
              </Button>
            ) : (
              <Button type="button" variant={phase === 'done' ? 'outline' : 'default'} onClick={() => void start()} disabled={phase === 'starting' || saving}>
                {phase === 'starting' ? <Loader2 className="animate-spin" aria-hidden /> : phase === 'done' ? <RotateCcw aria-hidden /> : <Mic aria-hidden />}
                {phase === 'done' ? r.again : r.start}
              </Button>
            )}
            <p className="text-muted-foreground text-sm" aria-live="polite">
              {phase === 'recording' ? (
                <span className="inline-flex items-center gap-2 font-medium text-[color:var(--status-absent)]">
                  <span className="size-2 animate-pulse rounded-full bg-current" aria-hidden />
                  {fmt(r.recording, { s: seconds })}
                </span>
              ) : (
                fmt(r.maxHint, { s: MAX_SECONDS })
              )}
            </p>
          </div>
          {result && (
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{r.preview}</p>
              <audio controls src={result.url} className="w-full" />
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t.common.cancel}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!result || saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            {saving ? t.mascotAdmin.lines.uploading : r.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
