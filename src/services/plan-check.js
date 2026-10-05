// Drawing check for the iTREND City Life marketing issue (job 2184, VK:a, May 2022),
// cross-read against the July 2022 plan booklet. Figures below are the values printed
// on those sheets. The check recomputes every total instead of trusting the sheet.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PLANS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../City Life Unit and Floor Plans');
const SQM_TO_SQFT = 10.76391041671;

const round2 = (n) => Math.round(n * 100) / 100;

const sheets = [
  { number: '2184-001', rev: 'D', title: 'Master Layout Plan', date: '23/05/2022', dwg: '220526-2184 Rev-B Marketing DWGs/2184-001Rev-D Master Layout Plan.dwg', pdf: '220526-2184 Rev-B marketing-PDFs/2184-001Rev-D Master Layout Plan.pdf' },
  { number: '2184-019', rev: '—', title: 'Ground Floor Plan', date: '24/05/2022', dwg: '220526-2184 Rev-B Marketing DWGs/2184-019 Ground Floor Plan.dwg', pdf: '220526-2184 Rev-B marketing-PDFs/2184-019 Ground Floor Plan.pdf' },
  { number: '2184-020', rev: 'B', title: 'First Floor Plan', date: '26/05/2022', dwg: '220526-2184 Rev-B Marketing DWGs/2184-020Rev-B First Floor Plan.dwg', pdf: '220526-2184 Rev-B marketing-PDFs/2184-020Rev-B First Floor Plan.pdf' },
  { number: '2184-021', rev: 'B', title: 'Typical Floor Plan', date: '26/05/2022', dwg: '220526-2184 Rev-B Marketing DWGs/2184-021Rev-B Typical Floor Plan.dwg', pdf: '220526-2184 Rev-B marketing-PDFs/2184-021Rev-B Typical Floor Plan.pdf' },
  { number: '2184-022', rev: 'B', title: 'Refuge Floor Plan', date: '26/05/2022', dwg: '220526-2184 Rev-B Marketing DWGs/2184-022Rev-B Refuge Floor Plan.dwg', pdf: '220526-2184 Rev-B marketing-PDFs/2184-022Rev-B Refuge Floor Plan.pdf' },
  { number: '2184-023', rev: 'A', title: '3 BHK Unit Plan', date: '25/05/2022', dwg: '220526-2184 Rev-B Marketing DWGs/2184-023Rev-A 3-BHK Unit Plan.dwg', pdf: '220526-2184 Rev-B marketing-PDFs/2184-023Rev-A 3-BHK Unit Plan.pdf' },
  { number: '2184-024', rev: 'A', title: '2 BHK Convertible Unit Plan', date: '25/05/2022', dwg: '220526-2184 Rev-B Marketing DWGs/2184-024Rev-A 2-BHK Convertible Unit Plan.dwg', pdf: '220526-2184 Rev-B marketing-PDFs/2184-024Rev-A 2-BHK Convertible Unit Plan.pdf' },
  { number: '2184-025', rev: 'A', title: '2 BHK Unit Plan', date: '25/05/2022', dwg: '220526-2184 Rev-B Marketing DWGs/2184-025Rev-A 2-BHK Unit Plan.dwg', pdf: '220526-2184 Rev-B marketing-PDFs/2184-025Rev-A 2-BHK Unit Plan.pdf' },
];

const companions = [
  { title: 'Typical floor plan', jpg: 'City Life Unit Plans/Typical floor plan 160722.jpg', psd: 'City Life Unit Plans/Typical floor plan 160722 PSD.psd' },
  { title: 'Refuge floor plan', jpg: 'City Life Unit Plans/Refuge floor plan 160722.jpg', psd: 'City Life Unit Plans/Refuge floor plan 160722 PSD.psd' },
  { title: '3 BHK unit plan', jpg: 'City Life Unit Plans/3 BHK Unit Plan 160722 PSD.jpg', psd: 'City Life Unit Plans/3 BHK Unit Plan 160722 PSD.psd' },
  { title: '2 BHK unit plan', jpg: 'City Life Unit Plans/2 BHK Unit Plan 160722.jpg', psd: 'City Life Unit Plans/2 BHK Unit Plan 160722 PSD.psd' },
  { title: '2 BHK convertible unit plan', jpg: 'City Life Unit Plans/2 BHK Convertible Unit Plan 160722 PSD.jpg', psd: 'City Life Unit Plans/2 BHK Convertible Unit Plan 160722 PSD.psd' },
];

