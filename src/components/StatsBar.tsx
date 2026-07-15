import { engine, toMMin } from '../engine/SimulationEngine';
import { gradeFace } from './MachineCanvas';

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return m + ':' + String(ss).padStart(2, '0');
}

/**
 * Test-campaign stats strip — the "how fast · how long · how exact"
 * numbers this rig exists for, live.
 */
export function StatsBar() {
  const st = engine.state;
  const stats = engine.getStats();
  const statusStr = st.estop ? 'E-STOP'
    : st.knifeFault ? 'KNIFE FAULT'
    : st.guardOpen ? 'Guard open'
    : !st.controlOn ? 'Control OFF'
    : !st.running ? 'Ready'
    : st.stopReq ? 'Stopping'
    : engine.penetrating ? 'Cutting'
    : 'Running';
  const stateColor = st.estop || st.knifeFault ? 'text-red-500'
    : !st.controlOn ? 'text-yellow-500'
    : st.running ? 'text-green-500' : 'text-zinc-300';

  const grade = stats.lastFace?.straight != null ? gradeFace(stats.lastFace.straight) : null;
  const overFeasible = engine.cruiseSpeed() > engine.vFeasibleLine() + 1e-9;

  const Tile = ({ label, value, cls, sub }: { label: string; value: string | number; cls?: string; sub?: string }) => (
    <div className="flex flex-col px-4 py-2 flex-1 min-w-[100px]">
      <span className="text-[0.58rem] uppercase tracking-wider text-[#71717a] font-semibold">{label}</span>
      <span className={`text-lg font-mono font-bold leading-tight ${cls || 'text-[#f4f4f5]'}`}>{value}</span>
      {sub && <span className="text-[0.6rem] font-mono text-zinc-500 leading-tight">{sub}</span>}
    </div>
  );

  return (
    <div className="flex flex-wrap items-stretch bg-[#18181b] border border-[#27272a] rounded-lg divide-x divide-[#27272a]">
      <Tile label="State" value={statusStr} cls={stateColor} />
      <Tile label="Line speed" value={toMMin(st.v).toFixed(1)} sub={'set ' + toMMin(engine.cruiseSpeed()).toFixed(0) + ' m/min'} cls={overFeasible ? 'text-orange-400' : 'text-blue-400'} />
      <Tile label="Max feasible" value={toMMin(engine.vFeasibleLine()).toFixed(0)} sub="m/min (knife limit)" cls="text-cyan-400" />
      <Tile label="Cuts" value={st.cuts} sub={st.trims + ' trim'} cls="text-green-500" />
      <Tile label="Rate" value={stats.rate > 0 ? stats.rate.toFixed(1) : engine.nominalRate().toFixed(1)} sub={stats.rate > 0 ? 'measured /min' : 'nominal /min'} cls="text-yellow-500" />
      <Tile label="Run time" value={fmtTime(st.runTime)} sub={(st.matCut / 1000).toFixed(1) + ' m cut'} />
      <Tile label="Length error" value={stats.last ? (stats.last.err >= 0 ? '+' : '') + stats.last.err.toFixed(3) : '—'} sub={stats.n > 1 ? 'σ ' + stats.stdErr.toFixed(3) + ' · max ' + stats.maxAbsErr.toFixed(3) : 'mm'} cls={stats.maxAbsErr > 0.5 ? 'text-orange-400' : 'text-green-400'} />
      <Tile label="Straightness" value={stats.lastFace?.straight != null ? stats.lastFace.straight.toFixed(3) : '—'} sub={grade ? grade.label + ' · max ' + stats.maxStraight.toFixed(2) : 'mm face deviation'} />
    </div>
  );
}
