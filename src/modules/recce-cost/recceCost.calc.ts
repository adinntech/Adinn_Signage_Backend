/** Pure recce-cost calculations. The server is the only source of truth; the web screen shows these values. */

export const DEFAULT_RATES = {
  kmRate: 3,
  breakfast: { from: '07:00', to: '10:00', amount: 100 },
  lunch: { from: '14:00', to: '16:00', amount: 100 },
  dinner: { from: '20:00', to: '22:00', amount: 100 },
  dailyFoodMax: 300,
  mealMinOverlapMinutes: 60,
  stayDistanceKm: 200,
  stayDurationHours: 6,
  stayPerNight: 800,
  stayMaxAmount: 4000,
  stayOrigin: 'OFFICE' as const,
  receiptRequiredAbove: 100,
  adminApprovalAbove: 5000,
  maxTripKm: 1000,
};
export type Rates = typeof DEFAULT_RATES;

const IST_MIN = 330;
const DAY = 24 * 60;
const r2 = (n: number) => Math.round(n * 100) / 100;
const toMin = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
/** Minutes since epoch in IST, so "calendar day" and meal windows follow Indian local time. */
const istMinutes = (d: Date) => Math.floor(d.getTime() / 60000) + IST_MIN;

export interface MealDay {
  date: string;
  meals: { meal: 'breakfast' | 'lunch' | 'dinner'; amount: number }[];
  suggested: number;
}

/** Meals per calendar day: a meal counts when the trip overlaps its window by at least mealMinOverlapMinutes. */
export function foodSuggestion(start: Date, end: Date | undefined, rates: Rates): { days: MealDay[]; suggested: number; durationHours: number } {
  if (!end || end <= start) return { days: [], suggested: 0, durationHours: 0 };
  const s = istMinutes(start);
  const e = istMinutes(end);
  const days: MealDay[] = [];
  for (let dayStart = Math.floor(s / DAY) * DAY; dayStart < e; dayStart += DAY) {
    const meals: MealDay['meals'] = [];
    for (const meal of ['breakfast', 'lunch', 'dinner'] as const) {
      const w = rates[meal];
      const overlap = Math.min(e, dayStart + toMin(w.to)) - Math.max(s, dayStart + toMin(w.from));
      if (overlap >= rates.mealMinOverlapMinutes && overlap > 0) meals.push({ meal, amount: w.amount });
    }
    const suggested = Math.min(rates.dailyFoodMax, meals.reduce((a, m) => a + m.amount, 0));
    days.push({ date: new Date((dayStart - IST_MIN) * 60000 + IST_MIN * 60000).toISOString().slice(0, 10), meals, suggested });
  }
  return { days, suggested: r2(days.reduce((a, d) => a + d.suggested, 0)), durationHours: r2((e - s) / 60) };
}

/** Calendar nights spent away (start date to end date in IST). */
export function nightsBetween(start: Date, end: Date | undefined): number {
  if (!end || end <= start) return 0;
  return Math.max(0, Math.floor(istMinutes(end) / DAY) - Math.floor(istMinutes(start) / DAY));
}

export function stayEligibility(input: { distanceKm?: number; hours?: number }, rates: Rates) {
  const byDistance = (input.distanceKm ?? 0) >= rates.stayDistanceKm && rates.stayDistanceKm > 0;
  const byDuration = (input.hours ?? 0) >= rates.stayDurationHours && rates.stayDurationHours > 0;
  const eligible = byDistance || byDuration;
  const reason = eligible
    ? [byDistance && `Distance ${input.distanceKm} km ≥ ${rates.stayDistanceKm} km`, byDuration && `Travel time ${input.hours} h ≥ ${rates.stayDurationHours} h`].filter(Boolean).join(' and ')
    : `Below the limits (${rates.stayDistanceKm} km or ${rates.stayDurationHours} h)`;
  return { eligible, reason };
}

export const suggestedStay = (nights: number, rates: Rates) => r2(Math.min(nights * rates.stayPerNight, rates.stayMaxAmount));

