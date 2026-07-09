import { ReactNode, useState } from 'react';
import { engine, toMMin, toMmSec } from '../engine/SimulationEngine';

const inputCls = "bg-[#18181b] border border-[#27272a] rounded text-[0.875rem] text-[#f4f4f5] px-2 py-1 font-mono focus:outline-none focus:border-[#eab308] disabled:opacity-40 disabled:cursor-not-allowed w-24";
const labelCls = "text-[0.65rem] uppercase tracking-[0.05em] text-[#71717a] font-semibold mb-1";

function Shell({ title, hint, onClose, children }: { title: string; hint?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-[#101013] border border-[#27272a] rounded-lg p-5 w-full max-w-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-[#f4f4f5]">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 cursor-pointer">✕</button>
        </div>
        {hint && <div className="mb-4 text-[0.7rem] text-zinc-500">{hint}</div>}
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

/** RECIPE — product data. Locked while the machine runs. */
export function RecipeModal({ onClose }: { onClose: () => void }) {
  const locked = engine.state.running;
  const r = engine.recipe;
  const [, bump] = useState(0);
  const up = (u: Parameters<typeof engine.updateRecipe>[0]) => { engine.updateRecipe(u); bump(x => x + 1); };
  const alpha2 = (2 * engine.contactAlpha() * 180) / Math.PI;

  return (
    <Shell title="Recipe — product data" hint={locked ? '🔒 Machine running — stop to edit.' : 'Changing the recipe rebuilds the cam and re-phases the knife (next cut = new TRIM reference edge).'} onClose={onClose}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Field label="Name">
          <input className={inputCls + ' w-full'} disabled={locked} value={r.name} onChange={e => up({ name: e.target.value })} />
        </Field>
        <Field label="Cut length [mm]">
          <input className={inputCls} type="number" disabled={locked} value={r.len} min={50} step={10} onChange={e => up({ len: +e.target.value })} />
        </Field>
        <Field label="Line speed [m/min]">
          <input className={inputCls} type="number" disabled={locked} value={Math.round(toMMin(r.spd) * 10) / 10} min={1} step={5} onChange={e => up({ spd: toMmSec(+e.target.value) })} />
        </Field>
        <Field label={`Thickness [mm] (max ${engine.config.maxThick})`}>
          <input className={inputCls} type="number" disabled={locked} value={r.thick} min={0.5} max={engine.config.maxThick} step={0.5} onChange={e => up({ thick: +e.target.value })} />
        </Field>
        <Field label="Sync mode">
          <select className={inputCls + ' w-full'} disabled={locked} value={r.syncMode} onChange={e => up({ syncMode: e.target.value as 'constant' | 'comp' })}>
            <option value="constant">CONSTANT ω (classic LRK)</option>
            <option value="comp">COMPENSATED (straight @ 20mm)</option>
          </select>
        </Field>
        <Field label="Velocity ratio k [%]">
          <div className="flex gap-1">
            <input className={inputCls} type="number" disabled={locked || r.syncMode === 'comp'} value={Math.round(r.ratio * 1000) / 10} min={80} max={130} step={0.5} onChange={e => up({ ratio: +e.target.value / 100 })} />
            <button
              disabled={locked || r.syncMode === 'comp'}
              title="k = α/sin(α): re-aligns the face bottom with the entry point at this thickness"
              onClick={() => up({ ratio: engine.suggestedRatio() })}
              className="border border-cyan-800 text-cyan-400 text-[0.65rem] font-bold uppercase px-2 rounded hover:bg-cyan-950/40 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
              auto {(engine.suggestedRatio() * 100).toFixed(1)}
            </button>
          </div>
        </Field>
      </div>
      <div className="mt-4 text-[0.7rem] font-mono text-zinc-500 leading-relaxed">
        blade contact window at {r.thick}mm: <span className="text-zinc-300">{alpha2.toFixed(1)}°</span>
        {' · '}nominal rate: <span className="text-zinc-300">{engine.nominalRate().toFixed(1)} cuts/min</span>
        {' · '}max feasible line speed: <span className="text-cyan-400">{toMMin(engine.vFeasibleLine()).toFixed(1)} m/min</span>
      </div>
      {engine.cam.warnings.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {engine.cam.warnings.map((wn, i) => <div key={i} className="text-[0.7rem] text-orange-400 font-semibold">⚠ {wn}</div>)}
        </div>
      )}
    </Shell>
  );
}

/** PROCESS PARAMETERS — sync window tuning. Locked while running (reshapes the cam). */
export function ParamsModal({ onClose }: { onClose: () => void }) {
  const locked = engine.state.running;
  const [, bump] = useState(0);
  const up = (u: Parameters<typeof engine.updateParams>[0]) => { engine.updateParams(u); bump(x => x + 1); };
  const alpha2 = (2 * engine.contactAlpha() * 180) / Math.PI;
  const tooSmall = engine.params.syncDeg < alpha2;

  return (
    <Shell title="Process parameters" hint={locked ? '🔒 Machine running — stop to edit.' : 'The sync window is the knife-angle range where the blade speed is locked to the material.'} onClose={onClose}>
      <div className="grid grid-cols-2 gap-4">
        <Field label={`Sync window [° knife angle]`}>
          <input className={inputCls} type="number" disabled={locked} value={engine.params.syncDeg} min={10} max={140} step={5} onChange={e => up({ syncDeg: +e.target.value })} />
        </Field>
        <Field label="Out-feed gain [× line speed]">
          <input className={inputCls} type="number" disabled={locked} value={engine.params.outFac} min={1} max={3} step={0.05} onChange={e => up({ outFac: +e.target.value })} />
        </Field>
      </div>
      <div className={`mt-4 text-[0.7rem] font-mono ${tooSmall ? 'text-orange-400 font-semibold' : 'text-zinc-500'}`}>
        {tooSmall ? '⚠ ' : ''}sync window {engine.params.syncDeg}° vs blade contact {alpha2.toFixed(1)}° at {engine.recipe.thick}mm
        {tooSmall ? ' — the blade will leave sync INSIDE the material.' : ' — contact fully covered ✓'}
      </div>
    </Shell>
  );
}

/** MACHINE CONFIGURATION — physical build. Locked while the control is ON. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const locked = engine.state.controlOn;
  const c = engine.config;
  const [, bump] = useState(0);
  const up = (u: Parameters<typeof engine.updateConfig>[0]) => { engine.updateConfig(u); bump(x => x + 1); };

  return (
    <Shell title="Machine configuration" hint={locked ? '🔒 Control is ON — turn it off to change the machine build (commissioning mode).' : 'Physical build: knife drum and servo drive data. Later knife SHAPES will plug in here.'} onClose={onClose}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Field label="Knife tip radius [mm]">
          <input className={inputCls} type="number" disabled={locked} value={c.knifeR} min={40} max={400} step={5} onChange={e => up({ knifeR: +e.target.value })} />
        </Field>
        <Field label="Blades on drum">
          <select className={inputCls} disabled={locked} value={c.knives} onChange={e => up({ knives: +e.target.value as 1 | 2 })}>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </Field>
        <Field label="Overcut [mm]">
          <input className={inputCls} type="number" disabled={locked} value={c.overcut} min={0} max={2} step={0.1} onChange={e => up({ overcut: +e.target.value })} />
        </Field>
        <Field label={`Knife ωmax [rad/s] (${(c.knifeWmax * 60 / (2 * Math.PI)).toFixed(0)} rpm)`}>
          <input className={inputCls} type="number" disabled={locked} value={c.knifeWmax} min={2} max={200} step={1} onChange={e => up({ knifeWmax: +e.target.value })} />
        </Field>
        <Field label="Knife αmax [rad/s²]">
          <input className={inputCls} type="number" disabled={locked} value={c.knifeAmax} min={20} max={20000} step={50} onChange={e => up({ knifeAmax: +e.target.value })} />
        </Field>
        <Field label="Following error limit [°]">
          <input className={inputCls} type="number" disabled={locked} value={c.folErrLimit} min={0.5} max={30} step={0.5} onChange={e => up({ folErrLimit: +e.target.value })} />
        </Field>
        <Field label="Feed Vmax [mm/s]">
          <input className={inputCls} type="number" disabled={locked} value={c.axVmax} min={10} step={100} onChange={e => up({ axVmax: +e.target.value })} />
        </Field>
        <Field label="Feed Amax [mm/s²]">
          <input className={inputCls} type="number" disabled={locked} value={c.axAmax} min={100} step={1000} onChange={e => up({ axAmax: +e.target.value })} />
        </Field>
        <Field label="Feed jerk [mm/s³]">
          <input className={inputCls} type="number" disabled={locked} value={c.axJerk} min={1000} step={10000} onChange={e => up({ axJerk: +e.target.value })} />
        </Field>
      </div>
      <div className="mt-4 text-[0.7rem] font-mono text-zinc-500">
        knife circumference {(2 * Math.PI * c.knifeR).toFixed(0)}mm · max feasible line speed with this drive: <span className="text-cyan-400">{toMMin(engine.vFeasibleLine()).toFixed(1)} m/min</span>
      </div>
    </Shell>
  );
}
