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

/**
 * Numeric field with a local DRAFT: while you type, the field is yours —
 * clear it, retype it, nothing snaps back. The value is committed to the
 * engine when you press Enter or leave the field; the engine's validator
 * then clamps it (an empty/invalid draft simply keeps the old value).
 * Committing on every keystroke made the fields uneditable: the engine
 * refused the transient empty value and instantly wrote the old number
 * back into the input.
 */
function NumInput({ label, value, onCommit, disabled, min, max, step, extra }: {
  label: string; value: number; onCommit: (v: number) => void;
  disabled?: boolean; min?: number; max?: number; step?: number; extra?: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    onCommit(parseFloat(draft));
    setDraft(null);
  };
  const input = (
    <input
      className={inputCls}
      type="number"
      inputMode="decimal"
      value={draft !== null ? draft : String(value)}
      disabled={disabled}
      min={min} max={max} step={step}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => { if (draft === null) setDraft(String(value)); }}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
  return (
    <Field label={label}>
      {extra ? <div className="flex gap-1">{input}{extra}</div> : input}
    </Field>
  );
}

/** Text field with the same draft-then-commit behavior (for the recipe name). */
function TextInput({ label, value, onCommit, disabled }: {
  label: string; value: string; onCommit: (v: string) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field label={label}>
      <input
        className={inputCls + ' w-full'}
        value={draft !== null ? draft : value}
        disabled={disabled}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (draft !== null) { onCommit(draft); setDraft(null); } }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </Field>
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
    <Shell title="Recipe — product data" hint={locked ? '🔒 Machine running — stop to edit.' : 'Values apply when you press Enter or leave a field. Changing the recipe rebuilds the cam and re-phases the knife (next cut = new TRIM reference edge).'} onClose={onClose}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <TextInput label="Name" value={r.name} disabled={locked} onCommit={v => up({ name: v })} />
        <NumInput label="Cut length [mm]" value={r.len} disabled={locked} min={50} max={5000} step={10}
          onCommit={v => up({ len: v })} />
        <NumInput label="Line speed [m/min]" value={Math.round(toMMin(r.spd) * 10) / 10} disabled={locked} min={1} step={5}
          onCommit={v => up({ spd: toMmSec(v) })} />
        <NumInput label={`Thickness [mm] (max ${engine.config.maxThick})`} value={r.thick} disabled={locked}
          min={0.5} max={engine.config.maxThick} step={0.5} onCommit={v => up({ thick: v })} />
        <Field label="Sync mode">
          <select className={inputCls + ' w-full'} disabled={locked} value={r.syncMode} onChange={e => up({ syncMode: e.target.value as 'constant' | 'comp' })}>
            <option value="constant">CONSTANT ω (classic LRK)</option>
            <option value="comp">COMPENSATED (straight @ 20mm)</option>
          </select>
        </Field>
        <NumInput label="Velocity ratio k [%]" value={Math.round(r.ratio * 1000) / 10}
          disabled={locked || r.syncMode === 'comp'} min={80} max={130} step={0.5}
          onCommit={v => up({ ratio: v / 100 })}
          extra={
            <button
              disabled={locked || r.syncMode === 'comp'}
              title="k = α/sin(α): re-aligns the face bottom with the entry point at this thickness"
              onClick={() => up({ ratio: engine.suggestedRatio() })}
              className="border border-cyan-800 text-cyan-400 text-[0.65rem] font-bold uppercase px-2 rounded hover:bg-cyan-950/40 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
              auto {(engine.suggestedRatio() * 100).toFixed(1)}
            </button>
          } />
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
    <Shell title="Process parameters" hint={locked ? '🔒 Machine running — stop to edit.' : 'Values apply when you press Enter or leave a field. The sync window is the knife-angle range where the blade speed is locked to the material.'} onClose={onClose}>
      <div className="grid grid-cols-2 gap-4">
        <NumInput label="Sync window [° knife angle]" value={engine.params.syncDeg} disabled={locked}
          min={10} max={140} step={5} onCommit={v => up({ syncDeg: v })} />
        <NumInput label="Out-feed gain [× line speed]" value={engine.params.outFac} disabled={locked}
          min={1} max={3} step={0.05} onCommit={v => up({ outFac: v })} />
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
    <Shell title="Machine configuration" hint={locked ? '🔒 Control is ON — turn it off to change the machine build (commissioning mode).' : 'Values apply when you press Enter or leave a field. Physical build: knife drum and servo drive data. Later knife SHAPES will plug in here.'} onClose={onClose}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <NumInput label="Knife tip radius [mm]" value={c.knifeR} disabled={locked} min={40} max={400} step={5}
          onCommit={v => up({ knifeR: v })} />
        <Field label="Blades on drum">
          <select className={inputCls} disabled={locked} value={c.knives} onChange={e => up({ knives: +e.target.value as 1 | 2 })}>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </Field>
        <NumInput label="Overcut [mm]" value={c.overcut} disabled={locked} min={0} max={2} step={0.1}
          onCommit={v => up({ overcut: v })} />
        <NumInput label={`Knife ωmax [rad/s] (${(c.knifeWmax * 60 / (2 * Math.PI)).toFixed(0)} rpm)`} value={c.knifeWmax}
          disabled={locked} min={2} max={200} step={1} onCommit={v => up({ knifeWmax: v })} />
        <NumInput label="Knife αmax [rad/s²]" value={c.knifeAmax} disabled={locked} min={20} max={20000} step={50}
          onCommit={v => up({ knifeAmax: v })} />
        <NumInput label="Following error limit [°]" value={c.folErrLimit} disabled={locked} min={0.5} max={30} step={0.5}
          onCommit={v => up({ folErrLimit: v })} />
        <NumInput label="Feed Vmax [mm/s]" value={c.axVmax} disabled={locked} min={10} step={100}
          onCommit={v => up({ axVmax: v })} />
        <NumInput label="Feed Amax [mm/s²]" value={c.axAmax} disabled={locked} min={100} step={1000}
          onCommit={v => up({ axAmax: v })} />
        <NumInput label="Feed jerk [mm/s³]" value={c.axJerk} disabled={locked} min={1000} step={10000}
          onCommit={v => up({ axJerk: v })} />
      </div>
      <div className="mt-4 text-[0.7rem] font-mono text-zinc-500">
        knife circumference {(2 * Math.PI * c.knifeR).toFixed(0)}mm · max feasible line speed with this drive: <span className="text-cyan-400">{toMMin(engine.vFeasibleLine()).toFixed(1)} m/min</span>
      </div>
    </Shell>
  );
}
