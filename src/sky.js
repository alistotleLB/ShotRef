/* ShotRef sky: cloud settings. Pure and import-free, so project.js can use cleanClouds. */
export const COVER = [['clear', 0, 'Clear'], ['few', 0.2, 'Few'], ['scattered', 0.42, 'Scattered'], ['mostly', 0.68, 'Mostly cloudy'], ['overcast', 1, 'Overcast']];
export const LOOKS = [['fluffy', 'Fluffy'], ['wispy', 'Wispy'], ['flat', 'Flat layer']];
export const DRIFTS = [['still', 'Still'], ['slow', 'Slow'], ['breezy', 'Breezy'], ['fast', 'Fast']];
export const CLOUDS_NEW = { cover: 0.2, look: 'fluffy', drift: 'slow', dir: 90, soft: 0.5, seed: 1 };
export const CLOUDS_NONE = { ...CLOUDS_NEW, cover: 0 };

/* the COVER key closest to a stored value */
export function nearestCover(cover) {
  const c = typeof cover === 'number' && Number.isFinite(cover) ? cover : 0;
  let best = COVER[0];
  for (const e of COVER) if (Math.abs(e[1] - c) < Math.abs(best[1] - c)) best = e;
  return best[0];
}

/* a repaired copy; anything missing or bad falls back field by field to CLOUDS_NONE */
export function cleanClouds(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}, D = CLOUDS_NONE;
  const num = (v, a, b, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d);
  const dir = typeof r.dir === 'number' && Number.isFinite(r.dir) ? ((r.dir % 360) + 360) % 360 : D.dir;
  return {
    cover: num(r.cover, 0, 1, D.cover),
    look: LOOKS.some(l => l[0] === r.look) ? r.look : D.look,
    drift: DRIFTS.some(d => d[0] === r.drift) ? r.drift : D.drift,
    dir,
    soft: num(r.soft, 0, 1, D.soft),
    seed: Math.round(num(r.seed, 1, 9999, D.seed)),
  };
}

/* ---- the sky dome: gradient, clouds, sun glow and drift, painted by one shader ----
   A unit sphere drawn at the far plane around whichever camera renders it (rotation only), so it never clips,
   ignores where the camera stands and reads as background (depth 1) in the depth of field pass.
   Clouds sit on a plane above the camera: a view direction d meets it at d.xz / d.y. */
