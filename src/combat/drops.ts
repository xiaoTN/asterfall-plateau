import * as THREE from 'three';
import { ITEMS } from '../config/items';
import type { GameContext, Interactable, InventoryItem, Region, Vec3, WorldView } from '../core/types';
import { disposeObject } from './models';

interface DropRecord { id: string; item: string; position: Vec3; region: Region; count: number; durability?: number; }
interface LiveDrop { interactable: Interactable; world: WorldView; record: DropRecord; age: number; pending: boolean; }
const PREFIX = 'combat-drop:';

/** Persist generated loot in boolean flags without extending the shared save contract. */
export class CombatDrops {
  private readonly live: LiveDrop[] = [];
  private serial = 0;

  constructor(private readonly ctx: GameContext, private readonly root: THREE.Group) {}

  private picked(id: string): boolean {
    const flags = this.ctx.state.flags;
    return !!(flags[id] || flags[`picked:${id}`] || flags[`pickup:${id}`] || flags[`collected:${id}`]);
  }

  private key(record: DropRecord): string {
    // Compact and rounded: the shared save migrator deliberately rejects flag keys >=120 chars.
    return PREFIX + JSON.stringify([record.id, record.item, record.region, record.position.map(value => +value.toFixed(2)), record.count, record.durability ?? null]);
  }

  uniqueId(prefix: string): string {
    let id: string;
    do { id = `combat:${this.ctx.state.region}:${this.ctx.state.bloodMoonCount}:${prefix}:${++this.serial}`; }
    while (this.picked(id) || this.live.some(drop => drop.record.id === id));
    return id;
  }

  private floorAt(position: THREE.Vector3): number {
    let floor = this.ctx.world.heightAt(position.x, position.z);
    for (const collider of this.ctx.world.colliders) {
      const box = collider.box;
      if (collider.enabled && box.max.y <= position.y + 0.4 && position.x >= box.min.x && position.x <= box.max.x && position.z >= box.min.z && position.z <= box.max.z) floor = Math.max(floor, box.max.y);
    }
    return floor;
  }

  spawn(id: string, item: string, position: THREE.Vector3, count = 1, extra?: Partial<InventoryItem>, persist = true): void {
    if (!ITEMS[item] || this.picked(id) || this.live.some(drop => drop.record.id === id)) return;
    const floor = this.floorAt(position);
    const record: DropRecord = {
      id, item, count, region: this.ctx.state.region,
      position: [position.x, Number.isFinite(floor) ? floor + 0.18 : position.y, position.z],
      ...(extra?.durability !== undefined ? { durability: extra.durability } : {}),
    };
    if (persist) this.ctx.state.flags[this.key(record)] = true;
    this.create(record);
  }

