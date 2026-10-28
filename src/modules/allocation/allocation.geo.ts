// Pure map maths for shop allocation: distances, nearest-neighbour routes, splitting shops between teams.

export interface LatLng { lat: number; lng: number }
/** Straight-line distance is shorter than the road; this factor turns it into a usable road estimate. */
export const ROAD_FACTOR = 1.25;

const rad = (d: number) => (d * Math.PI) / 180;
export function haversineKm(a: LatLng, b: LatLng) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export const roadKm = (a: LatLng, b: LatLng) => Math.round(haversineKm(a, b) * ROAD_FACTOR * 10) / 10;
export const hasCoords = (p: { lat?: number | null | undefined; lng?: number | null | undefined }): p is LatLng => typeof p.lat === 'number' && typeof p.lng === 'number' && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/** Visit order: always go to the closest shop not yet visited. */
export function nearestOrder<T extends LatLng>(origin: LatLng, points: T[]): T[] {
  const left = [...points];
  const out: T[] = [];
  let at = origin;
  while (left.length) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < left.length; i++) {
      const d = haversineKm(at, left[i]!);
      if (d < bestD) { bestD = d; best = i; }
    }
    const [next] = left.splice(best, 1);
    out.push(next!);
    at = next!;
  }
  return out;
}

export interface Team { key: string; vendorId: string | null }
export interface SplitSite { id: string; district?: string | null | undefined; distanceKm: number | null; seq: number }
export type SplitBy = 'district' | 'distance' | 'count';

/**
 * Fills each team in turn up to `maxPerTeam` shops (or an even share when not given). Sorting decides who gets what:
 * by district keeps a district together, by distance gives the nearest shops to the first team.
 */
export function splitSites(sites: SplitSite[], teams: Team[], by: SplitBy, maxPerTeam?: number) {
  if (!teams.length) return [];
  const sorted = [...sites].sort((a, b) => {
    if (by === 'district') return (a.district ?? '').localeCompare(b.district ?? '') || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.seq - b.seq;
    if (by === 'distance') return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.seq - b.seq;
    return a.seq - b.seq;
  });
  const cap = Math.max(1, maxPerTeam ?? Math.ceil(sorted.length / teams.length));
  const groups = teams.map((t) => ({ team: t, sites: [] as SplitSite[] }));
  sorted.forEach((s, i) => groups[Math.min(Math.floor(i / cap), groups.length - 1)]!.sites.push(s));
  return groups.filter((g) => g.sites.length > 0);
}

export interface DayStop<T> { stop: T; legKm: number }
export interface Day<T> { day: number; stops: DayStop<T>[]; km: number }
/** Nearest-neighbour route from the origin, cut into days of `shopsPerDay`; the last day also returns to the origin. */
export function buildItinerary<T extends LatLng>(origin: LatLng, points: T[], shopsPerDay: number) {
  const per = Math.max(1, Math.floor(shopsPerDay));
  const ordered = nearestOrder(origin, points);
  const days: Day<T>[] = [];
  let at = origin;
  ordered.forEach((p, i) => {
    if (i % per === 0) days.push({ day: days.length + 1, stops: [], km: 0 });
    const d = days[days.length - 1]!;
    const leg = roadKm(at, p);
    d.stops.push({ stop: p, legKm: leg });
    d.km = Math.round((d.km + leg) * 10) / 10;
    at = p;
  });
  const back = days.length ? roadKm(at, origin) : 0;
  if (days.length) { const last = days[days.length - 1]!; last.km = Math.round((last.km + back) * 10) / 10; }
  const totalKm = Math.round(days.reduce((a, d) => a + d.km, 0) * 10) / 10;
  return { days, totalKm, returnKm: back };
}
