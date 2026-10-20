import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Building2,
  CalendarDays,
  CalendarOff,
  ClipboardCheck,
  Clock,
  Coffee,
  Download,
  Eye,
  FileBarChart,
  FilePen,
  Hourglass,
  LayoutDashboard,
  MapPin,
  MonitorDot,
  Plane,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Smile,
  Sun,
  Timer,
  TimerReset,
  UserCog,
  UserPlus,
  Users,
} from 'lucide-react';
import { PERMISSIONS, isPortalVisible, type PortalKey, type PortalPageKey, type SessionUser } from '@workforce/shared';

import type { Dictionary } from '@/lib/i18n/dictionaries';

/** Task groups of the sidebar, the mobile drawer and the command palette's Pages. */
export type NavGroup = 'me' | 'today' | 'people' | 'setup' | 'insights';

export interface NavItem {
  href: string;
  label: (t: Dictionary) => string;
  /** Shorter name for the phone bottom bar (five columns); defaults to `label`. */
  shortLabel?: (t: Dictionary) => string;
  icon: LucideIcon;
  /** Legacy two-way split (My work / Administration); `group` is the task grouping. */
  section: 'me' | 'admin';
  group: NavGroup;
  /** "My work" page this item opens; hidden when HR turned that page off in the employee portal. */
  portalKey?: PortalPageKey;
  /** Live count shown next to the item (see useNavCounts). */
  badge?: 'approvals' | 'notifications';
  /** false: reachable from the palette and the bottom bar but not listed in the sidebar (the bell covers it). */
  inSidebar?: boolean;
  /** Search aliases in English and Arabic for the command palette. */
  keywords?: string[];
  visible: (user: SessionUser) => boolean;
}

const has = (user: SessionUser, ...anyOf: string[]) => anyOf.some((p) => user.permissions.includes(p));
const portal = (user: SessionUser, key: PortalKey) => isPortalVisible(user.portal, key);
const employeeWith = (user: SessionUser, permission: string) => has(user, permission) && user.employee !== null;

export const SETTINGS_PERMISSIONS = [PERMISSIONS.OFFICES_MANAGE, PERMISSIONS.BREAK_TYPES_MANAGE, PERMISSIONS.SETTINGS_MANAGE];

export const APPROVAL_PERMISSIONS = [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.OVERTIME_APPROVE, PERMISSIONS.CORRECTIONS_APPROVE];

/**
 * Sections of /admin/settings (?tab=…). Every company setting lives here, so each one opens the same way,
 * with the same grouped section list. Pages with their own menu entry (Departments, Audit log) are not
 * settings.
 */
export type SettingsTab =
  | 'offices'
  | 'break-types'
  | 'schedules'
  | 'assignments'
  | 'holidays'
  | 'leave-types'
  | 'entitlements'
  | 'overtime'
  | 'general'
  | 'portal';

/** Settings sections in display order (grouped by SETTING_LINKS), with who may open each (the API checks the same). */
export const SETTINGS_TAB_RULES: readonly { tab: SettingsTab; allowed: (user: SessionUser) => boolean }[] = [
  { tab: 'offices', allowed: (u) => has(u, PERMISSIONS.OFFICES_MANAGE) },
  { tab: 'break-types', allowed: (u) => has(u, PERMISSIONS.BREAK_TYPES_MANAGE) },
  { tab: 'schedules', allowed: (u) => has(u, PERMISSIONS.SCHEDULES_MANAGE) },
  { tab: 'assignments', allowed: (u) => has(u, PERMISSIONS.SCHEDULES_MANAGE) },
  { tab: 'holidays', allowed: (u) => has(u, PERMISSIONS.SCHEDULES_MANAGE) },
  { tab: 'leave-types', allowed: (u) => has(u, PERMISSIONS.SETTINGS_MANAGE) },
  // HR: leave approvers with company-wide scope.
  { tab: 'entitlements', allowed: (u) => has(u, PERMISSIONS.LEAVE_APPROVE) && has(u, PERMISSIONS.ATTENDANCE_READ_ALL) },
  { tab: 'overtime', allowed: (u) => has(u, PERMISSIONS.SETTINGS_MANAGE) },
  { tab: 'general', allowed: (u) => has(u, PERMISSIONS.SETTINGS_MANAGE) },
  { tab: 'portal', allowed: (u) => has(u, PERMISSIONS.SETTINGS_MANAGE) },
];

