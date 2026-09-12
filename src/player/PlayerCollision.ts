import * as THREE from 'three';
import { CONFIG } from '../config/game';
import type { Collider, WorldView } from '../core/types';

const SKIN = 0.002;
const UP = new THREE.Vector3(0, 1, 0);

/** Upright cylinder with rounded horizontal contacts and independently swept feet/head. */
export class PlayerCollision {
  impactSpeed = 0;
  support: Collider | null = null;
  private readonly supportCenter = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly previous = new THREE.Vector3();
  private readonly candidate = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly cameraBox = new THREE.Box3();
  private readonly hit = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  constructor(private readonly world: () => WorldView) {}

  reset(): void {
    this.support = null;
    this.impactSpeed = 0;
  }

  terrain(x: number, z: number): number {
    const y = this.world().heightAt(x, z);
    return Number.isFinite(y) ? y : -200;
  }

  private overlapsXZ(p: THREE.Vector3, box: THREE.Box3, radius = CONFIG.playerRadius): boolean {
    const dx = p.x - THREE.MathUtils.clamp(p.x, box.min.x, box.max.x);
    const dz = p.z - THREE.MathUtils.clamp(p.z, box.min.z, box.max.z);
    return dx * dx + dz * dz < radius * radius - 0.00001;
  }

  canOccupy(p: THREE.Vector3, height: number, ignore?: Collider): boolean {
    if (this.terrain(p.x, p.z) > p.y + 0.06) return false;
    for (const c of this.world().colliders) {
      if (!c.enabled || c === ignore || p.y >= c.box.max.y - SKIN || p.y + height <= c.box.min.y + SKIN) continue;
      if (this.overlapsXZ(p, c.box)) return false;
    }
    return true;
  }

  /** Highest walkable surface no higher than maxY; bridges supersede water beds. */
  floor(p: THREE.Vector3, maxY = p.y + 0.06): number {
    let y = this.terrain(p.x, p.z);
    for (const c of this.world().colliders) {
      if (c.enabled && c.box.max.y <= maxY && c.box.max.y > y && this.overlapsXZ(p, c.box)) y = c.box.max.y;
    }
    return y;
  }

  /** Carry a grounded actor along with a translated/lifting collider. */
  carry(p: THREE.Vector3, grounded: boolean): void {
    if (!grounded || !this.support?.enabled || !this.world().colliders.includes(this.support)) {
      this.support = null;
      return;
    }
    this.support.box.getCenter(this.center);
    this.center.sub(this.supportCenter);
    // A discontinuous region/platform reset is not a player launch.
    if (this.center.lengthSq() < 64) p.add(this.center);
    this.support.box.getCenter(this.supportCenter);
  }

  /** dt must already be scaled by the engine. Motion is substepped by time AND distance. */
  move(p: THREE.Vector3, v: THREE.Vector3, dt: number, height: number, grounded: boolean, snap: boolean): boolean {
    this.impactSpeed = 0;
    const steps = Math.min(80, Math.max(1, Math.ceil(dt / (1 / 120)), Math.ceil(v.length() * dt / (CONFIG.playerRadius * 0.36))));
    const h = dt / steps;
    let onGround = grounded;
    for (let i = 0; i < steps; i++) {
      this.previous.copy(p);
      const wasGrounded = onGround;
      p.x += v.x * h;
      p.z += v.z * h;
      this.resolveTerrainSide(p, this.previous, wasGrounded);
      this.resolveSides(p, v, height, wasGrounded && snap);
      const oldY = p.y;
      const falling = v.y <= 0;
      const incoming = -v.y;
      p.y += v.y * h;
      onGround = false;
      this.support = null;

      if (!falling) {
        let ceiling = Infinity;
        for (const c of this.world().colliders) {
          if (!c.enabled || !this.overlapsXZ(p, c.box)) continue;
          if (oldY + height <= c.box.min.y + SKIN && p.y + height >= c.box.min.y && c.box.min.y < ceiling) ceiling = c.box.min.y;
        }
        if (ceiling < Infinity) {
          p.y = ceiling - height - SKIN;
          v.y = 0;
        }
      }

      let floor = this.terrain(p.x, p.z);
      let floorCollider: Collider | null = null;
      const snapDepth = wasGrounded && snap && falling ? CONFIG.stepHeight + 0.04 : 0.025;
      for (const c of this.world().colliders) {
        if (!c.enabled || !this.overlapsXZ(p, c.box)) continue;
        const top = c.box.max.y;
        if (top > floor && top <= oldY + 0.055 && p.y <= top + snapDepth) {
          floor = top;
          floorCollider = c;
        }
      }
      let floorSnap = snapDepth;
      if (!floorCollider && floorSnap > 0.025 && p.y > floor + 0.025) {
        const gx = (this.terrain(p.x + 0.25, p.z) - this.terrain(p.x - 0.25, p.z)) * 2;
        const gz = (this.terrain(p.x, p.z + 0.25) - this.terrain(p.x, p.z - 0.25)) * 2;
        if (gx * gx + gz * gz > 2.8) floorSnap = 0.025;
      }
      if ((falling || p.y < floor - 0.05) && p.y <= floor + floorSnap) {
        p.y = floor;
        v.y = Math.max(0, v.y);
        onGround = true;
        this.support = floorCollider;
        this.impactSpeed = Math.max(this.impactSpeed, incoming);
      }
    }
    if (this.support) this.support.box.getCenter(this.supportCenter);
    return onGround;
  }

