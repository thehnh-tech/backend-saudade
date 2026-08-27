import type { Request } from "express";
import geoip from "geoip-lite";
import { config } from "../config.js";
import { lookupGeo, type GeoLocation } from "../geo.js";
import type { Around } from "./models.js";

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Tolerance added to the around radius: the reported GPS accuracy (capped at
// 65 m so a coarse fix cannot buy extra range) plus a 20 m grace margin.
export function joinToleranceM(accuracy: number) {
  return Math.min(Math.max(accuracy, 0), 65) + 20;
}

// req.ip is derived by Express according to `trust proxy` (rightmost
// X-Forwarded-For entry for the configured hop count) and cannot be forged by
// the client, unlike the leftmost XFF value. Keep `trust proxy` aligned with
// the real number of trusted proxies in front of the app.
export function clientIpOf(req: Request): string | null {
  return req.ip ?? null;
}

export type JoinFixInput = {
  lat: number;
  lng: number;
  accuracy: number;
  capturedAt: Date;
};

export type JoinRejection = {
  ok: false;
  status: 400 | 403;
  error: "GPS_TOO_COARSE" | "STALE_FIX" | "OUT_OF_RANGE" | "IMPLAUSIBLE_MOVEMENT" | "GEO_MISMATCH";
  details?: Record<string, unknown>;
};

export type JoinAudit = {
  joinFixes: Array<JoinFixInput & { distanceM: number }>;
  interFixDistanceM: number;
  joinIp: string | null;
  joinGeo: GeoLocation | null;
  suspicious: boolean;
};

export type JoinVerdict = { ok: true; audit: JoinAudit } | JoinRejection;

export function geoIpConsistency(ip: string | null, lat: number, lng: number): {
  geo: GeoLocation | null;
  distanceKm: number | null;
} {
  const geo = ip ? lookupGeo(ip) : null;
  if (!ip || !geo || !geo.countryCode) return { geo, distanceKm: null };
  const raw = geoip.lookup(ip.trim().replace(/^::ffff:/, ""));
  if (!raw || !Array.isArray(raw.ll) || raw.ll.length !== 2) return { geo, distanceKm: null };
  const [geoLat, geoLng] = raw.ll;
  const distanceKm = haversineMeters(lat, lng, geoLat, geoLng) / 1000;
  return { geo, distanceKm };
}

// Server-side double-fix verification. Guard order (after 404/410/idempotence
// /kicked which are handled by the route): accuracy -> freshness/spacing ->
// radius on EACH fix -> inter-fix speed plausibility -> GeoIP consistency.
export function verifyJoinFixes(
  around: Pick<Around, "center" | "radiusM">,
  fixes: [JoinFixInput, JoinFixInput],
  options: { ip: string | null; now?: Date; bypassGeoChecks?: boolean }
): JoinVerdict {
  const now = options.now ?? new Date();
  const bypass = options.bypassGeoChecks === true;
  const [lngCenter, latCenter] = around.center.coordinates;

  for (const fix of fixes) {
    if (fix.accuracy > config.joinMaxAccuracyM) {
      return {
        ok: false,
        status: 400,
        error: "GPS_TOO_COARSE",
        details: { accuracyM: fix.accuracy, maxAccuracyM: config.joinMaxAccuracyM }
      };
    }
  }

  for (const fix of fixes) {
    const ageMs = now.getTime() - fix.capturedAt.getTime();
    if (ageMs > config.joinMaxFixAgeMs || ageMs < -30_000) {
      return {
        ok: false,
        status: 400,
        error: "STALE_FIX",
        details: { ageMs, maxAgeMs: config.joinMaxFixAgeMs }
      };
    }
  }

  const spacingMs = Math.abs(fixes[1].capturedAt.getTime() - fixes[0].capturedAt.getTime());
  if (spacingMs < config.joinMinFixSpacingMs) {
    return {
      ok: false,
      status: 400,
      error: "STALE_FIX",
      details: { spacingMs, minSpacingMs: config.joinMinFixSpacingMs }
    };
  }

  const withDistances = fixes.map((fix) => ({
    ...fix,
    distanceM: Math.round(haversineMeters(latCenter, lngCenter, fix.lat, fix.lng))
  })) as [JoinFixInput & { distanceM: number }, JoinFixInput & { distanceM: number }];

  const interFixDistanceM = Math.round(
    haversineMeters(fixes[0].lat, fixes[0].lng, fixes[1].lat, fixes[1].lng)
  );

  const { geo, distanceKm } = geoIpConsistency(options.ip, fixes[1].lat, fixes[1].lng);
  let suspicious = false;

  if (!bypass) {
    for (const fix of withDistances) {
      const allowedM = Math.round(around.radiusM + joinToleranceM(fix.accuracy));
      if (fix.distanceM > allowedM) {
        return {
          ok: false,
          status: 403,
          error: "OUT_OF_RANGE",
          details: { distanceM: fix.distanceM, allowedM }
        };
      }
    }

    const speedMps = interFixDistanceM / Math.max(spacingMs / 1000, 0.001);
    if (speedMps > config.joinMaxInterFixSpeedMps) {
      return {
        ok: false,
        status: 403,
        error: "IMPLAUSIBLE_MOVEMENT",
        details: { interFixDistanceM, speedMps: Math.round(speedMps * 10) / 10 }
      };
    }

    if (distanceKm !== null) {
      if (distanceKm > 1000) {
        return {
          ok: false,
          status: 403,
          error: "GEO_MISMATCH",
          details: { geoIpDistanceKm: Math.round(distanceKm) }
        };
      }
      if (distanceKm >= 300) suspicious = true;
    }
  }

  return {
    ok: true,
    audit: {
      joinFixes: withDistances,
      interFixDistanceM,
      joinIp: options.ip,
      joinGeo: geo,
      suspicious
    }
  };
}