/** The settings sections this user may open, in display order. */
export function allowedSettingsTabs(user: SessionUser): SettingsTab[] {
  return SETTINGS_TAB_RULES.filter((r) => r.allowed(user)).map((r) => r.tab);
}

/** Section names (label contract: offices = "Office locations", general = "Company & sign-in"). */
export function settingsTabLabel(t: Dictionary, tab: SettingsTab): string {
  const nf = t.navFindability;
  switch (tab) {
    case 'leave-types':
      return t.settings.tabs.leaveTypes;
    case 'break-types':
      return t.settings.tabs.breakTypes;
    case 'overtime':
      return t.settings.tabs.overtime;
    case 'offices':
      return nf.settingsTabs.offices;
    case 'general':
      return nf.settingsTabs.general;
    case 'entitlements':
      return nf.settingsTabs.entitlements;
    case 'schedules':
    case 'assignments':
    case 'holidays':
    case 'portal':
      return nf.settingLabels[tab];
  }
}

/** Where a settings section opens. */
export const settingsHref = (tab: SettingsTab): string => `/admin/settings?tab=${tab}`;

export const NAV_ITEMS: NavItem[] = [
  // My work
  {
    href: '/', label: (t) => t.nav.home, icon: Sun, section: 'me', group: 'me', portalKey: 'home',
    keywords: ['home', 'today', 'check in', 'check out', 'clock in', 'break', 'الرئيسية', 'تسجيل الحضور', 'انصراف', 'استراحة', 'بصمة'],
    visible: (u) => employeeWith(u, PERMISSIONS.ATTENDANCE_SELF) && portal(u, 'home'),
  },
  {
    href: '/me/attendance', label: (t) => t.nav.myAttendance, shortLabel: (t) => t.navFindability.shortNav.myAttendance, icon: CalendarDays, section: 'me', group: 'me', portalKey: 'attendance',
    keywords: ['attendance', 'history', 'timesheet', 'late', 'حضوري', 'سجل', 'الحضور', 'تأخير'],
    visible: (u) => employeeWith(u, PERMISSIONS.ATTENDANCE_SELF) && portal(u, 'attendance'),
  },
  {
    href: '/me/leave', label: (t) => t.nav.myLeave, icon: Plane, section: 'me', group: 'me', portalKey: 'leave',
    keywords: ['leave', 'vacation', 'balance', 'remaining', 'entitlement', 'اجازة', 'رصيد', 'الرصيد المتبقي', 'استحقاق'],
    visible: (u) => employeeWith(u, PERMISSIONS.LEAVE_SELF) && portal(u, 'leave'),
  },
  {
    href: '/me/overtime', label: (t) => t.nav.myOvertime, shortLabel: (t) => t.navFindability.shortNav.myOvertime, icon: Hourglass, section: 'me', group: 'me', portalKey: 'overtime',
    keywords: ['overtime', 'extra time', 'اضافي', 'وقت اضافي'],
    visible: (u) => employeeWith(u, PERMISSIONS.OVERTIME_SELF) && portal(u, 'overtime'),
  },
  {
    href: '/me/corrections', label: (t) => t.nav.corrections, icon: FilePen, section: 'me', group: 'me', portalKey: 'corrections',
    keywords: ['correction', 'fix', 'missing check-out', 'forgot', 'تصحيح', 'نسيت', 'انصراف غير مسجل'],
    visible: (u) => employeeWith(u, PERMISSIONS.ATTENDANCE_SELF) && portal(u, 'corrections'),
  },
  {
    href: '/notifications', label: (t) => t.nav.notifications, shortLabel: (t) => t.navFindability.shortNav.notifications, icon: Bell, section: 'me', group: 'me', portalKey: 'notifications',
    badge: 'notifications', inSidebar: false,
    keywords: ['alerts', 'inbox', 'messages', 'تنبيهات', 'اشعارات'],
    visible: () => true,
  },
  // Today
  {
    href: '/admin', label: (t) => t.nav.adminDashboard, icon: LayoutDashboard, section: 'admin', group: 'today',
    keywords: ['dashboard', 'overview', 'kpi', 'لوحة', 'مؤشرات', 'نظرة عامة'],
    visible: (u) => has(u, PERMISSIONS.DASHBOARD_READ),
  },
  {
    href: '/admin/approvals', label: (t) => t.nav.approvals, shortLabel: (t) => t.navFindability.shortNav.approvals, icon: ClipboardCheck, section: 'admin', group: 'today', badge: 'approvals',
    keywords: ['approve', 'approvals', 'requests', 'pending', 'inbox', 'موافقة', 'موافقات', 'طلبات', 'اعتماد'],
    visible: (u) => has(u, ...APPROVAL_PERMISSIONS),
  },
  {
    href: '/admin/attendance', label: (t) => t.nav.live, shortLabel: (t) => t.navFindability.shortNav.live, icon: MonitorDot, section: 'admin', group: 'today',
    keywords: ['live', 'who is in', 'present', 'late', 'absent', 'today', 'مباشر', 'الحاضرون', 'متاخر', 'غائب', 'اليوم'],
    visible: (u) => has(u, PERMISSIONS.ATTENDANCE_READ_TEAM, PERMISSIONS.ATTENDANCE_READ_ALL),
  },
  {
    href: '/admin/overtime', label: (t) => t.nav.overtimeApproval, shortLabel: (t) => t.navFindability.shortNav.overtimeApproval, icon: TimerReset, section: 'admin', group: 'today',
    keywords: ['overtime', 'extra time', 'approve', 'اضافي', 'اعتماد'],
    visible: (u) => has(u, PERMISSIONS.OVERTIME_APPROVE),
  },
  // People
  {
    href: '/admin/employees', label: (t) => t.nav.employees, icon: Users, section: 'admin', group: 'people',
    keywords: ['people', 'staff', 'team', 'employee', 'user', 'account', 'موظف', 'موظفين', 'فريق', 'حساب'],
    visible: (u) => has(u, PERMISSIONS.EMPLOYEES_READ, PERMISSIONS.EMPLOYEES_MANAGE),
  },
  {
    href: '/admin/departments', label: (t) => t.nav.departments, icon: Building2, section: 'admin', group: 'people',
    keywords: ['department', 'teams', 'manager', 'قسم', 'اقسام', 'مدير'],
    visible: (u) => has(u, PERMISSIONS.DEPARTMENTS_MANAGE),
  },
  // Setup
  {
    href: '/admin/settings', label: (t) => t.nav.settings, icon: Settings, section: 'admin', group: 'setup',
    keywords: ['settings', 'configuration', 'options', 'schedule', 'shift', 'working hours', 'holidays', 'اعدادات', 'ضبط', 'دوام', 'وردية', 'عطل', 'ساعات العمل'],
    // Any allowed section, so a role with only the entitlements (or schedules) sections still finds Settings.
    visible: (u) => allowedSettingsTabs(u).length > 0,
  },
  {
    href: '/admin/mascot', label: (t) => t.mascotAdmin.navLabel, icon: Smile, section: 'admin', group: 'setup',
    keywords: ['nouria', 'mascot', 'character', 'voice', 'lines', 'messages', 'greeting', 'نورية', 'الشخصية', 'صوت', 'جمل', 'رسائل', 'ترحيب'],
    visible: (u) => has(u, PERMISSIONS.MASCOT_MANAGE),
  },
  // Insights
  {
    href: '/admin/reports', label: (t) => t.nav.reports, icon: FileBarChart, section: 'admin', group: 'insights',
    keywords: ['report', 'export', 'excel', 'payroll', 'monthly', 'تقرير', 'تصدير', 'اكسل', 'رواتب', 'شهري'],
    visible: (u) => has(u, PERMISSIONS.REPORTS_READ_ALL, PERMISSIONS.REPORTS_READ_TEAM),
  },
  {
    href: '/admin/audit', label: (t) => t.nav.audit, icon: ScrollText, section: 'admin', group: 'insights',
    keywords: ['audit', 'history', 'log', 'changes', 'who changed', 'تدقيق', 'سجل التغييرات'],
    visible: (u) => has(u, PERMISSIONS.AUDIT_READ),
  },
];

