function formatBoatClassShort(boatClass) {
  const code = String(boatClass || '').trim();
  // Accept M1x / M1X (case-insensitive sculling marker).
  const m = /^([BJL]?)([MW])([1248])([Xx+\-])$/.exec(code);
  if (!m) return code;
  let type = m[4];
  if (type === 'x' || type === 'X') type = 'X';
  return `${m[3]}${type}`;
}

function formatBoatLabel(name, boatClass) {
  const trimmed = String(name ?? '').trim();
  const short = formatBoatClassShort(boatClass);
  if (!trimmed) return short || '';
  if (!short) return trimmed;
  return `${trimmed} - ${short}`;
}

/** Default RNZ coaches — editable in Manager → Setup → Coaches & Boats. */
const DEFAULT_COACHES = ['Mike', 'Tom', 'James', 'Nick', 'Other'];

/** Starter boats: NZ place names, one of each common class. */
const DEFAULT_BOATS = [
  { name: 'Karapiro', boatClass: 'M1x' },
  { name: 'Ruawai', boatClass: 'W1x' },
  { name: 'Rotorua', boatClass: 'M2x' },
  { name: 'Pupuke', boatClass: 'W2x' },
  { name: 'Waihi', boatClass: 'M2-' },
  { name: 'Hawea', boatClass: 'M4x' },
  { name: 'Okere', boatClass: 'M4-' },
  { name: 'Maungatautari', boatClass: 'M8+' },
];

function normalizeCoach(row) {
  return {
    id: String(row.id),
    name: String(row.name),
    sortOrder: Number(row.sort_order ?? row.sortOrder ?? 0),
  };
}

function normalizeBoat(row) {
  const name = String(row.name);
  const boatClass = String(row.boat_class ?? row.boatClass);
  return {
    id: String(row.id),
    name,
    boatClass,
    label: formatBoatLabel(name, boatClass),
    sortOrder: Number(row.sort_order ?? row.sortOrder ?? 0),
    enabled: row.enabled !== false,
  };
}

function memoryDefaults() {
  const coaches = DEFAULT_COACHES.map((name, i) => ({
    id: `coach-${i + 1}`,
    name,
    sortOrder: i,
  }));
  const boats = DEFAULT_BOATS.map((b, i) => ({
    id: `boat-${i + 1}`,
    name: b.name,
    boatClass: b.boatClass,
    label: formatBoatLabel(b.name, b.boatClass),
    sortOrder: i,
    enabled: true,
  }));
  return { coaches, boats };
}

module.exports = {
  DEFAULT_COACHES,
  DEFAULT_BOATS,
  normalizeCoach,
  normalizeBoat,
  memoryDefaults,
};
