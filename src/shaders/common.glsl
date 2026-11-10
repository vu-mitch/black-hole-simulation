// Shared by all fragment shaders. Scene colours are HDR; when the browser cannot
// render to float textures (LDR_BUFFERS) they are squeezed into 8 bits instead.
#ifdef LDR_BUFFERS
const float HDR_RANGE = 16.0;
vec3 encodeHdr(vec3 c) { return sqrt(clamp(c / HDR_RANGE, 0.0, 1.0)); }
vec3 decodeHdr(vec3 c) { return c * c * HDR_RANGE; }
#else
vec3 encodeHdr(vec3 c) { return min(c, vec3(60000.0)); }
vec3 decodeHdr(vec3 c) { return c; }
#endif
