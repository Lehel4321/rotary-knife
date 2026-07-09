import { useState } from 'react';
import { useSimulationState } from './hooks/useSimulationState';
import { MachineCanvas } from './components/MachineCanvas';
import { Controls } from './components/Controls';
import { StatsBar } from './components/StatsBar';
import { CutLog } from './components/CutLog';
import { ScopePanel } from './components/ScopePanel';
import { CamPanel } from './components/CamPanel';

export default function App() {
  const [tab, setTab] = useState<'machine' | 'log'>('machine');
  const [showScope, setShowScope] = useState(false);
  const [showCam, setShowCam] = useState(true);

  useSimulationState(); // drives OB1 and binds components to engine updates

  const TabBtn = ({ id, label }: { id: 'machine' | 'log'; label: string }) => (
    <button
      className={`text-xs font-bold uppercase pb-1 cursor-pointer transition-colors ${tab === id ? 'text-yellow-500 border-b-2 border-yellow-500' : 'text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent'}`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  const ToggleBtn = ({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      className={`text-xs font-bold uppercase px-3 py-1.5 rounded transition-colors border ${on ? 'bg-yellow-500/20 text-yellow-500 border-yellow-500/50' : 'bg-transparent text-zinc-500 border-zinc-800 hover:text-zinc-300'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col min-h-screen bg-[#09090b] text-[#e4e4e7] font-sans">
      <header className="flex items-center justify-between px-6 py-4 border-b border-[#27272a] bg-[#09090b] flex-shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-yellow-500 rounded-sm"></div>
            <h1 className="text-lg font-bold tracking-tighter uppercase m-0">RotaryKnife <span className="text-zinc-500">SYNC v1.0</span></h1>
          </div>
          <div className="flex gap-4">
            <TabBtn id="machine" label="Simulation" />
            <TabBtn id="log" label="Cut log" />
          </div>
        </div>
        <div className="flex gap-3">
          <ToggleBtn on={showCam} label="Cam Profile" onClick={() => setShowCam(v => !v)} />
          <ToggleBtn on={showScope} label="Sync Scope" onClick={() => setShowScope(v => !v)} />
        </div>
      </header>

      <div className="flex-1 p-6 overflow-auto">
        {tab === 'machine' && (
          <div className="flex flex-col gap-4 mx-auto max-w-[1280px] relative">
            {showScope && <ScopePanel onClose={() => setShowScope(false)} />}
            <div className="relative h-[430px]">
              <MachineCanvas />
            </div>
            <StatsBar />
            {showCam && <CamPanel onClose={() => setShowCam(false)} />}
            <Controls />
          </div>
        )}

        {tab === 'log' && (
          <div className="mx-auto max-w-[1280px]">
            <CutLog />
          </div>
        )}
      </div>

      <footer className="px-4 py-2 bg-zinc-950 border-t border-zinc-900 flex justify-between items-center flex-shrink-0">
        <div className="flex gap-4 text-[10px] font-mono text-zinc-500">
          <span>NET: LOCAL_SIM</span>
          <span>PRINCIPLE: SIMATIC S7-1500T ROTARY KNIFE (LRK) · ENTRY-ID 109757260</span>
        </div>
        <div className="text-[10px] text-zinc-400 font-bold">
          OPERATOR: <span className="text-zinc-500">SYSTEM_ADMIN</span>
        </div>
      </footer>
    </div>
  );
}
