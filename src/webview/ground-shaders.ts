export const groundVertexShader = `
uniform mat4 u_VP;
uniform sampler2D u_heightMap;
uniform vec2 u_size;
uniform vec2 u_offset;
uniform bool u_extended[15];
uniform float u_baseTileset;

attribute vec2 a_position;
attribute float a_InstanceID;
attribute vec4 a_textures;
attribute vec4 a_variations;

varying vec4 v_tilesets;
varying vec2 v_uv[4];
varying float v_baseIncluded;

vec2 getCell(float variation) {
  if (variation < 16.0) {
    return vec2(mod(variation, 4.0), floor(variation / 4.0));
  }
  variation -= 16.0;
  return vec2(4.0 + mod(variation, 4.0), floor(variation / 4.0));
}

bool isExtended(float texture) {
  int index = int(texture - 0.6);
  if (index == 0) return u_extended[0];
  if (index == 1) return u_extended[1];
  if (index == 2) return u_extended[2];
  if (index == 3) return u_extended[3];
  if (index == 4) return u_extended[4];
  if (index == 5) return u_extended[5];
  if (index == 6) return u_extended[6];
  if (index == 7) return u_extended[7];
  if (index == 8) return u_extended[8];
  if (index == 9) return u_extended[9];
  if (index == 10) return u_extended[10];
  if (index == 11) return u_extended[11];
  if (index == 12) return u_extended[12];
  if (index == 13) return u_extended[13];
  if (index == 14) return u_extended[14];
  return false;
}

float textureForPass(float texture) {
  float localTexture = texture - u_baseTileset;
  if (localTexture > 0.5 && localTexture < 15.5) {
    return localTexture;
  }
  return 0.0;
}

vec2 getUV(vec2 position, float texture, float variation) {
  vec2 cell = getCell(variation);
  vec2 cellSize = vec2(isExtended(texture) ? 0.125 : 0.25, 0.25);
  vec2 uv = vec2(position.x, 1.0 - position.y);
  vec2 pixelSize = vec2(1.0 / 512.0, 1.0 / 256.0);
  return clamp((cell + uv) * cellSize, cell * cellSize + pixelSize, (cell + 1.0) * cellSize - pixelSize);
}

void main() {
  vec4 textures = vec4(
    textureForPass(a_textures[0]),
    textureForPass(a_textures[1]),
    textureForPass(a_textures[2]),
    textureForPass(a_textures[3])
  );

  if (textures[0] > 0.0 || textures[1] > 0.0 || textures[2] > 0.0 || textures[3] > 0.0) {
    v_tilesets = textures;
    v_baseIncluded = textures[0] > 0.5 ? 1.0 : 0.0;
    v_uv[0] = getUV(a_position, textures[0], a_variations[0]);
    v_uv[1] = getUV(a_position, textures[1], a_variations[1]);
    v_uv[2] = getUV(a_position, textures[2], a_variations[2]);
    v_uv[3] = getUV(a_position, textures[3], a_variations[3]);

    vec2 corner = vec2(mod(a_InstanceID, u_size.x), floor(a_InstanceID / u_size.x));
    vec2 base = corner + a_position;
    float height = texture2D(u_heightMap, base / u_size).a;
    gl_Position = u_VP * vec4(base * 128.0 + u_offset, height * 128.0, 1.0);
  } else {
    v_tilesets = vec4(0.0);
    v_baseIncluded = 0.0;
    v_uv[0] = vec2(0.0);
    v_uv[1] = vec2(0.0);
    v_uv[2] = vec2(0.0);
    v_uv[3] = vec2(0.0);
    gl_Position = vec4(0.0);
  }
}
`;

export const groundFragmentShader = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D u_tilesets[15];

varying vec4 v_tilesets;
varying vec2 v_uv[4];
varying float v_baseIncluded;

vec4 sampleTileset(float tileset, vec2 uv) {
  int index = int(tileset - 0.6);
  if (index == 0) return texture2D(u_tilesets[0], uv);
  if (index == 1) return texture2D(u_tilesets[1], uv);
  if (index == 2) return texture2D(u_tilesets[2], uv);
  if (index == 3) return texture2D(u_tilesets[3], uv);
  if (index == 4) return texture2D(u_tilesets[4], uv);
  if (index == 5) return texture2D(u_tilesets[5], uv);
  if (index == 6) return texture2D(u_tilesets[6], uv);
  if (index == 7) return texture2D(u_tilesets[7], uv);
  if (index == 8) return texture2D(u_tilesets[8], uv);
  if (index == 9) return texture2D(u_tilesets[9], uv);
  if (index == 10) return texture2D(u_tilesets[10], uv);
  if (index == 11) return texture2D(u_tilesets[11], uv);
  if (index == 12) return texture2D(u_tilesets[12], uv);
  if (index == 13) return texture2D(u_tilesets[13], uv);
  if (index == 14) return texture2D(u_tilesets[14], uv);
  return vec4(0.0);
}

vec4 composite(vec4 bottom, vec4 top) {
  float alpha = top.a + bottom.a * (1.0 - top.a);
  if (alpha <= 0.0) {
    return vec4(0.0);
  }
  vec3 rgb = (
    top.rgb * top.a + bottom.rgb * bottom.a * (1.0 - top.a)
  ) / alpha;
  return vec4(rgb, alpha);
}

void addLayer(inout vec4 color, float tileset, vec2 uv) {
  if (tileset > 0.5) {
    color = composite(color, sampleTileset(tileset, uv));
  }
}

void main() {
  vec4 color = vec4(0.0);

  if (v_baseIncluded > 0.5) {
    vec4 base = sampleTileset(v_tilesets[0], v_uv[0]);
    color = vec4(base.rgb, 1.0);
  } else {
    addLayer(color, v_tilesets[0], v_uv[0]);
  }

  addLayer(color, v_tilesets[1], v_uv[1]);
  addLayer(color, v_tilesets[2], v_uv[2]);
  addLayer(color, v_tilesets[3], v_uv[3]);
  gl_FragColor = color;
}
`;