/** Every item this user may open (role and employee-portal filtered), in menu order. */
export function visibleNav(user: SessionUser): NavItem[] {
  return NAV_ITEMS.filter((item) => item.visible(user));
}

/** Sidebar groups in display order: administrators see their daily work first and "My work" last. */
export function navGroupsFor(user: SessionUser): NavGroup[] {
  return has(user, PERMISSIONS.DASHBOARD_READ) ? ['today', 'people', 'setup', 'insights', 'me'] : ['me', 'today', 'people', 'setup', 'insights'];
}

/** Groups that start collapsed until the user toggles them ("My work" for administrators). */
export function defaultCollapsedGroups(user: SessionUser): NavGroup[] {
  return has(user, PERMISSIONS.DASHBOARD_READ) ? ['me'] : [];
}

export const navGroupLabel = (t: Dictionary, group: NavGroup): string => t.navFindability.groups[group];

const MOBILE_SLOTS = 3;

/**
 * Up to four bottom-bar items for phones (the bar adds "More"): three role-specific slots plus
 * Notifications. Hidden items are skipped, so the next candidate moves up.
 * - employees: My day, My attendance, My leave
 * - approvers: My day, Approval Center, Live attendance
 * - admin accounts without an employee profile: Dashboard, Approval Center, Employees
 */
