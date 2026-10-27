'use client';

import { ArrowDown, ArrowUp, CircleCheck, CircleDashed, CircleX, Clock, Plus, SkipForward, Trash2 } from 'lucide-react';
import {
  DIRECT_STEP, FALLBACK_STEP, MANAGER_STEP, MAX_APPROVAL_STEPS, SYSTEM_ROLES,
  type ApprovalStep, type LeaveApprovalStepDto, type RequestStatus, type RoleDto,
} from '@workforce/shared';

import { HelpTip } from '@/components/help-tip';
import { Interpolate } from '@/components/request-bits';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDateTime, localized } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

/**
 * Display name of a chain step: the manager step, the fallback / direct markers, or a role (its own
 * name from `roles` when loaded, else the built-in role names, else the key).
 */
export function useStepLabel(roles?: RoleDto[]) {
  const { t, locale } = useI18n();
  const c = t.approvalChains;
  return (step: ApprovalStep): string => {
    if (step === MANAGER_STEP) return c.steps.MANAGER;
    if (step === FALLBACK_STEP) return c.steps.ANY_APPROVER;
    if (step === DIRECT_STEP) return c.steps.DIRECT;
    const role = roles?.find((r) => r.key === step);
    if (role) return localized(locale, role.name, role.nameAr);
    return c.roleNames[step] ?? step;
  };
}

/** "Waiting for HR · step 2 of 3" under a pending status badge; undefined when not pending. */
export function useChainWaitingFor() {
  const { t } = useI18n();
  const label = useStepLabel();
  const p = t.approvalChains.progress;
  return (r: { status: RequestStatus; currentLevel: number; approvalSteps: ApprovalStep[] | null }): string | undefined => {
    if (r.status !== 'PENDING') return undefined;
    if (!r.approvalSteps) return t.employeeSelfService.requests.waitingHr;
    const levels = r.approvalSteps.length;
    const step = r.approvalSteps[r.currentLevel - 1];
    const who = step ? label(step) : t.employeeSelfService.requests.waitingHr;
    return levels > 1 ? fmt(p.waitingStep, { who, level: r.currentLevel, levels }) : fmt(p.waitingFor, { who });
  };
}

type StepState = 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'WAITING' | 'UPCOMING' | 'NOT_REACHED';

/**
 * The whole chain of a request, step by step: who decided each step (with their note), which steps
 * were skipped because nobody could decide them, which one is waiting and which are still to come.
 * Without a chain (a confidential request seen by a manager) only the decisions are listed.
 */
