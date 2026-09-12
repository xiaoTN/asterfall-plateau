import * as THREE from 'three';
import { CONFIG } from '../config/game';
import type { InventoryItem, WorldView } from '../core/types';

export interface Projectile {
  active: boolean;
  mesh: THREE.Group;
  shaft: THREE.Object3D;
  thrownMesh: THREE.Object3D;
  position: THREE.Vector3;
  previous: THREE.Vector3;
  velocity: THREE.Vector3;
  owner: 'player' | 'enemy';
  enemyId?: string;
  damage: number;
  age: number;
  item?: InventoryItem;
  burning: boolean;
  fireFuel: number;
  trail: THREE.Group;
  reflected: boolean;
}

/** Segment/sphere intersection returns an exact fractional time, including starts inside. */
export function sphereHit(start: THREE.Vector3, end: THREE.Vector3, center: THREE.Vector3, radius: number): number | null {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const ox = start.x - center.x, oy = start.y - center.y, oz = start.z - center.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-10) return null;
  const b = ox * dx + oy * dy + oz * dz;
  const determinant = b * b - a * c;
  if (determinant < 0) return null;
  const time = (-b - Math.sqrt(determinant)) / a;
  return time >= 0 && time <= 1 ? time : null;
}

export function boxHit(start: THREE.Vector3, end: THREE.Vector3, box: THREE.Box3, padding = 0): number | null {
  let near = 0, far = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = end[axis] - start[axis];
    const min = box.min[axis] - padding, max = box.max[axis] + padding;
    if (Math.abs(delta) < 1e-9) {
      if (start[axis] < min || start[axis] > max) return null;
    } else {
      const a = (min - start[axis]) / delta, b = (max - start[axis]) / delta;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far) return null;
    }
  }
  return near;
}

export function terrainHit(start: THREE.Vector3, end: THREE.Vector3, world: WorldView): number | null {
  // Subdivide long segments so ridges cannot be skipped by high speed arrows.
  const steps = Math.max(1, Math.ceil(start.distanceTo(end) / 0.35));
  const point = new THREE.Vector3();
  for (let index = 0; index <= steps; index++) {
    const time = index / steps;
    point.lerpVectors(start, end, time);
    if (point.y > world.heightAt(point.x, point.z) + 0.06) continue;
    let low = Math.max(0, (index - 1) / steps), high = time;
    for (let iteration = 0; iteration < 6; iteration++) {
      const middle = (low + high) * 0.5;
      point.lerpVectors(start, end, middle);
      if (point.y <= world.heightAt(point.x, point.z) + 0.06) high = middle;
      else low = middle;
    }
    return high;
  }
  return null;
}

