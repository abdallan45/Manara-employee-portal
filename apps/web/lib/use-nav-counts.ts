'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import type { ApprovalSummaryDto } from '@workforce/shared';

import { NOTIFICATIONS_CHANGED_EVENT } from '@/components/notifications-bell';
import { useAuth } from '@/lib/auth';
import { APPROVAL_PERMISSIONS } from '@/lib/nav';
import { useApi } from '@/lib/use-api';

/** Dispatch on window after deciding requests so the navigation count updates without waiting for the poll. */
export const APPROVALS_CHANGED_EVENT = 'wf:approvals-changed';

export interface NavCounts {
  /** Requests the user can decide now (0 without approval permissions or while loading). */
  approvals: number;
  /** Unread notifications. */
  notifications: number;
}

const POLL_MS = 60_000;
const OPTIONS = { refreshMs: POLL_MS, refetchOnFocus: true };

/**
 * Pending-work counts for the navigation. Polls /approvals/summary (approvers only) and
 * /notifications/unread-count every minute while the page is visible and again when the window regains
 * focus; refetches right away on NOTIFICATIONS_CHANGED_EVENT, APPROVALS_CHANGED_EVENT and after leaving
 * the Approval Center. A failed poll keeps the last known count. Must be used inside <AuthProvider>.
 */
export function useNavCounts(): NavCounts {
  const { can } = useAuth();
  const pathname = usePathname();
  const approver = can(...APPROVAL_PERMISSIONS);
  const summary = useApi<ApprovalSummaryDto>(approver ? '/approvals/summary' : null, undefined, OPTIONS);
  const unread = useApi<{ count: number }>('/notifications/unread-count', undefined, OPTIONS);

  const refetchSummary = summary.refetch;
  const refetchUnread = unread.refetch;

  useEffect(() => {
    const onNotifications = () => void refetchUnread();
    const onApprovals = () => {
      if (approver) void refetchSummary();
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onNotifications);
    window.addEventListener(APPROVALS_CHANGED_EVENT, onApprovals);
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onNotifications);
      window.removeEventListener(APPROVALS_CHANGED_EVENT, onApprovals);
    };
  }, [approver, refetchSummary, refetchUnread]);

  // Decisions made in the Approval Center show up in the count as soon as the user moves on.
  const previousPath = useRef(pathname);
  useEffect(() => {
    const before = previousPath.current;
    previousPath.current = pathname;
    if (approver && before !== pathname && before?.startsWith('/admin/approvals')) void refetchSummary();
  }, [approver, pathname, refetchSummary]);

  return {
    approvals: approver ? (summary.data?.pending.total ?? 0) : 0,
    notifications: unread.data?.count ?? 0,
  };
}
