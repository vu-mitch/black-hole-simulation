// Dual-filter downsample. The first pass also keeps only the bright part of the image.
uniform sampler2D uSource;
uniform vec2 uTexel;       // size of one source texel in uv
uniform float uThreshold;  // > 0 on the first pass only

in vec2 vUv;
out vec4 outColor;

vec3 fetch(vec2 uv) {
  vec3 c = decodeHdr(texture(uSource, uv).rgb);
  if (uThreshold > 0.0) {
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float knee = max(luma - uThreshold, 0.0);
    c *= knee / (luma + 1e-4);
    // Tame single-pixel stars so they do not flicker through the mip chain.
    c /= 1.0 + 0.15 * luma;
  }
  return c;
}

void main() {
  vec3 sum = fetch(vUv) * 4.0;
  sum += fetch(vUv + uTexel * vec2(-1.0, -1.0));
  sum += fetch(vUv + uTexel * vec2(1.0, -1.0));
  sum += fetch(vUv + uTexel * vec2(-1.0, 1.0));
  sum += fetch(vUv + uTexel * vec2(1.0, 1.0));
  outColor = vec4(encodeHdr(sum / 8.0), 1.0);
}
