import * as THREE from 'three';
import { CONFIG, LOCATIONS } from '../config/game';
import type { Vec3, WaterArea, WaterfallArea } from '../core/types';

/** One immutable triangulated heightfield drives both rendering and collision. */
export const TERRAIN_STEP = 2;
export const TERRAIN_EXTENT = 224;
const CELLS = TERRAIN_EXTENT * 2 / TERRAIN_STEP;
const STRIDE = CELLS + 1;
const heights = new Float32Array(STRIDE * STRIDE);
const clamp = THREE.MathUtils.clamp;
const smooth = (a: number, b: number, value: number): number => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export interface LakeDefinition { x: number; z: number; rx: number; rz: number; level: number; depth: number; current?: Vec3; }
// The eastern Rillstep reach stays well outside every central story corridor.
export const RIVER: Readonly<WaterArea> = { minX: 106, maxX: 110, minZ: 8, maxZ: 32, level: 13, depth: 1.6, current: [0, 0, 1.35] };
export const CASCADE: Readonly<WaterfallArea> = { minX: 106, maxX: 110, minZ: 32, maxZ: 32, minY: 5, maxY: 13, axis: 'z' };
export const LAKES: readonly LakeDefinition[] = [
  { x: -35, z: 46, rx: 16, rz: 11, level: 9.4, depth: 5.2 },
  { x: 88, z: -10, rx: 11, rz: 8, level: 8, depth: 4 },
  { x: 108, z: 8, rx: 7, rz: 7, level: RIVER.level, depth: 2.4, current: [0, 0, 0.35] },
  { x: 108, z: 42, rx: 12, rz: 12, level: CASCADE.minY, depth: 3.8, current: [0, 0, 0.45] },
];
export const SNOW_PATH: readonly Vec3[] = [[-26, 10.5, -30], [-40, 21, -41], [-48, 21, -40], [-55, 24, -53], [-66, 27, -60]];
const anchorHeight: Record<string, number> = {
  chamber: 22, outlook: 20, elder: 12, tower: 8, magnet: 11, bomb: 10,
  stasis: 14, ice: 27, temple: 12, camp1: 10, camp2: 12, camp3: 10, cabin: 21,
};
const anchorRadius: Record<string, number> = {
  chamber: 11, outlook: 4, elder: 7, tower: 17, magnet: 9, bomb: 9,
  stasis: 9, ice: 10, temple: 15, camp1: 11, camp2: 11, camp3: 11, cabin: 8,
};

export function isColdTerrain(x: number, z: number): boolean { return x < -38 && z < -38; }

function rawHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  let y = 7.5 + Math.sin(x * 0.033) * 2.4 + Math.cos(z * 0.042) * 2.2
    + Math.sin((x + z) * 0.076) * 0.8 + Math.cos((x - z) * 0.019) * 2;
  y += 14 * Math.exp(-((x / 42) ** 2 + ((z - 110) / 33) ** 2));
  const cold = smooth(-30, -78, x) * smooth(-30, -76, z);
  y += cold * (21 + 3 * Math.sin(x * 0.09) * Math.cos(z * 0.07));
  for (const [key, elevation] of Object.entries(anchorHeight)) {
    const p = LOCATIONS[key].position;
    const d = Math.hypot(x - p[0], z - p[2]);
    const inner = anchorRadius[key];
    y = THREE.MathUtils.lerp(y, elevation, 1 - smooth(inner, inner + 10, d));
  }
  // A gentle footpath reaches the cabin's southern doorway. Blending two flat
  // landmark shelves alone created a steep ring across the marked approach.
  // Bake this ramp into the same heightfield used by visuals and collision.
  let rampDistance = Infinity, rampHeight = y;
  for (let i = 1; i < SNOW_PATH.length; i++) {
    const a = SNOW_PATH[i - 1]!, b = SNOW_PATH[i]!;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const t = clamp(((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz), 0, 1);
    const distance = Math.hypot(x - a[0] - dx * t, z - a[2] - dz * t);
    if (distance < rampDistance) { rampDistance = distance; rampHeight = THREE.MathUtils.lerp(a[1], b[1], t); }
  }
  if (rampDistance < 5) y = THREE.MathUtils.lerp(y, rampHeight, 1 - smooth(1.8, 5, rampDistance));
  // A genuinely level room and short corridor; the only obstacle is the tutorial ledge.
  const roomDistance = Math.max(Math.abs(x) - 9, Math.abs(z - 104) - 14, 0);
  if (Math.abs(x) < 17 && z > 82 && z < 126) {
    y = THREE.MathUtils.lerp(y, 22, 1 - smooth(0, 7, roomDistance));
  }
  for (const lake of LAKES) {
    const d = Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz);
    if (d < 1.3) {
      const bed = lake.level - lake.depth + smooth(0.22, 1.03, d) * (lake.depth - 0.12);
      y = THREE.MathUtils.lerp(bed, y, smooth(1.0, 1.3, d));
    }
  }
  // A narrow incised channel on an elevated shelf. The last grid cell drops behind the vertical curtain.
  if (z > RIVER.minZ && z < CASCADE.minZ) {
    const side = Math.abs(x - (RIVER.minX + RIVER.maxX) / 2);
    const halfWidth = (RIVER.maxX - RIVER.minX) / 2;
    const influence = (1 - smooth(halfWidth + 1, halfWidth + 7, side)) * smooth(RIVER.minZ + 2, RIVER.minZ + 8, z);
    const bed = RIVER.level - RIVER.depth + smooth(0, halfWidth, side) * (RIVER.depth + 0.1);
    y = THREE.MathUtils.lerp(y, bed, influence);
  }
  const edge = CONFIG.radius + 2.2 * Math.sin(Math.atan2(z, x) * 9);
  const cliff = smooth(edge - 5, edge + 8, r);
  const valley = -48 + Math.sin(x * 0.06) * 3 + Math.cos(z * 0.051) * 4;
  y = THREE.MathUtils.lerp(y, valley, cliff);
  return y;
}
for (let z = 0; z <= CELLS; z++) {
  for (let x = 0; x <= CELLS; x++) {
    heights[z * STRIDE + x] = rawHeight(x * TERRAIN_STEP - TERRAIN_EXTENT, z * TERRAIN_STEP - TERRAIN_EXTENT);
  }
}

/** Feet height, world +Y; interpolation follows the rendered SW–NE cell diagonal exactly. */
export function terrainHeight(x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return -48;
  if (Math.abs(x) > TERRAIN_EXTENT || Math.abs(z) > TERRAIN_EXTENT) return -48;
  const gx = (x + TERRAIN_EXTENT) / TERRAIN_STEP;
  const gz = (z + TERRAIN_EXTENT) / TERRAIN_STEP;
  const ix = Math.min(CELLS - 1, Math.floor(gx));
  const iz = Math.min(CELLS - 1, Math.floor(gz));
  const u = gx - ix, v = gz - iz;
  const a = heights[iz * STRIDE + ix];
  const b = heights[iz * STRIDE + ix + 1];
  const c = heights[(iz + 1) * STRIDE + ix];
  const d = heights[(iz + 1) * STRIDE + ix + 1];
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v
    : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

export function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function outsideStructures(x: number, z: number, margin = 0): boolean {
  if (Math.hypot(x, z) > CONFIG.radius - 12) return false;
  if (Math.abs(x) < 15 + margin && z > 84 - margin && z < 123 + margin) return false;
  if (x > RIVER.minX - 5 - margin && x < RIVER.maxX + 5 + margin && z > RIVER.minZ - margin && z < RIVER.maxZ + 2 + margin) return false;
  for (const [key, location] of Object.entries(LOCATIONS)) {
    if (key === 'lake' || key === 'outlook') continue;
    const radius = (anchorRadius[key] ?? 7) + margin;
    if (Math.hypot(x - location.position[0], z - location.position[2]) < radius) return false;
  }
  return !LAKES.some(lake => Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz) < 1.18 + margin / 10);
}

