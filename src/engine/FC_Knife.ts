import { SimulationEngine } from './SimulationEngine';
import { camSetpoint } from './FB_Cam';

/**
 * FC31: Knife Axis (FOLLOWING AXIS / slave, cam-coupled)
 *
 * The rotary knife drive. Its position setpoint comes from the cam
 * (FB_Cam) evaluated at the CURRENT master position — this is the
 * software model of MC_CamIn on the S7-1500T: the knife has no time base
 * of its own, it is geared to the material through θ(φ).
 *
 * The axis is a real servo, not a perfect follower: it tracks the cam
 * setpoint with full setpoint feed-forward (velocity + acceleration, the
 * way an S7-1500T drive is commissioned), limited by the drive's ωmax
 * and αmax. As long as the cam demand stays inside the limits the
 * following error is negligible — even during line speed ramps — and
 * every cut is perfect; push the line speed beyond cam.vFeasible and
 * the axis SATURATES: the following error grows, cuts drift and skew,
 * and at config.folErrLimit the axis FAULTS like a real drive would.
 * That boundary is precisely what this test rig exists to measure.
 */
export function FC_Knife(db: SimulationEngine, dt: number) {
  const st = db.state;
  const cfg = db.config;

  // Network 1: Cam setpoint at the current master position.
  const sp = camSetpoint(db.cam, st.D - st.Dref);
  st.thetaSet = sp.theta;

  // Network 2: Servo tracking — exact discrete setpoint feed-forward
  // (close the remaining position error within one scan), saturated at
  // the drive limits. Below the limits the axis is dead-beat; above
  // them, physics says no and the error becomes visible in the cuts.
  const wDes = (st.thetaSet - st.theta) / dt;
  const wCmd = Math.max(-cfg.knifeWmax, Math.min(cfg.knifeWmax, wDes));
  const dwMax = cfg.knifeAmax * dt;
  st.omega += Math.max(-dwMax, Math.min(dwMax, wCmd - st.omega));
  st.theta += st.omega * dt;
  st.folErr = st.thetaSet - st.theta;

  // Network 3: Following-error monitor (drive fault, latching).
  if (Math.abs(st.folErr) > (cfg.folErrLimit * Math.PI) / 180) {
    db.safeStop(true);
    st.knifeFault = true;
    db.notify();
  }
}
