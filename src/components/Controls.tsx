import { useState } from 'react';
import { engine, toMMin } from '../engine/SimulationEngine';
import { recipeBook, sameRecipe } from '../engine/RecipeBook';
import { RecipeModal, ParamsModal, SettingsModal } from './Modals';

/**
 * Machine control panel: the basic safety control functions
 * (Control ON/OFF · START · graceful STOP · E-Stop · guard door)
 * plus the three data blocks (recipe / parameters / machine config)
 * and the slow-motion control for watching the blade work.
 */
export function Controls() {
  const [showRecipe, setShowRecipe] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const st = engine.state;
  const overFeasible = engine.cruiseSpeed() > engine.vFeasibleLine() + 1e-9;
  const savedRecipe = recipeBook.get(engine.recipe.name);
  const recipeDirty = !savedRecipe || !sameRecipe(savedRecipe, engine.recipe);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-[#18181b] p-4 rounded-lg border border-[#27272a]">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-[0.65rem] uppercase tracking-[0.05em] text-[#71717a] font-semibold">Machine Control</h3>
          <span className="text-[10px] text-zinc-500">Safety chain → Control ON → Start</span>
        </div>

        {/* Status banners */}
        {st.estop ? (
          <div className="mb-3 px-3 py-2 rounded border border-red-700 bg-red-950/60 text-red-400 text-[0.75rem] font-bold uppercase tracking-wider animate-pulse">
            ⛔ E-STOP ACTIVE — machine control OFF. Release the E-Stop button, then press CONTROL ON.
            {st.needsReset && <span className="block font-semibold text-red-300 normal-case tracking-normal mt-1">Production was interrupted — Control ON clears and re-phases the machine (the blade may be inside the material).</span>}
          </div>
        ) : st.knifeFault ? (
          <div className="mb-3 px-3 py-2 rounded border border-red-700 bg-red-950/60 text-red-400 text-[0.75rem] font-bold uppercase tracking-wider flex items-center justify-between gap-3">
            <span>
              ⚠ KNIFE AXIS FAULT — following error exceeded {engine.config.folErrLimit}° (cam demand beyond the drive limits).
              <span className="block font-semibold text-red-300 normal-case tracking-normal mt-1">Lower the line speed or raise the knife dynamics, then acknowledge.</span>
            </span>
            <button onClick={() => engine.ackKnifeFault()}
              className="border border-red-600 text-red-300 text-[0.7rem] font-semibold uppercase px-3 py-[6px] rounded hover:bg-red-900/50 transition-all cursor-pointer whitespace-nowrap">
              Acknowledge
            </button>
          </div>
        ) : st.guardOpen ? (
          <div className="mb-3 px-3 py-2 rounded border border-orange-700 bg-orange-950/40 text-orange-400 text-[0.75rem] font-bold uppercase tracking-wider">
            ⚠ GUARD DOOR OPEN — knife accessible. START interlocked; close the guard.
          </div>
        ) : !st.controlOn ? (
          <div className="mb-3 px-3 py-2 rounded border border-yellow-700 bg-yellow-950/40 text-yellow-500 text-[0.75rem] font-bold uppercase tracking-wider">
            ⚠ CONTROL OFF — press the green CONTROL ON button (safety check).
            {st.needsReset && <span className="block font-semibold text-yellow-300 normal-case tracking-normal mt-1">Production was interrupted — Control ON will clear and re-phase the machine.</span>}
          </div>
        ) : (
          <div className="mb-3 px-3 py-2 rounded border border-green-800 bg-green-950/40 text-green-500 text-[0.75rem] font-bold uppercase tracking-wider">
            ● CONTROL ON — {st.running ? (st.stopReq ? 'STOPPING: braking the line to the knife park phase…' : 'machine RUNNING') : 'ready to start'}
          </div>
        )}

        {overFeasible && !st.knifeFault && (
          <div className="mb-3 px-3 py-2 rounded border border-orange-700 bg-orange-950/40 text-orange-400 text-[0.75rem] font-bold uppercase tracking-wider">
            ⚠ SPEED TEST: {toMMin(engine.cruiseSpeed()).toFixed(0)} m/min is beyond the knife's feasible {toMMin(engine.vFeasibleLine()).toFixed(0)} m/min — following error will grow until the axis faults.
          </div>
        )}

        <div className="flex gap-4 flex-wrap items-center">
          <div className="flex rounded border border-[#27272a] overflow-hidden">
            <button
              onClick={() => engine.setControlOn()}
              disabled={st.estop || st.guardOpen || st.controlOn}
              title={st.estop ? 'Interlocked: release E-Stop first' : st.guardOpen ? 'Interlocked: close the guard first' : 'Turn machine control on (safety check)'}
              className={`flex items-center gap-2 border-r border-[#27272a] px-[12px] py-[8px] text-[0.75rem] font-semibold uppercase transition-all
                ${st.controlOn
                  ? 'bg-green-950/60 text-green-400 cursor-default'
                  : st.estop || st.guardOpen
                    ? 'bg-[#09090b] text-zinc-600 cursor-not-allowed'
                    : 'bg-transparent text-[#22c55e] hover:bg-[#14532d] cursor-pointer'}`}
            >
              <span className={`w-3 h-3 rounded-full border ${st.controlOn ? 'bg-green-400 border-green-300 shadow-[0_0_8px_#4ade80]' : 'bg-green-950 border-green-800'}`}></span>
              Control On
            </button>
            <button
              onClick={() => engine.setControlOff()}
              disabled={!st.controlOn}
              title="Turn machine control off"
              className={`flex items-center gap-2 px-[12px] py-[8px] text-[0.75rem] font-semibold uppercase transition-all
                ${!st.controlOn ? 'bg-[#09090b] text-zinc-600 cursor-not-allowed' : 'bg-transparent text-[#ef4444] hover:bg-[#7f1d1d] cursor-pointer'}`}
            >
              Off
            </button>
          </div>

          <button
            onClick={() => engine.setRun(true)}
            disabled={!st.controlOn || st.running || st.guardOpen || st.knifeFault}
            title={!st.controlOn ? 'Interlocked: turn Control ON first' : st.knifeFault ? 'Interlocked: acknowledge the knife fault first' : st.guardOpen ? 'Interlocked: close the guard' : 'Start the line'}
            className={`border rounded px-[12px] py-[8px] text-[0.75rem] font-semibold uppercase transition-all
              ${!st.controlOn || st.running || st.guardOpen || st.knifeFault
                ? 'border-[#27272a] bg-[#09090b] text-zinc-600 cursor-not-allowed'
                : 'border-[#166534] bg-transparent text-[#22c55e] hover:bg-[#14532d] cursor-pointer'}`}
          >
            ▶ Start
          </button>

          <button
            onClick={() => engine.requestStop()}
            disabled={!st.running || st.stopReq}
            title="Graceful stop: brakes the line to standstill exactly on a knife park phase (blade out of the material). Use E-Stop for an instant halt."
            className={`border rounded px-[12px] py-[8px] text-[0.75rem] font-semibold uppercase transition-all
              ${!st.running || st.stopReq
                ? 'border-[#27272a] bg-[#09090b] text-zinc-600 cursor-not-allowed'
                : 'border-yellow-700 bg-transparent text-yellow-500 hover:bg-yellow-950/50 cursor-pointer'}`}
          >
            {st.stopReq ? '■ Stopping…' : '■ Stop'}
          </button>

          <button
            onClick={() => st.estop ? engine.releaseEStop() : engine.pressEStop()}
            title={st.estop ? 'Twist to release the E-Stop button' : 'Emergency stop: drive power off instantly (blade freezes where it is)'}
            className={`flex items-center gap-2 border-2 rounded-full px-[16px] py-[8px] text-[0.75rem] font-bold uppercase transition-all cursor-pointer
              ${st.estop
                ? 'border-red-500 bg-red-950 text-red-300 shadow-[0_0_10px_#ef444455]'
                : 'border-[#991b1b] bg-[#450a0a] text-[#ef4444] hover:bg-[#7f1d1d]'}`}
          >
            <span className="w-4 h-4 rounded-full bg-red-600 border-2 border-yellow-500"></span>
            {st.estop ? 'Latched — click to release' : 'E-Stop'}
          </button>

          <button
            onClick={() => engine.toggleGuard()}
            title="Knife guard door. Opening it while running trips an immediate safety stop."
            className={`border rounded px-[12px] py-[8px] text-[0.75rem] font-semibold uppercase transition-all cursor-pointer
              ${st.guardOpen
                ? 'border-orange-600 bg-orange-950/40 text-orange-400'
                : 'border-[#27272a] bg-[#09090b] text-zinc-300 hover:bg-[#27272a]'}`}
          >
            {st.guardOpen ? '◱ Guard OPEN' : '◼ Guard closed'}
          </button>

          <div className="flex items-center gap-1 ml-auto">
            <span className="text-[0.6rem] uppercase text-zinc-500 font-semibold mr-1">Slow-mo</span>
            {[0.05, 0.25, 0.5, 1].map(f => (
              <button key={f} onClick={() => { engine.slowMo = f; engine.notify(); }}
                className={`text-[0.7rem] font-bold px-2 py-1 rounded border cursor-pointer transition-all
                  ${engine.slowMo === f ? 'border-cyan-700 text-cyan-400 bg-cyan-950/30' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}>
                {f === 1 ? '1×' : (f * 100) + '%'}
              </button>
            ))}
            <button
              onClick={() => engine.reset()}
              title="Master reset: clears the machine AND the test statistics"
              className="ml-3 border border-[#27272a] bg-[#09090b] text-[#f4f4f5] text-[0.75rem] font-semibold uppercase px-[12px] py-[6px] rounded transition-all hover:bg-[#27272a] cursor-pointer">
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* Data block cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button onClick={() => setShowRecipe(true)}
          className="text-left bg-[#18181b] p-3 rounded-lg border border-[#27272a] hover:border-blue-800 transition-all cursor-pointer">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-[0.6rem] uppercase tracking-[0.05em] text-zinc-400 font-semibold flex items-center gap-2">
              <span className="w-1 h-3 bg-blue-500"></span>Recipe
            </h3>
            <span className="text-[0.6rem] text-blue-400 font-semibold uppercase">{st.running ? '🔒 view' : 'edit ✎'}</span>
          </div>
          <div className="text-sm font-mono font-bold text-blue-400 leading-tight truncate">
            {engine.recipe.name}
            {recipeDirty && <span className="ml-2 text-[0.6rem] text-yellow-500 font-semibold uppercase" title="Not stored in the recipe library — open the recipe to SAVE it">● unsaved</span>}
          </div>
          <div className="text-[10px] text-zinc-500 font-mono">
            {engine.recipe.len}mm · {toMMin(engine.recipe.spd).toFixed(0)}m/min · {engine.recipe.thick}mm thick · {engine.recipe.syncMode === 'comp' ? 'COMPENSATED' : 'k=' + (engine.recipe.ratio * 100).toFixed(1) + '%'}
          </div>
        </button>

        <button onClick={() => setShowParams(true)}
          className="text-left bg-[#18181b] p-3 rounded-lg border border-[#27272a] hover:border-yellow-800 transition-all cursor-pointer">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-[0.6rem] uppercase tracking-[0.05em] text-zinc-400 font-semibold flex items-center gap-2">
              <span className="w-1 h-3 bg-yellow-500"></span>Parameters
            </h3>
            <span className="text-[0.6rem] text-yellow-500 font-semibold uppercase">{st.running ? '🔒 view' : 'edit ✎'}</span>
          </div>
          <div className="text-[10px] text-zinc-400 font-mono mt-1 leading-relaxed">
            sync window {engine.params.syncDeg}° · out-feed ×{engine.params.outFac}
          </div>
        </button>

        <button onClick={() => setShowSettings(true)}
          className="text-left bg-[#18181b] p-3 rounded-lg border border-[#27272a] hover:border-zinc-600 transition-all cursor-pointer">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-[0.6rem] uppercase tracking-[0.05em] text-zinc-400 font-semibold flex items-center gap-2">
              <span className="w-1 h-3 bg-zinc-500"></span>Machine Config
            </h3>
            <span className="text-[0.6rem] font-semibold uppercase text-zinc-400">{st.controlOn ? '🔒 view' : 'edit ⚙'}</span>
          </div>
          <div className="text-[10px] text-zinc-500 font-mono mt-1 leading-relaxed">
            R{engine.config.knifeR} · {engine.config.knives} blade{engine.config.knives > 1 ? 's' : ''} · ωmax {engine.config.knifeWmax}rad/s · feasible {toMMin(engine.vFeasibleLine()).toFixed(0)}m/min
          </div>
        </button>
      </div>

      {showRecipe && <RecipeModal onClose={() => setShowRecipe(false)} />}
      {showParams && <ParamsModal onClose={() => setShowParams(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
