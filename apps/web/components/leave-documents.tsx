'use client';

import { useRef, useState } from 'react';
import { ExternalLink, FileText, Loader2, Paperclip, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  LEAVE_DOCUMENT_MAX_BYTES, LEAVE_DOCUMENT_MAX_COUNT, LEAVE_DOCUMENT_TYPES, type LeaveDocumentDto,
} from '@workforce/shared';

import { HelpTip } from '@/components/help-tip';
import { Button } from '@/components/ui/button';
import { api, apiDelete } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';

const MB = LEAVE_DOCUMENT_MAX_BYTES / 1024 / 1024;
const ACCEPT = [...LEAVE_DOCUMENT_TYPES, '.jpg', '.jpeg', '.png', '.webp', '.pdf'].join(',');

export const documentUrl = (id: string) => `/api/v1/leave/documents/${encodeURIComponent(id)}/content`;

export function uploadLeaveDocument(requestId: string, file: File): Promise<LeaveDocumentDto> {
  const form = new FormData();
  form.append('file', file);
  return api<LeaveDocumentDto>(`/leave/requests/${encodeURIComponent(requestId)}/documents`, { method: 'POST', body: form });
}

function useFileCheck() {
  const { t } = useI18n();
  const d = t.leave.documents;
  /** Client-side pre-check; the server checks the real content again. */
  return (file: File): string | null => {
    const typeOk = (LEAVE_DOCUMENT_TYPES as readonly string[]).includes(file.type) || /\.(jpe?g|png|webp|pdf)$/i.test(file.name);
    if (!typeOk) return fmt(d.badType, { name: file.name });
    if (file.size > LEAVE_DOCUMENT_MAX_BYTES) return fmt(d.tooLarge, { name: file.name, mb: MB });
    return null;
  };
}

function formatSize(bytes: number, locale: 'en' | 'ar') {
  return bytes >= 1024 * 1024
    ? `${formatNumber(Math.round((bytes / 1024 / 1024) * 10) / 10, locale)} MB`
    : `${formatNumber(Math.max(1, Math.round(bytes / 1024)), locale)} KB`;
}

/** Files chosen in a form before the request exists (uploaded after it is created). Always optional. */
export function DocumentPicker({ files, onChange, expected, error }: {
  files: File[];
  onChange: (files: File[]) => void;
  /** The leave type normally needs a document: show a reminder (the request can still be sent without one). */
  expected?: boolean;
  error?: string;
}) {
  const { t, locale } = useI18n();
  const d = t.leave.documents;
  const input = useRef<HTMLInputElement>(null);
  const check = useFileCheck();
  const [problem, setProblem] = useState<string | null>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      const bad = check(f);
      if (bad) {
        setProblem(bad);
        continue;
      }
      if (next.length >= LEAVE_DOCUMENT_MAX_COUNT) {
        setProblem(fmt(d.tooMany, { n: LEAVE_DOCUMENT_MAX_COUNT }));
        break;
      }
      next.push(f);
    }
    onChange(next);
  };

  const message = error ?? problem;
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-sm font-medium">
          <span>
            {d.title}
            <span className="text-muted-foreground ms-1 text-xs font-normal">({t.common.optional})</span>
          </span>
          <HelpTip text={fmt(d.hint, { mb: MB, n: LEAVE_DOCUMENT_MAX_COUNT })} />
        </p>
        <Button type="button" variant="outline" size="sm" className="max-md:min-h-10" onClick={() => input.current?.click()} disabled={files.length >= LEAVE_DOCUMENT_MAX_COUNT}>
          <Paperclip aria-hidden />
          {d.add}
        </Button>
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          setProblem(null);
          add(e.target.files);
          e.target.value = '';
        }}
      />
      {expected && files.length === 0 && <p className="text-xs text-[color:var(--status-break)]">{d.required}</p>}
      <p className="sr-only">{fmt(d.hint, { mb: MB, n: LEAVE_DOCUMENT_MAX_COUNT })}</p>
      {files.length > 0 && (
        <ul className="grid gap-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-lg border border-tint/[0.06] bg-tint/[0.02] px-2.5 py-1.5 text-sm">
              <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <bdi className="min-w-0 flex-1 truncate">{f.name}</bdi>
              <span className="text-muted-foreground shrink-0 text-xs">{formatSize(f.size, locale)}</span>
              <Button type="button" variant="ghost" size="icon-sm" className="max-md:size-10" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label={`${d.remove}: ${f.name}`}>
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p role="alert" className="text-xs text-[color:var(--status-absent)]">
          {message}
        </p>
      )}
    </div>
  );
}

