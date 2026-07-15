import { useEffect, useState } from 'react';
import { engine } from '../engine/SimulationEngine';

export function useSimulationState() {
  const [, setStamp] = useState(0);

  useEffect(() => {
    // Coalesced UI refresh: engine notify events set a dirty flag that is
    // flushed once per animation frame, plus a ~150 ms heartbeat while
    // the machine runs — the live tiles (line speed, run time, follow
    // error) must never freeze between cut events on long pieces.
    let dirty = false;
    const unsubscribe = engine.subscribe(() => { dirty = true; });

    let lastTime = performance.now();
    let lastUi = 0;
    let frameId: number;

    const loop = (time: number) => {
      let dt = (time - lastTime) / 1000;
      lastTime = time;
      if (dt > 0.05) dt = 0.05;
      engine.update(dt); // engine gates internally on controlOn/running

      if (dirty || (engine.state.running && time - lastUi > 150)) {
        dirty = false;
        lastUi = time;
        setStamp(s => s + 1);
      }
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);

    return () => {
      unsubscribe();
      cancelAnimationFrame(frameId);
    };
  }, []);

  return { engine };
}
