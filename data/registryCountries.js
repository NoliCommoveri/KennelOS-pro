// registryCountries.js — which country a registry code belongs to (Dog Titles
// Field Plan D7, D8; docs/KennelOS_Registry_Title_Facts.md §1).
// Pure and import-free, like pedigreeParse.js: the chart reader and dogTitles.js
// both import it, and it's tested directly (tests/registryCountries.test.js).
//
// The map is the FCI's list of studbook and appendix initials (footer 28-09-26),
// older codes still seen on pedigrees, and the main non-FCI registries. Codes are
// written as printed; matching drops dots and a trailing hyphen and ignores case
// (normCode), and always takes the whole code, so KC never matches KCC or KCU.
//
// Off the map on purpose (an unmapped code leaves the country blank):
// - CKC: both the Canadian and the Continental Kennel Club
// - KCSB: a third-party abbreviation, not the Kennel Club's own
// - Bahrain/Bolivia (K.C.B., KCB N, KCB A, KCB, LPB), Costa Rica (ACC, CR), Cuba
//   (FCC, LGC) and FCG / F.C.G. (Georgia and Guatemala): rows the fact check
//   couldn't place for certain
// - single letters other than S (Sweden's old studbook code)

export const REGISTRY_COUNTRIES = Object.freeze({
  'South Africa': ['ZA'],
  Albania: ['PSH', 'PKSH'],
  Germany: ['VDH'],
  Argentina: ['FCA', 'FCAI'],
  Armenia: ['ADLA', 'AM'],
  Australia: ['ANKC'],
  Austria: ['ÖHZB', 'ÖHZB Reg.'],
  Azerbaijan: ['AKU'],
  Belgium: ['LOSH', 'ALSH', 'RISH', 'ALSH/RISH'],
  Belarus: ['BCU', 'BCU/Rg'],
  'Bosnia-Herzegovina': ['BHR'],
  Brazil: ['CBKC'],
  Bulgaria: ['PK', 'HPA', 'HPB'],
  Chile: ['KCC'],
  China: ['CKU'],
  Cyprus: ['CYKC'],
  Colombia: ['LOC'],
  Croatia: ['HR', 'HUR'],
  Denmark: ['DKK', 'DK', 'DKX-REG'],
  Egypt: ['EKF', 'EKF.R'],
  'El Salvador': ['ES-E', 'ES-F', 'ES-P'],
  'United Arab Emirates': ['AESKC', 'AESKC.REG'],
  Ecuador: ['LER', 'LES'],
  Spain: ['LOE', 'RRC'],
  Estonia: ['EST'],
  'United States': ['AKC', 'UKC'],
  Finland: ['SF', 'FIN', 'FI', 'EJ', 'ER'],
  France: ['LOF'],
  Georgia: ['GEO'],
  Ghana: ['KUG', 'KUG-AP'],
  Gibraltar: ['GKC'],
  Greece: ['BEA', 'BEK', 'GR-F', 'GR-N', 'BEA 1', 'BEA 2', 'BEA 3'],
  Honduras: ['ACH'],
  Hungary: ['MET'],
  India: ['KCI'],
  Indonesia: ['INA'],
  Iran: ['IR', 'IRAPP'],
  Ireland: ['IKC'],
  Iceland: ['IS', 'ISO'],
  Israel: ['ISBR', 'ISAP'],
  Italy: ['LOI', 'ROI', 'LIR', 'RSR'],
  Japan: ['JKC', 'JAX'],
  Jordan: ['JoKC', 'JoKC.AP'],
  Kazakhstan: ['UCK', 'UCK R'],
  Kyrgyzstan: ['UCKR', 'UCKR R'],
  Kosovo: ['RKS', 'KOS'],
  Kuwait: ['KKC-F', 'KKC-A'],
  Latvia: ['LV', 'LV-Reg'],
  Lebanon: ['KCL', 'AKCLSB'],
  Lithuania: ['LSVK', 'RLŠVK'],
  Luxembourg: ['LOL'],
  'North Macedonia': ['MR'],
  Madagascar: ['LOMAD', 'LA/LOMAD'],
  Malaysia: ['MKA'],
  Malta: ['MKC'],
  Morocco: ['LMO', 'RIM'],
  Mexico: ['FCM', 'GA', 'MA'],
  Moldova: ['UCHM'],
  Monaco: ['LOM'],
  Mongolia: ['MKF'],
  Montenegro: ['MNE'],
  Myanmar: ['MYKC', 'PBC'],
  Nicaragua: ['NIC-F', 'NIC-E', 'NIC-P'],
  Nigeria: ['NG', 'NG-BS', 'NG-A', 'NB-B'],
  Norway: ['NO', 'ANO'],
  'New Zealand': ['NZKC'],
  Pakistan: ['KP'],
  Panama: ['LCP', 'RIP'],
  Paraguay: ['PKC', 'RG', 'RIPY'],
  Netherlands: ['NHSB', 'NHSB.BIJL.'],
  Peru: ['KCP'],
  Philippines: ['PCC'],
  Poland: ['PKR.', 'PKR.NP', 'PKR', 'PKR.KW', 'KW'],
  'Puerto Rico': ['FCPR'],
  Portugal: ['LOP', 'RI'],
  'South Korea': ['ROK'],
  'Dominican Republic': ['FCD'],
  'Czech Republic': ['CMKU', 'ČLP', 'N Reg', 'Z Reg', 'P Reg', 'R CMKU', 'R ČLP'],
  Romania: ['COR'],
  'United Kingdom': ['KC'],
  Russia: ['RKF', 'RKF R.'],
  'San Marino': ['LOSM', 'RISM'],
  // KSS (the Serbian kennel union) prints before the JR studbook code on Serbian
  // charts ("KSS JR 71592 BST"), so it maps too.
  Serbia: ['JR', 'JUR', 'KSS'],
  Singapore: ['SKC'],
  Slovakia: ['SPKP', 'SHPK', 'SUCHNO', 'SPKP Reg.', 'SPKP RG'],
  Slovenia: ['SLR', 'SPR'],
  'Sri Lanka': ['KASL', 'BV'],
  Sweden: ['SE', 'S', 'REGV', 'SX', 'AS'],
  Switzerland: ['LOS', 'SHSB', 'LOS A0', 'SHSB A0'],
  Taiwan: ['K.C.T.'],
  Thailand: ['KCTH'],
  Tunisia: ['LOT', 'LOTA'],
  Turkey: ['KIF-', 'KIF-GSB-'],
  Ukraine: ['UKU.', 'UKU.R.'],
  Uruguay: ['KCU'],
  Uzbekistan: ['KFU'],
  Venezuela: ['FCV'],
  Vietnam: ['SPH', 'SPSPH']
});

