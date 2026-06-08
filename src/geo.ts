import geoip from "geoip-lite";

const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

const PRIVATE_RANGES: RegExp[] = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^127\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i
];

function isPrivateAddress(ip: string) {
  return PRIVATE_RANGES.some((pattern) => pattern.test(ip));
}

function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim().replace(/^::ffff:/, "");
  if (!trimmed) return null;
  return trimmed;
}

export type GeoLocation = {
  countryCode: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  timezone: string | null;
};

export function lookupGeo(ip: string | null | undefined): GeoLocation {
  const normalized = normalizeIp(ip);
  if (!normalized || isPrivateAddress(normalized)) {
    return { countryCode: null, country: null, city: null, region: null, timezone: null };
  }
  const lookup = geoip.lookup(normalized);
  if (!lookup) {
    return { countryCode: null, country: null, city: null, region: null, timezone: null };
  }
  const countryCode = lookup.country || null;
  let country: string | null = null;
  if (countryCode) {
    try {
      country = COUNTRY_NAMES.of(countryCode) ?? countryCode;
    } catch {
      country = countryCode;
    }
  }
  return {
    countryCode,
    country,
    city: lookup.city || null,
    region: lookup.region || null,
    timezone: lookup.timezone || null
  };
}

export function countryFromLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const trimmed = locale.trim();
  if (!trimmed) return null;
  try {
    const region = new Intl.Locale(trimmed).region;
    if (!region) return null;
    return COUNTRY_NAMES.of(region) ?? region;
  } catch {
    return null;
  }
}
