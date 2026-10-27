// Contracts for the attendance engine endpoints not covered by api.ts / admin.ts.
import type { SaturdayGroup } from './rota';

/** Device position sent with check-in / check-out (browser Geolocation API or the mobile app). */
export interface DeviceLocation {
  latitude: number;
  longitude: number;
  /** Reported accuracy radius in metres. */
  accuracy: number;
}

/** An office the employees must be near to check in or out. */
export interface OfficeGeofenceDto {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

/** GET /offices (admin). Offices without coordinates are not geofences until they get some. */
export interface OfficeLocationDto {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number;
  address: string | null;
  isActive: boolean;
  createdAt: string;
}

export const OFFICE_RADIUS_RANGE = { min: 20, max: 5000 } as const;

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle (haversine) distance in metres between two points given in degrees. */
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The nearest office to a point, with its distance; null when there are no offices. */
export function nearestOffice<T extends OfficeGeofenceDto>(at: { latitude: number; longitude: number }, offices: T[]): { office: T; distance: number } | null {
  let best: { office: T; distance: number } | null = null;
  for (const office of offices) {
    const distance = distanceMeters(at, office);
    if (!best || distance < best.distance) best = { office, distance };
  }
  return best;
}

export interface HolidayDto {
  id: string;
  date: string; // YYYY-MM-DD
  name: string;
  nameAr: string | null;
  isPaid: boolean;
  locationId: string | null;
}

export interface ScheduleAssignmentDto {
  id: string;
  scheduleId: string;
  employeeId: string | null;
  departmentId: string | null;
  validFrom: string; // YYYY-MM-DD
  validTo: string | null;
  createdAt: string;
  /** Display fields, filled by GET /schedules/assignments. */
  scheduleName?: string;
  employee?: { employeeCode: string; fullName: string; fullNameAr: string | null } | null;
  department?: { name: string; nameAr: string | null } | null;
}

/** Which schedule applies to an employee on a date, and why. */
export interface EmployeeScheduleDto {
  date: string;
  scheduleId: string | null;
  scheduleName: string;
  /** EMPLOYEE / DEPARTMENT assignment, the DEFAULT schedule, or the BUILT_IN fallback (Sun–Thu 08:00–16:00). */
  source: 'EMPLOYEE' | 'DEPARTMENT' | 'DEFAULT' | 'BUILT_IN';
  validTo: string | null;
  /** Effective Saturday rota group (null = Saturdays follow the schedule) and the rota start (null = no rota). */
  saturdayGroup: SaturdayGroup | null;
  saturdayRotaStart: string | null;
  /** The group's first working Saturday on or after `date`; null without a rota or a group. */
  nextWorkingSaturday: string | null;
}

/** Notification `type` keys written by the attendance engine; the UI localises by these. */
export const NOTIFICATION_TYPES = {
  MISSING_CHECKOUT: 'ATTENDANCE_MISSING_CHECKOUT',
  BREAK_OVERDUE: 'ATTENDANCE_BREAK_OVERDUE',
} as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export interface UnreadCountDto { count: number }
