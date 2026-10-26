// Pure cost rules for "vendor vs in-house". The only place these formulas live; the web shows what this returns.

export interface CostRates {
  /** Vendor price per shop, and the higher price when the shops are far away. */
  vendorRatePerShop: number;
  vendorFarRatePerShop: number;
  /** Average distance (km) from which the vendor's far rate applies. */
  vendorFarKm: number;
  /** In-house: food for one person for one day (morning, afternoon, dinner). */
  foodPerDay: number;
  stayPerNight: number;
  travelRatePerKm: number;
  /** Beyond this many km the long-distance travel rate applies to the extra distance. */
  longDistanceKm: number;
  longDistanceRatePerKm: number;
  /** Per-shop limit for in-house recce, and the worst case that is never acceptable without approval. */
  thresholdPerShop: number;
  worstCasePerShop: number;
  /** In-house costing more than this % above the vendor cost needs special approval. */
  overVendorPercent: number;
}

export const DEFAULT_RATES: CostRates = {
  vendorRatePerShop: 250,
  vendorFarRatePerShop: 350,
  vendorFarKm: 100,
  foodPerDay: 300,
  stayPerNight: 800,
  travelRatePerKm: 6,
  longDistanceKm: 150,
  longDistanceRatePerKm: 10,
  thresholdPerShop: 400,
  worstCasePerShop: 450,
  overVendorPercent: 25,
};

export interface CostInput {
  /** Shops the recce will cover. */
  shops: number;
  vendorDistanceKm: number;
  vendorOther: number;
  days: number;
  nights: number;
  totalKm: number;
  fuelAmount: number;
  otherAmount: number;
  /** Projects of different clients covered on the same trip; in-house cost is shared between them. */
  clientsShared: number;
  /** Shops the in-house team will cover (defaults to all shops). */
  shopsCovered?: number | undefined;
}

export type Channel = 'VENDOR' | 'IN_HOUSE';
export interface CostResult {
  vendor: { perShopRate: number; far: boolean; shopCost: number; other: number; total: number; perShop: number };
  inHouse: { food: number; stay: number; travel: number; longDistance: boolean; fuel: number; other: number; subtotal: number; total: number; perShop: number; shopsCovered: number };
  comparison: {
    /** vendor total - in-house total; positive when in-house is cheaper. */
    difference: number;
    /** Savings of the cheaper option relative to the vendor cost, in %. Negative when in-house costs more. */
    inHouseSavingPercent: number;
    inHouseOverVendorPercent: number;
    cheaper: Channel;
  };
  flags: { inHouseOverThreshold: boolean; inHouseWorstCase: boolean; inHouseOverVendor: boolean; vendorOverThreshold: boolean };
  /** Whether choosing this channel needs a special approval from admin. */
  needsApproval: Record<Channel, boolean>;
  recommended: Channel;
  reasons: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const nn = (n: number | undefined) => (Number.isFinite(n) && (n as number) > 0 ? (n as number) : 0);

export function travelCost(km: number, rates: CostRates) {
  const base = Math.min(km, rates.longDistanceKm) * rates.travelRatePerKm;
  const extra = Math.max(0, km - rates.longDistanceKm) * rates.longDistanceRatePerKm;
  return { amount: r2(base + extra), longDistance: km > rates.longDistanceKm };
}

export function calculateCosts(input: CostInput, rates: CostRates): CostResult {
  const shops = Math.max(1, Math.floor(nn(input.shops)));
  const covered = Math.max(1, Math.floor(nn(input.shopsCovered) || shops));
  const shared = Math.max(1, Math.floor(nn(input.clientsShared) || 1));

  const far = nn(input.vendorDistanceKm) >= rates.vendorFarKm;
  const perShopRate = far ? rates.vendorFarRatePerShop : rates.vendorRatePerShop;
  const vShop = r2(shops * perShopRate);
  const vOther = r2(nn(input.vendorOther));
  const vTotal = r2(vShop + vOther);

  const food = r2(nn(input.days) * rates.foodPerDay);
  const stay = r2(nn(input.nights) * rates.stayPerNight);
  const travel = travelCost(nn(input.totalKm), rates);
  const fuel = r2(nn(input.fuelAmount));
  const other = r2(nn(input.otherAmount));
  const subtotal = r2(food + stay + travel.amount + fuel + other);
  const hTotal = r2(subtotal / shared);

  const vendorPerShop = r2(vTotal / shops);
  const hPerShop = r2(hTotal / covered);
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
  // A channel that needs special approval is only recommended when the other one needs it too.
  const recommended: Channel = needsApproval[cheaper] && !needsApproval[cheaper === 'IN_HOUSE' ? 'VENDOR' : 'IN_HOUSE'] ? (cheaper === 'IN_HOUSE' ? 'VENDOR' : 'IN_HOUSE') : cheaper;

  const reasons: string[] = [];
  if (flags.inHouseWorstCase) reasons.push(`In-house cost per shop (₹${hPerShop}) is at or above the worst-case limit of ₹${rates.worstCasePerShop}.`);
  else if (flags.inHouseOverThreshold) reasons.push(`In-house cost per shop (₹${hPerShop}) is above the ₹${rates.thresholdPerShop} limit.`);
  if (flags.inHouseOverVendor) reasons.push(`In-house costs ${overVendorPct}% more than the vendor (limit ${rates.overVendorPercent}%).`);
  if (flags.vendorOverThreshold) reasons.push(`Vendor cost per shop (₹${vendorPerShop}) is above the ₹${rates.thresholdPerShop} limit.`);
  if (travel.longDistance) reasons.push(`Long-distance travel: km beyond ${rates.longDistanceKm} are charged at ₹${rates.longDistanceRatePerKm}/km.`);

  return {
    vendor: { perShopRate, far, shopCost: vShop, other: vOther, total: vTotal, perShop: vendorPerShop },
    inHouse: { food, stay, travel: travel.amount, longDistance: travel.longDistance, fuel, other, subtotal, total: hTotal, perShop: hPerShop, shopsCovered: covered },
    comparison: { difference, inHouseSavingPercent: vTotal > 0 ? r2((difference / vTotal) * 100) : 0, inHouseOverVendorPercent: overVendorPct, cheaper },
    flags,
    needsApproval,
    recommended,
    reasons,
  };
}
