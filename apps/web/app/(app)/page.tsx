'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AlarmClockOff,
  ArrowRight,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Clock,
  Coffee,
  FilePlus,
  Loader2,
  LocateFixed,
  LogIn,
  LogOut,
  type LucideIcon,
  MapPin,
  MapPinOff,
  Moon,
  PartyPopper,
  Plane,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Timer,
  TimerReset,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  type ApprovalSummaryDto,
  type AttendanceEventDto,
  type AttendanceState,
  type AttendanceStatusDto,
  type BreakTypeDto,
  type CorrectableSessionDto,
  type DeviceLocation,
  type LeaveBalanceDto,
  type LeaveRequestDto,
  type Paginated,
} from '@workforce/shared';

import { EventList, ProgressBar } from '@/components/attendance-bits';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { LiveTimer, Minutes, TimeRange, useNow } from '@/components/duration';
import { Interpolate, useLeaveAmount } from '@/components/request-bits';
import { EmptyState, ErrorState } from '@/components/states';
import { LateBadge, RemoteBadge, StateBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth';
import { addDays, formatClockDate, formatMinutes, formatTime, formatWeekday, formatWorkDate, localized, todayInAmman } from '@/lib/format';
import { formatDistance, officeVerdict, useDeviceLocation, type GeoResult } from '@/lib/geolocation';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { usePortal } from '@/lib/portal';
import { useApi } from '@/lib/use-api';
import { useAttendanceAction, type AttendanceActionPath } from '@/lib/use-attendance-action';
import { cn } from '@/lib/utils';

const APPROVER_PERMISSIONS = [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.OVERTIME_APPROVE, PERMISSIONS.CORRECTIONS_APPROVE];

function greeting(t: ReturnType<typeof useI18n>['t'], ms: number): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', hour: '2-digit', hour12: false }).format(new Date(ms)));
  if (hour < 12) return t.home.greetingMorning;
  if (hour < 18) return t.home.greetingAfternoon;
  return t.home.greetingEvening;
}