// carpet = carpet + utility. totalSqm = carpet + open balcony (+ terrace on the first floor).
// salableSqft is the sheet's saleable figure. loading is the factor the sheet is using.
const residential = [
  { type: '3 BHK', sheets: ['2184-023', '2184-021', '2184-020', '2184-022'], carpet: 71.35, balcony: 10.23, terrace: 0, totalSqm: 81.58, carpetSqft: 878, salableSqft: 1229, loading: 1.4 },
  { type: '2 BHK Convertible', sheets: ['2184-024', '2184-021', '2184-020', '2184-022'], carpet: 71.35, balcony: 10.23, terrace: 0, totalSqm: 81.58, carpetSqft: 878, salableSqft: 1229, loading: 1.4 },
  { type: '2 BHK', sheets: ['2184-025', '2184-021', '2184-022'], carpet: 58.24, balcony: 7.6, terrace: 0, totalSqm: 65.84, carpetSqft: 709, salableSqft: 992, loading: 1.4 },
  { type: '2 BHK-A', sheets: ['2184-020'], carpet: 58.71, balcony: 7.6, terrace: 3.26, totalSqm: 69.57, carpetSqft: 749, salableSqft: 1048, loading: 1.4 },
  { type: '2 BHK-R', sheets: ['2184-022'], carpet: 58.71, balcony: 10.86, terrace: 0, totalSqm: 69.57, carpetSqft: 749, salableSqft: 1048, loading: 1.4 },
  { type: '1 BHK-R', sheets: ['2184-022'], carpet: 43.56, balcony: 7.6, terrace: 0, totalSqm: 51.16, carpetSqft: 551, salableSqft: 771, loading: 1.4 },
];

const shops = [
  { type: 'Shop-01', count: 1, carpet: 44.78, mezz: 18.18, totalSqm: 62.96, salableSqft: 1017 },
  { type: 'Shop-02', count: 1, carpet: 53.81, mezz: 22.9, totalSqm: 76.71, salableSqft: 1239 },
  { type: 'Shop-03', count: 1, carpet: 26.21, mezz: 12.47, totalSqm: 38.68, salableSqft: 625 },
  { type: 'Shop-04 & 05', count: 2, carpet: 23.86, mezz: 11.36, totalSqm: 35.22, salableSqft: 569, groupSalableSqft: 1137 },
  { type: 'Shop-06 & 08', count: 2, carpet: 24.78, mezz: 11.81, totalSqm: 36.59, salableSqft: 591, groupSalableSqft: 1182 },
  { type: 'Shop-07', count: 1, carpet: 19.9, mezz: 9.49, totalSqm: 29.39, salableSqft: 475 },
  { type: 'Shop-09, 11, 12', count: 3, carpet: 23.02, mezz: 11.12, totalSqm: 34.14, salableSqft: 551, groupSalableSqft: 1654 },
  { type: 'Shop-10', count: 1, carpet: 18.49, mezz: 8.94, totalSqm: 27.43, salableSqft: 443 },
  { type: 'Shop-13, 15, 16', count: 3, carpet: 25.46, mezz: 12.35, totalSqm: 37.81, salableSqft: 610, groupSalableSqft: 1831 },
  { type: 'Shop-14', count: 1, carpet: 20.45, mezz: 9.92, totalSqm: 30.37, salableSqft: 490 },
];

const rooms = {
  '3 BHK': [
    ['Toilet', 1.35, 2.2], ['Bedroom', 3.05, 4.375], ['Living / Dining', 3.35, 5.18],
    ['Balcony', 5.05, 1.3], ['Bedroom', 2.75, 3.05], ['Bedroom', 3.05, 4.075],
    ['Balcony', 0.9, 4.075], ['Toilet', 2, 1.3], ['Kitchen', 3.825, 3.43],
  ],
  '2 BHK Convertible': [
    ['Toilet', 1.35, 2.2], ['Bedroom', 3.05, 4.375], ['Living', 3.35, 5.18],
    ['Balcony', 5.05, 1.3], ['Dining', 2.75, 3.05], ['Bedroom', 3.05, 4.075],
    ['Balcony', 0.9, 4.075], ['Toilet', 2, 1.3], ['Kitchen', 3.825, 3.43],
  ],
  '2 BHK': [
    ['Toilet', 1.425, 1.525], ['Balcony', 3.05, 1.525], ['Bedroom', 3.05, 3.5],
    ['Living', 3.05, 4.15], ['Toilet', 1.35, 2.2], ['Kitchen', 2.45, 3.425],
    ['Dining', 2.575, 2.25], ['Balcony', 1.575, 1.875], ['Bedroom', 3.05, 3.8],
  ],
};