  private resolveTerrainSide(p: THREE.Vector3, old: THREE.Vector3, grounded: boolean): void {
    const floor = this.terrain(p.x, p.z);
    if (floor <= old.y + 0.06) return;
    const rise = floor - this.terrain(old.x, old.z);
    const sample = 0.25;
    const gx = (this.terrain(p.x + sample, p.z) - this.terrain(p.x - sample, p.z)) / (sample * 2);
    const gz = (this.terrain(p.x, p.z + sample) - this.terrain(p.x, p.z - sample)) / (sample * 2);
    const dx = p.x - old.x;
    const dz = p.z - old.z;
    const uphill = gx * dx + gz * dz;
    if (rise > CONFIG.stepHeight || ((grounded || floor > old.y + 0.3) && gx * gx + gz * gz > 2.8 && uphill > 0)) {
      const denominator = gx * gx + gz * gz;
      if (denominator > 0.01) {
        const against = Math.max(0, uphill / denominator);
        p.x -= gx * against;
        p.z -= gz * against;
      }
      if (this.terrain(p.x, p.z) > old.y + CONFIG.stepHeight) {
        p.x = old.x;
        p.z = old.z;
      }
    }
  }

  private resolveSides(p: THREE.Vector3, v: THREE.Vector3, height: number, step: boolean): void {
    const radius = CONFIG.playerRadius;
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const c of this.world().colliders) {
        const b = c.box;
        if (!c.enabled || p.y >= b.max.y - SKIN || p.y + height <= b.min.y + SKIN) continue;
        if (p.x < b.min.x - radius || p.x > b.max.x + radius || p.z < b.min.z - radius || p.z > b.max.z + radius) continue;
        let dx = p.x - THREE.MathUtils.clamp(p.x, b.min.x, b.max.x);
        let dz = p.z - THREE.MathUtils.clamp(p.z, b.min.z, b.max.z);
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq >= radius * radius) continue;
        if (step && b.max.y - p.y <= CONFIG.stepHeight && b.max.y >= p.y) {
          this.candidate.set(p.x, b.max.y + SKIN, p.z);
          if (this.canOccupy(this.candidate, height, c)) {
            p.y = this.candidate.y;
            changed = true;
            continue;
          }
        }
        let penetration: number;
        if (distanceSq > 0.000001) {
          const distance = Math.sqrt(distanceSq);
          dx /= distance;
          dz /= distance;
          penetration = radius - distance + SKIN;
        } else {
          const left = p.x - b.min.x;
          const right = b.max.x - p.x;
          const back = p.z - b.min.z;
          const front = b.max.z - p.z;
          const nearest = Math.min(left, right, back, front);
          dx = nearest === left ? -1 : nearest === right ? 1 : 0;
          dz = dx !== 0 ? 0 : nearest === back ? -1 : 1;
          penetration = nearest + radius + SKIN;
        }
        p.x += dx * penetration;
        p.z += dz * penetration;
        const inward = v.x * dx + v.z * dz;
        if (inward < 0) {
          v.x -= dx * inward;
          v.z -= dz * inward;
        }
        changed = true;
      }
      if (!changed) break;
    }
  }

  /** Return a nearby rough wall and its outward normal. No mesh raycasts/allocations. */
  findClimb(p: THREE.Vector3, direction: THREE.Vector3, normal: THREE.Vector3, preferred?: Collider | null): Collider | null {
    let nearest = CONFIG.playerRadius + 0.3;
    let found: Collider | null = null;
    for (const c of this.world().colliders) {
      if (!c.enabled || !c.climbable || c.box.max.y < p.y + 0.35 || c.box.min.y > p.y + 1.35) continue;
      const x = THREE.MathUtils.clamp(p.x, c.box.min.x, c.box.max.x);
      const z = THREE.MathUtils.clamp(p.z, c.box.min.z, c.box.max.z);
      this.normal.set(p.x - x, 0, p.z - z);
      const distance = this.normal.length();
      if (distance < 0.001 || distance > nearest) continue;
      this.normal.divideScalar(distance);
      if (direction.dot(this.normal) > -0.12 && c !== preferred) continue;
      nearest = distance;
      found = c;
      normal.copy(this.normal);
    }
    return found;
  }

  /** Safe camera distance along a segment, including a near-plane clearance margin. */
  cameraDistance(origin: THREE.Vector3, end: THREE.Vector3): number {
    this.direction.subVectors(end, origin);
    let length = this.direction.length();
    if (length < 0.001) return 0;
    this.direction.divideScalar(length);
    this.ray.set(origin, this.direction);
    for (const c of this.world().colliders) {
      if (!c.enabled) continue;
      for (let i = 0; i < (c.cameraBox ? 2 : 1); i++) {
        this.cameraBox.copy(i === 0 ? c.box : c.cameraBox!).expandByScalar(0.18);
        if (this.cameraBox.containsPoint(origin)) continue;
        if (this.ray.intersectBox(this.cameraBox, this.hit)) length = Math.min(length, Math.max(0.15, this.hit.distanceTo(origin) - 0.035));
      }
    }
    const samples = Math.max(2, Math.ceil(length / 0.3));
    for (let i = 1; i <= samples; i++) {
      const distance = length * i / samples;
      this.hit.copy(origin).addScaledVector(this.direction, distance);
      if (this.hit.y < this.terrain(this.hit.x, this.hit.z) + 0.2) {
        length = Math.max(0.15, length * (i - 1) / samples);
        break;
      }
    }
    return length;
  }

  groundNormal(p: THREE.Vector3, result: THREE.Vector3): THREE.Vector3 {
    if (this.support) return result.copy(UP);
    const d = 0.3;
    return result.set(this.terrain(p.x - d, p.z) - this.terrain(p.x + d, p.z), d * 2, this.terrain(p.x, p.z - d) - this.terrain(p.x, p.z + d)).normalize();
  }
}
