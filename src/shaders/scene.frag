// Traces one backwards light ray per pixel through Schwarzschild spacetime.
// The optics mirror src/raytrace.ts, which is unit-tested; keep them in sync.

uniform vec2 uResolution;
uniform vec3 uPos;          // ship position, Gullstrand-Painleve Cartesian coordinates (r_s = 1)
uniform vec3 uVel;          // ship proper velocity relative to the local free-fall frame
uniform mat3 uCamera;       // columns: right, up, forward (ship rest frame)
uniform float uTanHalfFov;
uniform float uPixelAngle;  // angular size of one rendered pixel, radians
uniform vec4 uDiskPhase;    // xy: orbital time of the two blended disk layers, zw: their weights
uniform vec2 uDiskSeed;
uniform float uDiskEnabled;
uniform int uSkyMode;       // 0: stars, 1: coordinate grid
uniform int uMaxSteps;

out vec4 outColor;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

const float DISK_INNER = 3.0;        // innermost stable circular orbit
const float DISK_OUTER = 14.0;
const float DISK_TEMPERATURE = 4700.0;
const float DISK_BRIGHTNESS = 2.2;

const float U_PHOTON_SPHERE = 2.0 / 3.0;
const float BARRIER = 4.0 / 27.0;    // 1 / b_crit^2
const float MAX_ANGLE_STEP = 0.2;
const float RELATIVE_STEP = 0.2;
const float U_FLOOR = 0.05;
const int STEP_LIMIT = 256;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
        mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
        mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float fbm3(vec3 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * noise3(p);
    p = p * 2.03 + 17.1;
    amplitude *= 0.5;
  }
  return sum / 0.9375;
}

// Chromaticity of a black body, normalised to its brightest channel (linear RGB).
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  vec3 c;
  if (t <= 66.0) {
    c.r = 1.0;
    c.g = 0.39008157876 * log(t) - 0.63184144378;
    c.b = t <= 19.0 ? 0.0 : 0.54320678911 * log(t - 10.0) - 1.19625408914;
  } else {
    c.r = 1.29293618606 * pow(t - 60.0, -0.1332047592);
    c.g = 1.12989086089 * pow(t - 60.0, -0.0755148492);
    c.b = 1.0;
  }
  c = clamp(c, 0.0, 1.0);
  return c * c * (0.6 * c + 0.4);
}

// ---------------------------------------------------------------- sky

vec3 starLayer(vec3 dir, float cells, float seed, float density, float baseSize, float gain, float shift) {
  vec3 a = abs(dir);
  vec2 uv;
  float face;
  if (a.x >= a.y && a.x >= a.z) {
    uv = dir.yz / a.x;
    face = dir.x > 0.0 ? 0.0 : 1.0;
  } else if (a.y >= a.z) {
    uv = dir.zx / a.y;
    face = dir.y > 0.0 ? 2.0 : 3.0;
  } else {
    uv = dir.xy / a.z;
    face = dir.z > 0.0 ? 4.0 : 5.0;
  }
  vec2 grid = (uv * 0.5 + 0.5) * cells;
  vec2 id = floor(grid) + vec2(face * 211.0 + seed * 37.0, seed * 91.0);
  if (hash12(id) > density) return vec3(0.0);

  vec2 center = 0.2 + 0.6 * hash22(id + 11.7);
  // Cube-face coordinates stretch towards the corners; convert the offset back to an angle.
  vec2 delta = (fract(grid) - center) * (2.0 / cells) * pow(1.0 + dot(uv, uv), -0.75);
  float size = max(baseSize, 0.8 * uPixelAngle);
  float falloff = exp(-dot(delta, delta) / (size * size));
  float magnitude = pow(hash12(id + 3.3), 6.0);
  float kelvin = mix(2800.0, 12000.0, pow(hash12(id + 5.9), 1.6));
  // Keep the total flux when a star has to be drawn larger than it is.
  float flux = gain * (0.06 + magnitude) * (baseSize * baseSize) / (size * size);
  return blackbody(kelvin * shift) * (flux * falloff);
}

vec3 starSky(vec3 dir, float shift) {
  const vec3 galacticPole = vec3(0.3162, 0.8433, 0.4345);
  float latitude = dot(dir, galacticPole);
  float band = exp(-latitude * latitude * 12.0);

  vec3 color = starLayer(dir, 20.0, 1.0, 0.55, 0.0024, 9.0, shift);
  color += starLayer(dir, 64.0, 2.0, 0.5, 0.0017, 3.0, shift);
  color += starLayer(dir, 190.0, 3.0, 0.35 + 0.5 * band, 0.0012, 1.1, shift);

  float cloud = fbm3(dir * 3.1 + 4.0);
  float dust = fbm3(dir * 6.3 - 8.0);
  float glow = band * (0.25 + 1.5 * cloud * cloud) * mix(1.0, smoothstep(0.3, 0.62, dust), 0.8);
  vec3 warm = vec3(1.0, 0.78, 0.55);
  vec3 cool = vec3(0.5, 0.64, 1.0);
  vec3 milkyWay = mix(cool, warm, smoothstep(0.35, 0.7, fbm3(dir * 1.7 + 11.0))) * glow * 0.055;
  milkyWay += vec3(0.012, 0.014, 0.022) * (0.4 + cloud);
  // Tint the diffuse light the way a 6000 K spectrum would shift.
  color += milkyWay * blackbody(6000.0 * shift) / blackbody(6000.0);
  return color;
}

