import { SimulationEngine } from './SimulationEngine';

/**
 * FC34: Out-feed Belt
 *
 * Runs slightly FASTER than the line (params.outFac × line speed): the
 * moment a piece is cut off, the belt pulls it away and a visible gap
 * opens between the pieces — like the speed-up belt after the knife on
 * a real converting line (there is no kerf: a shear cut against the
 * anvil removes no material, so without the speed-up the pieces would
 * travel butted together).
 */
export function FC_Outfeed(db: SimulationEngine, dt: number) {
  const outV = db.cruiseSpeed() * db.params.outFac;
  for (const p of db.pieces) p.left += outV * dt;
  // Purge pieces that have left the visible machine area
  if (db.pieces.length > 0 && db.pieces[0].left > 2500) db.pieces.shift();
  while (db.pieces.length > 40) db.pieces.shift();
}
