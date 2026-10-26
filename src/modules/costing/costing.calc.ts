// Pure cost rules for "vendor vs in-house", worked out per area (district) of a project. The only place these formulas
// live; the web shows exactly what this returns.

export interface CostRates {
  /** Vendor price per shop, and the higher price when the area is far from the start point. */
  vendorRatePerShop: number;
  vendorFarRatePerShop: number;
  /** One-way distance (km) from which the vendor's far rate applies. */
  vendorFarKm: number;
  /** In-house: food for one person for one day = three meals (a third each), counted from the trip's start and end time. */
  foodPerDay: number;
  /** In-house: one night's stay (set by admin, normally 400-500). */
  stayPerNight: number;
  /** In-house: fuel for every km of the route. */
  fuelRatePerKm: number;
  /** Per-shop limit; above it (vendor bargained too high, or in-house too costly) a special approval is needed. */
  thresholdPerShop: number;
  /** Worst case per shop for in-house. */
  worstCasePerShop: number;
  /** In-house costing more than this % above the vendor cost needs special approval. */
  overVendorPercent: number;
}

export const DEFAULT_RATES: CostRates = {
  vendorRatePerShop: 300,
  vendorFarRatePerShop: 350,
  vendorFarKm: 100,
  foodPerDay: 300,
  stayPerNight: 450,
  fuelRatePerKm: 3,
  thresholdPerShop: 400,
  worstCasePerShop: 450,
  overVendorPercent: 25,
};

export type Channel = 'VENDOR' | 'IN_HOUSE';

/** Meal times used to count meals between a trip's start and end. */
export const MEAL_HOURS = [8, 13, 20] as const; // breakfast, lunch, dinner

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;
/** "2026-11-05T08:30" (a wall-clock time, no time zone) -> milliseconds on a fixed scale, or null when it is not valid. */
const wall = (s?: string | null) => {
  const m = s ? NAIVE.exec(s) : null;
  if (!m) return null;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  return Number.isFinite(t) ? t : null;
};
const DAY = 86_400_000;

export interface TripSpan { valid: boolean; meals: number; days: number; nights: number }
/**
 * What a trip needs: meals eaten between start and end (breakfast 8:00, lunch 13:00, dinner 20:00), calendar days touched,
 * and nights away (midnights crossed). A missing or reversed time counts as one ordinary day (3 meals, no stay).
 */
export function tripSpan(start?: string | null, end?: string | null): TripSpan {
  const a = wall(start);
  const b = wall(end);
  if (a === null || b === null || b < a) return { valid: false, meals: 3, days: 1, nights: 0 };
  const firstDay = Math.floor(a / DAY);
  const lastDay = Math.floor(b / DAY);
  let meals = 0;
  for (let d = firstDay; d <= lastDay; d++) for (const h of MEAL_HOURS) { const t = d * DAY + h * 3_600_000; if (t >= a && t <= b) meals++; }
  return { valid: true, meals, days: lastDay - firstDay + 1, nights: lastDay - firstDay };
}

export interface LegInput {
  shops: number;
  /** One-way distance from the start point to this area (km). */
  distanceKm: number;
  /** Total km the in-house team travels for this area (all days). Blank = a round trip of 2 x distance. */
  routeKm?: number | null | undefined;
  tripStart?: string | null | undefined;
  tripEnd?: string | null | undefined;
  /** Projects of different clients covered on the same trip; the in-house cost is shared between them. */
  clientsShared?: number | undefined;
  otherAmount?: number | undefined;
  /** Vendor price per shop agreed for this area (after bargaining). Blank = the vendor's rate card, or the company rate. */
  vendorRate?: number | null | undefined;
  vendorOther?: number | undefined;
  /** The chosen vendor's own rate card, when they have one. */
  cardRate?: number | null | undefined;
  cardFarRate?: number | null | undefined;
}

