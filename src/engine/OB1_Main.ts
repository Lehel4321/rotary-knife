import { SimulationEngine } from './SimulationEngine';
import { FC_Safety } from './FC_Safety';
import { FC_Feeder } from './FC_Feeder';
import { FC_Knife } from './FC_Knife';
import { FC_Cut } from './FC_Cut';
import { FC_Outfeed } from './FC_Outfeed';

/**
 * OB1: Main Cyclic Execution Block
 *
 * Runs with a FIXED scan time of 1 ms (SCAN_TIME) — SimulationEngine
 * converts real frame time into N fixed scans, so the machine behaves
 * identically on any monitor refresh rate (CuttingMaschine convention).
 *
 * Block call order matters and mirrors a real motion PLC cycle:
 *   1. FC_Safety   safety chain first — before anything may move
 *   2. FC_Feeder   LEADING axis: advance the material (master value)
 *   3. FC_Knife    FOLLOWING axis: evaluate the cam at the NEW master
 *                  position and track it (the MC_CamIn of this machine)
 *   4. FC_Cut      cut event detection + cut face recording
 *   5. FC_Outfeed  transport the cut pieces away
 *   6. Scope       1 kHz signal recording for the sync scope
 */
export function OB1_CyclicUpdate(db: SimulationEngine, dt: number) {
  // Network 1: Safety chain (level-triggered backstop)
  FC_Safety(db);

  // Safety gate: without machine control (Control-ON) nothing moves.
  if (!db.state.controlOn) return;
  if (!db.state.running) return;

  // Network 2: Machine time (only advances while producing — this is the
  // "how long have we been cutting" counter of the test campaign)
  db.state.simTime += dt;
  db.state.runTime += dt;

  // Network 3: Motion — master first, then the cam-coupled slave
  FC_Feeder(db, dt);
  FC_Knife(db, dt);

  // Network 4: Process — cutting and transport
  FC_Cut(db);
  FC_Outfeed(db, dt);

  // Network 5: Scope recording (1 sample per scan = 1 kHz)
  db.pushScope();
}
