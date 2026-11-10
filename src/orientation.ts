import { addScaled, cross, dot, normalize, scale, type Vec3 } from "./vec3";

/**
 * Orthonormal camera axes. Components are in the coordinate frame, which
 * coincides with the local free-fall frame; they describe where the ship's
 * right, up and forward point.
 */
export interface Orientation {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const spun = addScaled(scale(v, c), cross(axis, v), s);
  return addScaled(spun, axis, dot(axis, v) * (1 - c));
}

/** Look along `forward`, keeping the top of the view as close to `upHint` as possible. */
export function lookAlong(forward: Vec3, upHint: Vec3): Orientation {
  const f = normalize(forward);
  let side = cross(f, upHint);
  if (dot(side, side) < 1e-10) {
    side = cross(f, Math.abs(f[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  }
  const right = normalize(side);
  return { right, up: cross(right, f), forward: f };
}

/**
 * Turn the camera about its own axes. Positive yaw turns left, positive pitch
 * looks up and positive roll tips the view clockwise.
 */
export function turn(o: Orientation, yaw: number, pitch: number, roll: number): Orientation {
  let { right, up, forward } = o;
  if (yaw !== 0) {
    forward = rotateAbout(forward, up, yaw);
    right = rotateAbout(right, up, yaw);
  }
  if (pitch !== 0) {
    forward = rotateAbout(forward, right, pitch);
    up = rotateAbout(up, right, pitch);
  }
  if (roll !== 0) {
    right = rotateAbout(right, forward, -roll);
    up = rotateAbout(up, forward, -roll);
  }
  // Re-orthonormalise so rounding errors cannot accumulate over many frames.
  forward = normalize(forward);
  right = normalize(addScaled(right, forward, -dot(right, forward)));
  return { right, up: cross(right, forward), forward };
}
