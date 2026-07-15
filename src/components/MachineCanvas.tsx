import { useEffect, useRef } from 'react';
import { engine, toMMin } from '../engine/SimulationEngine';
import { bladeAngle } from '../engine/FB_Cam';

/**
 * Machine animation: side view of the rotary knife line, plus two
 * magnified insets — the CUT ZONE (blade passing through the material)
 * and the CUT FACE inspector (the physical straightness of the last cut).
 */

function txt(ctx: CanvasRenderingContext2D, x: number, y: number, t: string, c: string, a: CanvasTextAlign = 'center', size = 11) {
  ctx.fillStyle = c;
  ctx.font = `${size}px ui-monospace`;
  ctx.textAlign = a;
  ctx.fillText(t, x, y);
}

function vline(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number, c: string, w = 1) {
  ctx.strokeStyle = c;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
}

function niceStep(span: number) {
  const raw = span / 10;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

/** Grade a straightness value (mm) for the HMI. */
export function gradeFace(s: number): { label: string; color: string } {
  if (s < 0.05) return { label: 'EXCELLENT', color: '#22c55e' };
  if (s < 0.3) return { label: 'GOOD', color: '#a3e635' };
  if (s < 1) return { label: 'FAIR', color: '#eab308' };
  return { label: 'POOR', color: '#ef4444' };
}

/**
 * Screen angle of the rotation tick on an in-feed nip roller, for feed
 * position D (mm) and a roller of radius Rmm (mm).
 *
 * Canvas y points DOWN, so a GROWING angle reads as clockwise on screen.
 * The material travels +x, so the roller face at the nip must travel +x too:
 * the lower roller (dir=+1, material on its 12 o'clock) turns clockwise, the
 * upper roller (dir=−1, material on its 6 o'clock) counter-clockwise. Scaling
 * by Rmm makes the rim roll on the material without slip.
 */
export function nipTickAngle(D: number, Rmm: number, dir: 1 | -1) {
  return (D / Rmm) * dir + (dir > 0 ? 0 : Math.PI);
}

// Fading trail of the blade tip (canvas-side only, machine frame)
let tipTrail: { x: number; y: number }[] = [];

export function MachineCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    function resize() {
      if (!cv) return;
      const r = cv.parentElement?.getBoundingClientRect();
      if (!r) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = r.width * dpr;
      cv.height = r.height * dpr;
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const resizeObserver = new ResizeObserver(resize);
    if (cv.parentElement) resizeObserver.observe(cv.parentElement);

    let frameId: number;

    function render() {
      if (!cv || !ctx) return;
      const w = cv.clientWidth, h = cv.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const st = engine.state;
      const cam = engine.cam;
      const R = engine.config.knifeR;
      const T = engine.recipe.thick;
      const yc = R - engine.config.overcut; // drum center above anvil (mm)
      const Theta = cam.Theta;
      const thB = bladeAngle(st.theta, Theta); // blade nearest bottom (same wrap as FC_Cut)
      const phi = engine.camPhase();
      const inSync = phi <= cam.sA || phi >= cam.L - cam.sA;
      const tipLen = engine.tipLen();

      // ================= MACHINE SIDE VIEW =================
      const axisMin = -620, axisMax = 980;
      const sc = w / (axisMax - axisMin);
      const X = (mm: number) => (mm - axisMin) * sc;
      const yA = 178; // anvil top = material bottom (px)
      const Y = (mmAboveAnvil: number) => yA - mmAboveAnvil * sc;
      const thickPx = Math.max(3, T * sc);

      // ruler
      const ry = 236;
      ctx.strokeStyle = '#27272a'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(axisMin), ry); ctx.lineTo(X(axisMax), ry); ctx.stroke();
      const step = niceStep(axisMax - axisMin);
      for (let mm = Math.ceil(axisMin / step) * step; mm <= axisMax + 0.1; mm += step) {
        const z = Math.abs(mm) < 0.01;
        vline(ctx, X(mm), ry, ry + (z ? 8 : 4), z ? '#e7eaf0' : '#3f3f46', z ? 2 : 1);
        txt(ctx, X(mm), ry + 16, z ? '0' : String(Math.round(mm)), z ? '#dfe3ea' : '#71717a');
      }

      // anvil roller (below the material, opposite the knife drum)
      const anvR = Math.max(18, R * 0.45 * sc);
      ctx.strokeStyle = '#3f3f46'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X(0), yA + anvR + 1, anvR, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#18181b';
      ctx.beginPath(); ctx.arc(X(0), yA + anvR + 1, anvR, 0, Math.PI * 2); ctx.fill();
      txt(ctx, X(0), yA + anvR + 5, 'ANVIL', '#52525b');

      // out-feed belt
      const beltY = yA + 2;
      ctx.strokeStyle = '#27272a';
      ctx.strokeRect(X(45), beltY, X(axisMax - 15) - X(45), 6);
      ctx.fillStyle = '#52525b';
      // Belt travel = outFac × fed material, so the chevrons ramp and brake
      // with the line instead of running at the setpoint speed regardless.
      const scroll = ((st.D * engine.params.outFac) * sc) % 18;
      for (let x = X(45) + scroll; x < X(axisMax - 15) - 4; x += 18) {
        ctx.beginPath(); ctx.moveTo(x, beltY + 1.5); ctx.lineTo(x + 5, beltY + 3); ctx.lineTo(x, beltY + 4.5); ctx.fill();
      }
      txt(ctx, X(500), beltY + 20, 'OUT-FEED · ' + (engine.params.outFac * 100).toFixed(0) + '% line speed', '#71717a');

      // in-feed nip rollers (the FEED AXIS — leading axis)
      const nipX = X(-380);
      const nipR = 20;
      const nipRmm = nipR / sc; // roll without slip against the material
      for (const dir of [-1, 1]) {
        const cy = yA - T * sc / 2 + dir * (T * sc / 2 + nipR + 1);
        ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(nipX, cy, nipR, 0, Math.PI * 2); ctx.stroke();
        const a0 = nipTickAngle(st.D, nipRmm, dir as 1 | -1);
        ctx.beginPath(); ctx.moveTo(nipX, cy); ctx.lineTo(nipX + nipR * Math.cos(a0), cy + nipR * Math.sin(a0)); ctx.stroke();
      }
      txt(ctx, nipX, yA - T * sc - nipR * 2 - 12, 'FEED AXIS (master)', '#3b82f6');
      txt(ctx, nipX, yA - T * sc - nipR * 2 + 1, toMMin(st.v).toFixed(1) + ' m/min', '#93c5fd');

      // material web: upstream + forming piece (continuous through the knife)
      ctx.fillStyle = '#eab308';
      ctx.fillRect(X(axisMin), yA - thickPx, X(tipLen) - X(axisMin), thickPx);
      ctx.fillStyle = '#fef08a';
      ctx.fillRect(X(tipLen) - 2, yA - thickPx, 2, thickPx);

      // detached pieces on the out-feed
      for (const p of engine.pieces) {
        ctx.fillStyle = p.trim ? '#f97316' : '#eab308';
        ctx.fillRect(X(p.left), yA - thickPx, Math.max(2, X(p.left + p.len) - X(p.left)), thickPx);
        ctx.fillStyle = p.trim ? '#fdba74' : '#fef08a';
        ctx.fillRect(X(p.left), yA - thickPx, 1.5, thickPx);
        ctx.fillRect(X(p.left + p.len) - 1.5, yA - thickPx, 1.5, thickPx);
        if (p.trim && p.left < axisMax) txt(ctx, (X(p.left) + X(p.left + p.len)) / 2, yA - thickPx - 5, 'TRIM', '#fb923c');
      }

      // next-cut marker: the cut fires when the cam phase reaches L, so
      // the material point that will be cut is (L − φ) upstream of the
      // knife — NOT (L − tipLen), which is wrong by parkPhi right after
      // a (re)phase, where the first piece is the short TRIM cut.
      {
        const cutIn = cam.L - phi;
        const xc = -cutIn;
        if (xc > axisMin + 30 && cutIn > 1) {
          ctx.save(); ctx.setLineDash([3, 3]);
          vline(ctx, X(xc), yA - thickPx - 14, yA + 4, '#71717a', 1);
          ctx.restore();
          txt(ctx, X(xc), yA - thickPx - 18, 'cut in ' + cutIn.toFixed(0) + 'mm', '#71717a');
        }
      }

      // ---- knife drum (the KNIFE AXIS — following axis) ----
      const cx = X(0), cy = Y(yc);
      const bodyR = Math.max(6, (R - engine.config.maxThick - 4) * sc);
      // tip circle (dashed)
      ctx.save(); ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#3f3f46'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, R * sc, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      // sync window arc around bottom dead center (screen angle: bottom = +90°)
      ctx.strokeStyle = inSync ? '#eab308' : '#854d0e'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, R * sc + 3, Math.PI / 2 - cam.thetaA, Math.PI / 2 + cam.thetaA); ctx.stroke();
      // contact window arc (where the blade is inside the material)
      if (cam.alpha > 0) {
        ctx.strokeStyle = '#7f1d1d'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, R * sc - 2, Math.PI / 2 - cam.alpha, Math.PI / 2 + cam.alpha); ctx.stroke();
      }
      // body
      ctx.fillStyle = '#18181b'; ctx.strokeStyle = '#52525b'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, bodyR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // park marker (top of the cam period)
      const pk = cam.parkTheta;
      ctx.fillStyle = '#22c55e';
      ctx.beginPath(); ctx.arc(cx + R * sc * Math.sin(pk), cy + R * sc * Math.cos(pk), 2.5, 0, Math.PI * 2); ctx.fill();
      // blades
      for (let i = 0; i < engine.config.knives; i++) {
        const a = thB + i * Theta;
        const sx = Math.sin(a), cyn = Math.cos(a);
        const hot = engine.penetrating && i === 0;
        ctx.strokeStyle = hot ? '#ef4444' : inSync && i === 0 ? '#eab308' : '#e4e4e7';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx + bodyR * sx, cy + bodyR * cyn);
        ctx.lineTo(cx + R * sc * sx, cy + R * sc * cyn);
        ctx.stroke();
      }
      txt(ctx, cx + R * sc + 14, cy - 26, 'KNIFE AXIS', '#e4e4e7', 'left');
      txt(ctx, cx + R * sc + 14, cy - 13, '(slave · cam-coupled)', '#71717a', 'left', 10);
      txt(ctx, cx + R * sc + 14, cy + 2, (st.omega * 60 / (2 * Math.PI)).toFixed(0) + ' rpm · tip ' + toMMin(st.omega * R).toFixed(1) + ' m/min', '#a1a1aa', 'left', 10);
      // knife status badge
      const badge = engine.penetrating ? ['CUTTING', '#ef4444'] : inSync ? ['SYNC', '#eab308'] : cam.dwell && Math.abs(st.omega) < 0.01 && st.running ? ['PARK WAIT', '#22c55e'] : ['RETURN', '#71717a'];
      txt(ctx, cx + R * sc + 14, cy + 18, badge[0], badge[1], 'left');

      // ================= CAM PHASE BAR =================
      const pbX0 = X(90), pbX1 = X(axisMax - 40), pbY = 30;
      ctx.strokeStyle = '#27272a'; ctx.strokeRect(pbX0, pbY, pbX1 - pbX0, 10);
      const PB = (f: number) => pbX0 + f * (pbX1 - pbX0);
      // sync bands at both ends
      ctx.fillStyle = 'rgba(234,179,8,.25)';
      ctx.fillRect(PB(0), pbY, PB(cam.sA / cam.L) - PB(0), 10);
      ctx.fillRect(PB(1 - cam.sA / cam.L), pbY, PB(1) - PB(1 - cam.sA / cam.L), 10);
      // dwell band
      const dw = cam.segs.find(s => s.kind === 'dwell');
      if (dw) {
        ctx.fillStyle = 'rgba(34,197,94,.18)';
        ctx.fillRect(PB(dw.phi0 / cam.L), pbY, PB((dw.phi0 + dw.S) / cam.L) - PB(dw.phi0 / cam.L), 10);
      }
      // cursor
      ctx.fillStyle = '#e4e4e7';
      ctx.fillRect(PB(phi / cam.L) - 1, pbY - 2, 2, 14);
      vline(ctx, PB(0), pbY - 3, pbY + 13, '#ef4444', 1.5);
      vline(ctx, PB(1), pbY - 3, pbY + 13, '#ef4444', 1.5);
      txt(ctx, PB(0), pbY - 6, 'CUT', '#ef4444', 'center', 9);
      txt(ctx, pbX0 - 8, pbY + 9, 'CAM PHASE φ ' + phi.toFixed(0) + ' / ' + cam.L + 'mm', '#71717a', 'right', 10);

      // ================= INSET A: CUT ZONE (magnified) =================
      const iy0 = 262, ih = h - iy0 - 8, iw = 330;
      const drawInsetFrame = (x0: number, title: string) => {
        ctx.strokeStyle = '#27272a'; ctx.lineWidth = 1;
        ctx.strokeRect(x0, iy0, iw, ih);
        ctx.fillStyle = '#0c0c0f';
        ctx.fillRect(x0, iy0, iw, ih);
        ctx.strokeRect(x0, iy0, iw, ih);
        txt(ctx, x0 + 8, iy0 + 14, title, '#a1a1aa', 'left', 10);
      };

      const ax0 = 10;
      drawInsetFrame(ax0, 'CUT ZONE ×' + (330 / 110 / sc).toFixed(1));
      ctx.save();
      ctx.beginPath(); ctx.rect(ax0, iy0, iw, ih); ctx.clip();
      const zs = iw / 110; // ±55 mm view
      const zx = (mm: number) => ax0 + iw / 2 + mm * zs;
      const zyA = iy0 + ih - 24; // anvil line
      const zy = (mmAbove: number) => zyA - mmAbove * zs;
      // anvil hatch
      ctx.strokeStyle = '#3f3f46'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ax0, zyA); ctx.lineTo(ax0 + iw, zyA); ctx.stroke();
      for (let x = ax0 + 4; x < ax0 + iw; x += 8) {
        ctx.beginPath(); ctx.moveTo(x, zyA); ctx.lineTo(x - 5, zyA + 6); ctx.stroke();
      }
      // material slab: web + forming piece, then detached pieces
      ctx.fillStyle = 'rgba(234,179,8,.85)';
      ctx.fillRect(zx(-55), zy(T), zx(Math.min(tipLen, 55)) - zx(-55), T * zs);
      for (const p of engine.pieces) {
        if (p.left > 55 || p.left + p.len < -55) continue;
        ctx.fillRect(zx(Math.max(-55, p.left)), zy(T), zx(Math.min(55, p.left + p.len)) - zx(Math.max(-55, p.left)), T * zs);
      }
      // fresh edges
      if (tipLen < 55) { ctx.fillStyle = '#fef08a'; ctx.fillRect(zx(tipLen) - 1.5, zy(T), 1.5, T * zs); }
      // tip circle path
      ctx.save(); ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#3f3f46';
      ctx.beginPath(); ctx.arc(zx(0), zy(yc), R * zs, Math.PI / 2 - 0.75, Math.PI / 2 + 0.75); ctx.stroke();
      ctx.restore();
      // blade tip trail (machine frame — shows the cycloid of the tip)
      const tipX = R * Math.sin(thB), tipY = yc - R * Math.cos(thB);
      if (st.running) {
        tipTrail.push({ x: tipX, y: tipY });
        if (tipTrail.length > 140) tipTrail.shift();
      }
      for (let i = 1; i < tipTrail.length; i++) {
        ctx.strokeStyle = `rgba(148,163,184,${(i / tipTrail.length) * 0.5})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(zx(tipTrail[i - 1].x), zy(tipTrail[i - 1].y));
        ctx.lineTo(zx(tipTrail[i].x), zy(tipTrail[i].y));
        ctx.stroke();
      }
      // blade (tapered)
      const bd = (r: number, da: number) => ({ x: zx(r * Math.sin(thB + da)), y: zy(yc - r * Math.cos(thB + da)) });
      const p1 = bd(R, 0), p2 = bd(R - 22, 0.05), p3 = bd(R - 22, -0.05);
      ctx.fillStyle = engine.penetrating ? '#ef4444' : inSync ? '#eab308' : '#cbd5e1';
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath(); ctx.fill();
      // sync window edges on the material line
      ctx.fillStyle = 'rgba(234,179,8,.12)';
      const sList = [-cam.thetaA, cam.thetaA];
      const sPx = sList.map(a => zx(R * Math.sin(a)));
      ctx.fillRect(sPx[0], zy(T + 12), sPx[1] - sPx[0], (T + 12) * zs);
      txt(ctx, zx(0), zy(T + 14), 'sync window ' + ((2 * cam.thetaA * 180) / Math.PI).toFixed(0) + '° · contact ' + ((2 * cam.alpha * 180) / Math.PI).toFixed(0) + '°', '#a16207', 'center', 9);
      txt(ctx, zx(30), zyA + 14, 'material ' + T + 'mm →', '#71717a', 'left', 9);
      ctx.restore();

      // ================= INSET B: CUT FACE INSPECTOR =================
      const bx0 = w - 340;
      drawInsetFrame(bx0, 'CUT FACE (last cut)');
      ctx.save();
      ctx.beginPath(); ctx.rect(bx0, iy0, iw, ih); ctx.clip();
      const face = engine.face;
      // A stored face keeps the thickness it was CUT at — after a recipe
      // change the old face must not be rescaled to the new thickness.
      const faceT = face ? face.thick : T;
      const fy0 = iy0 + 26, fyh = ih - 44;
      const fx = bx0 + iw * 0.42;
      // reference: a perfectly straight face
      ctx.save(); ctx.setLineDash([4, 4]);
      vline(ctx, fx, fy0, fy0 + fyh, '#3f3f46', 1);
      ctx.restore();
      txt(ctx, fx, fy0 + fyh + 12, 'perfect vertical', '#52525b', 'center', 9);
      // depth scale
      txt(ctx, bx0 + 10, fy0 + 4, 'top', '#71717a', 'left', 9);
      txt(ctx, bx0 + 10, fy0 + fyh, 'bottom −' + faceT + 'mm', '#71717a', 'left', 9);
      const src = face ? face.pts : engine.trace.pts;
      if (src.length > 2) {
        const span = Math.max(0.08, ...src.map(p => Math.abs(p.x - src[0].x)));
        const mag = Math.min(60 / span, 400) ;
        const FX = (x: number) => fx + (x - src[0].x) * mag;
        const FY = (d: number) => fy0 + (d / faceT) * fyh;
        const downEnd = face ? face.downEnd : src.length - 1;
        // up-pass (dim) then down-pass (bright)
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(34,211,238,.35)';
        ctx.beginPath();
        for (let i = downEnd; i < src.length; i++) {
          const px = FX(src[i].x), py = FY(src[i].d);
          if (i === downEnd) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.strokeStyle = '#22d3ee';
        ctx.beginPath();
        for (let i = 0; i <= downEnd; i++) {
          const px = FX(src[i].x), py = FY(src[i].d);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        txt(ctx, fx, iy0 + 14, '×' + mag.toFixed(0) + ' magnified', '#52525b', 'center', 9);
        if (face) {
          // The phasing TRIM cut is shown but labeled — grading it would
          // contradict the trim-filtered Straightness tile below.
          const g = face.trim ? { label: 'TRIM CUT', color: '#fb923c' } : gradeFace(face.straight);
          txt(ctx, bx0 + iw - 10, iy0 + 14, g.label, g.color, 'right', 10);
          txt(ctx, bx0 + iw - 10, fy0 + 16, 'straightness ' + face.straight.toFixed(3) + 'mm', '#e4e4e7', 'right', 10);
          txt(ctx, bx0 + iw - 10, fy0 + 30, 'skew ' + (face.skew >= 0 ? '+' : '') + face.skew.toFixed(3) + 'mm', '#a1a1aa', 'right', 10);
          txt(ctx, bx0 + iw - 10, fy0 + 44, 'blade drag ' + face.drag.toFixed(3) + 'mm', '#a1a1aa', 'right', 10);
        } else {
          txt(ctx, bx0 + iw - 10, iy0 + 14, 'CUTTING…', '#22d3ee', 'right', 10);
        }
      } else {
        txt(ctx, bx0 + iw / 2, fy0 + fyh / 2, 'no cut yet', '#52525b');
      }
      ctx.restore();

      // ================= CENTER INFO BLOCK =================
      const mx0 = 360, mx1 = w - 360;
      if (mx1 - mx0 > 200) {
        const cxm = (mx0 + mx1) / 2;
        const rows: [string, string, string][] = [
          ['LINE', toMMin(st.v).toFixed(1) + ' m/min', '#3b82f6'],
          ['KNIFE TIP', toMMin(st.omega * R).toFixed(1) + ' m/min', '#ef4444'],
          ['FOLLOW ERR', ((st.folErr * 180) / Math.PI).toFixed(3) + '°', Math.abs((st.folErr * 180) / Math.PI) > engine.config.folErrLimit * 0.5 ? '#ef4444' : '#a1a1aa'],
          ['PIECE', tipLen.toFixed(0) + ' / ' + cam.L + ' mm', '#eab308'],
          ['MODE', engine.recipe.syncMode === 'comp' ? 'COMPENSATED' : 'CONSTANT k=' + (cam.k * 100).toFixed(1) + '%', '#a1a1aa'],
        ];
        let yy = iy0 + 22;
        for (const [label, val, col] of rows) {
          txt(ctx, cxm - 8, yy, label, '#52525b', 'right', 10);
          txt(ctx, cxm + 4, yy, val, col, 'left', 12);
          yy += 22;
        }
        // sync delta while in the window
        if (inSync && st.running) {
          const dv = toMMin(st.omega * R * Math.cos(thB) - st.v);
          txt(ctx, cxm, yy + 4, 'Δ tip↔material ' + (dv >= 0 ? '+' : '') + dv.toFixed(2) + ' m/min', Math.abs(dv) < 0.5 ? '#22c55e' : '#eab308', 'center', 10);
        }
      }

      frameId = requestAnimationFrame(render);
    }
    frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      tipTrail = [];
    };
  }, []);

  return (
    <div
      className="w-full h-full border border-dashed border-[#27272a] rounded-lg overflow-hidden relative"
      style={{ background: 'radial-gradient(circle at center, #111114 0%, #09090b 100%)' }}
    >
      <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: 'linear-gradient(#27272a 1px, transparent 1px), linear-gradient(90deg, #27272a 1px, transparent 1px)', backgroundSize: '20px 20px' }}></div>
      <canvas ref={canvasRef} className="block w-full h-full absolute inset-0 z-10" />
    </div>
  );
}