export function mobileNavFor(user: SessionUser): NavItem[] {
  const visible = visibleNav(user);
  const candidates = !user.employee
    ? ['/admin', '/admin/approvals', '/admin/employees', '/admin/attendance', '/admin/reports', '/admin/settings']
    : has(user, ...APPROVAL_PERMISSIONS)
      ? ['/', '/admin/approvals', '/admin/attendance', '/admin/overtime', '/me/attendance', '/me/leave']
      : ['/', '/me/attendance', '/me/leave', '/me/overtime', '/me/corrections'];
  const picked: NavItem[] = [];
  for (const href of candidates) {
    const item = visible.find((i) => i.href === href);
    if (item && picked.length < MOBILE_SLOTS) picked.push(item);
  }
  // Unusual roles: fill the remaining slots in menu order.
  for (const item of visible) {
    if (picked.length >= MOBILE_SLOTS) break;
    if (item.href !== '/notifications' && !picked.includes(item)) picked.push(item);
  }
  const notifications = visible.find((i) => i.href === '/notifications');
  return notifications ? [...picked, notifications] : picked;
}

/** Tabs of the employee hub, /admin/employees/view?id=&tab=… */
export type EmployeeHubTab = 'overview' | 'attendance' | 'leave' | 'overtime' | 'schedule' | 'profile';

/** Who may open each employee-hub tab (the hub falls back to Overview for any other). */
export function employeeTabAllowed(user: SessionUser, tab: EmployeeHubTab): boolean {
  switch (tab) {
    case 'overview':
      return true;
    case 'attendance':
      return has(user, PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM);
    case 'leave':
      return has(user, PERMISSIONS.LEAVE_APPROVE);
    case 'overtime':
      return has(user, PERMISSIONS.OVERTIME_APPROVE);
    case 'schedule':
      return has(user, PERMISSIONS.SCHEDULES_MANAGE);
    case 'profile':
      // Read-only for EMPLOYEES_READ (the hub's own requirement); editing and access details need EMPLOYEES_MANAGE.
      return true;
  }
}

/** Adjusting leave balances is HR's: leave approvers with company-wide scope (as the API's adjustments). */
export const canAdjustLeave = (user: SessionUser): boolean => has(user, PERMISSIONS.LEAVE_APPROVE) && has(user, PERMISSIONS.ATTENDANCE_READ_ALL);

/** The employee hub's correction controls: company-wide correctors, never on their own record. */
export const canCorrectAttendanceOf = (user: SessionUser, employeeId: string): boolean =>
  has(user, PERMISSIONS.ATTENDANCE_CORRECT) && has(user, PERMISSIONS.ATTENDANCE_READ_ALL) && user.employee?.id !== employeeId;

/** Where to land after sign-in: the employee day screen, or the admin dashboard for non-employees. */
/** Change-your-own-password page (account menu; forced while user.mustChangePassword). */
export const CHANGE_PASSWORD_PATH = '/me/password';

