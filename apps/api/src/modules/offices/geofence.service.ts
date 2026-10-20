import { Injectable } from '@nestjs/common';
import { distanceMeters, type DeviceLocation, type OfficeGeofenceDto } from '@workforce/shared';
import { PrismaService } from '../../common/prisma.service';

export type LocationProblem = 'LOCATION_REQUIRED' | 'LOCATION_INACCURATE' | 'LOCATION_OUTSIDE_OFFICE' | 'LOCATION_NOT_CONFIGURED';

export interface LocationVerdict {
  verified: boolean;
  /** Why the location is not verified; null when it is. */
  problem: LocationProblem | null;
  location: DeviceLocation | null;
  /** The office the device is inside, else the nearest one. */
  office: OfficeGeofenceDto | null;
  /** Metres to that office, rounded. */
  distance: number | null;
}

const CACHE_TTL_MS = 30_000;

/**
 * Decides whether a device location (browser Geolocation API or the mobile app) is inside an active
 * office geofence. The client reports the position, so a determined user can fake it: ENFORCE stops
 * casual check-ins from elsewhere, FLAG accepts them and leaves them marked for review.
 */
@Injectable()
export class GeofenceService {
  private cache: { at: number; offices: OfficeGeofenceDto[] } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Call after any change to offices. */
  invalidate(): void {
    this.cache = null;
  }

  /** Active offices that have coordinates. */
  async offices(): Promise<OfficeGeofenceDto[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.offices;
    const rows = await this.prisma.location.findMany({
      where: { isActive: true, latitude: { not: null }, longitude: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    const offices = rows.map((r) => ({ id: r.id, name: r.name, latitude: r.latitude!, longitude: r.longitude!, radiusMeters: r.radiusMeters }));
    this.cache = { at: Date.now(), offices };
    return offices;
  }

  async verify(location: DeviceLocation | null | undefined, maxAccuracyMeters: number): Promise<LocationVerdict> {
    const offices = await this.offices();
    const loc = location ?? null;
    const verdict = (problem: LocationProblem | null, office: OfficeGeofenceDto | null = null, distance: number | null = null): LocationVerdict => ({
      verified: problem === null, problem, location: loc, office, distance: distance === null ? null : Math.round(distance),
    });
    if (!offices.length) return verdict('LOCATION_NOT_CONFIGURED');
    if (!loc) return verdict('LOCATION_REQUIRED');

    // Being inside any office wins over merely being nearest to another (offices may differ in radius).
    let inside: { office: OfficeGeofenceDto; distance: number } | null = null;
    let nearest: { office: OfficeGeofenceDto; distance: number } | null = null;
    for (const office of offices) {
      const distance = distanceMeters(loc, office);
      if (!nearest || distance < nearest.distance) nearest = { office, distance };
      if (distance <= office.radiusMeters && (!inside || distance < inside.distance)) inside = { office, distance };
    }
    const match = (inside ?? nearest)!;
    if (loc.accuracy > maxAccuracyMeters) return verdict('LOCATION_INACCURATE', match.office, match.distance);
    return verdict(inside ? null : 'LOCATION_OUTSIDE_OFFICE', match.office, match.distance);
  }
}
