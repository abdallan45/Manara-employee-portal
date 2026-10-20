'use client';

import { useState, type FormEvent } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ChangePasswordInput } from '@workforce/shared';

import { FormField } from '@/components/form-field';
import { FormErrorSummary, focusFirstError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, api, fieldErrorsFrom } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/context';
import { useDirtyGuard } from '@/lib/use-dirty-guard';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

type Field = 'currentPassword' | 'newPassword' | 'confirmPassword';
const ORDER: Field[] = ['currentPassword', 'newPassword', 'confirmPassword'];
const idOf = (f: Field) => `pw-${f}`;
const EMPTY: Record<Field, string> = { currentPassword: '', newPassword: '', confirmPassword: '' };

/**
 * Current / new / confirm form for POST /auth/me/password. Checks length (10–128), the confirmation and
 * "different from the current one" before sending; server errors land on their field. `onChanged` runs
 * after a 204 (the API has then signed out the user's other sessions; this one stays).
 */
export function ChangePasswordForm({ onChanged }: { onChanged?: () => void }) {
  const { t, errorMessage } = useI18n();
  const { user } = useAuth();
  const s = t.accountSecurity;
  const [form, setForm] = useState<Record<Field, string>>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const dirty = ORDER.some((f) => form[f] !== '');
  useDirtyGuard(dirty && !busy);

  const labels: Record<Field, { label: string; hint: string }> = {
    currentPassword: { label: s.currentPassword, hint: s.currentPasswordHint },
    newPassword: { label: s.newPassword, hint: s.newPasswordHint },
    confirmPassword: { label: s.confirmPassword, hint: s.confirmPasswordHint },
  };

  const check = (f: Record<Field, string>): Partial<Record<Field, string>> => {
    const e: Partial<Record<Field, string>> = {};
    if (!f.currentPassword) e.currentPassword = s.enterCurrent;
    if (f.newPassword.length < PASSWORD_MIN) e.newPassword = s.tooShort;
    else if (f.newPassword.length > PASSWORD_MAX) e.newPassword = s.tooLong;
    else if (f.currentPassword && f.newPassword === f.currentPassword) e.newPassword = s.sameAsCurrent;
    if (!e.newPassword && f.confirmPassword !== f.newPassword) e.confirmPassword = s.mismatch;
    return e;
  };

  const set = (key: Field, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDone(false);
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    setSubmitted(true);
    setFormError(null);
    const found = check(form);
    setErrors(found);
    const bad = ORDER.filter((k) => found[k]);
    if (bad.length) {
      focusFirstError(bad.map(idOf));
      return;
    }
    setBusy(true);
    try {
      const body: ChangePasswordInput = { currentPassword: form.currentPassword, newPassword: form.newPassword };
      await api<void>('/auth/me/password', { method: 'POST', body });
      setForm(EMPTY);
      setErrors({});
      setSubmitted(false);
      setDone(true);
      toast.success(s.successToast, { description: s.successBody });
      onChanged?.();
    } catch (err) {
      const fail = (field: Field, message: string) => {
        setErrors({ [field]: message });
        focusFirstError([idOf(field)]);
      };
      if (err instanceof ApiError && err.code === 'INVALID_CURRENT_PASSWORD') fail('currentPassword', t.errors.INVALID_CURRENT_PASSWORD);
      else if (err instanceof ApiError && err.code === 'PASSWORD_REUSED') fail('newPassword', t.errors.PASSWORD_REUSED);
      else if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        // Never show the API's English text: a rejected field gets its localized rule.
        const fe = fieldErrorsFrom(err.details);
        const mapped: Partial<Record<Field, string>> = {};
        if (fe.currentPassword) mapped.currentPassword = s.enterCurrent;
        if (fe.newPassword) mapped.newPassword = form.newPassword.length > PASSWORD_MAX ? s.tooLong : s.tooShort;
        setErrors(mapped);
        setFormError(errorMessage(err));
        const first = ORDER.filter((k) => mapped[k]);
        if (first.length) focusFirstError(first.map(idOf));
      } else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const summary = ORDER.filter((k) => errors[k]).map((k) => ({ id: idOf(k), message: `${labels[k].label}: ${errors[k]}` }));

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <FormErrorSummary errors={submitted ? summary : []} />
      {done && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-[color:var(--status-working)]/30 bg-[color:var(--status-working)]/10 p-3 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[color:var(--status-working)]" aria-hidden />
          <span>
            <span className="font-semibold">{s.successToast}.</span> {s.successBody}
          </span>
        </p>
      )}
      {/* Lets password managers attach the new password to the right account. */}
      <input type="text" name="username" autoComplete="username" className="hidden" aria-hidden tabIndex={-1} readOnly value={user.username} />
      {ORDER.map((key) => (
        <FormField key={key} id={idOf(key)} label={labels[key].label} hint={labels[key].hint} error={errors[key]} required>
          {({ id, describedBy, invalid, required }) => (
            <Input
              id={id}
              name={key}
              type={show ? 'text' : 'password'}
              dir="ltr"
              className="h-11"
              autoComplete={key === 'currentPassword' ? 'current-password' : 'new-password'}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={PASSWORD_MAX + 50}
              value={form[key]}
              onChange={(e) => set(key, e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-required={required}
            />
          )}
        </FormField>
      ))}
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShow((v) => !v)} aria-pressed={show}>
          {show ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {show ? s.hide : s.show}
        </Button>
      </div>
      {formError && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {formError}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full sm:w-auto sm:justify-self-start" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
        {busy ? s.submitting : s.submit}
      </Button>
    </form>
  );
}