/* how far the cloud plane slides per second of shot time, in cloud-plane units (one unit = the cloud height) */
const DRIFT_SPEED = { still: 0, slow: 0.012, breezy: 0.045, fast: 0.13 };
const LOOK_ID = { fluffy: 0, wispy: 1, flat: 2 };

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = `
uniform vec3 uTop, uMid, uHor, uLit, uShade, uSunCol, uSunDir;
uniform vec2 uWind, uDrift, uSeed;
uniform float uCover, uSoft, uLook, uNight;
varying vec3 vDir;

float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6); /* turns and doubles each octave, so the grid never lines up */
float fbm(vec2 p, int n) {
  float s = 0.0, a = 0.5, w = 0.0;
  for (int i = 0; i < 5; i++) { if (i >= n) break; s += a * vnoise(p); w += a; p = ROT * p + 17.0; a *= 0.5; }
  return s / w;
}
/* cloud density at a point of the cloud plane; spread so a threshold of 1 - cover covers about that much sky */
float density(vec2 q, int n) {
  if (uLook > 0.5 && uLook < 1.5) { vec2 side = vec2(-uWind.y, uWind.x); q = vec2(dot(q, uWind) * 0.25, dot(q, side) * 1.4); } /* wispy: long streaks along the wind */
  return clamp((fbm(q, n) - 0.5) * 2.3 + 0.5, 0.0, 1.0);
}

void main() {
  vec3 d = normalize(vDir);
  float el = clamp(asin(clamp(d.y, -1.0, 1.0)) / 1.5707963, 0.0, 1.0);
  vec3 col = el < 0.38 ? mix(uHor, uMid, smoothstep(0.0, 1.0, el / 0.38)) : mix(uMid, uTop, smoothstep(0.0, 1.0, (el - 0.38) / 0.62));
  float alpha = 0.0;
  if (uCover > 0.0 && d.y > 0.0) {
    vec2 plane = d.xz / (d.y + 0.08) - uDrift;
    vec2 q = plane * 0.75 + uSeed;
    float dn = density(q, 5), a, thick;
    if (uLook > 1.5) { /* flat layer: a near-continuous sheet, thicker as cover grows */
      a = mix(0.82, 1.0, dn) * smoothstep(0.0, 0.15, uCover) * mix(0.45, 1.0, uCover);
      thick = 0.35 + 0.45 * uCover * dn;
    } else {
      float s = 0.03 + uSoft * 0.25, th = mix(1.0 + s, -s, uCover);
      a = smoothstep(th - s, th + s, dn);
      thick = smoothstep(th, th + 0.45, dn);
      if (uLook > 0.5) { a *= 0.78; thick *= 0.5; }
    }
    /* light: denser toward the sun means this side is in the cloud's own shade */
    vec2 toSun = normalize(uSunDir.xz + vec2(1e-4));
    float lit = clamp(0.62 + (dn - density(q + toSun * 0.12, 3)) * 3.2, 0.0, 1.0);
    vec3 cc = mix(uShade, uLit, lit);
    cc = mix(cc, uShade, thick * 0.55);
    alpha = a * smoothstep(0.0, 0.18, d.y);
    col = mix(col, cc, alpha);
  }
  float sd = dot(d, uSunDir);
  if (uNight > 0.5) col += uSunCol * pow(max(sd, 0.0), 160.0) * 0.18 * (1.0 - alpha * 0.9); /* a faint moon glow */
  else {
    float disc = uSunDir.y < -0.02 ? 0.0 : smoothstep(0.9995, 0.9999, sd) * 3.0;
    float halo = pow(max(sd, 0.0), 12.0) * 0.35 + pow(max(sd, 0.0), 300.0) * 0.4;
    col += uSunCol * (disc + halo) * (1.0 - alpha * 0.9);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function makeSkyDome(THREE) {
  const C = v => new THREE.Color(v);
  const u = {
    uTop: { value: C() }, uMid: { value: C() }, uHor: { value: C() }, uLit: { value: C() }, uShade: { value: C() }, uSunCol: { value: C() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uWind: { value: new THREE.Vector2(1, 0) }, uDrift: { value: new THREE.Vector2() }, uSeed: { value: new THREE.Vector2() },
    uCover: { value: 0 }, uSoft: { value: 0.5 }, uLook: { value: 0 }, uNight: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.frustumCulled = false; mesh.renderOrder = -1; mesh.raycast = () => {}; mesh.name = 'skyDome';
  let clouds = cleanClouds(null), time = 0;
  const drift = () => { const k = (DRIFT_SPEED[clouds.drift] || 0) * time; u.uDrift.value.copy(u.uWind.value).multiplyScalar(k); };
  return {
    mesh,
    uniforms: u,
    /* any subset of { sky, clouds, sunDir, sunColor, night } */
    update(o) {
      if (o.sky != null) {
        const base = C(o.sky);
        u.uMid.value.copy(base); u.uTop.value.copy(base).multiplyScalar(0.72); u.uHor.value.copy(base).lerp(C('#ffffff'), 0.32);
      }
      if (o.night != null) u.uNight.value = o.night ? 1 : 0;
      if (o.sunColor != null || o.night != null || o.sky != null) {
        const night = u.uNight.value > 0.5;
        if (o.sunColor != null) u.uSunCol.value.set(o.sunColor);
        u.uLit.value.copy(night ? C('#2a3142').multiplyScalar(1.5) : C('#ffffff').lerp(u.uSunCol.value, 0.35));
        u.uShade.value.copy(night ? C('#2a3142') : u.uMid.value.clone().multiplyScalar(0.75));
      }
      if (o.sunDir) u.uSunDir.value.copy(o.sunDir).normalize();
      if (o.clouds) {
        clouds = cleanClouds(o.clouds);
        const a = clouds.dir * Math.PI / 180, s = clouds.seed;
        u.uWind.value.set(Math.sin(a), Math.cos(a)); /* the compass bearing the clouds drift toward, like the sun's direction */
        u.uSeed.value.set((s * 17.13) % 251, (s * 9.71) % 241);
        u.uCover.value = clouds.cover; u.uSoft.value = clouds.soft; u.uLook.value = LOOK_ID[clouds.look] || 0;
        drift();
      }
    },
    setTime(t) { time = Number.isFinite(t) ? t : 0; drift(); },
    get time() { return time; },
  };
}
