export const MIN_SPEED_MPS: number;

export function parseBoatClass(...parts: (string | null | undefined)[]): string | null;
export function reference2kSec(boatClass: string | null | undefined): number | null;
export function formatSplit500m(speedMps: number | null | undefined): string;
export function splitSecFromMps(speedMps: number | null | undefined): number | undefined;
export function prognosticPercent(speedMps: number, boatClass: string | null): number | null;
export function formatPrognostic(speedMps: number, boatClass: string | null): string | null;
export function formatPaceWithPrognostic(
  speedMps: number | null | undefined,
  ...rest: (string | null | undefined | { suffix?: boolean })[]
): string;
