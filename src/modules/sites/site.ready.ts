// "Verified" means the shop's details were checked in Shop verification: Operations approved it (and, for a shop with a
// measurement, BD too). Recce planning (the smart plan) works only on verified shops. A shop can be verified only when it can
// be found: it has an address, or at least its area and district.
const ADDRESS_LINES = ['address1', 'address2', 'address3'];
const empty = (field: string) => ({ $or: [{ [field]: null }, { [field]: '' }] });
const filled = (field: string) => ({ [field]: { $nin: [null, ''] } });

/** Mongo filter: the shop has an address, or both its area and district. */
export const FINDABLE: { $or: object[] } = { $or: [...ADDRESS_LINES.map(filled), { $and: [filled('location'), filled('district')] }] };
/** Mongo filter: the shop has no address line at all. */
export const NO_ADDRESS: { $and: object[] } = { $and: ADDRESS_LINES.map(empty) };

/** Mongo filter for verified shops of a project, by its requirement type. */
export const verifiedFilter = (requirementType?: string | null): Record<string, unknown> =>
  requirementType === 'SHOP_MEASUREMENT' ? { opsApproval: 'APPROVED', bdApproval: 'APPROVED' } : { opsApproval: 'APPROVED' };

export const isFindable = (s: { address1?: string | null; address2?: string | null; address3?: string | null; location?: string | null; district?: string | null }) =>
  !!(s.address1?.trim() || s.address2?.trim() || s.address3?.trim() || (s.location?.trim() && s.district?.trim()));
