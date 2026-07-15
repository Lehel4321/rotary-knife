import { SimulationEngine } from './SimulationEngine';
import { CutFace, CutRecord } from '../types';
import { bladeAngle } from './FB_Cam';

/**
 * FC33: Cut Detection & Cut Face Recorder
 *
 * Two jobs, both driven by the ACTUAL knife angle (not the setpoint —
 * a lagging axis must produce lagging cuts, that is what we measure):
 *
 * 1. CUT EVENT — the blade tip crosses bottom dead center (θ ≡ 0 mod Θ).
 *    The crossing is interpolated INSIDE the scan (sub-millisecond), so
 *    the piece length measurement is much finer than the 1 ms cycle:
 *    at 1000 mm/s a raw scan boundary would already be a ±1 mm error.
 *    The piece length is the master travel between two crossings.
 *
 * 2. CUT FACE TRACE — while the tip is inside the material the tip
 *    position is recorded IN THE MATERIAL FRAME (x relative to the
 *    entry point, depth below the surface). A perfectly synchronized
 *    knife draws a vertical line; any speed mismatch bends the trace.
 *    From the completed trace:
 *      straightness = max lateral deviation of the down-pass (mm)
 *      skew         = bottom vs entry offset (mm, the "lean" of the face)
 *      drag         = loop width at the surface between the blade's
 *                     down-pass and up-pass (mm) — the blade rubbing the
 *                     freshly cut face on the way out.
 *
 * The trace metrics are written back onto the cut's log record when the
 * blade exits the material (a cut fires mid-trace, at maximum depth).
 */
export function FC_Cut(db: SimulationEngine) {
  const st = db.state;
  const cam = db.cam;
  const Theta = cam.Theta;
  const R = cam.R;
  const T = db.recipe.thick;
  const yc = R - db.config.overcut; // drum center height above the anvil

  // --- Network 1: blade-in-material trace ---
  const thB = bladeAngle(st.theta, Theta);
  const tipY = yc - R * Math.cos(thB);
  const inMat = tipY < T && Math.abs(thB) < Math.PI / 2;

  if (inMat) {
    if (!db.trace.active) {
      // Trace starts: anchor the material frame so the entry point is x = 0
      db.trace.active = true;
      db.trace.D0 = st.D - R * Math.sin(thB);
      db.trace.pts = [];
      db.trace.folErrMax = 0;
    }
    // Decimated on push: at very low line speed the blade can sit in the
    // material for tens of thousands of scans — recording a point only
    // when the tip has moved keeps the face bounded (~a few hundred
    // points) at full metric fidelity (0.08 mm resolution).
    const pt = {
      d: Math.max(0, Math.min(T, T - tipY)),
      x: R * Math.sin(thB) - (st.D - db.trace.D0),
    };
    const last = db.trace.pts[db.trace.pts.length - 1];
    if (!last || Math.abs(pt.d - last.d) > 0.08 || Math.abs(pt.x - last.x) > 0.08) {
      db.trace.pts.push(pt);
    }
    const errDeg = Math.abs((st.folErr * 180) / Math.PI);
    if (errDeg > db.trace.folErrMax) db.trace.folErrMax = errDeg;
  } else if (db.trace.active) {
    // Blade left the material -> finalize the face and grade it
    db.trace.active = false;
    const pts = db.trace.pts;
    if (pts.length >= 3) {
      let downEnd = 0;
      for (let i = 1; i < pts.length; i++) if (pts[i].d > pts[downEnd].d) downEnd = i;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i <= downEnd; i++) {
        if (pts[i].x < lo) lo = pts[i].x;
        if (pts[i].x > hi) hi = pts[i].x;
      }
      const face: CutFace = {
        pts,
        downEnd,
        straight: hi - lo,
        skew: pts[downEnd].x - pts[0].x,
        drag: Math.abs(pts[pts.length - 1].x - pts[0].x),
        thick: T,
        trim: false,
      };
      // Attach to the newest cut record that has no face data yet
      for (let i = db.log.length - 1; i >= 0 && i >= db.log.length - 3; i--) {
        const rec = db.log[i];
        if (rec.straight === null && !rec.lost) {
          rec.straight = face.straight;
          rec.skew = face.skew;
          rec.drag = face.drag;
          rec.folErrMax = Math.max(rec.folErrMax, db.trace.folErrMax);
          face.trim = rec.trim;
          break;
        }
      }
      db.face = face;
      db.notify();
    }
    db.trace.pts = [];
  }

  // --- Network 2: cut event on bottom-dead-center crossing ---
  db.scopeCut = false;
  const idx = Math.floor(st.theta / Theta);
  if (idx > db.lastCutIdx) {
    // Interpolate the master position at the exact crossing
    const thC = idx * Theta;
    const dTh = st.theta - db.prev.theta;
    const frac = dTh > 1e-12 ? (thC - db.prev.theta) / dTh : 1;
    const Dcut = db.prev.D + Math.max(0, Math.min(1, frac)) * (st.D - db.prev.D);

    const len = Dcut - st.DlastCut;
    st.DlastCut = Dcut;
    const trim = st.firstCut;
    st.firstCut = false;
    if (trim) st.trims++; else st.cuts++;

    // The cut-off piece drops onto the out-feed belt, rear edge at the knife
    db.pieces.push({ left: st.D - Dcut, len, trim });

    const rec: CutRecord = {
      n: st.cuts + st.trims,
      t: st.simTime,
      len,
      err: len - db.recipe.len,
      trim,
      vLine: st.v,
      straight: null,
      skew: null,
      drag: null,
      folErrMax: db.trace.folErrMax,
    };
    db.log.push(rec);
    if (db.log.length > 400) db.log.shift();
    db.scopeCut = true;
    db.lastCutIdx = idx;
    db.notify();
  }

  // --- Network 3: snapshot for next scan's interpolation ---
  db.prev.D = st.D;
  db.prev.theta = st.theta;
  db.penetrating = inMat;
}
