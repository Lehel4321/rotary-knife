import { engine, toMMin } from '../engine/SimulationEngine';
import { gradeFace } from './MachineCanvas';

/**
 * Cut log — every cut of the test campaign with its quality numbers.
 * Export as CSV to keep the measurement series of a test run.
 */
export function CutLog() {
  const rows = [...engine.log].reverse();
  const stats = engine.getStats();

  const exportCsv = () => {
    const head = 'n,t_s,len_mm,err_mm,straightness_mm,skew_mm,drag_mm,folErrMax_deg,vLine_mm_s,trim';
    const body = engine.log.map(r =>
      [r.n, r.t.toFixed(3), r.len.toFixed(4), r.err.toFixed(4),
       r.straight?.toFixed(4) ?? '', r.skew?.toFixed(4) ?? '', r.drag?.toFixed(4) ?? '',
       r.folErrMax.toFixed(4), r.vLine.toFixed(1), r.trim ? 1 : 0].join(','));
    const blob = new Blob([head + '\n' + body.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rotary-knife-test_${engine.recipe.name}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="bg-[#18181b] border border-[#27272a] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[0.65rem] uppercase tracking-[0.05em] text-[#71717a] font-semibold">
          Cut log — {stats.n} cuts · mean err {stats.meanErr.toFixed(3)}mm · σ {stats.stdErr.toFixed(3)}mm · mean straightness {stats.meanStraight.toFixed(3)}mm
        </h3>
        <button onClick={exportCsv}
          className="border border-[#27272a] bg-[#09090b] text-[#f4f4f5] text-[0.7rem] font-semibold uppercase px-3 py-1.5 rounded hover:bg-[#27272a] transition-all cursor-pointer">
          ⤓ Export CSV
        </button>
      </div>
      <div className="overflow-auto max-h-[480px]">
        <table className="w-full text-[0.75rem] font-mono">
          <thead className="text-zinc-500 text-[0.65rem] uppercase sticky top-0 bg-[#18181b]">
            <tr className="text-left">
              <th className="py-1 pr-3">#</th>
              <th className="py-1 pr-3">t [s]</th>
              <th className="py-1 pr-3">length [mm]</th>
              <th className="py-1 pr-3">error [mm]</th>
              <th className="py-1 pr-3">straightness [mm]</th>
              <th className="py-1 pr-3">skew [mm]</th>
              <th className="py-1 pr-3">drag [mm]</th>
              <th className="py-1 pr-3">fol.err max [°]</th>
              <th className="py-1 pr-3">line [m/min]</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const g = r.straight != null ? gradeFace(r.straight) : null;
              return (
                <tr key={r.n} className={`border-t border-[#27272a] ${r.trim ? 'text-zinc-600' : 'text-zinc-300'}`}>
                  <td className="py-1 pr-3">{r.n}{r.trim && <span className="text-orange-400 ml-1">TRIM</span>}</td>
                  <td className="py-1 pr-3">{r.t.toFixed(2)}</td>
                  <td className="py-1 pr-3">{r.len.toFixed(3)}</td>
                  <td className={`py-1 pr-3 ${Math.abs(r.err) > 0.5 ? 'text-orange-400' : 'text-green-400'}`}>{(r.err >= 0 ? '+' : '') + r.err.toFixed(3)}</td>
                  <td className="py-1 pr-3" style={{ color: g?.color }}>{r.straight != null ? r.straight.toFixed(3) : '…'}</td>
                  <td className="py-1 pr-3">{r.skew != null ? (r.skew >= 0 ? '+' : '') + r.skew.toFixed(3) : '…'}</td>
                  <td className="py-1 pr-3">{r.drag != null ? r.drag.toFixed(3) : '…'}</td>
                  <td className={`py-1 pr-3 ${r.folErrMax > engine.config.folErrLimit * 0.5 ? 'text-orange-400' : ''}`}>{r.folErrMax.toFixed(3)}</td>
                  <td className="py-1 pr-3">{toMMin(r.vLine).toFixed(1)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="py-6 text-center text-zinc-600">No cuts yet — start the machine.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