export function homeFor(user: SessionUser): string {
  if (user.employee && has(user, PERMISSIONS.ATTENDANCE_SELF)) return '/';
  const first = visibleNav(user).find((i) => i.href !== '/notifications');
  return first?.href ?? '/notifications';
}

export function isActivePath(pathname: string, href: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (href === '/') return p === '/';
  if (href === '/admin') return p === '/admin';
  return p === href || p.startsWith(`${href}/`);
}

// ───────────────────────────── Settings destinations ─────────────────────────────

/** Categories of the settings overview and of the section list, in display order. */
export type SettingGroup = 'attendance' | 'time' | 'leave' | 'overtime' | 'access';

export type SettingLinkId = SettingsTab;

export interface SettingLink {
  id: SettingLinkId;
  group: SettingGroup;
  href: string;
  icon: LucideIcon;
  label: (t: Dictionary) => string;
  description: (t: Dictionary) => string;
  keywords?: string[];
  allowed: (user: SessionUser) => boolean;
}

const tabAllowed = (tab: SettingsTab) => (u: SessionUser) => SETTINGS_TAB_RULES.some((r) => r.tab === tab && r.allowed(u));

export const SETTING_GROUPS: readonly SettingGroup[] = ['attendance', 'time', 'leave', 'overtime', 'access'];

/** Every setting, grouped and in display order: the overview list, the section list and the palette's Settings group. */
export const SETTING_LINKS: readonly SettingLink[] = [
  {
    id: 'offices', group: 'attendance', href: settingsHref('offices'), icon: MapPin,
    label: (t) => settingsTabLabel(t, 'offices'), description: (t) => t.navFindability.settingDescriptions.offices,
    keywords: ['office', 'location', 'gps', 'geofence', 'radius', 'check-in rules', 'block', 'enforcement', 'مكتب', 'موقع', 'الموقع', 'نطاق', 'منع', 'قواعد تسجيل الحضور'],
    allowed: tabAllowed('offices'),
  },
  {
    id: 'break-types', group: 'attendance', href: settingsHref('break-types'), icon: Coffee,
    label: (t) => settingsTabLabel(t, 'break-types'), description: (t) => t.navFindability.settingDescriptions.breakTypes,
    keywords: ['break', 'lunch', 'prayer', 'استراحة', 'غداء', 'صلاة'],
    allowed: tabAllowed('break-types'),
  },
  {
    id: 'schedules', group: 'time', href: settingsHref('schedules'), icon: Clock,
    label: (t) => settingsTabLabel(t, 'schedules'), description: (t) => t.navFindability.settingDescriptions.schedules,
    keywords: ['schedule', 'shift', 'working hours', 'grace', 'flexible', 'دوام', 'وردية', 'ساعات العمل', 'مرن'],
    allowed: tabAllowed('schedules'),
  },
  {
    id: 'assignments', group: 'time', href: settingsHref('assignments'), icon: Users,
    label: (t) => settingsTabLabel(t, 'assignments'), description: (t) => t.navFindability.settingDescriptions.assignments,
    keywords: ['assign', 'assignment', 'schedule', 'تعيين', 'دوام'],
    allowed: tabAllowed('assignments'),
  },
  {
    id: 'holidays', group: 'time', href: settingsHref('holidays'), icon: CalendarOff,
    label: (t) => settingsTabLabel(t, 'holidays'), description: (t) => t.navFindability.settingDescriptions.holidays,
    keywords: ['holidays', 'official holidays', 'eid', 'days off', 'عطل', 'عطلة رسمية', 'عيد'],
    allowed: tabAllowed('holidays'),
  },
  {
    id: 'leave-types', group: 'leave', href: settingsHref('leave-types'), icon: CalendarDays,
    label: (t) => settingsTabLabel(t, 'leave-types'), description: (t) => t.navFindability.settingDescriptions.leaveTypes,
    keywords: ['leave', 'annual', 'sick', 'vacation', 'entitlement', 'اجازة', 'سنوية', 'مرضية', 'استحقاق'],
    allowed: tabAllowed('leave-types'),
  },
  {
    id: 'entitlements', group: 'leave', href: settingsHref('entitlements'), icon: UserCog,
    label: (t) => settingsTabLabel(t, 'entitlements'), description: (t) => t.navFindability.settingDescriptions.entitlements,
    keywords: ['entitlement', 'balance', 'bulk', 'leave', 'استحقاق', 'الاستحقاق السنوي', 'رصيد', 'جماعي'],
    allowed: tabAllowed('entitlements'),
  },
  {
    id: 'overtime', group: 'overtime', href: settingsHref('overtime'), icon: Timer,
    label: (t) => settingsTabLabel(t, 'overtime'), description: (t) => t.navFindability.settingDescriptions.overtime,
    keywords: ['overtime', 'multiplier', 'rate', 'extra time', 'اضافي', 'معامل'],
    allowed: tabAllowed('overtime'),
  },
  {
    id: 'general', group: 'access', href: settingsHref('general'), icon: SlidersHorizontal,
    label: (t) => settingsTabLabel(t, 'general'), description: (t) => t.navFindability.settingDescriptions.general,
    keywords: ['general', 'company', 'time zone', 'password', 'lockout', 'sign-in', 'login', 'عام', 'الشركة', 'المنطقة الزمنية', 'كلمة المرور', 'تسجيل الدخول'],
    allowed: tabAllowed('general'),
  },
  {
    id: 'portal', group: 'access', href: settingsHref('portal'), icon: Eye,
    label: (t) => settingsTabLabel(t, 'portal'), description: (t) => t.navFindability.settingDescriptions.portal,
    keywords: ['portal', 'employee portal', 'employee pages', 'hide pages', 'visibility', 'my work', 'بوابة', 'بوابة الموظف', 'صفحات الموظفين', 'اخفاء', 'عملي'],
    allowed: tabAllowed('portal'),
  },
];

