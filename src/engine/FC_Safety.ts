import { SimulationEngine } from './SimulationEngine';

/**
 * FC10: Safety Chain (basic safety control functions)
 *
 * Evaluated FIRST in every OB1 scan, before any motion block — like the
 * safety program of a real machine. This deliberately minimal machine
 * has exactly three safety functions:
 *
 *   E-STOP     latching mushroom button. Pressing it drops the machine
 *              control instantly (drive power off, category 0 stop) —
 *              handled edge-triggered in SimulationEngine.pressEStop().
 *              This FC is the level-triggered backstop: while the button
 *              is latched, nothing may ever run.
 *   GUARD DOOR the knife drum is behind an interlocked guard. START is
 *              refused while the door is open, and opening the door
 *              while running trips an immediate safety stop (a rotary
 *              knife gets a category 0 stop — no graceful run-down with
 *              an open door).
 *   CONTROL ON software equivalent of the control voltage: without it,
 *              OB1 does not execute any motion block at all.
 *
 * A safety trip marks the production as non-resumable (needsReset): the
 * blade may have frozen inside the material, so the next Control-ON
 * clears and re-phases the machine.
 */
export function FC_Safety(db: SimulationEngine) {
  const st = db.state;

  // Safety chain open while the machine is running -> trip immediately.
  // Drive power gone: both axes halt where they are (blade possibly
  // inside the material — that is exactly what needsReset is for).
  if (st.running && (st.estop || st.guardOpen)) {
    db.safeStop(true);
    db.notify();
  }

  // E-Stop latched -> the machine control can never be on.
  if (st.estop && st.controlOn) {
    st.controlOn = false;
    db.notify();
  }
}
