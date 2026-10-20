'use client';

import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';

/**
 * Categorical series colours, validated for CVD separation and contrast on the card surface of each theme
 * (CSS variables in globals.css, so the charts follow the light / dark switch without re-rendering).
 */
export const SERIES = {
  primary: 'var(--series-1)',
  secondary: 'var(--series-2)',
  tertiary: 'var(--series-3)',
} as const;

/** Axis ticks: muted-foreground (7.6:1 on the dark card, 6.3:1 on the light one) at 12px. */
const AXIS = { fill: 'var(--muted-foreground)', fontSize: 12 };
const GRID = 'var(--chart-grid)';

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

type Row = Record<string, string | number>;

function ChartTooltip({ active, payload, label, format }: Partial<TooltipContentProps<number, string>> & { format?: (v: number) => string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-popover rounded-xl border border-tint/10 px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-semibold">{label}</p>
      <ul className="space-y-0.5">
        {payload.map((p) => (
          <li key={String(p.dataKey)} className="flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ background: p.color }} aria-hidden />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="tabular ms-auto ps-3 font-semibold">{typeof p.value === 'number' && format ? format(p.value) : String(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LegendText(value: string): ReactNode {
  return <span className="text-brand-soft text-xs">{value}</span>;
}

/** Charts read left->right in both languages (time axes), so they are always laid out LTR. */
function Frame({ children, height, label }: { children: ReactNode; height: number; label: string }) {
  return (
    <div dir="ltr" role="img" aria-label={label} style={{ height }} className="w-full">
      {children}
    </div>
  );
}

export function TrendLineChart({ data, xKey, series, label, height = 260 }: {
  data: Row[];
  xKey: string;
  series: SeriesDef[];
  label: string;
  height?: number;
}) {
  return (
    <Frame height={height} label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--chart-cursor)' }} />
          <Legend iconType="circle" iconSize={8} formatter={LegendText} wrapperStyle={{ paddingTop: 8 }} />
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Frame>
  );
}

export function SimpleBarChart({ data, xKey, series, label, format, height = 260, layout = 'horizontal' }: {
  data: Row[];
  xKey: string;
  series: SeriesDef[];
  label: string;
  format?: (v: number) => string;
  height?: number;
  /** 'vertical' = category labels on the Y axis (long department names). */
  layout?: 'horizontal' | 'vertical';
}) {
  const vertical = layout === 'vertical';
  return (
    <Frame height={height} label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={vertical ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 12, bottom: 0, left: vertical ? 8 : -16 }} barGap={2}>
          <CartesianGrid stroke={GRID} vertical={vertical} horizontal={!vertical} />
          {vertical ? (
            <>
              <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} width={96} />
            </>
          ) : (
            <>
              <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} />
            </>
          )}
          <Tooltip content={<ChartTooltip format={format} />} cursor={{ fill: 'var(--chart-cursor-fill)' }} />
          {series.length > 1 && <Legend iconType="circle" iconSize={8} formatter={LegendText} wrapperStyle={{ paddingTop: 8 }} />}
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={s.color}
              radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              maxBarSize={vertical ? 14 : 28}
              stroke="var(--card)"
              strokeWidth={1}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Frame>
  );
}
