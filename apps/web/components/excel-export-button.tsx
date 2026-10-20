'use client';

import { useState } from 'react';
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AttendanceReportDto } from '@workforce/shared';

import { DateRangePicker, type DateRange } from '@/components/date-range';
import { downloadText, reportCsv } from '@/components/report-bits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { apiGet, type Query } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

const MAX_DAYS = 93;
type Format = 'xlsx' | 'csv';

/**
 * "Export" button: a dialog asks for the period (and format), then the detailed report is loaded and
 * downloaded. Excel has the attendance day by day with totals plus one tab per subject and employee.
 */
export function ExportReportButton({ initialRange, query = {}, single = false, allowCsv = false, variant = 'default' }: {
  initialRange: DateRange;
  /** Fixed filters, e.g. { departmentId } or { employeeId }. */
  query?: Query;
  /** One employee: no per-employee tabs. */
  single?: boolean;
  allowCsv?: boolean;
  variant?: 'default' | 'outline';
}) {
  const { t, locale, errorMessage } = useI18n();
  const x = t.exportDialog;
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange>(initialRange);
  const [format, setFormat] = useState<Format>('xlsx');
  const [busy, setBusy] = useState(false);

  const openDialog = () => {
    setRange(initialRange);
    setOpen(true);
  };

  const run = async () => {
    setBusy(true);
    try {
      // export=true (and detail=true) make the API require `reports.export`; the payload is the same.
      const report = await apiGet<AttendanceReportDto>('/reports/attendance', {
        ...query,
        ...range,
        detail: format === 'xlsx' ? 'true' : undefined,
        export: 'true',
      });
      if (format === 'csv') downloadText(`attendance-report_${report.from}_${report.to}.csv`, reportCsv(report, t, locale));
      else {
        const { exportReportExcel } = await import('@/components/report-excel');
        await exportReportExcel(report, t, locale, { single });
      }
      setOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const formats: { value: Format; label: string; icon: typeof Download }[] = [
    { value: 'xlsx', label: x.excel, icon: FileSpreadsheet },
    ...(allowCsv ? [{ value: 'csv' as const, label: x.csv, icon: Download }] : []),
  ];

  return (
    <>
      <Button variant={variant} onClick={openDialog}>
        <Download aria-hidden />
        {x.title}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent closeLabel={t.common.close}>
          <DialogHeader>
            <DialogTitle>{x.title}</DialogTitle>
            <DialogDescription>{x.description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <DateRangePicker value={range} onChange={setRange} maxDays={MAX_DAYS} tooLongMessage={t.reports.rangeTooLong} />
            {formats.length > 1 && (
              <div className="grid gap-2">
                <Label>{x.format}</Label>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={x.format}>
                  {formats.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      role="radio"
                      aria-checked={format === f.value}
                      onClick={() => setFormat(f.value)}
                      className={cn(
                        'flex items-center gap-2 rounded-xl border p-3 text-start text-sm transition-colors',
                        format === f.value ? 'border-[color:var(--brand-soft)]/50 bg-tint/[0.06] font-semibold' : 'border-tint/[0.08] hover:bg-tint/[0.03]',
                      )}
                    >
                      <f.icon className="size-4 shrink-0" aria-hidden />
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {t.common.cancel}
            </Button>
            <Button onClick={() => void run()} disabled={busy || !range.from || !range.to || range.from > range.to}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
              {busy ? t.reports.exporting : x.export}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
