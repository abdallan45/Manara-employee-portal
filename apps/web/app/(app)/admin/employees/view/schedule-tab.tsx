'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, CalendarX } from 'lucide-react';
import { PERMISSIONS, type CurrentWorkHoursDto, type EmployeeDto, type EmployeeScheduleDto, type ScheduleAssignmentDto, type ScheduleDto } from '@workforce/shared';

import { HelpTip } from '@/components/help-tip';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth';
import { formatMinutes, formatWorkDate, localized, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi, type ApiState } from '@/lib/use-api';
import { AssignForm, EndForm } from '../../schedules/assignments-tab';

type Group = 'active' | 'upcoming' | 'ended';
const groupOf = (a: ScheduleAssignmentDto, today: string): Group =>
  a.validFrom > today ? 'upcoming' : a.validTo !== null && a.validTo < today ? 'ended' : 'active';

/**
 * Schedule tab: the schedule in force and where it comes from, the department's schedule as context,
 * and the employee's own assignments (active, upcoming, ended). Assigning and ending happen here.
 * `openAssign` (the header's "Assign schedule") opens the assign dialog once the schedules are loaded.
 */
export function ScheduleTab({ employee, name, schedule, openAssign = false, onAssignOpened }: {
  employee: EmployeeDto;
  name: string;
  schedule: ApiState<EmployeeScheduleDto>;
  openAssign?: boolean;
  onAssignOpened?: () => void;
}) {
  const { t, locale, units } = useI18n();
  const { can } = useAuth();
  const s = t.employeeHub.schedule;
  const w = t.adminWorkflows.schedules;
  const sr = t.saturdayRota;
  const canManage = can(PERMISSIONS.SCHEDULES_MANAGE);
  const today = todayInAmman();
  const [assigning, setAssigning] = useState(false);
  const [ending, setEnding] = useState<ScheduleAssignmentDto | null>(null);
  const [dirty, setDirty] = useState(false);

  const schedules = useApi<ScheduleDto[]>(canManage ? '/schedules' : null);
  const assignments = useApi<ScheduleAssignmentDto[]>(canManage ? '/schedules/assignments' : null);
  const companyHours = useApi<CurrentWorkHoursDto>('/settings/work-hours/current');
  const breakMinutes = employee.includedBreakMinutes ?? companyHours.data?.includedBreakMinutes;

  const scheduleCount = schedules.data?.length;
  useEffect(() => {
    if (!openAssign || scheduleCount === undefined) return;
    onAssignOpened?.();
    if (canManage && scheduleCount > 0) {
      setDirty(false);
      setAssigning(true);
    }
  }, [openAssign, scheduleCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const own = (assignments.data ?? []).filter((a) => a.employeeId === employee.id);
  const departmentAssignment = employee.departmentId
    ? (assignments.data ?? []).find((a) => a.departmentId === employee.departmentId && groupOf(a, today) === 'active')
    : undefined;
  const groups: Group[] = ['active', 'upcoming', 'ended'];
  const byGroup = (g: Group) => own.filter((a) => groupOf(a, today) === g).sort((x, y) => y.validFrom.localeCompare(x.validFrom));
  const current = schedule.data;
  const currentLabel = current ? `${current.scheduleName} (${t.employeeHub.scheduleSource[current.source]})` : undefined;
  const department = localized(locale, employee.departmentName, employee.departmentNameAr);
  const sourceHelp =
    current?.source === 'DEPARTMENT' ? s.inheritedHint : current?.source === 'DEFAULT' || current?.source === 'BUILT_IN' ? s.defaultHint : undefined;

  const refresh = () => {
    void assignments.refetch();
    void schedule.refetch();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="font-semibold">{s.currentTitle}</h2>
              {schedule.error && !current ? (
                <ErrorState compact error={schedule.error} onRetry={() => void schedule.refetch()} />
              ) : !current ? (
                <LoadingRows rows={1} className="px-0" />
              ) : (
                <>
                  <p className="text-lg font-semibold">
                    <bdi>{current.scheduleName}</bdi>
                  </p>
                  <p className="text-muted-foreground flex flex-wrap items-center gap-x-1 text-sm">
                    <span>
                      {s.source}: {t.employeeHub.scheduleSource[current.source]}
                      {current.validTo && ` · ${fmt(t.employeeHub.overview.until, { date: formatWorkDate(current.validTo, locale) })}`}
                    </span>
                    {sourceHelp && <HelpTip text={sourceHelp} />}
                  </p>
                  {sourceHelp && <p className="sr-only">{sourceHelp}</p>}
                  <p className="text-muted-foreground text-sm">
                    {employee.dailyRequiredMinutes != null
                      ? fmt(w.hoursOwn, { duration: formatMinutes(employee.dailyRequiredMinutes, units) })
                      : companyHours.data
                        ? fmt(w.hoursCompany, { duration: formatMinutes(companyHours.data.dailyRequiredMinutes, units) })
                        : w.hoursDefault}
                    {breakMinutes != null && ` · ${fmt(w.breakOwn, { duration: formatMinutes(breakMinutes, units) })}`}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {sr.effective}:{' '}
                    {current.saturdayGroup ? fmt(sr.group, { group: sr.groupNames[current.saturdayGroup] }) : sr.notOnRotation}
                    {current.saturdayGroup && !current.saturdayRotaStart && ` · ${sr.rotationNotSet}`}
                    {current.nextWorkingSaturday && (
                      <>
                        {' · '}
                        {sr.nextWorking}: <bdi className="tabular">{formatWorkDate(current.nextWorkingSaturday, locale)}</bdi>
                      </>
                    )}
                  </p>
                  {current.source === 'DEPARTMENT' && department && (
                    <p className="text-muted-foreground text-sm">
                      <bdi>{department}</bdi>
                    </p>
                  )}
                  {current.source === 'EMPLOYEE' && departmentAssignment?.scheduleName && (
                    <p className="text-muted-foreground text-sm">{fmt(s.departmentContext, { name: departmentAssignment.scheduleName })}</p>
                  )}
                </>
              )}
            </div>
            {canManage && (
              <Button
                onClick={() => {
                  setDirty(false);
                  setAssigning(true);
                }}
                disabled={!schedules.data?.length}
              >
                <CalendarClock aria-hidden />
                {t.employeeHub.page.assignSchedule}
              </Button>
            )}
          </div>
          {!canManage && <p className="text-muted-foreground text-xs">{s.manageOnly}</p>}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardContent className="space-y-4">
            <h2 className="font-semibold">{s.historyTitle}</h2>
            {assignments.error && !assignments.data ? (
              <ErrorState compact error={assignments.error} onRetry={() => void assignments.refetch()} />
            ) : !assignments.data ? (
              <LoadingRows rows={2} className="px-0" />
            ) : own.length === 0 ? (
              <EmptyState title={s.empty} />
            ) : (
              groups.map((g) => {
                const list = byGroup(g);
                if (list.length === 0) return null;
                return (
                  <section key={g} className="space-y-2" aria-labelledby={`sched-${g}`}>
                    <h3 id={`sched-${g}`} className="text-muted-foreground text-sm font-medium">
                      {s.groups[g]}
                    </h3>
                    <ul className="divide-y divide-tint/[0.05] rounded-xl border border-tint/[0.06]">
                      {list.map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                          <div className="min-w-0">
                            <p className="font-medium">
                              <bdi>{a.scheduleName}</bdi>
                            </p>
                            <p className="text-muted-foreground tabular text-xs">
                              {fmt(s.range, { from: formatWorkDate(a.validFrom, locale), to: a.validTo ? formatWorkDate(a.validTo, locale) : t.schedules.openEnded })}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={
                                g === 'active' ? 'text-[color:var(--status-working)]' : g === 'upcoming' ? 'text-[color:var(--status-break)]' : 'text-muted-foreground'
                              }
                            >
                              {s.groups[g]}
                            </Badge>
                            {g === 'active' && (
                              <Button variant="ghost" size="sm" className="max-md:min-h-10" onClick={() => setEnding(a)}>
                                <CalendarX aria-hidden />
                                {t.schedules.endAssignment}
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={assigning} onOpenChange={setAssigning}>
        <DialogContent dirty={dirty}>
          <DialogHeader>
            <DialogTitle>{t.schedules.assignTitle}</DialogTitle>
            <DialogDescription>
              <bdi>{name}</bdi> · {t.schedules.assignHint}
            </DialogDescription>
          </DialogHeader>
          {assigning && (
            <AssignForm
              schedules={schedules.data ?? []}
              initialEmployeeId={employee.id}
              lockTarget
              currentScheduleLabel={currentLabel}
              onDirtyChange={setDirty}
              onCancel={() => setAssigning(false)}
              onSaved={() => {
                setAssigning(false);
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={ending !== null} onOpenChange={(o) => !o && setEnding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.schedules.endTitle}</DialogTitle>
            <DialogDescription>{t.schedules.endBody}</DialogDescription>
          </DialogHeader>
          {ending && (
            <EndForm
              assignment={ending}
              onCancel={() => setEnding(null)}
              onSaved={() => {
                setEnding(null);
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
