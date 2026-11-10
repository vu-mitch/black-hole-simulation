// Dual-filter upsample, added onto the next larger bloom level.
uniform sampler2D uSource;  // smaller level
uniform sampler2D uBase;    // level being written, before the glow is added
uniform vec2 uTexel;        // size of one source texel in uv

in vec2 vUv;
out vec4 outColor;

vec3 fetch(vec2 offset) {
  return decodeHdr(texture(uSource, vUv + uTexel * offset).rgb);
}

void main() {
  vec3 sum = fetch(vec2(-1.0, 0.0)) + fetch(vec2(1.0, 0.0)) + fetch(vec2(0.0, -1.0)) + fetch(vec2(0.0, 1.0));
  sum += 2.0 * (fetch(vec2(-0.5, -0.5)) + fetch(vec2(0.5, -0.5)) + fetch(vec2(-0.5, 0.5)) + fetch(vec2(0.5, 0.5)));
  vec3 base = decodeHdr(texture(uBase, vUv).rgb);
  outColor = vec4(encodeHdr(base + sum / 12.0), 1.0);
}
