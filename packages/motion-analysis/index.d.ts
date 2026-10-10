export declare class MotionAnalyzer {
  constructor(opts?: Record<string, unknown>);
  reset(): void;
  process(t: number, ax: number, ay: number, az: number): void;
  getMetrics(): {
    strokeRate: number | null;
    capsize: boolean;
    tiltDeg: number | null;
    calibrated: boolean;
  };
  getStrokeDebug(): {
    strokeRate: number | null;
    calibrated: boolean;
    axis: string | null;
    markerMode: string | null;
    markers: { t: number; v: number }[];
    surge: { t: number; v: number }[];
    samples: { t: number; ax: number; ay: number; az: number }[];
  };
}

export function analyzeMotionWindow(
  samples: { t: number; motion?: { ax: number; ay: number; az: number } }[],
): {
  strokeRate: number | null;
  capsize: boolean;
  tiltDeg: number | null;
  calibrated: boolean;
};

export function analyzeMotionDebug(
  samples: {
    t: number;
    ax?: number;
    ay?: number;
    az?: number;
    motion?: { ax: number; ay: number; az: number };
  }[],
  opts?: { bufferMs?: number },
): {
  strokeRate: number | null;
  calibrated: boolean;
  axis: string | null;
  markerMode: string | null;
  markers: { t: number; v: number }[];
  surge: { t: number; v: number }[];
  samples: { t: number; ax: number; ay: number; az: number }[];
  liveStrokeRate: { t: number; spm: number | null }[];
};

export const MIN_SPM: number;
export const MAX_SPM: number;