const TYPICAL_FLOORS = [2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 18, 20];
const REFUGE_FLOORS = [4, 9, 14, 19];
const LARGE_POSITIONS = [1, 5, 6, 10];
const TWO_BHK_POSITIONS = [2, 3, 4, 7, 8, 9];

// Position 10 is written 2010 / 10010 / 1010, not 210 / 1010-as-floor-10. Positions 01–09
// are the floor number followed by two digits.
const flatNo = (floor, position) => (
  position === 10 ? Number(`${floor}010`) : Number(`${floor}${String(position).padStart(2, '0')}`)
);

function parseFlat(n) {
  const s = String(n);
  if (s.endsWith('010')) return { floor: Number(s.slice(0, -3)), position: 10 };
  return { floor: Number(s.slice(0, -2)), position: Number(s.slice(-2)) };
}

function exists(rel) {
  return fs.existsSync(path.join(PLANS_DIR, rel));
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

export function runPlanCheck() {
  const checks = [];
  const add = (status, title, detail, source) => checks.push({ id: checks.length + 1, status, title, detail, source });

  const missingSheets = sheets.filter((s) => !exists(s.dwg) || !exists(s.pdf));
  if (missingSheets.length === 0) {
    add('pass', 'Architectural issue is paired', 'Each of the 8 marketing sheets has both a DWG and a PDF.', '2184-001, 019–025');
  } else {
    add('fail', 'Architectural issue is paired', `Missing file for ${missingSheets.map((s) => s.number).join(', ')}.`, 'City Life Unit and Floor Plans');
  }

  const missingArt = companions.filter((c) => !exists(c.jpg) || !exists(c.psd));
  if (missingArt.length === 0) {
    add('pass', 'July marketing art matches the unit set', 'JPG and PSD exist for the typical floor, refuge floor, 3 BHK, 2 BHK and 2 BHK convertible.', 'City Life Unit Plans, 16/07/2022');
  } else {
    add('fail', 'July marketing art matches the unit set', `Missing ${missingArt.map((c) => c.title).join(', ')}.`, 'City Life Unit Plans');
  }

  if (exists('ITrend Hinjawadi Plan Booklet.pdf')) {
    add('pass', 'Plan booklet is in the set', 'ITrend Hinjawadi Plan Booklet.pdf is present (8 pages: cover, master, typical, refuge, 2 BHK, convertible, 3 BHK, back cover).', 'Booklet');
  } else {
    add('fail', 'Plan booklet is in the set', 'ITrend Hinjawadi Plan Booklet.pdf was not found.', 'Booklet');
  }

  for (const row of residential) {
    const summed = round2(row.carpet + row.balcony + row.terrace);
    const parts = [`carpet ${row.carpet}`, `open balcony ${row.balcony}`, row.terrace ? `terrace ${row.terrace}` : null].filter(Boolean).join(' + ');
    if (summed === row.totalSqm) {
      add('pass', `${row.type} area adds up`, `${parts} = ${row.totalSqm} m².`, row.sheets[0]);
    } else {
      add('fail', `${row.type} area adds up`, `${parts} = ${summed} m², sheet says ${row.totalSqm} m².`, row.sheets[0]);
    }

    const sqft = Math.round(row.totalSqm * SQM_TO_SQFT);
    if (sqft === row.carpetSqft) {
      add('pass', `${row.type} square-foot conversion`, `${row.totalSqm} m² × 10.7639 rounds to ${row.carpetSqft} sq.ft.`, row.sheets[0]);
    } else {
      add('fail', `${row.type} square-foot conversion`, `${row.totalSqm} m² converts to ${sqft} sq.ft, sheet says ${row.carpetSqft}.`, row.sheets[0]);
    }

    const salable = Math.round(row.totalSqm * SQM_TO_SQFT * row.loading);
    if (salable === row.salableSqft) {
      add('pass', `${row.type} saleable area`, `${row.carpetSqft} sq.ft at a ${row.loading} loading rounds to ${row.salableSqft} sq.ft.`, row.sheets[0]);
    } else if (near(salable, row.salableSqft, 1)) {
      add('warning', `${row.type} saleable area`, `Computed ${salable} sq.ft, sheet says ${row.salableSqft}. Difference is 1 sq.ft of rounding.`, row.sheets[0]);
    } else {
      add('fail', `${row.type} saleable area`, `Computed ${salable} sq.ft, sheet says ${row.salableSqft}.`, row.sheets[0]);
    }
  }

  const three = residential.find((r) => r.type === '3 BHK');
  const conv = residential.find((r) => r.type === '2 BHK Convertible');
  if (three.carpet === conv.carpet && three.balcony === conv.balcony && three.totalSqm === conv.totalSqm && three.salableSqft === conv.salableSqft) {
    add('pass', 'Convertible uses the 3 BHK shell', '2184-023 and 2184-024 print the same 71.35 + 10.23 = 81.58 m² and 1,229 sq.ft saleable. The convertible dining room is the 3 BHK third bedroom, both 2.75 × 3.05 m.', '2184-023, 2184-024');
  } else {
    add('fail', 'Convertible uses the 3 BHK shell', '3 BHK and 2 BHK convertible area statements do not match.', '2184-023, 2184-024');
  }

  const two = residential.find((r) => r.type === '2 BHK');
  const twoA = residential.find((r) => r.type === '2 BHK-A');
  if (two.carpet !== twoA.carpet) {
    add('pass', 'First-floor 2 BHK-A is a terrace variant', `Typical 2 BHK carpet is ${two.carpet} m². First-floor 2 BHK-A is ${twoA.carpet} m² plus a ${twoA.terrace} m² terrace, totalling ${twoA.totalSqm} m². It is not the same flat as 2184-025.`, '2184-020');
  }

  for (const [type, list] of Object.entries(rooms)) {
    const balconies = list.filter((r) => r[0] === 'Balcony');
    const product = round2(balconies.reduce((t, [, w, d]) => t + w * d, 0));
    const stated = residential.find((r) => r.type === type).balcony;
    if (near(product, stated, 0.02)) {
      add('pass', `${type} balcony dimensions`, balconies.map(([, w, d]) => `${w} × ${d}`).join(' + ') + ` = ${product} m², against ${stated} m² open balcony.`, type === '2 BHK' ? '2184-025' : type === '3 BHK' ? '2184-023' : '2184-024');
    } else {
      add('fail', `${type} balcony dimensions`, `Room sizes multiply to ${product} m², sheet open balcony is ${stated} m².`, type);
    }
  }

  let shopFail = 0;
  for (const shop of shops) {
    const summed = round2(shop.carpet + shop.mezz);
    const salable = Math.round(shop.totalSqm * SQM_TO_SQFT * 1.5);
    const group = shop.count * salable;
    const totalOk = summed === shop.totalSqm;
    const saleOk = salable === shop.salableSqft;
    const groupOk = shop.groupSalableSqft == null || near(group, shop.groupSalableSqft, 1);
    if (!totalOk || !saleOk || !groupOk) shopFail += 1;
    if (shop.groupSalableSqft != null && group !== shop.groupSalableSqft && near(group, shop.groupSalableSqft, 1)) {
      add('warning', `${shop.type} grouped saleable`, `${shop.count} × ${salable} = ${group} sq.ft. The ground-floor sheet prints ${shop.groupSalableSqft}.`, '2184-019');
    }
  }
  if (shopFail === 0) {
    add('pass', 'Ground-floor shop areas add up', 'For all 16 shops, carpet + mezzanine equals the printed total, and saleable sq.ft is that total at a 1.5 loading.', '2184-019');
  } else {
    add('fail', 'Ground-floor shop areas add up', `${shopFail} shop row(s) do not reconcile carpet, mezzanine, total and saleable area.`, '2184-019');
  }

  const typicalFlats = [
    ...LARGE_POSITIONS.flatMap((p) => TYPICAL_FLOORS.map((f) => flatNo(f, p))),
    ...TWO_BHK_POSITIONS.flatMap((p) => TYPICAL_FLOORS.map((f) => flatNo(f, p))),
  ];
  const refugeFlats = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((p) => REFUGE_FLOORS.map((f) => flatNo(f, p)));
  const overlap = typicalFlats.filter((n) => refugeFlats.includes(n));
  const typicalFloorsUsed = [...new Set(typicalFlats.map((n) => parseFlat(n).floor))].sort((a, b) => a - b);
  const refugeFloorsUsed = [...new Set(refugeFlats.map((n) => parseFlat(n).floor))].sort((a, b) => a - b);
  if (overlap.length === 0 && typicalFloorsUsed.join() === TYPICAL_FLOORS.join() && refugeFloorsUsed.join() === REFUGE_FLOORS.join()) {
    add('pass', 'Flat numbers follow the floor types', `Typical plate is 10 flats (4 of 3 BHK / 2 BHK convertible at positions 01, 05, 06, 10 and 6 of 2 BHK). Those numbers run on floors ${TYPICAL_FLOORS.join(', ')}. Floors ${REFUGE_FLOORS.join(', ')} are the refuge issue and are absent from the typical schedule. Floor 1 is the terrace-flat issue (101–1010).`, '2184-020, 2184-021, 2184-022');
  } else {
    add('fail', 'Flat numbers follow the floor types', `Overlap or floor mismatch. Overlap ${overlap.length}.`, '2184-021, 2184-022');
  }

  add('warning', 'Floor 21 is in the stack and not in the flat schedule', 'Rev D calls the building LGF+G+3P+21 Floors. Flat numbers stop at floor 20. There is no floor-21 plan in this issue.', '2184-001 Rev D');
  add('warning', 'Booklet stack does not match Rev D', '2184-001 Rev D prints LGF+G+3P+21 Floors. The booklet prints LGF+G+M+3P+21 Floors. Shop mezzanines are drawn on the ground floor; they are not a separate master-plan floor on Rev D.', '2184-001 Rev D vs booklet p.2');
  add('warning', 'Amenity and open space differ between Rev D and the booklet', 'Rev D: amenity 488.33 m² and one open space of 587.18 m². Booklet: amenity 486.60 m² and two open spaces of 230.00 m² each (460.00 m²).', '2184-001 Rev D vs booklet p.2');
  add('pass', 'This package does not include podium or lower-ground plans', 'The stack includes a lower ground floor and 3 podium levels. Those sheets are not part of this marketing issue (001 and 019–025 only).', '2184-001 Rev D');

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    warning: checks.filter((c) => c.status === 'warning').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };

  return {
    project: {
      name: 'iTREND City Life',
      location: 'S.No. 236, Hinjawadi, Pune',
      architect: 'VK:a architecture',
      drawnBy: 'Kiran',
      jobNo: '2184',
      clientOnUnitPlans: 'Neev Sai Creations for Mr. Sachin Agarwal',
      marketing: 'Saheel Properties and Kohinoor',
      stackOnDrawing: 'LGF + Ground + 3 podium + 21 floors',
      stackOnBooklet: 'LGF + Ground + Mezzanine + 3 podium + 21 floors',
      corridorM: 1.5,
      lifts: '10 passenger and 13 passenger',
      refugeAreaSqm: 45,
    },
    summary,
    checks,
    sheets: sheets.map((s) => ({
      ...s,
      dwgPresent: exists(s.dwg),
      pdfPresent: exists(s.pdf),
    })),
    companions: companions.map((c) => ({ ...c, jpgPresent: exists(c.jpg), psdPresent: exists(c.psd) })),
    bookletPresent: exists('ITrend Hinjawadi Plan Booklet.pdf'),
    residential: residential.map((row) => ({
      ...row,
      computedTotalSqm: round2(row.carpet + row.balcony + row.terrace),
      computedCarpetSqft: Math.round(row.totalSqm * SQM_TO_SQFT),
      computedSalableSqft: Math.round(row.totalSqm * SQM_TO_SQFT * row.loading),
    })),
    shops: shops.map((shop) => ({
      ...shop,
      computedTotalSqm: round2(shop.carpet + shop.mezz),
      computedSalableSqft: Math.round(shop.totalSqm * SQM_TO_SQFT * 1.5),
    })),
    shopCount: shops.reduce((t, s) => t + s.count, 0),
    floors: {
      typical: { floors: TYPICAL_FLOORS, flatsPerFloor: 10, large: LARGE_POSITIONS, twoBhk: TWO_BHK_POSITIONS },
      refuge: { floors: REFUGE_FLOORS, flatsPerFloor: 10, refugeAreaSqm: 45 },
      first: { floors: [1], largeFlats: [101, 105, 106, 1010], twoBhkA: [102, 103, 104, 107, 108, 109] },
    },
    rooms: Object.entries(rooms).map(([type, list]) => ({
      type,
      rooms: list.map(([name, widthM, depthM]) => ({ name, widthM, depthM })),
    })),
  };
}
