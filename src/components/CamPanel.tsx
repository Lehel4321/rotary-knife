import { useEffect, useRef } from 'react';
import { engine, toMMin } from '../engine/SimulationEngine';
import { CamProfile, evalCam } from '../engine/FB_Cam';

// The ratio curve is static per cam — resampling 400 evalCam calls every
// animation frame to animate one cursor is wasted work. Cached on cam identity.
let camCache: { cam: CamProfile; ratio: number[]; peak: number } | null = null;

/**
 * CAM PROFILE panel — how the feeder and the knife are synchronized.
 *
 * The feeder is the LEADING axis and simply runs at line speed; the
 * knife is geared to it through this cam (θ over material travel φ).
 * The plot shows the blade tip speed as a MULTIPLE of the material
 * speed: the flat plateau at k across the sync window is what makes the
 * cut straight; the hill (or the standstill valley) is the return
 * stroke. Because the cam is positional, this picture — and the cut
 * quality — is the same at every line speed.
 */
export function CamPanel({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
        if (cv.width !== parent.width * dpr) { cv.width = parent.width * dpr; cv.height = 230 * dpr; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      const w = cv.clientWidth, h = 230;
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);

      const cam = engine.cam;
      const R = engine.config.knifeR;
      const plotW = w - 210, x0 = 46, y0 = 16, plotH = h - 48;
      const X = (phi: number) => x0 + (phi / cam.L) * plotW;

      // ratio curve r(φ) = dθ/dφ · R (tip speed / material speed), cached per cam
      const N = 400;
      if (!camCache || camCache.cam !== cam) {
        const ratio: number[] = [];
        let peak = 0;
        for (let i = 0; i <= N; i++) {
          const r = evalCam(cam, (i / N) * cam.L)[1] * R;
          ratio.push(r);
          if (r > peak) peak = r;
        }
        camCache = { cam, ratio, peak };
      }
      const ratio = camCache.ratio;
      const peakRatio = camCache.peak;
      const rMax = Math.max(peakRatio * 1.15, 1.4);
      const Y = (r: number) => y0 + plotH - (r / rMax) * plotH;

      // sync bands
      ctx.fillStyle = 'rgba(234,179,8,.12)';
      ctx.fillRect(X(0), y0, X(cam.sA) - X(0), plotH);
      ctx.fillRect(X(cam.L - cam.sA), y0, X(cam.L) - X(cam.L - cam.sA), plotH);
      // dwell band
      const dw = cam.segs.find(s => s.kind === 'dwell');
      if (dw) {
        ctx.fillStyle = 'rgba(34,197,94,.10)';
        ctx.fillRect(X(dw.phi0), y0, X(dw.phi0 + dw.S) - X(dw.phi0), plotH);
        ctx.fillStyle = '#166534';
        ctx.font = '10px ui-monospace'; ctx.textAlign = 'center';
        ctx.fillText('KNIFE STANDSTILL (park)', X(dw.phi0 + dw.S / 2), y0 + 12);
      }

      // reference: ratio = 1 (tip speed = material speed)
      ctx.strokeStyle = '#27272a'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x0, Y(1)); ctx.lineTo(x0 + plotW, Y(1)); ctx.stroke();
      ctx.setLineDash([]);
      // zero line + axes
      ctx.beginPath(); ctx.moveTo(x0, Y(0)); ctx.lineTo(x0 + plotW, Y(0)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + plotH); ctx.stroke();

      // ratio curve
      ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const px = X((i / N) * cam.L), py = Y(ratio[i]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // live phase cursor
      const phi = engine.camPhase();
      ctx.strokeStyle = '#e4e4e7';
      ctx.beginPath(); ctx.moveTo(X(phi), y0); ctx.lineTo(X(phi), y0 + plotH); ctx.stroke();

      // labels
      ctx.font = '10px ui-monospace';
      ctx.fillStyle = '#71717a'; ctx.textAlign = 'left';
      ctx.fillText('tip speed ÷ material speed', x0 + 4, y0 + 10);
      ctx.textAlign = 'right';
      ctx.fillText('1.0', x0 - 4, Y(1) + 3);
      ctx.fillText('0', x0 - 4, Y(0) + 3);
      ctx.fillText(rMax.toFixed(1), x0 - 4, y0 + 8);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#a16207';
      ctx.fillText('SYNC', X(cam.sA / 2), y0 + plotH + 12);
      ctx.fillText('SYNC', X(cam.L - cam.sA / 2), y0 + plotH + 12);
      ctx.fillStyle = '#71717a';
      ctx.fillText('← one cut length ' + cam.L + 'mm of material = one blade pitch ' + ((cam.Theta * 180) / Math.PI).toFixed(0) + '° →', x0 + plotW / 2, y0 + plotH + 26);
      ctx.fillStyle = '#ef4444';
      ctx.fillText('CUT', X(0), y0 + plotH + 12);

      // numbers block right
      const nx = w - 158;
      ctx.textAlign = 'left';
      const rows: [string, string, string?][] = [
        ['circumference', (2 * Math.PI * R).toFixed(0) + ' mm'],
        ['contact window', ((2 * cam.alpha * 180) / Math.PI).toFixed(1) + '° (' + engine.recipe.thick + 'mm)'],
        ['sync window', ((2 * cam.thetaA * 180) / Math.PI).toFixed(0) + '°'],
        ['peak tip ratio', peakRatio.toFixed(2) + '×'],
        ['suggested k', (engine.suggestedRatio() * 100).toFixed(1) + '%'],
        ['pred. straightness', cam.mode === 'comp' ? '0.000 mm' : cam.predictStraight.toFixed(3) + ' mm', cam.mode === 'comp' ? '#22c55e' : undefined],
        ['MAX LINE SPEED', toMMin(engine.vFeasibleLine()).toFixed(1) + ' m/min', '#22d3ee'],
        ['max cut rate', (60 * engine.vFeasibleLine() / cam.L).toFixed(0) + ' /min', '#22d3ee'],
      ];
      let yy = 30;
      for (const [k2, v, col] of rows) {
        ctx.fillStyle = '#52525b'; ctx.fillText(k2, nx, yy);
        ctx.fillStyle = col ?? '#d4d4d8'; ctx.fillText(v, nx, yy + 12);
        yy += 26;
      }

      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameId);
  }, []);

  return (
    <div className="bg-[#0c0c0f] border border-[#27272a] rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[0.65rem] uppercase tracking-[0.05em] text-[#71717a] font-semibold">
          Cam Profile — knife geared to the material (LRK camming, one period)
        </h3>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm cursor-pointer px-1">✕</button>
      </div>
      <div className="relative h-[230px]">
        <canvas ref={canvasRef} className="block w-full h-full" />
      </div>
      {engine.cam.warnings.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {engine.cam.warnings.map((wn, i) => (
            <div key={i} className="text-[0.7rem] text-orange-400 font-semibold">⚠ {wn}</div>
          ))}
        </div>
      )}
    </div>
  );
}