  private create(record: DropRecord): void {
    const definition = ITEMS[record.item];
    if (!definition) return;
    const mesh = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: definition.color, roughness: 0.75, flatShading: true, emissive: definition.color, emissiveIntensity: 0.11 });
    let itemMesh: THREE.Mesh;
    if (definition.category === 'weapon' || definition.category === 'arrow' || record.item === 'wood') {
      itemMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.055, 0.85, 5), material);
      itemMesh.rotation.z = Math.PI * 0.38;
      if (definition.category === 'weapon' && record.item !== 'branch') {
        const tip = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16), new THREE.MeshStandardMaterial({ color: 0xb9c8c9, metalness: 0.4, roughness: 0.6 }));
        tip.position.set(-0.34, 0.18, 0);
        mesh.add(tip);
      }
    } else if (definition.category === 'bow') {
      itemMesh = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 4, 10, Math.PI * 1.3), material);
    } else {
      itemMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(record.item === 'apple' ? 0.19 : 0.24, 0), material);
    }
    itemMesh.castShadow = true;
    mesh.add(itemMesh);
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.29, 12), new THREE.MeshBasicMaterial({ color: 0xf4dfaa, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.12;
    mesh.add(glow);
    mesh.position.fromArray(record.position);
    this.root.add(mesh);
    const interactable: Interactable = {
      id: record.id, kind: 'pickup', name: `${definition.name}${record.count > 1 ? ` ×${record.count}` : ''}`,
      position: new THREE.Vector3().fromArray(record.position), radius: 2.4, item: record.item, mesh,
      data: { combatDrop: true, count: record.count, ...(record.durability !== undefined ? { durability: record.durability } : {}) },
    };
    this.ctx.world.interactables.push(interactable);
    this.live.push({ interactable, world: this.ctx.world, record, age: 0, pending: false });
  }

  /** A disarmed enemy can reclaim only its own still-uncollected physical pickup. */
  position(id: string): THREE.Vector3 | undefined {
    const drop = this.live.find(candidate => candidate.record.id === id);
    return drop && !drop.pending && !this.picked(id) && drop.world.interactables.includes(drop.interactable)
      ? drop.interactable.position : undefined;
  }

  retrieve(id: string): boolean {
    if (!this.position(id)) return false;
    const index = this.live.findIndex(drop => drop.record.id === id);
    delete this.ctx.state.flags[this.key(this.live[index].record)];
    this.remove(index);
    return true;
  }

  defer(id: string): void {
    const drop = this.live.find(candidate => candidate.record.id === id);
    if (!drop) return;
    drop.pending = true;
    const index = drop.world.interactables.indexOf(drop.interactable);
    if (index >= 0) drop.world.interactables.splice(index, 1);
    if (drop.interactable.mesh) drop.interactable.mesh.visible = false;
  }

  relocate(id: string, position: THREE.Vector3, durability: number): void {
    const index = this.live.findIndex(candidate => candidate.record.id === id);
    if (index < 0) return;
    const drop = this.live[index];
    delete this.ctx.state.flags[this.key(drop.record)];
    if (durability <= 0) {
      this.ctx.state.flags[`picked:${id}`] = true;
      this.remove(index);
      return;
    }
    const floor = this.floorAt(position);
    drop.record.position = [position.x, Number.isFinite(floor) ? floor + 0.18 : position.y, position.z];
    drop.record.durability = durability;
    drop.interactable.position.fromArray(drop.record.position);
    drop.interactable.data = { ...drop.interactable.data, durability };
    if (drop.interactable.mesh) {
      drop.interactable.mesh.position.fromArray(drop.record.position);
      drop.interactable.mesh.visible = true;
    }
    if (drop.pending) drop.world.interactables.push(drop.interactable);
    drop.pending = false;
    drop.age = 0;
    this.ctx.state.flags[this.key(drop.record)] = true;
  }

  update(dt: number): void {
    for (let index = this.live.length - 1; index >= 0; index--) {
      const drop = this.live[index];
      if (drop.pending) continue;
      if (this.picked(drop.record.id) || !drop.world.interactables.includes(drop.interactable)) {
        this.ctx.state.flags[`picked:${drop.record.id}`] = true;
        delete this.ctx.state.flags[this.key(drop.record)];
        this.remove(index);
        continue;
      }
      drop.age += dt;
      if (drop.interactable.mesh) {
        const bob = Math.sin(drop.age * 2.7) * 0.05;
        drop.interactable.mesh.position.y = drop.record.position[1] + Math.abs(Math.sin(Math.min(1, drop.age) * Math.PI * 2)) * Math.max(0, 1 - drop.age) * 0.4 + bob;
        drop.interactable.mesh.rotation.y += dt * 0.35;
      }
    }
  }

  reset(): void {
    this.clear();
    for (const [key, alive] of Object.entries(this.ctx.state.flags)) {
      if (!alive || !key.startsWith(PREFIX)) continue;
      try {
        const fields: unknown = JSON.parse(key.slice(PREFIX.length));
        if (!Array.isArray(fields) || fields.length !== 6) continue;
        const [id, item, region, position, count, durability] = fields as unknown[];
        if (typeof id !== 'string' || typeof item !== 'string' || !ITEMS[item] || typeof region !== 'string' || !['overworld', 'magnet', 'bomb', 'stasis', 'ice'].includes(region) || !Array.isArray(position) || position.length !== 3 || !position.every(value => typeof value === 'number' && Number.isFinite(value)) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) continue;
        const record: DropRecord = { id, item, region: region as Region, position: position as Vec3, count, ...(typeof durability === 'number' && Number.isFinite(durability) ? { durability: Math.max(0, durability) } : {}) };
        if (this.picked(record.id)) { delete this.ctx.state.flags[key]; continue; }
        if (record.region === this.ctx.state.region) this.create(record);
      } catch { /* Invalid optional loot records never prevent loading a save. */ }
    }
  }

  private remove(index: number): void {
    const drop = this.live[index];
    drop.interactable.radius = 0;
    (drop.interactable.data ??= {}).disabled = true;
    if (drop.interactable.mesh) drop.interactable.mesh.visible = false;
    const worldIndex = drop.world.interactables.indexOf(drop.interactable);
    if (worldIndex >= 0) drop.world.interactables.splice(worldIndex, 1);
    if (drop.interactable.mesh) disposeObject(drop.interactable.mesh);
    this.live.splice(index, 1);
  }

  private clear(): void { for (let index = this.live.length - 1; index >= 0; index--) this.remove(index); }
  dispose(): void { this.clear(); }
}