vec3 gridSky(vec3 dir) {
  float longitude = atan(dir.z, dir.x);
  float latitude = asin(clamp(dir.y, -1.0, 1.0));
  const float spacing = PI / 12.0;
  float cosLat = max(cos(latitude), 1e-3);
  float width = max(1.5 * uPixelAngle, 0.004);
  float dLon = abs(fract(longitude / spacing + 0.5) - 0.5) * spacing * cosLat;
  float dLat = abs(fract(latitude / spacing + 0.5) - 0.5) * spacing;
  float line = 1.0 - smoothstep(0.5 * width, width, min(dLon, dLat));
  vec2 cell = floor(vec2(longitude, latitude) / spacing);
  float checker = mod(cell.x + cell.y, 2.0);
  vec3 base = 0.5 + 0.5 * dir;
  return base * mix(0.1, 0.2, checker) + vec3(0.85) * line;
}

vec3 sky(vec3 dir, float energyAtInfinity) {
  // Photons arrive with 1 / E_inf times the energy they had far away.
  float shift = 1.0 / energyAtInfinity;
  float intensity = min(shift * shift * shift * shift, 400.0);
  if (uSkyMode == 1) return gridSky(dir) * min(intensity, 6.0);
  return starSky(dir, shift) * intensity;
}

// ---------------------------------------------------------------- accretion disk

// Value noise that wraps around in y with the given period.
float ringNoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, period);
  float y1 = mod(i.y + 1.0, period);
  return mix(
    mix(hash12(vec2(i.x, y0)), hash12(vec2(i.x + 1.0, y0)), f.x),
    mix(hash12(vec2(i.x, y1)), hash12(vec2(i.x + 1.0, y1)), f.x),
    f.y);
}

float diskNoise(float r, float angle, float seed) {
  float turns = angle / TAU;
  float sum = 0.0;
  float amplitude = 0.5;
  float radial = 1.7;
  float azimuthal = 5.0;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * ringNoise(vec2(r * radial + seed * 19.0 + float(i) * 7.0, turns * azimuthal), azimuthal);
    radial *= 2.1;
    azimuthal *= 2.0;
    amplitude *= 0.5;
  }
  return sum / 0.9375;
}

// Returns premultiplied emission in rgb and opacity in a.
vec4 shadeDisk(vec3 hit, float r, float energyAtInfinity, float axialAngularMomentum) {
  float x = r / DISK_INNER;
  // Thin-disk temperature profile, normalised to its peak.
  float profile = pow(x, -0.75) * pow(max(1.0 - inversesqrt(x), 0.0), 0.25) / 0.488;

  // Gas on circular geodesics about +y: angular velocity omega, time dilation ut.
  float omega = sqrt(0.5 / (r * r * r));
  float ut = inversesqrt(1.0 - 1.5 / r);
  float shift = 1.0 / (ut * max(energyAtInfinity - omega * axialAngularMomentum, 1e-4));

  float angle = atan(hit.z, hit.x);
  float n1 = diskNoise(r, angle + omega * uDiskPhase.x, uDiskSeed.x);
  float n2 = diskNoise(r, angle + omega * uDiskPhase.y, uDiskSeed.y);
  vec2 w = uDiskPhase.zw;
  float n = clamp(0.5 + ((n1 - 0.5) * w.x + (n2 - 0.5) * w.y) * inversesqrt(dot(w, w)), 0.0, 1.0);

  float edges = smoothstep(DISK_INNER, DISK_INNER * 1.06, r) * (1.0 - smoothstep(DISK_OUTER * 0.5, DISK_OUTER, r));
  float alpha = clamp(edges * (0.3 + 0.9 * smoothstep(0.2, 0.8, n)), 0.0, 0.97);

  float temperature = profile * shift;
  float power = temperature * temperature;
  vec3 emission = blackbody(DISK_TEMPERATURE * temperature) * (power * power * DISK_BRIGHTNESS * (0.35 + 1.3 * n * n));
  return vec4(emission * alpha, alpha);
}

// ---------------------------------------------------------------- light paths