/** Documents of an existing request: previews, open in a new tab, optional add / remove. */
export function LeaveDocuments({ requestId, documents, canAdd = false, canRemove, missingWarning = false, onChanged }: {
  requestId: string;
  documents: LeaveDocumentDto[];
  canAdd?: boolean;
  canRemove?: (doc: LeaveDocumentDto) => boolean;
  /** The type needs a document and none is attached. */
  missingWarning?: boolean;
  onChanged?: () => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const d = t.leave.documents;
  const input = useRef<HTMLInputElement>(null);
  const check = useFileCheck();
  const [busy, setBusy] = useState<string | null>(null);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy('upload');
    try {
      for (const f of Array.from(list)) {
        const bad = check(f);
        if (bad) {
          toast.error(bad);
          continue;
        }
        await uploadLeaveDocument(requestId, f);
        toast.success(d.addedToast);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      onChanged?.();
    }
  };

  const remove = async (doc: LeaveDocumentDto) => {
    setBusy(doc.id);
    try {
      await apiDelete<void>(`/leave/documents/${encodeURIComponent(doc.id)}`);
      toast.success(d.removedToast);
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{d.title}</p>
        {canAdd && documents.length < LEAVE_DOCUMENT_MAX_COUNT && (
          <>
            <Button type="button" variant="outline" size="sm" className="max-md:min-h-10" onClick={() => input.current?.click()} disabled={busy !== null}>
              {busy === 'upload' ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
              {busy === 'upload' ? d.uploading : d.add}
            </Button>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>
      {missingWarning && documents.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-[color:var(--status-break)]">
          <TriangleAlert className="size-3.5" aria-hidden />
          {d.missingWarning}
        </p>
      )}
      {documents.length === 0 ? (
        !missingWarning && <p className="text-muted-foreground text-sm">{d.none}</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {documents.map((doc) => {
            const image = doc.mimeType.startsWith('image/');
            return (
              <li key={doc.id} className="flex items-center gap-3 rounded-xl border border-tint/[0.06] bg-tint/[0.02] p-2">
                <a href={documentUrl(doc.id)} target="_blank" rel="noopener noreferrer" className="shrink-0" aria-label={`${d.open}: ${doc.fileName}`}>
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element -- authenticated API image, not a static asset
                    <img src={documentUrl(doc.id)} alt="" className="size-12 rounded-lg object-cover" loading="lazy" />
                  ) : (
                    <span className="flex size-12 items-center justify-center rounded-lg bg-[color:var(--status-absent)]/10 text-[color:var(--status-absent)]">
                      <FileText className="size-5" aria-hidden />
                    </span>
                  )}
                </a>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" dir="auto">{doc.fileName}</p>
                  <p className="text-muted-foreground text-xs">{formatSize(doc.size, locale)}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button asChild variant="ghost" size="icon-sm" className="max-md:size-10">
                    <a href={documentUrl(doc.id)} target="_blank" rel="noopener noreferrer" aria-label={`${d.open}: ${doc.fileName}`}>
                      <ExternalLink aria-hidden />
                    </a>
                  </Button>
                  {canRemove?.(doc) && (
                    <Button variant="ghost" size="icon-sm" className="max-md:size-10" onClick={() => void remove(doc)} disabled={busy !== null} aria-label={`${d.remove}: ${doc.fileName}`}>
                      {busy === doc.id ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

