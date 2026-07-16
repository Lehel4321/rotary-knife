import { useEffect, useRef, useState } from 'react';
import { engine, toMMin, SCAN_TIME } from '../engine/SimulationEngine';

/**
 * SYNC SCOPE — the money shot of rotary knife camming: the material
 * velocity (blue) and the blade tip circumferential velocity (red) on
 * one axis, recorded at 1 kHz machine time by OB1. During the sync
 * window the red trace locks onto the blue line, on the return stroke
 * it swings away — exactly the trace you would capture with TIA Portal
 * on the real S7-1500T axes. Yellow bands = blade inside the material.
 */
export function ScopePanel({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [span, setSpan] = useState(2); // seconds of machine time
  const [paused, setPaused] = useState(false);
  const frozen = useRef<{ t: Float64Array; vMat: Float32Array; vTip: Float32Array; errDeg: Float32Array; pen: Uint8Array; cut: Uint8Array; n: number; i: number; cap: number } | null>(null);

  useEffect(() => {
    if (paused) {
      const s = engine.scope;
      frozen.current = {
        t: s.t.slice(), vMat: s.vMat.slice(), vTip: s.vTip.slice(),
        errDeg: s.errDeg.slice(), pen: s.pen.slice(), cut: s.cut.slice(), n: s.n, i: s.i, cap: s.cap,
      };
    } else frozen.current = null;
  }, [paused]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let frameId: number;

    const render = () => {
      const parent = cv.parentElement?.getBoundingClientRect();
      if (parent) {
        const dpr = window.devicePixelRatio || 1;
        if (cv.width !== parent.width * dpr) { cv.width = parent.width * dpr; cv.height = 260 * dpr; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      const w = cv.clientWidth, h = 260;
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);

      const s = frozen.current ?? engine.scope;
      if (s.n > 2) {
        const latest = (s.i - 1 + s.cap) % s.cap;
        const tMax = s.t[latest];
        const tMin = tMax - span;
        const X = (t: number) => ((t - tMin) / span) * w;

        const vLane = { y0: 18, h: 130 };
        const eLane = { y0: 170, h: 56 };

        // Pass 1: gather the visible samples. The ring is written at
        // exactly 1 sample per scan, so the window is the newest
        // span/SCAN_TIME entries — no need to walk the whole buffer.
        const rows: { x: number; vm: number; vt: number; e: number; pen: number; cut: number }[] = [];
        let dataVMax = 0, dataEMax = 0;
        const jStart = Math.max(0, s.n - (Math.ceil(span / SCAN_TIME) + 4));
        for (let j = jStart; j < s.n; j++) {
          const idx = (s.i - s.n + j + s.cap) % s.cap;
          const t = s.t[idx];
          if (t < tMin || t > tMax) continue;
          const vm = s.vMat[idx], vt = s.vTip[idx], e = s.errDeg[idx];
          rows.push({ x: X(t), vm, vt, e, pen: s.pen[idx], cut: s.cut[idx] });
          if (vm > dataVMax) dataVMax = vm;
          if (vt > dataVMax) dataVMax = vt;
          if (Math.abs(e) > dataEMax) dataEMax = Math.abs(e);
        }

        // Scales fit the DATA in view (the buffer may hold samples from a
        // different recipe speed than the live settings — scaling from
        // live settings would draw old traces off-canvas), while still
        // covering the live limit lines.
        const vMaxAx = Math.max(100, dataVMax * 1.12, engine.cruiseSpeed() * 0.5);
        const eMax = Math.max(0.1, engine.config.folErrLimit, dataEMax) * 1.05;
        const YV = (v: number) => vLane.y0 + vLane.h - (v / vMaxAx) * vLane.h;
        const YE = (e: number) => eLane.y0 + eLane.h / 2 - (e / eMax) * (eLane.h / 2);

        // grid
        ctx.strokeStyle = '#18181b'; ctx.lineWidth = 1;
        for (let gx = 0; gx <= 10; gx++) { ctx.beginPath(); ctx.moveTo((gx / 10) * w, 0); ctx.lineTo((gx / 10) * w, h); ctx.stroke(); }

        // Pass 2: build the layers
        const penRects: [number, number][] = [];
        let penStart: number | null = null;
        const pv: [number, number][] = [], pt: [number, number][] = [], pe: [number, number][] = [];
        const cuts: number[] = [];
        for (const r of rows) {
          pv.push([r.x, YV(r.vm)]);
          pt.push([r.x, YV(r.vt)]);
          pe.push([r.x, YE(r.e)]);
          if (r.pen) { if (penStart === null) penStart = r.x; }
          else if (penStart !== null) { penRects.push([penStart, r.x]); penStart = null; }
          if (r.cut) cuts.push(r.x);
        }
        if (penStart !== null) penRects.push([penStart, w]);

        // penetration bands
        ctx.fillStyle = 'rgba(234,179,8,.10)';
        for (const [a, b] of penRects) ctx.fillRect(a, 0, Math.max(1.5, b - a), h);
        // cut pulses
        ctx.strokeStyle = '#e4e4e7';
        for (const x of cuts) { ctx.beginPath(); ctx.moveTo(x, vLane.y0 - 8); ctx.lineTo(x, vLane.y0 + vLane.h); ctx.stroke(); }

        const poly = (pts: [number, number][], color: string, lw: number) => {
          if (pts.length < 2) return;
          ctx.strokeStyle = color; ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i2 = 1; i2 < pts.length; i2++) ctx.lineTo(pts[i2][0], pts[i2][1]);
          ctx.stroke();
        };
        // zero + limit lines
        ctx.strokeStyle = '#27272a';
        ctx.beginPath(); ctx.moveTo(0, YV(0)); ctx.lineTo(w, YV(0)); ctx.stroke();
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, YE(eMax)); ctx.lineTo(w, YE(eMax)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, YE(-eMax)); ctx.lineTo(w, YE(-eMax)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(0, YE(0)); ctx.lineTo(w, YE(0)); ctx.stroke();

        // Draw order matters: during the sync window the tip velocity is
        // EXACTLY the material velocity — a same-width material line drawn
        // second paints pixel-perfectly over the tip trace and the knife
        // signal appears to drop out for the whole cut window. Material
        // first and wide, tip thin on top: the lock shows as red riding
        // centered inside a blue halo.
        poly(pv, '#3b82f6', 3.5);
        poly(pt, '#ef4444', 1.5);
        poly(pe, '#f59e0b', 1);

        ctx.font = '11px ui-monospace'; ctx.textAlign = 'left';
        ctx.fillStyle = '#3b82f6'; ctx.fillText('MATERIAL v (' + toMMin(engine.state.v).toFixed(1) + ' m/min)', 6, 14);
        ctx.fillStyle = '#ef4444'; ctx.fillText('KNIFE TIP ω·R (' + toMMin(engine.state.omega * engine.config.knifeR).toFixed(1) + ' m/min)', 240, 14);
        ctx.fillStyle = '#eab308'; ctx.fillText('▮ blade in material', 520, 14);
        ctx.fillStyle = '#f59e0b'; ctx.fillText('FOLLOWING ERROR ±' + engine.config.folErrLimit + '° limit', 6, eLane.y0 - 4);
        ctx.fillStyle = '#71717a'; ctx.textAlign = 'right';
        ctx.fillText(span + 's window · 1kHz machine time', w - 6, 14);
      }
      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameId);
  }, [span, paused]);

  return (
    <div className="bg-[#0c0c0f] border border-[#27272a] rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[0.65rem] uppercase tracking-[0.05em] text-[#71717a] font-semibold">
          Sync Scope — leading axis vs knife axis
        </h3>
        <div className="flex gap-2 items-center">
          {[1, 2, 5].map(sp => (
            <button key={sp} onClick={() => setSpan(sp)}
              className={`text-[0.65rem] font-bold px-2 py-0.5 rounded border cursor-pointer ${span === sp ? 'border-yellow-600 text-yellow-500' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
              {sp}s
            </button>
          ))}
          <button onClick={() => setPaused(p => !p)}
            className={`text-[0.65rem] font-bold px-2 py-0.5 rounded border cursor-pointer ${paused ? 'border-cyan-700 text-cyan-400' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
            {paused ? '▶ resume' : '❚❚ freeze'}
          </button>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm cursor-pointer px-1">✕</button>
        </div>
      </div>
      <div className="relative h-[260px]">
        <canvas ref={canvasRef} className="block w-full h-full" />
      </div>
    </div>
  );
}