/** Minutes since midnight in company time. */
function ammanMinuteOfDay(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/** "HH:MM" -> minutes since midnight. */
function clockToMinutes(value: string): number {
  const [h = 0, m = 0] = value.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

/**
 * Work minutes added since the status snapshot while the employee is on a break. Break time counts as
 * work while it fits in the day's remaining break allowance, and a counts-as-work break type also up to
 * its maximum; only the rest is lost. `counting` says whether the break still counts at `now`.
 */
function workDuringBreak(data: AttendanceStatusDto, now: number): { minutes: number; counting: boolean } {
  const snap = Date.parse(data.serverTime);
  const since = Math.max(0, (now - snap) / 60_000);
  if (data.state !== 'ON_BREAK' || !data.openBreak) return { minutes: 0, counting: false };
  const type = data.openBreak.breakType;
  const started = Date.parse(data.openBreak.startedAt);
  const max = type.maxMinutes;
  const over = (t: number) => (max === null ? 0 : Math.max(0, (t - started) / 60_000 - max));
  const deductible = !type.countsAsWork ? since : max === null ? 0 : Math.max(0, over(now) - over(snap));
  const allowanceLeft = data.today.breakAllowanceLeftMinutes;
  return { minutes: since - Math.max(0, deductible - allowanceLeft), counting: deductible < allowanceLeft || (type.countsAsWork && over(now) === 0) };
}

function breakName(b: BreakTypeDto, locale: 'en' | 'ar'): string {
  return (locale === 'ar' && b.nameAr) || b.name;
}

function Stat({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <dt className="text-muted-foreground truncate text-xs">{label}</dt>
      <dd className="num truncate text-lg font-semibold">{children}</dd>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-5">
      <Skeleton className="order-first h-56 rounded-2xl lg:order-none lg:col-span-2 lg:col-start-4 lg:row-start-1" />
      <Skeleton className="h-28 rounded-2xl lg:col-span-3 lg:row-start-1" />
      <Skeleton className="h-40 rounded-2xl lg:col-span-5" />
    </div>
  );
}

export default function HomePage() {
  const { user, can } = useAuth();
  const { t } = useI18n();

  useEffect(() => {
    document.title = `${t.nav.home} · ${t.common.appName}`;
  }, [t]);

  if (!user.employee || !can(PERMISSIONS.ATTENDANCE_SELF)) {
    return (
      <EmptyState
        className="mx-auto max-w-lg"
        icon={CalendarClock}
        title={t.home.noEmployee}
        description={t.employeeSelfService.noEmployeeBody}
        action={
          can(PERMISSIONS.DASHBOARD_READ) ? (
            <Button asChild variant="outline">
              <Link href="/admin">
                {t.home.noEmployeeAdmin}
                <ArrowRight className="rtl:-scale-x-100" aria-hidden />
              </Link>
            </Button>
          ) : undefined
        }
      />
    );
  }
  return <EmployeeDay />;
}

/**
 * The inline error under the actions. `state` is the attendance state the error was about: once the
 * server reports another state (the action went through after all, or the stale work period was closed),
 * the error no longer applies and is dropped. 'connection': no response arrived; 'location': no device
 * position, or the server refused the one sent (with a hint on how to fix it).
 */
type ActionError =
  | { kind: 'connection'; action: AttendanceActionPath; breakTypeId?: string; state: AttendanceState }
  | { kind: 'stale'; sessionId: string | null; startedAt: string | null; state: AttendanceState }
  | { kind: 'location'; action: AttendanceActionPath; message: string; hint?: string; state: AttendanceState }
  | { kind: 'other'; message: string };

const LOCATION_ERRORS = ['LOCATION_REQUIRED', 'LOCATION_INACCURATE', 'LOCATION_OUTSIDE_OFFICE', 'LOCATION_NOT_CONFIGURED'];

const numberOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface LastAction {
  action: AttendanceActionPath;
  /** Server time of the response. */
  at: string;
  /** Check-out: the work period that was closed (for the correction link). */
  sessionId: string | null;
}

interface Headline {
  color: string;
  icon: LucideIcon;
  mirror?: boolean;
  title: ReactNode;
  sub?: ReactNode;
  /** Check-in is not expected today (leave, holiday, day off): offer it only as a small secondary action. */
  demoteCheckIn?: boolean;
  /** Checked out earlier today: Check in again is outlined, not as loud as the primary action. */
  checkedOut?: boolean;
}

function EmployeeDay() {
  const { user, can } = useAuth();
  const { t, locale, units, errorMessage } = useI18n();
  const s = t.employeeSelfService;
  const h = s.home;
  const { isVisible } = usePortal();
  const showBreaks = isVisible('home.breaks');
  const showSummary = isVisible('home.summary');
  const showActivity = isVisible('home.activity');
  const showCorrections = isVisible('corrections');
  const showLeaveDocs = isVisible('leave.documents');
  // My leave hidden by HR: the balances stay visible here (an employee's own balances are never hidden).
  const showBalances = !isVisible('leave') && can(PERMISSIONS.LEAVE_SELF);

  const status = useApi<AttendanceStatusDto>('/attendance/me/status', undefined, { refreshMs: 60_000, refetchOnFocus: true });
  const today = todayInAmman();
  const events = useApi<Paginated<AttendanceEventDto>>(showActivity ? '/attendance/me/events' : null, {
    from: addDays(today, -6),
    to: today,
    page: 1,
    pageSize: 8,
  });
  const sessions = useApi<CorrectableSessionDto[]>('/corrections/me/sessions');
  // Only for "Document needed" (today's leave and holiday come with the status).
  const leaveRequests = useApi<LeaveRequestDto[]>(can(PERMISSIONS.LEAVE_SELF) && showLeaveDocs ? '/leave/me/requests' : null);
  const balances = useApi<LeaveBalanceDto[]>(showBalances ? '/leave/me/balances' : null, { year: Number(today.slice(0, 4)) });
  const leaveAmount = useLeaveAmount('long');
  const approvals = useApi<ApprovalSummaryDto>(can(...APPROVER_PERMISSIONS) ? '/approvals/summary' : null, undefined, { refetchOnFocus: true });
  const { run, pending, guarded } = useAttendanceAction();
  const [offset, setOffset] = useState(0);
  const [breakPickerOpen, setBreakPickerOpen] = useState(false);
  const [confirmCheckOut, setConfirmCheckOut] = useState(false);
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [actionAt, setActionAt] = useState<Date | null>(null);
  const geo = useDeviceLocation();
  /** Check-in / check-out waiting for the device position before the request is sent. */
  const [locatingFor, setLocatingFor] = useState<AttendanceActionPath | null>(null);
  /** The outcome of "Check my location", announced once (the chip alone is not announced). */
  const [locationMessage, setLocationMessage] = useState('');

  const data = status.data;
  useEffect(() => {
    if (data) setOffset(Date.parse(data.serverTime) - Date.now());
  }, [data]);
  const now = useNow(offset);

  const employee = user.employee;
  const name = (locale === 'ar' && employee?.fullNameAr) || employee?.fullName || user.username;

  const activeBreakTypes = useMemo(() => (data?.breakTypes ?? []).filter((b) => b.isActive), [data]);

  if (status.loading && !data) return <HomeSkeleton />;
  if (!data) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;

  // Check-in and check-out send the device location. Approved remote work today waives the office rule
  // (the server marks those events remote); under FLAG the server accepts them away from the office too.
  const loc = data.location;
  const enforced = loc.enforcement === 'ENFORCE' && !loc.remote;
  const flagged = loc.enforcement === 'FLAG' && !loc.remote;
  const noOffices = loc.offices.length === 0;
  // No office location set up under ENFORCE: the server refuses every check-in and check-out.
  const blocked = enforced && noOffices;
  const position = geo.result?.ok ? geo.result : null;
  const verdict = position ? officeVerdict(position.location, loc.offices) : null;
  const distance = (m: number) => formatDistance(m, locale);

  // Errors that the current server state contradicts are dropped (e.g. "couldn't reach the server" when the
  // check-in went through after all).
  const errorStillApplies = (e: ActionError): boolean => {
    if (e.kind === 'connection' || e.kind === 'stale' || e.kind === 'location') return e.state === data.state;
    return true;
  };
  const shownError = actionError && errorStillApplies(actionError) ? actionError : null;
  if (actionError && !shownError) setActionError(null);

  // Live figures: the server snapshot plus time elapsed since serverTime. The requirement includes the
  // break allowance, so a break inside it keeps counting and "remaining" is always from the full day.
  const sinceSnapshotMin = Math.max(0, (now - Date.parse(data.serverTime)) / 60_000);
  const onBreak = workDuringBreak(data, now);
  const liveNet = data.today.netWorkMinutes + (data.state === 'WORKING' ? sinceSnapshotMin : onBreak.minutes);
  const liveBreak = data.today.breakMinutes + (data.state === 'ON_BREAK' ? sinceSnapshotMin : 0);
  const required = data.today.requiredMinutes;
  const remaining = Math.max(0, required - liveNet);
  const extra = Math.max(data.today.extraMinutes, required > 0 ? liveNet - required : 0);
  const done = required > 0 && liveNet >= required;

  const sched = data.today.scheduled;
  const nowMin = ammanMinuteOfDay(now);
  const coreEndMin = sched.type === 'FLEXIBLE' && sched.isWorkday && sched.coreEnd ? clockToMinutes(sched.coreEnd) : null;
  const insideCore = coreEndMin !== null && nowMin < coreEndMin;
  const earlyCheckOut = sched.isWorkday && required > 0 && remaining >= 1;
  const needsCheckOutConfirm = earlyCheckOut || insideCore;

  const busy = pending !== null || locatingFor !== null;
  /** The button showing a spinner: the action being located or sent. */
  const spinning = pending ?? locatingFor;
  const breakMax = data.openBreak?.breakType.maxMinutes ?? null;
  const breakElapsedMin = data.openBreak ? Math.max(0, (now - Date.parse(data.openBreak.startedAt)) / 60_000) : 0;
  const breakOver = breakMax !== null && breakElapsedMin > breakMax;

  const correctionHref = (sessionId?: string | null) =>
    sessionId ? `/me/corrections?new=1&session=${encodeURIComponent(sessionId)}` : '/me/corrections?new=1';

  // The previous error stays on screen while the action runs (a focused Try again keeps its place) and is
  // replaced by the outcome.
  const act = async (action: AttendanceActionPath, breakTypeId?: string) => {
    const stateBefore = data.state;
    const closingSessionId = action === 'check-out' ? (data.openSession?.id ?? null) : null;
    // Check-in and check-out take a fresh position first (breaks carry none). Without one the request is
    // not sent when the office rule applies; under FLAG or remote work the server decides without it.
    let location: DeviceLocation | undefined;
    if (action === 'check-in' || action === 'check-out') {
      setLocatingFor(action);
      const found = await geo.locate();
      setLocatingFor(null);
      if (found.ok) location = found.location;
      else if (enforced) {
        setActionError({ kind: 'location', action, message: h.geo[found.reason], hint: h.geoHelp[found.reason], state: stateBefore });
        toast.error(h.geo[found.reason]);
        return;
      }
    }
    const outcome = await run(action, breakTypeId, location);
    if (outcome.ok) {
      setActionError(null);
      status.setData(outcome.status);
      // A background status request started before the action (focus or poll) could still land after this
      // response and put the old state back: a foreground refetch aborts it and reads the committed state.
      void status.refetch();
      setActionAt(new Date());
      setBreakPickerOpen(false);
      setLastAction({ action, at: outcome.status.serverTime, sessionId: closingSessionId });
      void events.refetch();
      if (action === 'check-in' || action === 'check-out') void sessions.refetch();
      return;
    }
    if (outcome.retryable) {
      setActionError({ kind: 'connection', action, breakTypeId, state: stateBefore });
      toast.error(h.errorNetwork);
      return;
    }
    const details = (outcome.error.details ?? null) as Record<string, unknown> | null;
    if (outcome.error.code === 'ATTENDANCE_INVALID_TRANSITION' && details?.reason === 'STALE_SESSION') {
      setActionError({
        kind: 'stale',
        sessionId: typeof details.sessionId === 'string' ? details.sessionId : null,
        startedAt: typeof details.startedAt === 'string' ? details.startedAt : null,
        state: stateBefore,
      });
      toast.error(t.home.staleSession);
    } else if (LOCATION_ERRORS.includes(outcome.error.code)) {
      const away = numberOr(details?.distanceMeters);
      const radius = numberOr(details?.radiusMeters);
      const office = typeof details?.officeName === 'string' ? details.officeName : null;
      const accuracy = numberOr(details?.accuracyMeters);
      const max = numberOr(details?.maxAccuracyMeters);
      let message = errorMessage(outcome.error);
      if (outcome.error.code === 'LOCATION_OUTSIDE_OFFICE' && away !== null && radius !== null && office) {
        message = fmt(h.errorOutside, { distance: distance(away), office, radius: distance(radius) });
      } else if (outcome.error.code === 'LOCATION_INACCURATE' && accuracy !== null && max !== null) {
        message = fmt(h.errorInaccurate, { accuracy: distance(accuracy), max: distance(max) });
      } else if (outcome.error.code === 'LOCATION_NOT_CONFIGURED') {
        message = h.errorNotConfigured;
      }
      setActionError({ kind: 'location', action, message, state: stateBefore });
      toast.error(message);
    } else {
      setActionError({ kind: 'other', message: errorMessage(outcome.error) });
      toast.error(errorMessage(outcome.error));
    }
    // The server state differs from what we showed - resync.
    if (['ATTENDANCE_INVALID_TRANSITION', 'BREAK_TYPE_INACTIVE', 'IDEMPOTENCY_KEY_REUSED', ...LOCATION_ERRORS].includes(outcome.error.code)) {
      setBreakPickerOpen(false);
      void status.refetch();
      void events.refetch();
    }
  };

  /** Primary buttons ignore taps while a request runs and for 2 s after a success (aria-disabled, not disabled). */
  const press = (action: AttendanceActionPath) => {
    if (busy || guarded) return;
    if (action === 'check-out' && needsCheckOutConfirm) {
      setConfirmCheckOut(true);
      return;
    }
    void act(action);
  };

  const startBreak = () => {
    if (busy || guarded) return;
    if (activeBreakTypes.length === 1 && activeBreakTypes[0]) void act('break/start', activeBreakTypes[0].id);
    else setBreakPickerOpen(true);
  };

  // ── State headline ──
  const timeNode = (iso: string | null) => <bdi className="tabular">{formatTime(iso, locale)}</bdi>;
  const leaveToday = data.todayLeave ?? null;
  const holidayToday = data.todayHoliday ?? null;
  const checkedOutSessionId =
    (lastAction?.action === 'check-out' ? lastAction.sessionId : null) ??
    (sessions.data ?? []).find((x) => x.endedAt !== null && x.endedAt === data.today.lastOut)?.id ??
    null;

  const wrongLink = (
    <span className="text-muted-foreground">
      {h.wrong}{' '}
      {showCorrections ? (
        <Link href={correctionHref(checkedOutSessionId)} className="text-link font-medium underline-offset-4 hover:underline">
          {s.requestCorrection}
        </Link>
      ) : (
        s.contactHr
      )}
    </span>
  );

  let headline: Headline;
  if (data.state === 'WORKING' && data.openSession) {
    headline = { color: 'var(--status-working)', icon: Timer, title: <Interpolate text={h.workingSince} vars={{ time: timeNode(data.openSession.startedAt) }} /> };
  } else if (data.state === 'ON_BREAK' && data.openBreak) {
    const vars = { type: <bdi>{breakName(data.openBreak.breakType, locale)}</bdi>, elapsed: <bdi className="tabular">{Math.floor(breakElapsedMin)}</bdi>, max: <bdi className="tabular">{breakMax}</bdi> };
    headline = {
      color: breakOver ? 'var(--status-absent)' : 'var(--status-break)',
      icon: Coffee,
      title: <Interpolate text={breakMax !== null ? h.onBreakOf : h.onBreak} vars={vars} />,
    };
  } else if (data.today.status === 'ON_LEAVE') {
    const type = leaveToday ? localized(locale, leaveToday.leaveTypeName, leaveToday.leaveTypeNameAr) : '';
    headline = {
      color: 'var(--status-leave)',
      icon: Plane,
      title: type ? <Interpolate text={h.onLeave} vars={{ type: <bdi>{type}</bdi> }} /> : h.onLeavePlain,
      demoteCheckIn: true,
    };
  } else if (!sched.isWorkday && !data.today.firstIn) {
    headline = holidayToday
      ? {
          color: 'var(--status-leave)',
          icon: PartyPopper,
          title: <Interpolate text={h.holidayNamed} vars={{ name: <bdi>{localized(locale, holidayToday.name, holidayToday.nameAr)}</bdi> }} />,
          demoteCheckIn: true,
        }
      : { color: 'var(--status-none)', icon: Moon, title: h.dayOff, demoteCheckIn: true };
  } else if (data.today.lastOut) {
    headline = {
      color: 'var(--status-out)',
      icon: LogOut,
      mirror: true,
      title: <Interpolate text={h.checkedOutAt} vars={{ time: timeNode(data.today.lastOut) }} />,
      sub: wrongLink,
      checkedOut: true,
    };
  } else {
    let sub: ReactNode;
    let color = 'var(--brand-soft)';
    if (sched.isWorkday && sched.type === 'FIXED' && sched.start) {
      const diff = clockToMinutes(sched.start) - nowMin;
      const vars = { time: <bdi className="tabular">{sched.start.slice(0, 5)}</bdi>, d: <Minutes value={Math.abs(diff)} /> };
      if (diff > 0) sub = <Interpolate text={h.shiftStarts} vars={vars} />;
      else {
        sub = <Interpolate text={h.shiftLate} vars={vars} />;
        if (diff < 0) color = 'var(--status-missing)';
      }
    } else if (sched.isWorkday && sched.type === 'FLEXIBLE' && sched.coreStart && sched.coreEnd) {
      sub = <Interpolate text={h.coreHours} vars={{ range: <TimeRange start={sched.coreStart} end={sched.coreEnd} /> }} />;
    }
    headline = { color, icon: Clock, title: h.notCheckedIn, sub };
  }

  const HeadIcon = headline.icon;
  const updatedAt = [status.lastUpdatedAt, actionAt].filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0];

  // ── Confirmation after the last action (announced politely; check-out is already the headline). ──
  const confirmation = lastAction
    ? {
        'check-in': h.checkedInAt,
        'check-out': h.checkedOutDone,
        'break/start': h.breakStartedAt,
        'break/end': h.breakEndedAt,
      }[lastAction.action]
    : null;
  const confirmationText = lastAction && confirmation ? fmt(confirmation, { time: formatTime(lastAction.at, locale) }) : '';

  // ── Needs your attention ──
  const openPeriods = (sessions.data ?? []).filter((x) => x.status === 'MISSING_CHECKOUT');
  const missingDocs = showLeaveDocs
    ? (leaveRequests.data ?? []).filter(
        (r) => (r.status === 'PENDING' || r.status === 'APPROVED') && r.leaveType?.requiresAttachment && r.documents.length === 0 && r.endDate >= addDays(today, -30),
      )
    : [];
  const pendingApprovals = approvals.data?.pending;
  const waitingParts = pendingApprovals
    ? [
        pendingApprovals.leave > 0 ? fmt(h.waitingLeave, { n: pendingApprovals.leave }) : null,
        pendingApprovals.overtime > 0 ? fmt(h.waitingOvertime, { n: pendingApprovals.overtime }) : null,
        pendingApprovals.correction > 0 ? fmt(h.waitingCorrections, { n: pendingApprovals.correction }) : null,
      ].filter((x): x is string => x !== null)
    : [];
  const hasAttention = openPeriods.length > 0 || missingDocs.length > 0 || waitingParts.length > 0;
  const leaveDates = (r: LeaveRequestDto) =>
    r.startDate === r.endDate ? formatWorkDate(r.startDate, locale) : `${formatWorkDate(r.startDate, locale)} – ${formatWorkDate(r.endDate, locale)}`;

  // ── Location chip: nearest office and distance once a position is known ──
  const describePosition = (r: GeoResult | null): { tone: string; icon: LucideIcon; text: string } => {
    const away = enforced ? 'var(--status-absent)' : 'var(--status-break)';
    if (loc.remote) return { tone: 'var(--brand-soft)', icon: ShieldCheck, text: h.remoteToday };
    if (noOffices) return { tone: away, icon: MapPinOff, text: h.noOffices };
    if (!r) return { tone: 'var(--status-none)', icon: MapPin, text: h.locationUnknown };
    if (!r.ok) return { tone: away, icon: MapPinOff, text: h.locationFailed };
    const v = officeVerdict(r.location, loc.offices);
    if (!v) return { tone: away, icon: MapPinOff, text: h.noOffices };
    if (r.location.accuracy > loc.maxAccuracyMeters) return { tone: 'var(--status-break)', icon: MapPinOff, text: fmt(h.locationVague, { accuracy: distance(r.location.accuracy) }) };
    const vars = { distance: distance(v.distance), office: v.office.name };
    return v.inside
      ? { tone: 'var(--status-working)', icon: MapPin, text: fmt(h.nearOffice, vars) }
      : { tone: away, icon: MapPinOff, text: fmt(h.farFromOffice, vars) };
  };
  const chip = geo.locating && !geo.result && !loc.remote && !noOffices
    ? { tone: 'var(--status-none)', icon: Loader2, text: h.locating }
    : describePosition(geo.result);
  const ChipIcon = chip.icon;

  const locationDetails = (
    <>
      {position && (
        <p>
          {fmt(h.accuracy, { accuracy: distance(position.location.accuracy) })}
          {' · '}
          {fmt(h.locatedAt, { time: formatTime(position.at, locale) })}
        </p>
      )}
      {verdict && <p>{fmt(h.officeRadius, { office: verdict.office.name, radius: distance(verdict.office.radiusMeters) })}</p>}
      {geo.result && !geo.result.ok && (
        <p>
          {h.geo[geo.result.reason]} {h.geoHelp[geo.result.reason]}
        </p>
      )}
      {flagged && <p>{t.home.flagNotice}</p>}
      {loc.remote && <p>{t.home.remoteNotice}</p>}
      <p>{h.locationHint}</p>
    </>
  );

  // Asks for the location permission only here, on a press. aria-disabled, not disabled, while locating:
  // a focused button that becomes disabled loses focus.
  const checkLocation = async () => {
    if (geo.locating || busy) return;
    setLocationMessage('');
    const r = await geo.locate();
    setLocationMessage(r.ok ? describePosition(r).text : `${h.geo[r.reason]} ${h.geoHelp[r.reason]}`);
  };
  const checkLocationButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="max-md:min-h-10 aria-disabled:opacity-60"
      onClick={() => void checkLocation()}
      aria-disabled={geo.locating || busy || undefined}
    >
      {geo.locating ? <Loader2 className="animate-spin" aria-hidden /> : geo.result ? <RefreshCw aria-hidden /> : <LocateFixed aria-hidden />}
      {geo.result ? h.checkAgain : h.checkLocation}
    </Button>
  );

  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-5 lg:items-start">
      {/* Left column on large screens: identity, attention, today. On phones the column dissolves (contents). */}
      <div className="contents lg:col-span-3 lg:grid lg:gap-4">
        {/* Identity: one line greeting, one line clock, location chip */}
        <Card className="relative gap-3 overflow-hidden py-4">
          <div className="bg-brand-gradient absolute inset-x-0 top-0 h-[2px] opacity-70" aria-hidden />
          <CardContent className="space-y-3 px-4 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="min-w-0 truncate text-lg font-bold sm:text-xl">
                <Interpolate text={h.greeting} vars={{ greeting: greeting(t, now), name: <bdi>{name}</bdi> }} />
              </h1>
              <StateBadge state={data.state} pulse={data.state !== 'OFF'} />
            </div>
            <p className="text-muted-foreground text-sm" aria-live="off">
              <bdi className="num text-foreground font-semibold">{formatTime(now, locale, true)}</bdi>
              {' · '}
              {formatClockDate(now, locale)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold"
                style={{
                  color: chip.tone,
                  borderColor: `color-mix(in srgb, ${chip.tone} 30%, transparent)`,
                  background: `color-mix(in srgb, ${chip.tone} 10%, transparent)`,
                }}
              >
                <ChipIcon className={cn('size-3.5 shrink-0', chip.icon === Loader2 && 'animate-spin')} aria-hidden />
                <span className="tabular min-w-0">
                  <bdi>{chip.text}</bdi>
                </span>
              </span>
              {!noOffices && checkLocationButton}
              <p role="status" className="sr-only">
                {locationMessage}
              </p>
              <details className="text-muted-foreground w-full text-xs [&[open]>summary]:mb-1.5">
                <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-md underline-offset-4 hover:underline">{h.details}</summary>
                <div className="space-y-1">{locationDetails}</div>
              </details>
            </div>
          </CardContent>
        </Card>

        {/* Needs your attention: only when something is waiting */}
        {hasAttention && (
          <Card className="gap-3 py-4">
            <CardHeader className="px-4 sm:px-5">
              <CardTitle className="text-base">{h.attentionTitle}</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <ul className="divide-y divide-tint/[0.05]">
                {openPeriods.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <AlarmClockOff className="size-4 shrink-0 text-[color:var(--status-missing)]" aria-hidden />
                      {fmt(h.noCheckOut, { date: formatWorkDate(p.workDate, locale) })}
                    </span>
                    {p.pendingCorrection ? (
                      <span className="text-muted-foreground text-xs">{h.correctionPending}</span>
                    ) : showCorrections ? (
                      <Button asChild size="sm" variant="outline" className="max-md:min-h-10">
                        <Link href={correctionHref(p.id)}>{h.fix}</Link>
                      </Button>
                    ) : (
                      <span className="text-muted-foreground text-xs">{s.contactHr}</span>
                    )}
                  </li>
                ))}
                {missingDocs.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <FilePlus className="size-4 shrink-0 text-[color:var(--status-break)]" aria-hidden />
                      <Interpolate
                        text={h.documentNeeded}
                        vars={{ type: <bdi>{localized(locale, r.leaveType?.name, r.leaveType?.nameAr)}</bdi>, dates: <span className="tabular">{leaveDates(r)}</span> }}
                      />
                    </span>
                    <Button asChild size="sm" variant="outline" className="max-md:min-h-10">
                      <Link href={`/me/leave?request=${encodeURIComponent(r.id)}`}>{h.addDocument}</Link>
                    </Button>
                  </li>
                ))}
                {waitingParts.length > 0 && (
                  <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <ClipboardCheck className="size-4 shrink-0 text-[color:var(--brand-soft)]" aria-hidden />
                      {fmt(h.waitingForYou, { list: waitingParts.join(h.listSeparator) })}
                    </span>
                    <Button asChild size="sm" variant="outline" className="max-md:min-h-10">
                      <Link href="/admin/approvals">{h.openApprovals}</Link>
                    </Button>
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Today */}
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">{t.home.today}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {data.today.remote && <RemoteBadge />}
              {data.today.isLate && <LateBadge minutes={data.today.lateMinutes} />}
              <span className="text-muted-foreground text-xs">
                {sched.isWorkday ? (
                  sched.type === 'FLEXIBLE' ? (
                    sched.coreStart && sched.coreEnd ? (
                      <Interpolate text={h.coreHours} vars={{ range: <TimeRange start={sched.coreStart} end={sched.coreEnd} /> }} />
                    ) : (
                      t.home.flexible
                    )
                  ) : (
                    <TimeRange start={sched.start} end={sched.end} />
                  )
                ) : (
                  s.dayOff
                )}
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  <Minutes value={liveNet} dimZero={false} className="num text-3xl font-bold" />
                  <span className="text-muted-foreground text-xs">{s.hoursWorked}</span>
                </span>
                {required > 0 && (
                  <span className="text-muted-foreground text-xs">
                    <Interpolate text={t.home.ofRequired} vars={{ d: <Minutes value={required} /> }} />
                  </span>
                )}
              </div>
              {required > 0 && <ProgressBar value={liveNet} max={required} label={s.hoursWorked} />}
              {done ? (
                <p className="flex items-center gap-1.5 text-sm font-medium text-[color:var(--status-working)]">
                  <CircleCheck className="size-4" aria-hidden />
                  {h.doneForToday}
                </p>
              ) : (data.state === 'WORKING' || onBreak.counting) && required > 0 ? (
                <p className="text-muted-foreground text-sm">
                  <Interpolate text={h.expectedFinish} vars={{ time: <bdi className="text-foreground tabular font-semibold">{formatTime(now + remaining * 60_000, locale)}</bdi> }} />
                </p>
              ) : null}
            </div>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label={t.home.breaks}>
                <Minutes value={liveBreak} />
              </Stat>
              <Stat label={extra > 0 ? t.home.extra : t.home.remaining}>
                <Minutes value={extra > 0 ? extra : remaining} className={extra > 0 ? 'text-[color:var(--status-working)]' : undefined} />
              </Stat>
              <Stat label={t.home.firstIn}>
                <bdi>{formatTime(data.today.firstIn, locale)}</bdi>
              </Stat>
              <Stat label={t.home.lastOut}>
                <bdi>{formatTime(data.today.lastOut, locale)}</bdi>
              </Stat>
            </dl>
          </CardContent>
        </Card>
      </div>

      {/* Right column on large screens: actions (first on phones), week and month. */}
      <div className="contents lg:col-span-2 lg:grid lg:gap-4">
        <Card className="order-first gap-4 lg:order-none">
          <CardContent className="flex flex-col gap-4">
            {/* State headline */}
            <div className="flex items-start gap-3">
              <span
                className="flex size-11 shrink-0 items-center justify-center rounded-2xl"
                style={{ color: headline.color, background: `color-mix(in srgb, ${headline.color} 14%, transparent)` }}
              >
                <HeadIcon className={cn('size-5', headline.mirror && 'rtl:-scale-x-100')} aria-hidden />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-xl leading-snug font-bold" style={{ color: headline.color }}>
                  {headline.title}
                </p>
                {headline.sub && <p className="text-sm">{headline.sub}</p>}
                {updatedAt && (
                  <p className={cn('text-xs', status.stale ? 'text-[color:var(--status-missing)]' : 'text-muted-foreground')}>
                    {fmt(h.updated, { time: formatTime(updatedAt, locale) })}
                  </p>
                )}
              </div>
            </div>

            {data.state === 'WORKING' && data.openSession && (
              <div className="space-y-0.5">
                <p className="text-muted-foreground text-xs">{h.currentPeriod}</p>
                <LiveTimer since={data.openSession.startedAt} offsetMs={offset} className="text-3xl font-bold" />
              </div>
            )}

            {data.state === 'ON_BREAK' && data.openBreak && (
              <div className="space-y-2">
                <LiveTimer since={data.openBreak.startedAt} offsetMs={offset} className={cn('text-3xl font-bold', breakOver && 'text-[color:var(--status-absent)]')} />
                {breakMax !== null && (
                  <>
                    <ProgressBar value={breakElapsedMin} max={breakMax} tone="warn" label={fmt(t.home.breakLimit, { n: breakMax })} />
                    <p className={cn('text-xs', breakOver ? 'text-[color:var(--status-absent)]' : 'text-muted-foreground')}>
                      {breakOver ? fmt(t.home.breakOver, { n: breakMax }) : fmt(t.home.breakLimit, { n: breakMax })}
                    </p>
                  </>
                )}
              </div>
            )}

            {/* Confirmation of the last action: persistent, announced politely. */}
            <p role="status" className={cn('text-sm font-medium text-[color:var(--status-working)]', (!lastAction || lastAction.action === 'check-out') && 'sr-only')}>
              {confirmationText}
            </p>

            {/* Inline errors (toasts are only a secondary channel). */}
            {(shownError || blocked) && (
              <div
                role="alert"
                className="space-y-2 rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm"
              >
                {shownError?.kind === 'connection' ? (
                  <>
                    <p className="flex items-center gap-1.5 font-medium">
                      <CircleAlert className="size-4 shrink-0 text-[color:var(--status-absent)]" aria-hidden />
                      {h.errorNetwork}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="max-md:min-h-10 aria-disabled:opacity-60"
                      aria-disabled={busy || undefined}
                      onClick={() => {
                        if (!busy) void act(shownError.action, shownError.breakTypeId);
                      }}
                    >
                      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                      {h.tryAgain}
                    </Button>
                  </>
                ) : shownError?.kind === 'stale' ? (
                  <>
                    <p className="flex items-center gap-1.5 font-medium">
                      <CircleAlert className="size-4 shrink-0 text-[color:var(--status-absent)]" aria-hidden />
                      {fmt(h.errorStale, {
                        day: shownError.startedAt
                          ? `${formatWeekday(todayInAmman(Date.parse(shownError.startedAt)), locale, 'long')} ${formatWorkDate(todayInAmman(Date.parse(shownError.startedAt)), locale)}`
                          : '—',
                      })}
                    </p>
                    {/* Only a check-in is accepted now: it closes the open period as "missing check-out", which the
                        correction form then prefills (Needs your attention → Fix). */}
                    <p className="text-muted-foreground text-xs">{showCorrections ? h.staleCheckInHint : h.staleCheckInHintHr}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="max-md:min-h-10 aria-disabled:opacity-60"
                      disabled={blocked}
                      aria-disabled={busy || guarded || undefined}
                      onClick={() => {
                        if (!busy && !guarded) void act('check-in');
                      }}
                    >
                      {spinning === 'check-in' ? <Loader2 className="animate-spin" aria-hidden /> : <LogIn className="rtl:-scale-x-100" aria-hidden />}
                      {h.checkInNow}
                    </Button>
                  </>
                ) : shownError?.kind === 'location' ? (
                  <>
                    <p className="flex items-start gap-1.5 font-medium">
                      <MapPinOff className="mt-0.5 size-4 shrink-0 text-[color:var(--status-absent)]" aria-hidden />
                      <span className="tabular">{shownError.message}</span>
                    </p>
                    {shownError.hint && <p className="text-muted-foreground text-xs">{shownError.hint}</p>}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="max-md:min-h-10 aria-disabled:opacity-60"
                      disabled={blocked}
                      aria-disabled={busy || guarded || undefined}
                      onClick={() => {
                        if (!busy && !guarded) void act(shownError.action);
                      }}
                    >
                      {spinning === shownError.action ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                      {h.tryAgain}
                    </Button>
                  </>
                ) : shownError?.kind === 'other' ? (
                  <p className="flex items-center gap-1.5 font-medium">
                    <CircleAlert className="size-4 shrink-0 text-[color:var(--status-absent)]" aria-hidden />
                    {shownError.message}
                  </p>
                ) : (
                  <p className="flex items-start gap-1.5 font-medium">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[color:var(--status-absent)]" aria-hidden />
                    {h.errorNotConfigured}
                  </p>
                )}
              </div>
            )}

            <div className="mt-auto grid gap-2.5">
              {data.state === 'OFF' &&
                (headline.demoteCheckIn ? (
                  <Button
                    variant="ghost"
                    className="text-muted-foreground min-h-10 justify-self-center underline-offset-4 hover:underline"
                    disabled={blocked}
                    aria-disabled={busy || guarded || undefined}
                    onClick={() => press('check-in')}
                  >
                    {spinning === 'check-in' ? <Loader2 className="animate-spin" aria-hidden /> : <LogIn className="rtl:-scale-x-100" aria-hidden />}
                    {h.checkInAnyway}
                  </Button>
                ) : (
                  <Button
                    size="xl"
                    variant={headline.checkedOut ? 'outline' : 'default'}
                    className="min-h-14 w-full aria-disabled:opacity-60"
                    disabled={blocked}
                    aria-disabled={busy || guarded || undefined}
                    onClick={() => press('check-in')}
                  >
                    {spinning === 'check-in' ? <Loader2 className="animate-spin" aria-hidden /> : <LogIn className="rtl:-scale-x-100" aria-hidden />}
                    {headline.checkedOut ? h.checkInAgain : t.home.checkIn}
                  </Button>
                ))}
              {data.state === 'WORKING' && (
                <>
                  <Button
                    size="xl"
                    variant="blue"
                    className="min-h-14 w-full aria-disabled:opacity-60"
                    disabled={blocked}
                    aria-disabled={busy || guarded || undefined}
                    onClick={() => press('check-out')}
                  >
                    {spinning === 'check-out' ? <Loader2 className="animate-spin" aria-hidden /> : <LogOut className="rtl:-scale-x-100" aria-hidden />}
                    {t.home.checkOut}
                  </Button>
                  {showBreaks && (
                    <>
                      <Button
                        size="lg"
                        variant="outline"
                        className="w-full"
                        disabled={activeBreakTypes.length === 0}
                        aria-disabled={busy || guarded || undefined}
                        onClick={startBreak}
                      >
                        {pending === 'break/start' ? <Loader2 className="animate-spin" aria-hidden /> : <Coffee aria-hidden />}
                        {t.home.startBreak}
                      </Button>
                      {activeBreakTypes.length === 0 && <p className="text-muted-foreground text-center text-xs">{t.home.noBreakTypes}</p>}
                    </>
                  )}
                </>
              )}
              {data.state === 'ON_BREAK' && (
                <Button size="xl" className="min-h-14 w-full aria-disabled:opacity-60" aria-disabled={busy || guarded || undefined} onClick={() => press('break/end')}>
                  {pending === 'break/end' ? <Loader2 className="animate-spin" aria-hidden /> : <TimerReset aria-hidden />}
                  {t.home.endBreak}
                </Button>
              )}
              {/* Check-in / check-out wait for the device position first. */}
              <p role="status" className={cn('text-muted-foreground flex items-center justify-center gap-1.5 text-xs', !locatingFor && 'sr-only')}>
                {locatingFor && (
                  <>
                    <MapPin className="size-3.5" aria-hidden />
                    {h.locating}
                  </>
                )}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Week / month */}
        {showSummary && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            {([
              ['week', t.home.thisWeek, data.week],
              ['month', t.home.thisMonth, data.month],
            ] as const).map(([key, label, period]) => (
              <Card key={key} className="gap-3">
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground text-xs">{label}</span>
                    {period.extraMinutes > 0 && (
                      <span className="rounded-full bg-[color:var(--status-working)]/10 px-2 py-0.5 text-xs font-semibold text-[color:var(--status-working)]">
                        +<Minutes value={period.extraMinutes} /> {t.home.extraHours}
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <Minutes value={period.netWorkMinutes} dimZero={false} className="num text-2xl font-bold" />
                    {period.requiredMinutes > 0 && (
                      <span className="text-muted-foreground text-xs">
                        <Interpolate text={t.home.ofRequired} vars={{ d: <Minutes value={period.requiredMinutes} /> }} />
                      </span>
                    )}
                  </div>
                  {period.requiredMinutes > 0 && <ProgressBar value={period.netWorkMinutes} max={period.requiredMinutes} label={label} />}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Leave balances, read-only, while HR has hidden the My leave page. */}
        {showBalances && (balances.error && !balances.data ? (
          <Card className="gap-0 py-0">
            <ErrorState compact error={balances.error} onRetry={() => void balances.refetch()} />
          </Card>
        ) : balances.data && balances.data.length > 0 ? (
          <Card className="gap-3">
            <CardHeader className="flex flex-row items-baseline justify-between gap-2">
              <CardTitle className="text-base">{h.balancesTitle}</CardTitle>
              <span className="text-muted-foreground text-xs">{t.leave.available}</span>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-tint/[0.05]">
                {balances.data.map((b) => (
                  <div key={b.leaveType.id} className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
                    <dt className="min-w-0 truncate text-sm">
                      <bdi>{localized(locale, b.leaveType.name, b.leaveType.nameAr)}</bdi>
                    </dt>
                    <dd className="num shrink-0 text-sm font-semibold" dir="auto">
                      {leaveAmount(b.available, b.leaveType.unit)}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ) : null)}
      </div>

      {/* Recent activity */}
      {showActivity && (
        <Card className="lg:col-span-5">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">{t.home.recentEvents}</CardTitle>
            <Button asChild variant="ghost" size="sm" className="max-md:min-h-10">
              <Link href="/me/attendance">
                {t.home.viewAll}
                <ArrowRight className="rtl:-scale-x-100" aria-hidden />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {events.error && !events.data ? (
              <ErrorState compact error={events.error} onRetry={() => void events.refetch()} />
            ) : events.loading && !events.data ? (
              <div className="space-y-2">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : events.data && events.data.items.length > 0 ? (
              <EventList events={events.data.items} showSource={false} />
            ) : (
              <p className="text-muted-foreground py-6 text-center text-sm">{t.events.empty}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Early check-out guard: only when time is still missing or core hours are not over. */}
      <ConfirmDialog
        open={confirmCheckOut}
        onOpenChange={setConfirmCheckOut}
        title={h.confirmCheckOutTitle}
        description={
          earlyCheckOut
            ? fmt(h.confirmCheckOutBody, { remaining: formatMinutes(remaining, units), required: formatMinutes(required, units) })
            : fmt(h.confirmCoreBody, { time: sched.coreEnd?.slice(0, 5) ?? '' })
        }
        confirmLabel={t.home.checkOut}
        cancelLabel={h.keepWorking}
        onConfirm={() => act('check-out')}
      />

      {/* Break type picker (only when there is more than one active type) */}
      <Dialog open={breakPickerOpen} onOpenChange={(o) => !busy && setBreakPickerOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.home.chooseBreak}</DialogTitle>
            <DialogDescription>{t.home.chooseBreakHint}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {activeBreakTypes.map((b) => (
              <button
                key={b.id}
                type="button"
                disabled={busy}
                onClick={() => void act('break/start', b.id)}
                className="flex min-h-14 items-center gap-3 rounded-2xl border border-tint/[0.08] bg-tint/[0.02] p-3.5 text-start transition-colors hover:border-tint/20 hover:bg-tint/[0.05] disabled:opacity-50"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--status-break)]/10 text-[color:var(--status-break)]">
                  {pending === 'break/start' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Coffee className="size-4" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{breakName(b, locale)}</span>
                  <span className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
                    <span>{b.maxMinutes !== null ? fmt(t.home.breakLimit, { n: b.maxMinutes }) : t.home.noLimit}</span>
                    <span aria-hidden>·</span>
                    <span className={b.isPaid ? 'text-[color:var(--status-working)]' : undefined}>{b.isPaid ? t.home.paid : t.home.unpaid}</span>
                    {b.requiresApproval && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{t.home.needsApproval}</span>
                      </>
                    )}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