/** One fixed allocation pool for player arrows, enemy arrows, and thrown weapons. */
export class ProjectilePool {
  readonly projectiles: Projectile[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly direction = new THREE.Vector3();

  constructor(parent: THREE.Group) {
    const shaftGeometry = new THREE.CylinderGeometry(0.025, 0.025, 0.85, 4);
    const tipGeometry = new THREE.ConeGeometry(0.064, 0.18, 4);
    const featherGeometry = new THREE.BoxGeometry(0.16, 0.17, 0.025);
    const weaponGeometry = new THREE.CylinderGeometry(0.065, 0.04, 0.95, 5);
    const weaponTipGeometry = new THREE.DodecahedronGeometry(0.19);
    const wood = new THREE.MeshStandardMaterial({ color: 0xb69b70, roughness: 0.85 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xc8e0e1, roughness: 0.45, metalness: 0.5 });
    const feather = new THREE.MeshStandardMaterial({ color: 0xf0d4a1, roughness: 1 });
    const flameGeometry = new THREE.ConeGeometry(0.14, 0.55, 5);
    const flameMaterial = new THREE.MeshBasicMaterial({ color: 0xffa03c, transparent: true, opacity: 0.85, depthWrite: false });
    this.geometries.push(shaftGeometry, tipGeometry, featherGeometry, weaponGeometry, weaponTipGeometry, flameGeometry);
    this.materials.push(wood, metal, feather, flameMaterial);
    for (let index = 0; index < CONFIG.arrowPoolSize; index++) {
      const mesh = new THREE.Group();
      const shaft = new THREE.Group();
      shaft.add(new THREE.Mesh(shaftGeometry, wood));
      const tip = new THREE.Mesh(tipGeometry, metal);
      tip.position.y = 0.49;
      shaft.add(tip);
      const fletching = new THREE.Mesh(featherGeometry, feather);
      fletching.position.y = -0.32;
      shaft.add(fletching);
      const thrownMesh = new THREE.Group();
      thrownMesh.add(new THREE.Mesh(weaponGeometry, wood));
      const head = new THREE.Mesh(weaponTipGeometry, metal);
      head.position.y = 0.45;
      thrownMesh.add(head);
      mesh.add(shaft, thrownMesh);
      mesh.visible = false;
      const trail = new THREE.Group();
      trail.name = 'projectile-fire-trail';
      for (let n = 0; n < 3; n++) {
        const flame = new THREE.Mesh(flameGeometry, flameMaterial);
        flame.position.y = -0.3 - n * 0.32;
        flame.rotation.z = Math.PI;
        flame.scale.setScalar(1 - n * 0.22);
        trail.add(flame);
      }
      trail.visible = false;
      parent.add(mesh, trail);
      this.projectiles.push({ active: false, mesh, shaft, thrownMesh, trail, position: new THREE.Vector3(), previous: new THREE.Vector3(), velocity: new THREE.Vector3(), owner: 'player', damage: 0, age: 0, burning: false, fireFuel: 0, reflected: false });
    }
  }

  spawn(position: THREE.Vector3, velocity: THREE.Vector3, damage: number, owner: Projectile['owner'], enemyId?: string, item?: InventoryItem): Projectile | null {
    const projectile = this.projectiles.find(candidate => !candidate.active);
    if (!projectile) return null;
    projectile.active = true;
    projectile.position.copy(position);
    projectile.previous.copy(position);
    projectile.velocity.copy(velocity);
    projectile.mesh.position.copy(position);
    projectile.mesh.visible = true;
    projectile.shaft.visible = !item;
    projectile.thrownMesh.visible = !!item;
    projectile.owner = owner;
    projectile.enemyId = enemyId;
    projectile.damage = damage;
    projectile.age = 0;
    projectile.item = item ? { ...item } : undefined;
    projectile.burning = false;
    projectile.fireFuel = 0;
    projectile.trail.visible = false;
    projectile.reflected = false;
    return projectile;
  }

  update(dt: number, collision: (projectile: Projectile) => void, expired: (projectile: Projectile) => void): void {
    for (const projectile of this.projectiles) {
      if (!projectile.active) continue;
      projectile.age += dt;
      projectile.previous.copy(projectile.position);
      projectile.velocity.y -= CONFIG.gravity * (projectile.item ? 0.65 : 0.38) * dt;
      projectile.position.addScaledVector(projectile.velocity, dt);
      collision(projectile);
      if (!projectile.active) continue;
      projectile.mesh.position.copy(projectile.position);
      this.direction.copy(projectile.velocity).normalize();
      projectile.mesh.quaternion.setFromUnitVectors(this.up, this.direction);
      projectile.trail.visible = projectile.burning;
      projectile.trail.position.copy(projectile.position);
      projectile.trail.quaternion.copy(projectile.mesh.quaternion);
      projectile.trail.scale.setScalar(0.85 + Math.sin(projectile.age * 35) * 0.15);
      if (projectile.item) projectile.mesh.rotateX(projectile.age * 12);
      if (projectile.age > 9 || projectile.position.y < -100 || Math.hypot(projectile.position.x, projectile.position.z) > CONFIG.radius + 100) expired(projectile);
    }
  }

  release(projectile: Projectile): void {
    projectile.active = false;
    projectile.mesh.visible = false;
    projectile.trail.visible = false;
    projectile.burning = false;
    projectile.fireFuel = 0;
    projectile.item = undefined;
  }

  reset(): void { this.projectiles.forEach(projectile => this.release(projectile)); }

  dispose(): void {
    for (const projectile of this.projectiles) { projectile.mesh.removeFromParent(); projectile.trail.removeFromParent(); }
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
  }
}