// A code as matched: uppercased, dots dropped, a trailing hyphen dropped, spaces
// evened out. "K.C.T." → "KCT", "RKF R." → "RKF R", "KIF-" → "KIF".
export const normCode = (code) => String(code ?? '').toUpperCase().replace(/\./g, '')
  .replace(/\s+/g, ' ').trim().replace(/-$/, '');

const BY_CODE = new Map();
for (const [country, codes] of Object.entries(REGISTRY_COUNTRIES)) {
  for (const c of codes) BY_CODE.set(normCode(c), country);
}

// The country a registry code belongs to, or '' when it's not on the map.
export function countryOfRegistry(code) {
  const k = normCode(code);
  return (k && BY_CODE.get(k)) || '';
}

// ISO 3166 alpha-3 codes → country name, for the bracketed country an AKC
// Certified Pedigree prints on a dog born abroad ("(SRB)"). Names match the map's.
export const ISO3_COUNTRIES = Object.freeze({
  ZAF: 'South Africa', ALB: 'Albania', DEU: 'Germany', ARG: 'Argentina', ARM: 'Armenia',
  AUS: 'Australia', AUT: 'Austria', AZE: 'Azerbaijan', BHR: 'Bahrain', BEL: 'Belgium',
  BLR: 'Belarus', BOL: 'Bolivia', BIH: 'Bosnia-Herzegovina', BRA: 'Brazil', BGR: 'Bulgaria',
  CAN: 'Canada', CHL: 'Chile', CHN: 'China', CYP: 'Cyprus', COL: 'Colombia',
  CRI: 'Costa Rica', HRV: 'Croatia', CUB: 'Cuba', DNK: 'Denmark', EGY: 'Egypt',
  SLV: 'El Salvador', ARE: 'United Arab Emirates', ECU: 'Ecuador', ESP: 'Spain', EST: 'Estonia',
  USA: 'United States', FIN: 'Finland', FRA: 'France', GEO: 'Georgia', GHA: 'Ghana',
  GIB: 'Gibraltar', GRC: 'Greece', GTM: 'Guatemala', HND: 'Honduras', HUN: 'Hungary',
  IND: 'India', IDN: 'Indonesia', IRN: 'Iran', IRL: 'Ireland', ISL: 'Iceland',
  ISR: 'Israel', ITA: 'Italy', JPN: 'Japan', JOR: 'Jordan', KAZ: 'Kazakhstan',
  KGZ: 'Kyrgyzstan', XKX: 'Kosovo', KWT: 'Kuwait', LVA: 'Latvia', LBN: 'Lebanon',
  LTU: 'Lithuania', LUX: 'Luxembourg', MKD: 'North Macedonia', MDG: 'Madagascar', MYS: 'Malaysia',
  MLT: 'Malta', MAR: 'Morocco', MEX: 'Mexico', MDA: 'Moldova', MCO: 'Monaco',
  MNG: 'Mongolia', MNE: 'Montenegro', MMR: 'Myanmar', NIC: 'Nicaragua', NGA: 'Nigeria',
  NOR: 'Norway', NZL: 'New Zealand', PAK: 'Pakistan', PAN: 'Panama', PRY: 'Paraguay',
  NLD: 'Netherlands', PER: 'Peru', PHL: 'Philippines', POL: 'Poland', PRI: 'Puerto Rico',
  PRT: 'Portugal', KOR: 'South Korea', DOM: 'Dominican Republic', CZE: 'Czech Republic', ROU: 'Romania',
  GBR: 'United Kingdom', RUS: 'Russia', SMR: 'San Marino', SRB: 'Serbia', SGP: 'Singapore',
  SVK: 'Slovakia', SVN: 'Slovenia', LKA: 'Sri Lanka', SWE: 'Sweden', CHE: 'Switzerland',
  TWN: 'Taiwan', THA: 'Thailand', TUN: 'Tunisia', TUR: 'Turkey', UKR: 'Ukraine',
  URY: 'Uruguay', UZB: 'Uzbekistan', VEN: 'Venezuela', VNM: 'Vietnam'
});

// A country as printed → its name: an ISO alpha-3 code becomes the country
// ("SRB" → "Serbia"), anything else stays as printed ("Canada").
export function countryName(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return ISO3_COUNTRIES[t.toUpperCase()] || t;
}

export const DEFAULT_HOME_COUNTRY = 'United States';
const OWN = new Set(['owned', 'co_owned']);

// Her home country (D7): the country of the registry most of her own dogs
// (owned or co-owned, not pedigree-only, not archived) use, else the United
// States. A tie goes to the United States when it's among them, else A–Z.
export function homeCountry(dogs) {
  const counts = new Map();
  for (const d of dogs || []) {
    if (!d || d.pedigree_only || d.is_archived || !OWN.has(d.ownership_type)) continue;
    const c = countryOfRegistry(d.registry);
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
  }
  if (!counts.size) return DEFAULT_HOME_COUNTRY;
  const top = Math.max(...counts.values());
  const best = [...counts].filter(([, n]) => n === top).map(([c]) => c);
  return best.includes(DEFAULT_HOME_COUNTRY) ? DEFAULT_HOME_COUNTRY : best.sort()[0];
}