const paths: readonly [number, number, number, number][] = [
  [0, 88, 9, 64], [9, 64, 4, 18], [0, -16, 0, -60],
  [-16, 5, -55, 26], [15, 8, 55, 32], [14, -12, 58, -54],
  [-14, -13, -57, -61], ...SNOW_PATH.slice(1).map((b, i): [number, number, number, number] => [SNOW_PATH[i]![0], SNOW_PATH[i]![2], b[0], b[2]]),
];
function segmentDistance(x: number, z: number, segment: readonly [number, number, number, number]): number {
  const [ax, az, bx, bz] = segment;
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}
export function pathDistance(x: number, z: number): number {
  let d = Infinity;
  for (const path of paths) d = Math.min(d, segmentDistance(x, z, path));
  return d;
}

/** Chunking preserves frustum culling; flat triangle colors give the plateau its painted facets. */
export function buildTerrain(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Asterfall triangulated plateau';
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  const random = seededRandom(7419);
  const grass = new THREE.Color('#8aa94e');
  const meadow = new THREE.Color('#678c48');
  const snow = new THREE.Color('#e1edf0');
  const stone = new THREE.Color('#747f77');
  const sand = new THREE.Color('#b8aa79');
  const caveFloor = new THREE.Color('#7c8a84');
  const color = new THREE.Color();
  const chunkSize = 32;
  for (let cz = 0; cz < CELLS; cz += chunkSize) {
    for (let cx = 0; cx < CELLS; cx += chunkSize) {
      const vertices: number[] = [], colors: number[] = [];
      const addTriangle = (ax: number, az: number, bx: number, bz: number, dx: number, dz: number): void => {
        const points = [[ax, az], [bx, bz], [dx, dz]];
        const wx = (ax + bx + dx) / 3 * TERRAIN_STEP - TERRAIN_EXTENT;
        const wz = (az + bz + dz) / 3 * TERRAIN_STEP - TERRAIN_EXTENT;
        const values = points.map(([px, pz]) => heights[pz * STRIDE + px]);
        const slope = Math.max(...values) - Math.min(...values);
        color.copy(grass).lerp(meadow, 0.18 + random() * 0.6);
        const coldness = smooth(-34, -48, wx) * smooth(-34, -48, wz);
        color.lerp(snow, coldness * (0.92 + random() * 0.08));
        if (slope > 1.7 || Math.hypot(wx, wz) > CONFIG.radius - 4) color.lerp(stone, 0.7);
        if (pathDistance(wx, wz) < 1.7) color.lerp(sand, 0.72);
        for (const lake of LAKES) {
          const distance = Math.hypot((wx - lake.x) / lake.rx, (wz - lake.z) / lake.rz);
          if (distance < 1.13) color.lerp(sand, 0.74);
        }
        if (wx > RIVER.minX - 2 && wx < RIVER.maxX + 2 && wz > RIVER.minZ && wz < RIVER.maxZ) color.lerp(sand, 0.8);
        if (Math.abs(wx) < 10 && wz > 90 && wz < 119) color.copy(caveFloor);
        color.multiplyScalar(0.93 + random() * 0.14);
        points.forEach(([px, pz], i) => {
          vertices.push(px * TERRAIN_STEP - TERRAIN_EXTENT, values[i], pz * TERRAIN_STEP - TERRAIN_EXTENT);
          colors.push(color.r, color.g, color.b);
        });
      };
      for (let z = cz; z < Math.min(CELLS, cz + chunkSize); z++) {
        for (let x = cx; x < Math.min(CELLS, cx + chunkSize); x++) {
          addTriangle(x, z, x, z + 1, x + 1, z);
          addTriangle(x + 1, z + 1, x + 1, z, x, z + 1);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = true;
      mesh.name = `terrain-${cx}-${cz}`;
      mesh.userData.terrain = true;
      root.add(mesh);
    }
  }
  return root;
}
