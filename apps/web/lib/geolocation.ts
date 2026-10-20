'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { distanceMeters, type DeviceLocation, type OfficeGeofenceDto } from '@workforce/shared';

import { formatNumber } from '@/lib/format';
import type { Locale } from '@/lib/i18n/dictionaries';

/**
 * Why the browser gave no position. `insecure`: the page is not served over https (or localhost), where
 * browsers refuse geolocation outright; `unsupported`: no Geolocation API at all.
 */
export type GeoFailure = 'denied' | 'unavailable' | 'timeout' | 'insecure' | 'unsupported';

export type GeoResult =
  | { ok: true; location: DeviceLocation; /** Date.now() when the position was taken */ at: number }
  | { ok: false; reason: GeoFailure };

const TIMEOUT_MS = 15_000;

function supportState(): GeoFailure | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!('geolocation' in navigator) || !navigator.geolocation) return 'unsupported';
  return null;
}

/** One fresh, high-accuracy position (never a cached one). May show the browser's permission prompt. */
export function getDeviceLocation(): Promise<GeoResult> {
  const unsupported = supportState();
  if (unsupported) return Promise.resolve({ ok: false, reason: unsupported });
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          ok: true,
          location: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) },
          at: Date.now(),
        }),
      (err) =>
        resolve({
          ok: false,
          reason: err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable',
        }),
      { enableHighAccuracy: true, timeout: TIMEOUT_MS, maximumAge: 0 },
    );
  });
}

/** The browser's location permission without prompting; 'unknown' where the Permissions API can't tell. */
export async function locationPermission(): Promise<PermissionState | 'unknown'> {
  if (supportState()) return 'unknown';
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    return status?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Where a position stands against the office geofences, as the server decides it: inside any office wins
 * over merely being nearest to another (offices may differ in radius). null when there are no offices.
 */
export function officeVerdict(at: { latitude: number; longitude: number }, offices: OfficeGeofenceDto[]):
  { office: OfficeGeofenceDto; distance: number; inside: boolean } | null {
  let inside: { office: OfficeGeofenceDto; distance: number } | null = null;
  let nearest: { office: OfficeGeofenceDto; distance: number } | null = null;
  for (const office of offices) {
    const distance = distanceMeters(at, office);
    if (!nearest || distance < nearest.distance) nearest = { office, distance };
    if (distance <= office.radiusMeters && (!inside || distance < inside.distance)) inside = { office, distance };
  }
  const match = inside ?? nearest;
  return match ? { ...match, inside: inside !== null } : null;
}

/** "40 m" / "1.2 km" in the interface language, Latin digits. */
export function formatDistance(meters: number, locale: Locale): string {
  if (meters < 1000) {
    const rounded = meters < 100 ? Math.round(meters) : Math.round(meters / 10) * 10;
    return formatNumber(rounded, locale, { style: 'unit', unit: 'meter', unitDisplay: 'short' });
  }
  return formatNumber(meters / 1000, locale, { style: 'unit', unit: 'kilometer', unitDisplay: 'short', maximumFractionDigits: meters < 10_000 ? 1 : 0 });
}

/** "31.95392, 35.91061": 5 decimals is about 1 m. */
export const formatCoordinates = (latitude: number, longitude: number): string => `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

export const mapsUrl = (latitude: number, longitude: number): string => `https://www.google.com/maps?q=${latitude},${longitude}`;

/**
 * "31.95, 35.91" (as Google Maps copies a point) -> both numbers; null for anything else. Accepts a space
 * instead of the comma, and Arabic-Indic digits.
 */
export function parseCoordinatePair(input: string): { latitude: number; longitude: number } | null {
  const ascii = input.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const m = /^\(?\s*([+-]?\d+(?:\.\d+)?)\s*[,،\s]\s*([+-]?\d+(?:\.\d+)?)\s*\)?$/.exec(ascii);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  return { latitude, longitude };
}

export const isValidLatitude = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= -90 && n <= 90;
export const isValidLongitude = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= -180 && n <= 180;

/**
 * The device position for the check-in page. Nothing asks for permission until `locate()` is called (a
 * button press); when the permission is already granted, the position is read once on mount.
 */
export function useDeviceLocation() {
  const [result, setResult] = useState<GeoResult | null>(null);
  const [locating, setLocating] = useState(false);
  const inFlight = useRef<Promise<GeoResult> | null>(null);

  const locate = useCallback((): Promise<GeoResult> => {
    // Two presses close together share one request.
    if (inFlight.current) return inFlight.current;
    setLocating(true);
    const p = getDeviceLocation().then((r) => {
      inFlight.current = null;
      setResult(r);
      setLocating(false);
      return r;
    });
    inFlight.current = p;
    return p;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void locationPermission().then((state) => {
      if (!cancelled && state === 'granted') void locate();
    });
    return () => {
      cancelled = true;
    };
  }, [locate]);

  return { result, locating, locate };
}