export function ChainProgress({ steps, currentLevel, status, approvals, skippedLevels, roles, className }: {
  steps: ApprovalStep[] | null;
  currentLevel: number;
  status: RequestStatus;
  approvals: LeaveApprovalStepDto[];
  skippedLevels: number[];
  roles?: RoleDto[];
  className?: string;
}) {
  const { t, locale } = useI18n();
  const p = t.approvalChains.progress;
  const label = useStepLabel(roles);
  if (!steps || steps.length === 0) {
    if (approvals.length === 0) return <p className="text-muted-foreground text-sm">{p.noSteps}</p>;
  }
  const chain = steps && steps.length ? steps : [...new Set(approvals.map((a) => a.step))];
  const levels = chain.length;

  const stateOf = (level: number, decision: LeaveApprovalStepDto | undefined): StepState => {
    if (decision) return decision.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED';
    if (skippedLevels.includes(level)) return 'SKIPPED';
    if (status === 'PENDING') return level === currentLevel ? 'WAITING' : 'UPCOMING';
    return 'NOT_REACHED';
  };
  const ICON = { APPROVED: CircleCheck, REJECTED: CircleX, SKIPPED: SkipForward, WAITING: Clock, UPCOMING: CircleDashed, NOT_REACHED: CircleDashed } as const;
  const COLOR: Record<StepState, string> = {
    APPROVED: 'var(--status-working)', REJECTED: 'var(--status-absent)', SKIPPED: 'var(--status-none)',
    WAITING: 'var(--status-break)', UPCOMING: 'var(--status-none)', NOT_REACHED: 'var(--status-none)',
  };

  return (
    <ol className={cn('space-y-3', className)}>
      {chain.map((step, i) => {
        const level = steps && steps.length ? i + 1 : approvals.find((a) => a.step === step)?.level ?? i + 1;
        const decision = approvals.find((a) => a.level === level);
        const state = stateOf(level, decision);
        const Icon = ICON[state];
        const who = decision ? localized(locale, decision.approver.name, decision.approver.nameAr) || decision.approver.username : null;
        return (
          <li key={`${level}-${step}`} className="flex gap-3">
            <Icon className="mt-0.5 size-4 shrink-0" style={{ color: COLOR[state] }} aria-hidden />
            <div className={cn('min-w-0 space-y-0.5 text-sm', (state === 'UPCOMING' || state === 'NOT_REACHED' || state === 'SKIPPED') && 'text-muted-foreground')}>
              <p className="flex items-center gap-1 font-medium">
                <span>{levels > 1 ? fmt(p.stepOfWho, { level, levels, who: label(step) }) : label(step)}</span>
                {step === MANAGER_STEP && <HelpTip text={t.approvalChains.stepHelp.MANAGER} />}
                {step === FALLBACK_STEP && <HelpTip text={t.approvalChains.stepHelp.ANY_APPROVER} />}
              </p>
              <p className="text-xs">
                {state === 'APPROVED' && <Interpolate text={p.approvedBy} vars={{ name: <bdi>{who}</bdi> }} />}
                {state === 'REJECTED' && <Interpolate text={p.rejectedBy} vars={{ name: <bdi>{who}</bdi> }} />}
                {state === 'SKIPPED' && p.skipped}
                {state === 'WAITING' && <span className="font-medium text-[color:var(--status-break)]">{p.waiting}</span>}
                {state === 'UPCOMING' && p.upcoming}
                {state === 'NOT_REACHED' && p.notReached}
                {decision && <span className="text-muted-foreground"> · {formatDateTime(decision.createdAt, locale)}</span>}
              </p>
              {decision?.comment && (
                <p className="text-foreground rounded-lg bg-tint/[0.03] px-2.5 py-1.5 whitespace-pre-wrap" dir="auto">
                  <span className="sr-only">{p.note}: </span>
                  {decision.comment}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** "Direct manager → HR → General manager" */
export function useChainSummary(roles?: RoleDto[]) {
  const { t } = useI18n();
  const label = useStepLabel(roles);
  return (steps: ApprovalStep[]) => steps.map(label).join(t.approvalChains.editor.summarySeparator);
}

/** Roles offered as chain steps: everything except the plain employee role. */
const stepRoles = (roles: RoleDto[]) => roles.filter((r) => r.key !== SYSTEM_ROLES.EMPLOYEE);

/**
 * Ordered list of approval steps (1..MAX_APPROVAL_STEPS): each "Direct manager / project manager" or a
 * role. Steps can be added, removed and moved. `id` goes on the first step's select (error focus).
 */
export function ChainEditor({ id, value, onChange, roles, label, help, error, disabled }: {
  id: string;
  value: ApprovalStep[];
  onChange: (steps: ApprovalStep[]) => void;
  roles: RoleDto[];
  label?: string;
  help?: string;
  error?: string;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const e = t.approvalChains.editor;
  const options = stepRoles(roles);
  const known = (step: ApprovalStep) => step === MANAGER_STEP || options.some((r) => r.key === step);
  const labelText = useStepLabel(roles);
  const errorId = error ? `${id}-error` : undefined;
  const helpId = `${id}-help`;

  const update = (i: number, step: ApprovalStep) => onChange(value.map((s, j) => (j === i ? step : s)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onChange(next);
  };

  return (
    <fieldset className="grid min-w-0 gap-2" aria-describedby={[helpId, errorId].filter(Boolean).join(' ')} aria-invalid={error ? true : undefined}>
      <legend className="mb-1.5 flex items-center gap-1 text-sm leading-none font-medium">
        {label ?? e.label}
        <HelpTip text={help ?? e.help} />
      </legend>
      <p id={helpId} className="sr-only">{help ?? e.help}</p>
      <ol className="grid gap-2">
        {value.map((step, i) => {
          const n = i + 1;
          return (
            <li key={i} className="flex items-center gap-2 rounded-xl border border-tint/[0.08] bg-tint/[0.02] p-2">
              <span className="text-muted-foreground tabular w-16 shrink-0 text-xs font-medium">{fmt(e.step, { n })}</span>
              <Select value={step} onValueChange={(v) => update(i, v)} disabled={disabled}>
                <SelectTrigger id={i === 0 ? id : `${id}-${n}`} className="min-w-0 flex-1" aria-label={fmt(e.step, { n })}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MANAGER_STEP}>{e.managerOption}</SelectItem>
                  <SelectGroup>
                    <SelectLabel>{e.roleGroup}</SelectLabel>
                    {options.map((r) => (
                      <SelectItem key={r.key} value={r.key}>
                        {localized(locale, r.name, r.nameAr)}
                      </SelectItem>
                    ))}
                    {!known(step) && <SelectItem value={step}>{labelText(step)}</SelectItem>}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => move(i, -1)} disabled={disabled || i === 0} aria-label={fmt(e.moveUp, { n })}>
                <ArrowUp aria-hidden />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => move(i, 1)} disabled={disabled || i === value.length - 1} aria-label={fmt(e.moveDown, { n })}>
                <ArrowDown aria-hidden />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, j) => j !== i))} disabled={disabled || value.length <= 1} aria-label={fmt(e.remove, { n })}>
                <Trash2 aria-hidden />
              </Button>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, MANAGER_STEP])} disabled={disabled || value.length >= MAX_APPROVAL_STEPS}>
          <Plus aria-hidden />
          {e.addStep}
        </Button>
        <span className="text-muted-foreground text-xs">{fmt(e.max, { n: MAX_APPROVAL_STEPS })}</span>
      </div>
      {error && (
        <p id={errorId} className="text-xs text-[color:var(--status-absent)]">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * A request's chain behind a "Approval steps" disclosure, for list rows (own overtime and corrections).
 * Nothing is shown for a one-step request nobody has decided yet.
 */
export function ChainDisclosure({ request, className }: {
  request: { status: RequestStatus; currentLevel: number; approvalSteps: ApprovalStep[] | null; approvals: LeaveApprovalStepDto[]; skippedLevels: number[] };
  className?: string;
}) {
  const { t } = useI18n();
  const steps = request.approvalSteps ?? [];
  if (request.approvals.length === 0 && steps.length <= 1 && request.skippedLevels.length === 0) return null;
  return (
    <details className={cn('text-xs', className)}>
      <summary className="text-link w-fit cursor-pointer underline-offset-4 hover:underline">{t.approvalChains.progress.title}</summary>
      <ChainProgress
        className="mt-2"
        steps={request.approvalSteps}
        currentLevel={request.currentLevel}
        status={request.status}
        approvals={request.approvals}
        skippedLevels={request.skippedLevels}
      />
    </details>
  );
}
