import { useEffect, useState } from 'react';
import { engine } from '../engine/SimulationEngine';

export function useSimulationState() {
  const [stamp, setStamp] = useState(0);

  useEffect(() => {
    const unsubscribe = engine.subscribe(() => setStamp(s => s + 1));

    let lastTime = performance.now();
    let frameId: number;

    const loop = (time: number) => {
      let dt = (time - lastTime) / 1000;
      lastTime = time;
      if (dt > 0.05) dt = 0.05;
      engine.update(dt); // engine gates internally on controlOn/running
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);

    return () => {
      unsubscribe();
      cancelAnimationFrame(frameId);
    };
  }, []);

  return { engine, stamp };
}
