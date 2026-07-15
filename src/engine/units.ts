/**
 * Operator-facing unit conversions — one home for every factor, shared by
 * the engine and the HMI (a hand-rolled `*0.06` or `/1000/60` in one file
 * drifting from the others is how display bugs are born).
 */
export const MM_S_PER_M_MIN = 1000 / 60; // 60 m/min = 1000 mm/s

export const toMMin = (mmPerSec: number) => mmPerSec / MM_S_PER_M_MIN;
export const toMmSec = (mPerMin: number) => mPerMin * MM_S_PER_M_MIN;
export const toDeg = (rad: number) => (rad * 180) / Math.PI;
export const toRad = (deg: number) => (deg * Math.PI) / 180;
export const toRpm = (radPerSec: number) => (radPerSec * 60) / (2 * Math.PI);
