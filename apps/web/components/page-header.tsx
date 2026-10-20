'use client';

import { useEffect, useId, type ReactNode, type Ref } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { HelpTip } from '@/components/help-tip';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

export interface Breadcrumb {
  label: string;
  /** Omit on the current page (the last crumb). */
  href?: string;
}

/**
 * Page title row. Optional `breadcrumbs` render above the title from `sm` up; below `sm` only a back
 * link to the last linked crumb is shown. The browser tab title follows `documentTitle ?? title` in the
 * current language, e.g. "Overtime policy · Employee Portal".
 *
 * `description` explains the page: it shows as a "?" help tip after the title (and stays in the DOM for
 * screen readers). `subtitle` is for live data under the title (a job title, a pending count) and stays visible.
 */
export function PageHeader({ title, description, subtitle, actions, breadcrumbs, documentTitle, titleRef, className }: {
  title: string;
  description?: string;
  /** Visible line under the title for data (not explanations). */
  subtitle?: string;
  actions?: ReactNode;
  /** Trail above the title; the last item is the current page (no link, aria-current="page"). */
  breadcrumbs?: Breadcrumb[];
  /** Browser tab title without the app name; defaults to `title`. */
  documentTitle?: string;
  /** Makes the <h1> focusable from script (tabIndex -1), for pages that move focus to it after a view change. */
  titleRef?: Ref<HTMLHeadingElement>;
  className?: string;
}) {
  const { t, locale } = useI18n();
  const descId = useId();
  const nf = t.navFindability;
  const tabTitle = documentTitle ?? title;
  const appName = t.common.appName;

  useEffect(() => {
    if (tabTitle) document.title = `${tabTitle} · ${appName}`;
  }, [tabTitle, appName, locale]);

  const crumbs = breadcrumbs ?? [];
  const back = [...crumbs].reverse().find((c) => c.href);

  return (
    <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0 space-y-1">
        {crumbs.length > 0 && (
          <>
            <nav aria-label={nf.breadcrumb} className="hidden sm:block">
              <ol className="text-muted-foreground flex flex-wrap items-center gap-1 text-sm">
                {crumbs.map((crumb, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <li key={`${i}-${crumb.label}`} className="flex min-w-0 items-center gap-1">
                      {i > 0 && <ChevronRight className="size-3.5 shrink-0 opacity-70 rtl:-scale-x-100" aria-hidden />}
                      {last || !crumb.href ? (
                        <span aria-current={last ? 'page' : undefined} className={cn('truncate', last && 'text-foreground font-medium')}>
                          <bdi>{crumb.label}</bdi>
                        </span>
                      ) : (
                        <Link
                          href={crumb.href}
                          className="hover:text-foreground inline-flex min-h-6 items-center truncate rounded-sm underline-offset-4 transition-colors hover:underline"
                        >
                          <bdi>{crumb.label}</bdi>
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
            {back?.href && (
              <Link
                href={back.href}
                aria-label={fmt(nf.backTo, { label: back.label })}
                className="text-muted-foreground hover:text-foreground -ms-1 inline-flex min-h-10 max-w-full items-center gap-1 rounded-md px-1 text-sm transition-colors sm:hidden"
              >
                <ChevronLeft className="size-4 shrink-0 rtl:-scale-x-100" aria-hidden />
                <bdi className="truncate">{back.label}</bdi>
              </Link>
            )}
          </>
        )}
        <div className="flex min-w-0 items-center gap-1">
          <h1
            ref={titleRef}
            tabIndex={titleRef ? -1 : undefined}
            aria-describedby={description ? descId : undefined}
            className={cn('font-display min-w-0 text-xl font-bold tracking-normal sm:text-2xl', titleRef && 'outline-none')}
          >
            {title}
          </h1>
          {description && <HelpTip text={description} />}
        </div>
        {description && (
          <p id={descId} className="sr-only">
            {description}
          </p>
        )}
        {subtitle && <p className="text-muted-foreground text-sm">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
