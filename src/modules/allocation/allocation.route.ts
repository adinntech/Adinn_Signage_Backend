import { buildItinerary, roadKm, type LatLng } from './allocation.geo';
import { googleMapsAddressUrl, googleMapsUrl, roadTrip } from './allocation.maps';

export interface RouteSite extends LatLng {
  _id: unknown;
  siteCode: string;
  shopName?: string | undefined;
  dealerName?: string | undefined;
  district?: string | undefined;
  location?: string | undefined;
  address1?: string | undefined;
  address2?: string | undefined;
  address3?: string | undefined;
  pincode?: string | undefined;
}

export interface RouteDay {
  day: number;
  km: number;
  minutes: number | null;
  source: 'ROAD' | 'ESTIMATE';
  path: [number, number][];
  /** Google Maps route through the shop positions. */
  googleUrl: string;
  /** The same stops typed in as written addresses, the way a person would enter them in Google Maps. */
  googleAddressUrl: string;
  stops: { id: unknown; name: string; district: string | null; area: string | null; lat: number; lng: number; legKm: number }[];
}

const nameOf = (s: RouteSite) => s.shopName || s.dealerName || s.siteCode;
/** Shop name and written address, as typed into Google Maps. */
export const addressOf = (s: RouteSite) => [s.shopName || s.dealerName, s.address1, s.address2, s.address3 ?? s.location, s.district, s.pincode].map((x) => (x ?? '').trim()).filter(Boolean).join(', ');

/**
 * Cuts the shops into days of `shopsPerDay` and plans each day as a round trip from the start point: the visiting order and
 * the distance come from real roads (like a Google Maps multi-stop route), or a straight-line estimate when the road service
 * is not reachable. Shared by the Movement screen and the per-area route in the cost plan.
 */
export async function planRoute(origin: LatLng, sites: RouteSite[], shopsPerDay: number) {
  const grouped = buildItinerary(origin, sites, shopsPerDay);
  let road = 0;
  const days: RouteDay[] = [];
  for (const g of grouped.days) {
    const stops = g.stops.map((x) => x.stop);
    const trip = await roadTrip([origin, ...stops]);
    const ordered = trip ? trip.order.map((i) => stops[i]!) : stops;
    const legs = [origin, ...ordered, origin];
    const km = trip ? trip.km : Math.round(legs.slice(1).reduce((a, p, i) => a + roadKm(legs[i]!, p), 0) * 10) / 10;
    if (trip) road++;
    days.push({
      day: g.day,
      km,
      minutes: trip?.minutes ?? null,
      source: trip ? 'ROAD' : 'ESTIMATE',
      path: trip?.path ?? legs.map((p) => [p.lat, p.lng] as [number, number]),
      googleUrl: googleMapsUrl(origin, ordered),
      googleAddressUrl: googleMapsAddressUrl(origin, ordered.map((o) => ({ address: addressOf(o), at: o }))),
      stops: ordered.map((st, i) => ({ id: st._id, name: nameOf(st), district: st.district ?? null, area: st.location ?? null, lat: st.lat, lng: st.lng, legKm: roadKm(i === 0 ? origin : ordered[i - 1]!, st) })),
    });
  }
  const totalKm = Math.round(days.reduce((a, d) => a + d.km, 0) * 10) / 10;
  return { days, totalKm, roadDistance: days.length > 0 && road === days.length };
}
