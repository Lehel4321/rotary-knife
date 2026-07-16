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
  const vPrev = st.v; // for trapezoidal position integration (Network 3)

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
    st.stopCommit = false;
  }

  // Network 1c: Position-controlled braking to the park target. The
  // moment the committed stopping distance covers what is left, the stop
  // LATCHES (stopCommit) and the ramp runs through to standstill in one
  // clean S-curve — bang-bang re-acceleration near the target would end
  // the ramp overbraked and spike the jerk.
  if (st.braking) {
    if (!st.stopCommit && commitStopDist(st.v, st.a, A, J) >= st.brakeD - st.D) {
      st.stopCommit = true;
    }
    if (st.stopCommit) vt = 0;
  }

  // Network 2: Jerk-limited velocity tracking (S-curve). Bang-bang jerk
  // with one-step lookahead, plus a FRACTIONAL jerk step on the crossing
  // scan: the settle velocity (velocity reached after ramping the
  // acceleration to zero) is placed EXACTLY on the setpoint, and from
  // then on the unwind branch conserves it scan by scan — trapezoidal
  // integration conserves settle along constant jerk exactly — so the
  // axis rides the analytic S-curve parabola into every setpoint instead
  // of quantizing the jerk flip to whole scans (which drifted the ramp
  // ~0.7 % off the MotionProfileSolver profile and landed brake ramps
  // millimeters off the committed stopping distance).
  if (st.v !== vt || st.a !== 0) {
    const settleAfter = (v: number, a: number) => v + (a * Math.abs(a)) / (2 * J);
    const aUp = Math.min(A, st.a + J * dt);
    const vUp = st.v + ((st.a + aUp) / 2) * dt;
    const aDn = Math.max(-A, st.a - J * dt);
    const vDn = st.v + ((st.a + aDn) / 2) * dt;
    if (settleAfter(vUp, aUp) <= vt) {
      // building toward the target (or easing off an overbraked state)
      st.a = aUp;
      st.v = vUp;
    } else if (settleAfter(vDn, aDn) >= vt) {
      // unwinding toward the target — conserves settle once it equals vt
      st.a = aDn;
      st.v = vDn;
    } else {
      // Crossing scan: both full steps straddle the setpoint. Solve the
      // fractional target acceleration a' with settleAfter(v', a') = vt:
      //   a' ≥ 0:  a'² + J·dt·a' + 2J(v + a·dt/2 − vt) = 0
      //   a' ≤ 0:  a'² − J·dt·a' − 2J(v + a·dt/2 − vt) = 0
      const B = J * dt;
      const K = 2 * J * (st.v + (st.a * dt) / 2 - vt);
      let aNew = st.v + (st.a * dt) / 2 <= vt
        ? (-B + Math.sqrt(B * B - 4 * K)) / 2
        : (B - Math.sqrt(B * B + 4 * K)) / 2;
      aNew = Math.max(Math.max(-A, st.a - B), Math.min(Math.min(A, st.a + B), aNew));
      st.v += ((st.a + aNew) / 2) * dt;
      st.a = aNew;
    }
    // Snap onto the setpoint at ramp end (float dust only — the
    // fractional step already lands the profile on vt analytically).
    if (Math.abs(st.v - vt) <= J * dt * dt && Math.abs(st.a) <= 1.001 * J * dt) {
      st.v = vt;
      st.a = 0;
    }
    if (st.v < 0) { st.v = 0; st.a = 0; } // the line never runs backwards
  }

  // Network 3: Advance the encoder position — trapezoidal, consistent
  // with the velocity integration (a rectangle rule here under-travels
  // every brake ramp by v·dt/2, which is millimeters at high line
  // speed). While braking, never overshoot the park target — the knife
  // would leave its park position.
  let dD = ((vPrev + st.v) / 2) * dt;
  if (st.braking) dD = Math.min(dD, Math.max(0, st.brakeD - st.D));
  st.D += dD;
  st.matCut += dD; // campaign total, survives clearSequence (like runTime)

  // Network 4: Standstill reached -> machine idle. STANDSTILL is the
  // completion condition, not the park position: the discrete brake ramp
  // may land a few mm short of brakeD at high line speed (up to ~v·dt/2
  // integration deficit — 3.2 mm at 180 m/min), which is still well
  // inside the park region (< 0.2° of knife angle per mm). Gating on a
  // tight position tolerance instead deadlocks the stop: v = 0 short of
  // target and the latched ramp can never close the gap.
  if (st.braking && st.stopCommit && st.v <= 0.001) {
    st.v = 0;
    st.a = 0;
    st.braking = false;
    st.stopCommit = false;
    st.stopReq = false;
    st.running = false;
    db.notify();
  }
}