/** Haversine distance in km. */
export function haversineKm(a: { lat?: number; lng?: number }, b: { lat?: number; lng?: number }) {
  if ([a.lat, a.lng, b.lat, b.lng].some((v) => typeof v !== 'number')) return undefined;
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat! - a.lat!);
  const dLng = rad(b.lng! - a.lng!);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat!)) * Math.cos(rad(b.lat!)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface TripCalcInput {
  transportType: 'PUBLIC' | 'PRIVATE';
  startAt: Date;
  endAt?: Date;
  legs: { amount: number }[];
  odoStart?: { reading?: number; gps?: { lat?: number; lng?: number; accuracy?: number }; capturedAt?: Date };
  odoEnd?: { reading?: number; gps?: { lat?: number; lng?: number; accuracy?: number }; capturedAt?: Date };
  misc: { amount: number }[];
  manualDistanceKm?: number;
  estimatedTravelHours?: number;
  stayNights?: number;
  stayClaimed?: number;
  stayException?: boolean;
  foodClaimed?: number;
}

export function calcTrip(t: TripCalcInput, rates: Rates) {
  const flags: string[] = [];
  let distanceKm: number | undefined;
  if (t.transportType === 'PRIVATE') {
    const a = t.odoStart?.reading;
    const b = t.odoEnd?.reading;
    if (a !== undefined && b !== undefined) {
      if (b < a) flags.push('END_BELOW_START');
      else distanceKm = r2(b - a);
    }
    if (distanceKm !== undefined && distanceKm > rates.maxTripKm) flags.push('DISTANCE_ABOVE_LIMIT');
    if (t.odoStart && !t.odoStart.gps?.lat) flags.push('START_GPS_MISSING');
    if (t.odoEnd && !t.odoEnd.gps?.lat) flags.push('END_GPS_MISSING');
    for (const g of [t.odoStart?.gps, t.odoEnd?.gps]) if (g?.accuracy && g.accuracy > 100) { flags.push('GPS_LOW_ACCURACY'); break; }
    const straight = haversineKm(t.odoStart?.gps ?? {}, t.odoEnd?.gps ?? {});
    // The road distance can never be shorter than the straight line between the two GPS points.
    if (straight !== undefined && distanceKm !== undefined && distanceKm < straight * 0.9 - 1) flags.push('ODOMETER_SHORTER_THAN_GPS');
    if (t.odoStart?.capturedAt && t.odoEnd?.capturedAt && t.odoEnd.capturedAt < t.odoStart.capturedAt) flags.push('END_BEFORE_START_TIME');
  }
  const tripKm = t.transportType === 'PRIVATE' ? distanceKm : t.manualDistanceKm;
  const transportAmount = t.transportType === 'PRIVATE' ? r2((distanceKm ?? 0) * rates.kmRate) : r2(t.legs.reduce((a, l) => a + l.amount, 0));
  const miscAmount = r2(t.misc.reduce((a, m) => a + m.amount, 0));

  const food = foodSuggestion(t.startAt, t.endAt, rates);
  const foodAmount = t.foodClaimed ?? food.suggested;

  const hours = t.estimatedTravelHours ?? (food.durationHours || undefined);
  const stay = stayEligibility({ distanceKm: tripKm, hours }, rates);
  const stayAmount = r2(t.stayClaimed ?? 0);

  if (food.suggested < foodAmount) flags.push('FOOD_ABOVE_SUGGESTED');
  if (stayAmount > 0 && !stay.eligible && !t.stayException) flags.push('STAY_NOT_ELIGIBLE');

  const total = r2(transportAmount + miscAmount + foodAmount + stayAmount);
  return {
    distanceKm: tripKm,
    kmRate: rates.kmRate,
    transport: transportAmount,
    misc: miscAmount,
    food: { suggested: food.suggested, claimed: r2(foodAmount), days: food.days, durationHours: food.durationHours },
    stay: { ...stay, nights: t.stayNights ?? nightsBetween(t.startAt, t.endAt), suggested: suggestedStay(t.stayNights ?? nightsBetween(t.startAt, t.endAt), rates), claimed: stayAmount },
    total,
    needsAdminApproval: total > rates.adminApprovalAbove,
    flags,
  };
}

export interface VendorRateInput {
  ratePerShop: number; ratePerDay: number; ratePerLocation: number; fixedProjectRate: number;
  travelCharges: number; stayCharges: number; otherCharges: number;
}
/** Vendor cost for one assignment. A fixed project rate replaces the per-unit rates. */
export function calcVendorCost(rate: VendorRateInput, q: { shops: number; days: number; locations: number; additional?: number }) {
  const base = rate.fixedProjectRate > 0 ? rate.fixedProjectRate : q.shops * rate.ratePerShop + q.days * rate.ratePerDay + q.locations * rate.ratePerLocation;
  const extras = rate.travelCharges + rate.stayCharges + rate.otherCharges + (q.additional ?? 0);
  return { base: r2(base), extras: r2(extras), total: r2(base + extras) };
}
