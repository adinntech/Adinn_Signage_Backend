/**
 * Test data for the smart recce planner (shops Excel -> extract -> suggest in-house / vendor per district).
 *   Excel only:           npx tsx scripts/make-demo-planner.ts
 *   Excel + demo vendors: npx tsx scripts/make-demo-planner.ts --apply
 * Writes two sheets to docs/test-data/ (shops with sizes, and shops only) in the client sheet shape the import already understands:
 * S.No, Customer Name, District, Size (e.g. 10*4), Remarks, Address 1/2/3, Dis, Pin, PH, GST.
 * With --apply it also creates five ACTIVE demo vendors (codes VND-PLN1..5) with district, service areas, skills and rates.
 * Safe to run again. Remove the vendors from Vendor master in the web app when you are done.
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { connectDb, disconnectDb } from '../src/config/db';
import { Vendor } from '../src/modules/vendors/vendor.model';

const AREAS: { district: string; towns: [string, string][]; count: number }[] = [
  { district: 'Madurai', count: 10, towns: [['Anna Nagar', '625020'], ['Thirunagar', '625006'], ['Villapuram', '625012'], ['KK Nagar', '625020']] },
  { district: 'Coimbatore', count: 10, towns: [['RS Puram', '641002'], ['Gandhipuram', '641012'], ['Peelamedu', '641004'], ['Singanallur', '641005']] },
  { district: 'Tiruchirappalli', count: 8, towns: [['Thillai Nagar', '620018'], ['Srirangam', '620006'], ['Woraiyur', '620003']] },
  { district: 'Tirunelveli', count: 8, towns: [['Palayamkottai', '627002'], ['Melapalayam', '627005'], ['Vannarpettai', '627003']] },
];
const NAMES = ['Sri Murugan Hardware', 'Lakshmi Paints', 'Anbu Traders', 'Velan Electricals', 'Kumar Steels', 'Ganesh Agencies', 'Selvam Tiles', 'Raja Sanitary', 'Meenakshi Stores', 'Bala Cements'];
const SIZES = ['10*4', '8*3', '12*4', '6*3', '10*5', '8*4'];

function rows() {
  const out: (string | number)[][] = [];
  let n = 0;
  for (const a of AREAS) {
    for (let i = 0; i < a.count; i++) {
      n++;
      const [town, pin] = a.towns[i % a.towns.length]!;
      const name = NAMES[(n + i) % NAMES.length]!;
      out.push([n, `${name} (${town.toUpperCase()})`, a.district, SIZES[n % SIZES.length]!, n % 7 === 0 ? 'Existing board is damaged' : '', `${n + 10}, Main Road`, town, a.district, a.district.slice(0, 3).toUpperCase(), pin, `+91 9${String(400000000 + n * 1234567).slice(0, 9)}`, '']);
    }
  }
  return out;
}

async function write(file: string, withSize: boolean) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shops');
  const head = ['S.No', 'Customer Name', 'District', 'Size', 'Remarks', 'Address 1', 'Address 2', 'Address 3', 'Dis', 'Pin', 'PH', 'GST'];
  const keep = head.map((_, i) => withSize || i !== 3);
  ws.addRow(head.filter((_, i) => keep[i]));
  for (const r of rows()) ws.addRow(r.filter((_, i) => keep[i]));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => (c.width = 18));
  await wb.xlsx.writeFile(file);
}

const VENDORS = [
  { code: 'VND-PLN1', name: 'Madurai Signage Crew', mobile: '9000000101', district: 'Madurai', areas: ['Dindigul', 'Theni'], skills: ['Measurement', 'Board fitting'], rate: 420, far: 470 },
  { code: 'VND-PLN2', name: 'Kovai Recce Works', mobile: '9000000102', district: 'Coimbatore', areas: ['Tiruppur', 'Erode'], skills: ['Measurement'], rate: 300, far: 350 },
  { code: 'VND-PLN3', name: 'Kovai Budget Crew', mobile: '9000000103', district: 'Tiruppur', areas: ['Coimbatore'], skills: ['Photos'], rate: 220, far: 250 },
  { code: 'VND-PLN4', name: 'Trichy Boards & Co', mobile: '9000000104', district: 'Tiruchirappalli', areas: ['Thanjavur'], skills: ['Measurement', 'Photos'], rate: 330, far: 380 },
  { code: 'VND-PLN5', name: 'Nellai Field Team', mobile: '9000000105', district: 'Tirunelveli', areas: ['Thoothukudi', 'Tenkasi'], skills: ['Measurement'], rate: 260, far: 310 },
];

async function main() {
  const dir = path.resolve(__dirname, '../../../docs/test-data');
  fs.mkdirSync(dir, { recursive: true });
  await write(path.join(dir, 'planner-demo-shops-with-size.xlsx'), true);
  await write(path.join(dir, 'planner-demo-shops-only.xlsx'), false);
  console.log(`Excel files written to ${dir}`);
  if (!process.argv.includes('--apply')) return console.log('Vendors not created (add --apply to create the 5 demo vendors).');
  await connectDb();
  for (const v of VENDORS) {
    await Vendor.updateOne(
      { code: v.code },
      { $set: { name: v.name, nameKey: v.name.toLowerCase(), type: 'ORGANIZATION', mobile: v.mobile, district: v.district, serviceAreas: v.areas, skills: v.skills, ratePerShop: v.rate, farRatePerShop: v.far, status: 'ACTIVE' } },
      { upsert: true },
    );
  }
  console.log(`Demo vendors ready: ${VENDORS.map((v) => v.code).join(', ')}`);
  await disconnectDb();
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
