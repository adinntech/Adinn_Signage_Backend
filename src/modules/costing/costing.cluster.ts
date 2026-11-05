// Groups a project's shops into work areas: shops that sit close together can be done in one trip, so the in-house team's
// cost is shared between them, while a vendor charges per shop. Pure functions (no database) so they can be tested alone.
import { haversineKm, nearestOrder, roadKm, type LatLng } from '../allocation/allocation.geo';

export interface ClusterShop { id: string; district: string; location?: string | null; lat?: number | null; lng?: number | null; pincode?: string | null }
export interface Cluster {
  key: string;
  name: string;
  district: string;
  shops: ClusterShop[];
  /** Shops that have a map position. */
  located: number;
  centre: LatLng | null;
  /** Road km from the start point to the middle of the area. */
  distanceKm: number;
  /** One trip from the start point through the located shops (nearest next) and back. */
  routeKm: number;
  towns: string[];
  /** Pincodes of the area's shops (up to 5), used to find vendors nearby. */
  pincodes: string[];
}

export const CLUSTER_RADIUS_KM = 25;
const key = (s?: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const has = (s: ClusterShop): s is ClusterShop & LatLng => typeof s.lat === 'number' && typeof s.lng === 'number' && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180;
const tidy = (s?: string | null) => (s ?? '').trim().replace(/\s+/g, ' ');

function topTowns(shops: ClusterShop[], limit = 3) {
  const count = new Map<string, { label: string; n: number }>();
  for (const s of shops) {
    const label = tidy(s.location);
    if (!label) continue;
    const e = count.get(key(label)) ?? { label, n: 0 };
    e.n++;
    count.set(key(label), e);
  }
  return [...count.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).slice(0, limit).map((e) => e.label);
}

/**
 * Within each district: shops with a map position are grouped by distance (farthest from the start first, everything within
 * `radiusKm` of that shop joins it); shops without a position join the area their town name matches, else get a group by
 * town name. Biggest areas come first.
 */
export function clusterShops(shops: ClusterShop[], origin: LatLng | null, radiusKm = CLUSTER_RADIUS_KM): Cluster[] {
  const byDistrict = new Map<string, ClusterShop[]>();
  for (const s of shops) {
    const k = key(s.district) || 'no-district';
    byDistrict.set(k, [...(byDistrict.get(k) ?? []), s]);
  }
  const out: Cluster[] = [];
  for (const [dk, list] of byDistrict) {
    const district = tidy(list.find((s) => tidy(s.district))?.district) || 'No district';
    const located = list.filter(has);
    const loose = list.filter((s) => !has(s));
    const groups: ClusterShop[][] = [];
    const left = new Set(located);
    while (left.size) {
      const seed = [...left].reduce((a, b) => ((origin ? haversineKm(origin, b as LatLng) - haversineKm(origin, a as LatLng) : 0) > 0 ? b : a));
      const g = [...left].filter((s) => haversineKm(seed as LatLng, s as LatLng) <= radiusKm);
      g.forEach((s) => left.delete(s));
      groups.push(g);
    }
    // Shops without a position: join the area whose towns include theirs, else a group of their own per town.
    const townOf = groups.map((g) => new Set(g.map((s) => key(s.location)).filter(Boolean)));
    const orphans = new Map<string, ClusterShop[]>();
    for (const s of loose) {
      const idx = townOf.findIndex((t) => key(s.location) && t.has(key(s.location)));
      if (idx >= 0) groups[idx]!.push(s);
      else orphans.set(key(s.location) || 'unknown', [...(orphans.get(key(s.location) || 'unknown') ?? []), s]);
    }
    groups.push(...orphans.values());
    groups.sort((a, b) => b.length - a.length);
    groups.forEach((g, i) => {
      const pts = g.filter(has) as (ClusterShop & LatLng)[];
      const centre = pts.length ? { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length } : null;
      let routeKm = 0;
      if (origin && pts.length) {
        let at: LatLng = origin;
        for (const p of nearestOrder(origin, pts)) { routeKm += roadKm(at, p); at = p; }
        routeKm += roadKm(at, origin);
      }
      const towns = topTowns(g);
      const label = towns.slice(0, 2).join(' & ');
      out.push({
        key: `${dk}~${i + 1}`,
        name: label ? `${label}${tidy(district) && !towns.some((t) => key(t) === key(district)) ? ` (${district})` : ''}${pts.length === 0 ? ' - not on map' : ''}` : `${district} area ${i + 1}`,
        district,
        shops: g,
        located: pts.length,
        centre,
        distanceKm: origin && centre ? roadKm(origin, centre) : 0,
        routeKm: Math.round(routeKm * 10) / 10,
        towns,
        pincodes: [...new Set(g.map((s) => (s.pincode ?? '').replace(/[^0-9]/g, '')).filter((p) => p.length === 6))].slice(0, 5),
      });
    });
  }
  return out;
}
