import { SimulationEngine } from './SimulationEngine';
import { commitStopDist } from './MotionProfile';

/**
 * FC30: Material Feed Axis (LEADING AXIS / master)
 *
 * The heart of the rotary knife principle: the material NEVER stops for
 * a cut. The feed axis runs continuously at the line speed; the knife
 * (following axis, FC_Knife) is position-coupled to it through the cam.
 * `D` is the feed encoder position in mm — the cam master value.
 *
 * The axis moves like a real servo motor with the configured motor data
 * (config.axVmax / axAmax / axJerk): velocity follows a jerk-limited
 * S-curve using the trajectory math ported from
 * Lehel4321/MotionProfileSolver (see MotionProfile.ts).
 *
 * GRACEFUL STOP: because the knife is cam-coupled to THIS axis, stopping
 * the line automatically stops the knife in sync — pieces cut during the
 * ramp-down still come out at exactly the recipe length (position cam!).
 * The only constraint is WHERE to stop: the line brakes to a standstill
 * exactly on a knife PARK phase (blade away from the material), computed
 * from the S-curve committed stopping distance.
 *
 * ENABLE GATING: no enable checks here — OB1 only calls this block while
 * the machine is running (CuttingMaschine convention).
 */
export function FC_Feeder(db: SimulationEngine, dt: number) {
  const A = db.config.axAmax;
  const J = db.config.axJerk;
  const st = db.state;
  const cam = db.cam;

  // Network 1: Velocity setpoint. Continuous line speed (capped at axis Vmax).
  let vt = db.cruiseSpeed();

  // Network 1b: Graceful stop — arm the park-phase brake target once.
  if (st.stopReq && !st.braking) {
    const dMin = commitStopDist(st.v, st.a, A, J);
    // Smallest park-phase position that is still reachable with an
    // S-curve brake: Dref + parkPhi + m·L  >=  D + dMin
    const m = Math.ceil((st.D + dMin - st.Dref - cam.parkPhi) / cam.L);
    st.brakeD = st.Dref + cam.parkPhi + m * cam.L;
    st.braking = true;
  }

  // Network 1c: Position-controlled braking to the park target.
  if (st.braking) {
    const rem = st.brakeD - st.D;
    if (rem <= 0.001) {
      vt = 0;
    } else if (commitStopDist(st.v, st.a, A, J) >= rem) {
      vt = 0; // committing to brake for the park target
    }
  }

  // Network 2: Jerk-limited velocity tracking (S-curve).
  // vSettle = velocity we would end at if accel were ramped to zero now;
  // steer the jerk so vSettle converges on the setpoint.
  const vSettle = st.v + (st.a * Math.abs(st.a)) / (2 * J);
  const jerk = vSettle < vt ? J : -J;
  st.a = Math.max(-A, Math.min(A, st.a + jerk * dt));
  st.v += st.a * dt;

  // Snap to the setpoint when within one scan's resolution (avoids
  // limit-cycle chatter around the target velocity).
  if (Math.abs(st.v - vt) <= Math.abs(st.a) * dt + J * dt * dt && Math.abs(st.a) <= 2 * J * dt) {
    st.v = vt;
    st.a = 0;
  }
  if (st.v < 0) { st.v = 0; st.a = 0; } // the line never runs backwards

  // Network 3: Advance the encoder position. While braking, never
  // overshoot the park target — the knife would leave its park position.
  let dD = st.v * dt;
  if (st.braking) dD = Math.min(dD, Math.max(0, st.brakeD - st.D));
  st.D += dD;

  // Network 4: Standstill on the park target reached -> machine idle.
  if (st.braking && st.v <= 0.001 && st.brakeD - st.D <= 0.05) {
    st.v = 0;
    st.a = 0;
    st.braking = false;
    st.stopReq = false;
    st.running = false;
    db.notify();
  }
}
