import { env } from '../../config/env';
import { hasCoords, type LatLng } from './allocation.geo';

// Map lookups for shop allocation. With GOOGLE_MAPS_API_KEY set, Google answers (addresses are found the way a person finds
// them in Google Maps, and routes are real two-wheeler routes). Without a key the open services (OpenStreetMap Nominatim for
// addresses, OSRM for routes) are used. When nothing answers, callers fall back to a straight-line estimate.

const osmHeaders = () => ({ 'User-Agent': env.MAPS_USER_AGENT, Accept: 'application/json', 'Accept-Language': 'en' });
const TIMEOUT_MS = 9000;
const googleOn = () => !!env.GOOGLE_MAPS_API_KEY;

export interface GeocodeHit extends LatLng { quality: 'ADDRESS' | 'AREA' | 'PINCODE' }
export interface GeocodeQuery { address?: string | undefined; area?: string | undefined; district?: string | undefined; pincode?: string | undefined }

const clean = (s?: string) => (s ?? '').replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();
// Tamil Nadu and the neighbouring states sit well inside this box; a hit outside India is a wrong match.
const inIndia = (p: LatLng) => p.lat >= 6 && p.lat <= 37.5 && p.lng >= 68 && p.lng <= 98;

async function osmSearch(q: string): Promise<LatLng | null> {
  const url = `${env.geocoderUrl}/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: osmHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Address lookup answered ${res.status}`);
  const body = (await res.json()) as { lat?: string; lon?: string }[];
  const first = body[0];
  const p = first ? { lat: Number(first.lat), lng: Number(first.lon) } : null;
  return p && hasCoords(p) && inIndia(p) ? p : null;
}

