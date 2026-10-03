import { DEFAULT_INGEST_URL } from '@rowing/telemetry-types';
import { loadSettings } from './settings';

export type FleetCoach = {
  id: string;
  name: string;
  sortOrder?: number;
};

export type FleetBoat = {
  id: string;
  name: string;
  boatClass: string;
  label: string;
  sortOrder?: number;
  enabled?: boolean;
};

export type FleetConfig = {
  coaches: FleetCoach[];
  boats: FleetBoat[];
  persisted?: boolean;
};

const LS_FLEET_CACHE = 'rnz_fleet_config_v1';

function fleetConfigUrl(): string {
  const s = loadSettings();
  const ingest = (s.ingestUrl || DEFAULT_INGEST_URL).trim();
  try {
    const u = new URL(ingest);
    return `${u.origin}/api/fleet-config`;
  } catch {
    return '/api/fleet-config';
  }
}

function readCache(): FleetConfig | null {
  try {
    const raw = localStorage.getItem(LS_FLEET_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FleetConfig;
    if (!Array.isArray(parsed.coaches) || !Array.isArray(parsed.boats)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(config: FleetConfig): void {
  localStorage.setItem(LS_FLEET_CACHE, JSON.stringify(config));
}

/** Default coaches/boats when offline or API unavailable. */
export function defaultFleetConfig(): FleetConfig {
  const coaches = ['Mike', 'Tom', 'James', 'Nick', 'Other'].map((name, i) => ({
    id: `coach-${i + 1}`,
    name,
    sortOrder: i,
  }));
  const boats = [
    { name: 'Karapiro', boatClass: 'M1x' },
    { name: 'Ruawai', boatClass: 'W1x' },
    { name: 'Rotorua', boatClass: 'M2x' },
    { name: 'Pupuke', boatClass: 'W2x' },
    { name: 'Waihi', boatClass: 'M2-' },
    { name: 'Hawea', boatClass: 'M4x' },
    { name: 'Okere', boatClass: 'M4-' },
    { name: 'Maungatautari', boatClass: 'M8+' },
  ].map((b, i) => ({
    id: `boat-${i + 1}`,
    name: b.name,
    boatClass: b.boatClass,
    label: `${b.name} - ${formatClassShort(b.boatClass)}`,
    sortOrder: i,
    enabled: true,
  }));
  return { coaches, boats, persisted: false };
}

function formatClassShort(boatClass: string): string {
  const m = /^([BJL]?)([MW])([1248])([X+\-])$/.exec(boatClass.trim());
  if (!m) return boatClass;
  let type = m[4];
  if (type === 'x') type = 'X';
  return `${m[3]}${type}`;
}

/** Sync snapshot of last known coaches/boats (localStorage or built-in defaults). */
export function getCachedFleetConfig(): FleetConfig {
  return readCache() ?? defaultFleetConfig();
}

export async function fetchFleetConfig(force = false): Promise<FleetConfig> {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  }
  const s = loadSettings();
  const token = s.ingestToken.trim();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(fleetConfigUrl(), { headers });
    const data = (await res.json()) as FleetConfig & { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Fleet config failed (${res.status})`);
    }
    const config: FleetConfig = {
      coaches: data.coaches ?? [],
      boats: data.boats ?? [],
      persisted: data.persisted,
    };
    writeCache(config);
    return config;
  } catch {
    const fallback = readCache() ?? defaultFleetConfig();
    return fallback;
  }
}

export function findBoat(config: FleetConfig, boatId: string): FleetBoat | undefined {
  return config.boats.find((b) => b.id === boatId);
}

export function findCoach(config: FleetConfig, coachId: string): FleetCoach | undefined {
  return config.coaches.find((c) => c.id === coachId);
}