// One Runge-Kutta step of u'' = u (3/2 u - 1), u = r_s / r, in the orbit angle.
vec2 advanceOrbit(vec2 s, float h) {
  float a1 = s.x * (1.5 * s.x - 1.0);
  float u2 = s.x + 0.5 * h * s.y;
  float d2 = s.y + 0.5 * h * a1;
  float a2 = u2 * (1.5 * u2 - 1.0);
  float u3 = s.x + 0.5 * h * d2;
  float d3 = s.y + 0.5 * h * a2;
  float a3 = u3 * (1.5 * u3 - 1.0);
  float u4 = s.x + h * d3;
  float d4 = s.y + h * a3;
  float a4 = u4 * (1.5 * u4 - 1.0);
  return vec2(
    s.x + (h / 6.0) * (s.y + 2.0 * d2 + 2.0 * d3 + d4),
    s.y + (h / 6.0) * (a1 + 2.0 * a2 + 2.0 * a3 + a4));
}

vec3 tracePixel(vec3 d) {
  // Aberration from the ship frame into the free-fall frame, then the river flow.
  float gamma = sqrt(1.0 + dot(uVel, uVel));
  float pd = dot(uVel, d);
  float k0 = gamma - pd;
  vec3 D = d + uVel * (pd / (gamma + 1.0) - 1.0);
  float r0 = length(uPos);
  vec3 e1 = uPos / r0;
  float beta = inversesqrt(r0);
  float energyAtInfinity = k0 + beta * dot(D, e1);
  // Light with non-positive energy at infinity never came from our universe.
  if (energyAtInfinity <= 0.0) return vec3(0.0);

  vec3 angularMomentum = cross(uPos, -D);
  vec3 v = normalize(D + e1 * (beta * k0));
  float cosA = dot(v, e1);
  vec3 tangent = v - e1 * cosA;
  float sinA = length(tangent);
  if (sinA < 1e-5) return cosA > 0.0 ? sky(v, energyAtInfinity) : vec3(0.0);
  vec3 e2 = tangent / sinA;

  float u = 1.0 / r0;
  float du = -u * cosA / sinA;
  float invImpactSq = energyAtInfinity * energyAtInfinity / dot(angularMomentum, angularMomentum);
  bool escapes = u < U_PHOTON_SPHERE
    ? (du <= 0.0 || invImpactSq < BARRIER)
    : (du < 0.0 && invImpactSq > BARRIER);

  bool disk = uDiskEnabled > 0.5;
  // Captured rays starting inside the disk's inner edge only move inward.
  if (!escapes && (!disk || r0 < DISK_INNER)) return vec3(0.0);

  // The height above the disk plane varies as cos(phi - phi0) along the orbit.
  float nextCrossing = 1e9;
  if (disk && abs(e1.y) + abs(e2.y) > 1e-6) {
    float quarter = atan(e2.y, e1.y) + 0.5 * PI;
    nextCrossing = quarter - PI * floor(quarter / PI);
    if (nextCrossing < 1e-4) nextCrossing += PI;
  }

  vec3 color = vec3(0.0);
  float transmittance = 1.0;
  float phi = 0.0;
  bool reachedInfinity = false;
  for (int i = 0; i < STEP_LIMIT; i++) {
    if (i >= uMaxSteps) break;
    float h = min(MAX_ANGLE_STEP, RELATIVE_STEP * max(u, U_FLOOR) / max(abs(du), 1e-9));
    if (phi + h >= nextCrossing) {
      float uCross = advanceOrbit(vec2(u, du), nextCrossing - phi).x;
      if (uCross > 0.0) {
        float r = 1.0 / uCross;
        if (r > DISK_INNER && r < DISK_OUTER) {
          vec3 hit = (e1 * cos(nextCrossing) + e2 * sin(nextCrossing)) * r;
          vec4 layer = shadeDisk(hit, r, energyAtInfinity, angularMomentum.y);
          color += transmittance * layer.rgb;
          transmittance *= 1.0 - layer.a;
        }
      }
      nextCrossing += PI;
    }
    vec2 next = advanceOrbit(vec2(u, du), h);
    phi += h;
    if (next.x <= 0.0) {
      // u = 0 is infinity; step back along the asymptote to the exact zero.
      phi -= atan(next.x / next.y);
      reachedInfinity = true;
      break;
    }
    u = next.x;
    du = next.y;
    if (du > 0.0 && (u >= 1.0 || (!escapes && u * DISK_INNER > 1.0))) break;
    if (transmittance < 0.01) break;
  }

  if (escapes && transmittance >= 0.01) {
    // Rays that run out of steps circle the photon sphere; any sky direction will do there.
    vec3 dir = e1 * cos(phi) + e2 * sin(phi);
    color += transmittance * sky(dir, energyAtInfinity) * (reachedInfinity ? 1.0 : 0.5);
  }
  return color;
}

void main() {
  vec2 ndc = (2.0 * gl_FragCoord.xy - uResolution) / uResolution.y;
  vec3 d = normalize(uCamera * vec3(ndc * uTanHalfFov, 1.0));
  vec3 color = tracePixel(d);
  // Guard the bloom chain against NaNs from degenerate rays.
  if (any(isnan(color)) || any(isinf(color))) color = vec3(0.0);
  // Keep one hot pixel from blooming across the whole shadow.
  color = min(color, vec3(14.0));
  outColor = vec4(encodeHdr(color), 1.0);
}
