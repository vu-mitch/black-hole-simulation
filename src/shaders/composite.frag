// Combines the scene with its glow, then exposes and tone-maps to the display.
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uFade;  // 0: normal, 1: fully black

in vec2 vUv;
out vec4 outColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 color = decodeHdr(texture(uScene, vUv).rgb);
  color += decodeHdr(texture(uBloom, vUv).rgb) * uBloomStrength;
  color = aces(color * uExposure);
  color = pow(color, vec3(1.0 / 2.2));

  vec2 centered = vUv - 0.5;
  color *= 1.0 - 0.35 * dot(centered, centered);
  color *= 1.0 - uFade;
  color += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(color, 1.0);
}