// ───────────────────────────── Palette actions ─────────────────────────────

export interface NavAction {
  id: 'addEmployee' | 'requestLeave' | 'requestOvertime' | 'fixAttendance' | 'openApprovals' | 'exportAttendance';
  href: string;
  icon: LucideIcon;
  keywords?: string[];
  visible: (user: SessionUser) => boolean;
}

/** Command-palette shortcuts, gated by the same permission and employee-portal checks as NAV_ITEMS. */
export const NAV_ACTIONS: readonly NavAction[] = [
  {
    id: 'addEmployee', href: '/admin/employees?new=1', icon: UserPlus,
    keywords: ['new employee', 'create', 'hire', 'موظف جديد', 'اضافة'],
    visible: (u) => has(u, PERMISSIONS.EMPLOYEES_MANAGE),
  },
  {
    id: 'requestLeave', href: '/me/leave?new=1', icon: Plane,
    keywords: ['leave', 'vacation', 'day off', 'اجازة', 'طلب'],
    visible: (u) => employeeWith(u, PERMISSIONS.LEAVE_SELF) && portal(u, 'leave.requests'),
  },
  {
    id: 'requestOvertime', href: '/me/overtime?new=1', icon: Hourglass,
    keywords: ['overtime', 'extra time', 'اضافي', 'طلب'],
    visible: (u) => employeeWith(u, PERMISSIONS.OVERTIME_SELF) && portal(u, 'overtime.requests'),
  },
  {
    id: 'fixAttendance', href: '/me/corrections?new=1', icon: FilePen,
    keywords: ['correction', 'forgot', 'missing check-out', 'تصحيح', 'نسيت'],
    visible: (u) => employeeWith(u, PERMISSIONS.ATTENDANCE_SELF) && portal(u, 'corrections'),
  },
  {
    id: 'openApprovals', href: '/admin/approvals', icon: ClipboardCheck,
    keywords: ['approve', 'pending', 'requests', 'موافقة', 'اعتماد', 'طلبات'],
    visible: (u) => has(u, ...APPROVAL_PERMISSIONS),
  },
  {
    id: 'exportAttendance', href: '/admin/reports', icon: Download,
    keywords: ['export', 'excel', 'report', 'payroll', 'تصدير', 'اكسل', 'تقرير'],
    visible: (u) => has(u, PERMISSIONS.REPORTS_READ_ALL, PERMISSIONS.REPORTS_READ_TEAM),
  },
];