async function googleSearch(q: string): Promise<(LatLng & { exact: boolean; postal: boolean }) | null> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:IN&region=in&key=${encodeURIComponent(env.GOOGLE_MAPS_API_KEY)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Address lookup answered ${res.status}`);
  const body = (await res.json()) as { status?: string; results?: { geometry?: { location?: { lat: number; lng: number }; location_type?: string }; types?: string[] }[] };
  if (body.status === 'ZERO_RESULTS') return null;
  if (body.status !== 'OK') throw new Error(`Address lookup answered ${body.status}`);
  const r = body.results?.[0];
  const loc = r?.geometry?.location;
  const p = loc ? { lat: loc.lat, lng: loc.lng } : null;
  if (!p || !hasCoords(p) || !inIndia(p)) return null;
  const type = r?.geometry?.location_type;
  return { ...p, exact: type === 'ROOFTOP' || type === 'RANGE_INTERPOLATED', postal: !!r?.types?.includes('postal_code') };
}

/** Finds a shop's position. Tries the full address, then the area, then the pincode, and says how exact the match is. */
export async function geocode(q: GeocodeQuery, pause: () => Promise<void> = async () => undefined): Promise<GeocodeHit | null> {
  if (!googleOn() && !env.geocoderUrl) return null;
  const district = clean(q.district);
  const tries: { text: string; quality: GeocodeHit['quality'] }[] = [];
  if (clean(q.address)) tries.push({ text: [clean(q.address), clean(q.area), district, clean(q.pincode), 'India'].filter(Boolean).join(', '), quality: 'ADDRESS' });
  if (clean(q.area)) tries.push({ text: [clean(q.area), district, 'Tamil Nadu', 'India'].filter(Boolean).join(', '), quality: 'AREA' });
  if (/^\d{6}$/.test(clean(q.pincode))) tries.push({ text: `${clean(q.pincode)}, India`, quality: 'PINCODE' });
  for (const t of tries) {
    if (googleOn()) {
      const g = await googleSearch(t.text);
      // Google says how exact it was; a loose match for a full address is only as good as the area.
      if (g) return { lat: g.lat, lng: g.lng, quality: t.quality === 'ADDRESS' && !g.exact ? (g.postal ? 'PINCODE' : 'AREA') : t.quality };
    } else {
      const p = await osmSearch(t.text);
      if (p) return { ...p, quality: t.quality };
    }
    await pause();
  }
  return null;
}

export interface RoadTrip { order: number[]; km: number; minutes: number; path: [number, number][] }

/** Decodes Google's encoded polyline into [lat, lng] points. */
export function decodePolyline(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    for (const axis of [0, 1] as const) {
      let shift = 0, result = 0, b: number;
      do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < encoded.length + 1);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

async function googleTrip(points: LatLng[]): Promise<RoadTrip | null> {
  const ll = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const mid = points.slice(1);
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.optimizedIntermediateWaypointIndex',
    },
    body: JSON.stringify({ origin: ll(points[0]!), destination: ll(points[0]!), intermediates: mid.map(ll), travelMode: env.GOOGLE_TRAVEL_MODE, optimizeWaypointOrder: mid.length > 1, polylineQuality: 'OVERVIEW' }),
    signal: AbortSignal.timeout(TIMEOUT_MS * 2),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { routes?: { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string }; optimizedIntermediateWaypointIndex?: number[] }[] };
  const r = body.routes?.[0];
  if (!r || r.distanceMeters == null) return null;
  const order = r.optimizedIntermediateWaypointIndex?.length === mid.length ? r.optimizedIntermediateWaypointIndex : mid.map((_, i) => i);
  return {
    order,
    km: Math.round((r.distanceMeters / 1000) * 10) / 10,
    minutes: Math.round(parseInt(r.duration ?? '0', 10) / 60),
    path: r.polyline?.encodedPolyline ? decodePolyline(r.polyline.encodedPolyline) : [],
  };
}

async function osrmTrip(points: LatLng[]): Promise<RoadTrip | null> {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${env.routingUrl}/trip/v1/driving/${coords}?roundtrip=true&source=first&geometries=geojson&overview=simplified`;
  const res = await fetch(url, { headers: osmHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  if (!res.ok) return null;
  const body = (await res.json()) as { code?: string; trips?: { distance: number; duration: number; geometry?: { coordinates: [number, number][] } }[]; waypoints?: { waypoint_index: number }[] };
  const trip = body.trips?.[0];
  if (body.code !== 'Ok' || !trip || !body.waypoints) return null;
  // waypoints[i].waypoint_index is where input point i falls in the trip; sort the inputs by it.
  const order = body.waypoints.map((w, i) => ({ i, at: w.waypoint_index })).filter((x) => x.i !== 0).sort((a, b) => a.at - b.at).map((x) => x.i - 1);
  return { order, km: Math.round((trip.distance / 1000) * 10) / 10, minutes: Math.round(trip.duration / 60), path: (trip.geometry?.coordinates ?? []).map(([lng, lat]) => [lat, lng] as [number, number]) };
}

/**
 * Best round trip through the points, starting and ending at the first one, over real roads (like a Google Maps
 * multi-stop route). `order` lists the other points' indexes in visiting order.
 */
export async function roadTrip(points: LatLng[]): Promise<RoadTrip | null> {
  if (points.length < 2) return null;
  if (googleOn()) {
    try {
      const g = await googleTrip(points);
      if (g) return g;
    } catch {
      /* fall through to the open service */
    }
  }
  if (!env.routingUrl) return null;
  try {
    return await osrmTrip(points);
  } catch {
    return null;
  }
}

const pt = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** A Google Maps directions link for a day's round trip using map positions (opens in the browser or the phone's Maps app; no key needed). */
export function googleMapsUrl(origin: LatLng, stops: LatLng[]) {
  return `https://www.google.com/maps/dir/${[origin, ...stops, origin].map(pt).join('/')}`;
}

/**
 * The same trip as Google Maps links built from each shop's written address, exactly as a person would type the stops in.
 * Needs no map position, so it works before the shops are located. `origin` is a position or a place name.
 */
export function googleMapsAddressUrl(origin: LatLng | string | null, stops: { address: string; at?: LatLng | undefined }[]) {
  // Positions stay as plain "lat,lng"; written addresses and place names are URL-encoded.
  const o = origin ? (typeof origin === 'string' ? encodeURIComponent(origin) : pt(origin)) : null;
  const parts = [o, ...stops.map((s) => (s.address.trim() ? encodeURIComponent(s.address.trim()) : s.at ? pt(s.at) : '')), o].filter((x): x is string => !!x);
  return `https://www.google.com/maps/dir/${parts.join('/')}`;
}