export interface LegResult {
  vendor: { perShopRate: number; far: boolean; negotiated: boolean; shopCost: number; other: number; total: number; perShop: number };
  inHouse: { meals: number; days: number; nights: number; datesAssumed: boolean; routeKm: number; food: number; stay: number; fuel: number; other: number; subtotal: number; total: number; perShop: number };
  comparison: { difference: number; inHouseSavingPercent: number; inHouseOverVendorPercent: number; cheaper: Channel };
  flags: { inHouseOverThreshold: boolean; inHouseWorstCase: boolean; inHouseOverVendor: boolean; vendorOverThreshold: boolean };
  /** Whether choosing this channel for this area needs a special approval from admin. */
  needsApproval: Record<Channel, boolean>;
  recommended: Channel;
  reasons: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const nn = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

export function calculateLeg(input: LegInput, rates: CostRates): LegResult {
  const shops = Math.max(1, Math.floor(nn(input.shops)));
  const shared = Math.max(1, Math.floor(nn(input.clientsShared) || 1));

  const far = nn(input.distanceKm) >= rates.vendorFarKm;
  const negotiated = nn(input.vendorRate) > 0;
  const card = far ? nn(input.cardFarRate) || nn(input.cardRate) : nn(input.cardRate);
  const perShopRate = negotiated ? nn(input.vendorRate) : card || (far ? rates.vendorFarRatePerShop : rates.vendorRatePerShop);
  const vShop = r2(shops * perShopRate);
  const vOther = r2(nn(input.vendorOther));
  const vTotal = r2(vShop + vOther);

  const trip = tripSpan(input.tripStart, input.tripEnd);
  const routeKm = nn(input.routeKm) || 2 * nn(input.distanceKm);
  const food = r2(trip.meals * (rates.foodPerDay / 3));
  const stay = r2(trip.nights * rates.stayPerNight);
  const fuel = r2(routeKm * rates.fuelRatePerKm);
  const other = r2(nn(input.otherAmount));
  const subtotal = r2(food + stay + fuel + other);
  const hTotal = r2(subtotal / shared);

  const vendorPerShop = r2(vTotal / shops);
  const hPerShop = r2(hTotal / shops);
  const difference = r2(vTotal - hTotal);
  const overVendorPct = vTotal > 0 ? r2(((hTotal - vTotal) / vTotal) * 100) : 0;
  const flags = {
    inHouseOverThreshold: hPerShop > rates.thresholdPerShop,
    inHouseWorstCase: hPerShop >= rates.worstCasePerShop,
    inHouseOverVendor: overVendorPct > rates.overVendorPercent,
    vendorOverThreshold: vendorPerShop > rates.thresholdPerShop,
  };
  const needsApproval: Record<Channel, boolean> = {
    IN_HOUSE: flags.inHouseOverThreshold || flags.inHouseOverVendor,
    VENDOR: flags.vendorOverThreshold,
  };
  const cheaper: Channel = hTotal <= vTotal ? 'IN_HOUSE' : 'VENDOR';
  const other_ = cheaper === 'IN_HOUSE' ? 'VENDOR' : 'IN_HOUSE';
  // A channel that needs special approval is only recommended when the other one needs it too.
  const recommended: Channel = needsApproval[cheaper] && !needsApproval[other_] ? other_ : cheaper;

  const reasons: string[] = [];
  if (flags.inHouseWorstCase) reasons.push(`In-house cost per shop (₹${hPerShop}) is at or above the worst-case limit of ₹${rates.worstCasePerShop}.`);
  else if (flags.inHouseOverThreshold) reasons.push(`In-house cost per shop (₹${hPerShop}) is above the ₹${rates.thresholdPerShop} limit.`);
  if (flags.inHouseOverVendor) reasons.push(`In-house costs ${overVendorPct}% more than the vendor (limit ${rates.overVendorPercent}%).`);
  if (flags.vendorOverThreshold) reasons.push(`Vendor price per shop (₹${vendorPerShop}) is above the ₹${rates.thresholdPerShop} limit.`);

  return {
    vendor: { perShopRate, far, negotiated, shopCost: vShop, other: vOther, total: vTotal, perShop: vendorPerShop },
    inHouse: { meals: trip.meals, days: trip.days, nights: trip.nights, datesAssumed: !trip.valid, routeKm: r2(routeKm), food, stay, fuel, other, subtotal, total: hTotal, perShop: hPerShop },
    comparison: { difference, inHouseSavingPercent: vTotal > 0 ? r2((difference / vTotal) * 100) : 0, inHouseOverVendorPercent: overVendorPct, cheaper },
    flags,
    needsApproval,
    recommended,
    reasons,
  };
}

export interface PlanTotals {
  shops: number;
  /** Legs with a channel chosen. */
  chosenLegs: number;
  legs: number;
  /** Total of the chosen channel of every chosen leg. */
  chosenTotal: number;
  /** Total if every leg took its recommended channel. */
  recommendedTotal: number;
  perShop: number;
  inHouseShops: number;
  vendorShops: number;
  /** Any chosen leg that breaks a limit. */
  needsApproval: boolean;
  reasons: string[];
}

export function totalsOf(legs: { name: string; shops: number; channel?: Channel | null | undefined; calc: LegResult }[]): PlanTotals {
  let shops = 0, chosenLegs = 0, chosenTotal = 0, recommendedTotal = 0, inHouseShops = 0, vendorShops = 0;
  let needsApproval = false;
  const reasons: string[] = [];
  for (const l of legs) {
    shops += l.shops;
    recommendedTotal += l.calc.recommended === 'IN_HOUSE' ? l.calc.inHouse.total : l.calc.vendor.total;
    if (!l.channel) continue;
    chosenLegs++;
    chosenTotal += l.channel === 'IN_HOUSE' ? l.calc.inHouse.total : l.calc.vendor.total;
    if (l.channel === 'IN_HOUSE') inHouseShops += l.shops; else vendorShops += l.shops;
    if (l.calc.needsApproval[l.channel]) {
      needsApproval = true;
      reasons.push(`${l.name}: ${l.calc.reasons.filter((r) => (l.channel === 'IN_HOUSE' ? /In-house/.test(r) : /Vendor/.test(r))).join(' ')}`.trim());
    }
  }
  const cost = r2(chosenTotal);
  return { shops, chosenLegs, legs: legs.length, chosenTotal: cost, recommendedTotal: r2(recommendedTotal), perShop: shops && chosenLegs === legs.length ? r2(cost / shops) : 0, inHouseShops, vendorShops, needsApproval, reasons };
}
