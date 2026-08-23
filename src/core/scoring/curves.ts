import type { Specs } from "../types.ts";

export function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Piecewise-linear score curves. Each curve maps a measured hardware value
 * to 0..100 through anchor points, so a spec's worth is a policy decision
 * written as data rather than scattered arithmetic.
 */
export function curve(value: number, points: Array<[number, number]>): number {
  if (value <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (value <= x2) {
      const t = (value - x1) / (x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  return last[1];
}

const PANEL_SCORE: Record<string, number> = {
  AMOLED: 100,
  pOLED: 100,
  "PLS LCD": 55,
  "IPS LCD": 55,
  "TFT LCD": 40,
};

// AnTuTu v11 anchors: the floor is a usable budget chip, the ceiling a
// current flagship. Log-scale, because a +100k jump means nothing at the
// top and everything at the bottom.
const ANTUTU_FLOOR = Math.log(150_000);
const ANTUTU_CEILING = Math.log(2_200_000);

export function perfScore(antutu: number | null): number | null {
  if (antutu === null) return null;
  return clamp(
    ((Math.log(antutu) - ANTUTU_FLOOR) / (ANTUTU_CEILING - ANTUTU_FLOOR)) * 100,
  );
}

export function memoryScore(s: Specs): number | null {
  if (s.ramGb === null && s.storageGb === null) return null;
  const ram = s.ramGb === null
    ? null
    : curve(s.ramGb, [[2, 10], [4, 35], [6, 60], [8, 80], [12, 95], [16, 100]]);
  const storage = s.storageGb === null
    ? null
    : curve(s.storageGb, [[32, 10], [64, 35], [128, 65], [256, 85], [512, 97], [
      1024,
      100,
    ]]);
  if (ram === null) return storage;
  if (storage === null) return ram;
  return ram * 0.5 + storage * 0.5;
}

export function displayScore(s: Specs): number | null {
  const parts: Array<[number, number]> = [];
  if (s.panel) parts.push([PANEL_SCORE[s.panel] ?? 50, 0.4]);
  if (s.refreshHz !== null) {
    parts.push([
      curve(s.refreshHz, [[60, 35], [90, 65], [120, 90], [144, 97], [
        165,
        100,
      ]]),
      0.35,
    ]);
  }
  if (s.resolution) {
    parts.push([
      s.resolution === "QHD+" ? 100 : s.resolution === "FHD+" ? 80 : 45,
      0.25,
    ]);
  }
  if (parts.length === 0) return null;
  const w = parts.reduce((sum, [, weight]) => sum + weight, 0);
  return parts.reduce((sum, [v, weight]) => sum + v * weight, 0) / w;
}

export function batteryScore(s: Specs): number | null {
  const parts: Array<[number, number]> = [];
  if (s.batteryMah !== null) {
    parts.push([
      curve(s.batteryMah, [[3000, 15], [4000, 35], [5000, 65], [6000, 88], [
        7000,
        100,
      ]]),
      0.7,
    ]);
  }
  if (s.chargingW !== null) {
    parts.push([
      curve(s.chargingW, [[10, 15], [18, 35], [33, 60], [45, 75], [67, 90], [
        100,
        100,
      ]]),
      0.3,
    ]);
  }
  if (parts.length === 0) return null;
  const w = parts.reduce((sum, [, weight]) => sum + weight, 0);
  return parts.reduce((sum, [v, weight]) => sum + v * weight, 0) / w;
}

export function cameraScore(s: Specs): number | null {
  if (s.mainCameraMp === null && s.ois === null) return null;
  let base = s.mainCameraMp === null
    ? 50
    : curve(s.mainCameraMp, [[8, 15], [13, 30], [32, 55], [50, 72], [64, 78], [
      108,
      88,
    ], [200, 95]]);
  if (s.ois === true) base = Math.min(100, base + 12);
  // The main sensor is table stakes at every tier above budget; the ARRAY
  // is what makes a camera phone. Without these bonuses a "camera priority"
  // query cannot separate a dozen identical 50MP+OIS handsets.
  if (s.teleMp !== null) base += 10;
  if (s.ultraWideMp !== null) base += 6;
  if (s.aperture !== null) {
    if (s.aperture <= 1.7) base += 6;
    else if (s.aperture <= 2.0) base += 3;
  }
  return Math.min(100, Math.round(base));
}

export function extrasScore(s: Specs): number | null {
  let known = 0;
  let score = 0;
  const add = (has: boolean | null, weight: number) => {
    if (has === null) return;
    known += weight;
    if (has) score += weight;
  };
  add(s.has5g, 35);
  add(s.nfc, 15);
  add(s.ipRating !== null ? true : null, 20);
  if (s.osUpgrades !== null) {
    known += 30;
    score += curve(s.osUpgrades, [[0, 0], [2, 15], [4, 27], [6, 30]]);
  }
  if (known === 0) return null;
  return (score / known) * 100;
}
