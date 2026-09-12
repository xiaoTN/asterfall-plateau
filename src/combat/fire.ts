import * as THREE from 'three';
import { ITEMS } from '../config/items';
import type { AbilityTarget, GameContext, Interactable, InventoryItem } from '../core/types';
import { FLAGS } from '../quests/progression';
import type { CombatEnemy } from './enemies';
import type { Projectile } from './projectiles';
import { sphereHit } from './projectiles';

interface Fuel { id: string; position: THREE.Vector3; prop?: Interactable; target?: AbilityTarget; }
interface Spread { origin: THREE.Vector3; remaining: number; }
interface Flame { source: Fuel; spread: Spread; fuel: number; age: number; mesh: THREE.Mesh; logWait?: number; }
interface FirePorts {
  hitTarget(target: AbilityTarget, amount: number): void;
  hitTree(tree: Interactable, amount: number): void;
  damageEnemy(enemy: CombatEnemy, amount: number): void;
  wear(item: InventoryItem, amount: number): boolean;
}
const MAX_FLAMES = 32, MAX_SPREAD = 12, SPREAD_RADIUS = 9, CELL = 3;
const MAX_OBJECTS = 2048, MAX_QUERY = 96;

/** Local, finite wild fire. Hearth flags remain owned by the shared world/interaction contract. */
export class LocalFire {
  private readonly flames: Flame[] = [];
  private readonly pool: THREE.Mesh[] = [];
  private readonly cells = new Map<string, Fuel[]>();
  private readonly grass = new Map<string, THREE.Vector3>();
  private readonly spent = new Set<string>();
  private readonly equipment = new Map<string, number>();
  private readonly enemyBurn = new Map<string, number>();
  private readonly enemyWet = new Map<string, number>();
  private readonly hearthState = new Map<string, string>();
  private hearths: Interactable[] = [];
  private actorWet = 0;
  private actorBurn = 0;
  private tick = 0;
  private indexClock = 0;
  private damageClock = 0;
  private readonly geometry = new THREE.ConeGeometry(0.38, 1.2, 5);
  private readonly material = new THREE.MeshBasicMaterial({ color: 0xffa13e, transparent: true, opacity: 0.85, depthWrite: false });

  constructor(private readonly ctx: GameContext, root: THREE.Group, private readonly ports: FirePorts) {
    for (let i = 0; i < MAX_FLAMES; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.name = 'bounded-wild-flame';
      mesh.visible = false;
      root.add(mesh);
      this.pool.push(mesh);
    }
  }

  private cell(position: THREE.Vector3): string { return `${Math.floor(position.x / CELL)},${Math.floor(position.z / CELL)}`; }
  private raining(): boolean { return this.ctx.state.region === 'overworld' && this.ctx.state.weather === 'rain'; }
  inWater(position: THREE.Vector3, radius = 0): boolean {
    return this.ctx.world.waters.slice(0, 64).some(w => position.x >= w.minX && position.x <= w.maxX && position.z >= w.minZ && position.z <= w.maxZ && position.y - radius < w.level + 0.1);
  }
  private wetFuel(source: Fuel): boolean {
    const radius = source.target ? Number(source.target.mesh.userData.radius ?? 0.4) : source.prop?.kind === 'tree' ? 0 : 0.2;
    return this.inWater(source.position, Number.isFinite(radius) ? Math.max(0, radius) : 0.4);
  }
  private wetActor(): boolean {
    return this.actorWet > 0 || this.raining() || this.ctx.state.player.movement === 'swim' || this.inWater(this.ctx.actor.position) || this.ctx.actor.model.userData.wet === true;
  }
  private wetEnemy(enemy: CombatEnemy): boolean {
    return (this.enemyWet.get(enemy.id) ?? 0) > 0 || this.raining() || this.inWater(enemy.position) || enemy.model.root.userData.wet === true;
  }
  weaponBurning(item: InventoryItem | undefined): boolean {
    return !!item && !!ITEMS[item.id]?.flammable && !this.wetActor() && ((this.equipment.get(item.uid) ?? 0) > 0 || (item.id === 'torch' && this.ctx.state.flags.torchLit));
  }

  igniteActor(): void { if (!this.wetActor() && this.ctx.state.player.hp > 0 && this.actorBurn <= 0) this.actorBurn = 4; }
  igniteEnemy(enemy: CombatEnemy): boolean {
    if (this.wetEnemy(enemy) || enemy.hp <= 0) return false;
    if (!this.enemyBurn.has(enemy.id)) this.enemyBurn.set(enemy.id, 5);
    return true;
  }

  private available(source: Fuel): boolean {
    if (source.target) return !source.target.solved;
    if (source.prop?.kind === 'tree') return !this.ctx.state.flags[FLAGS.chopped(source.prop.id)];
    if (source.prop) return !this.ctx.state.flags[FLAGS.picked(source.prop.id)] && source.prop.mesh?.visible !== false && (!source.prop.mesh || source.prop.mesh.parent !== null);
    return true;
  }
  private add(source: Fuel, spread: Spread): void {
    if (this.flames.length >= MAX_FLAMES || spread.remaining <= 0 || this.spent.size >= MAX_OBJECTS || this.spent.has(source.id) || !this.available(source) || this.wetFuel(source) || this.raining() || source.position.distanceTo(spread.origin) > SPREAD_RADIUS) return;
    const mesh = this.pool.find(candidate => !candidate.visible);
    if (!mesh) return;
    spread.remaining--;
    this.spent.add(source.id); // Never refill an already burning/exhausted fuel source by hitting it again.
    mesh.visible = true;
    mesh.position.copy(source.position).y += 0.5;
    mesh.scale.set(1, source.prop?.kind === 'tree' ? 2.5 : 1, 1);
    const fuel = source.prop?.kind === 'tree' ? 12 : source.target || source.prop ? 8 : 4;
    this.flames.push({ source, spread, fuel, age: 0, mesh });
    const object = source.target?.mesh ?? source.prop?.mesh;
    if (object) object.userData.burning = true;
  }

  /** A new ignition has a 9m origin leash and at most 12 fuel sources, globally at most 32. */
  ignite(position: THREE.Vector3, radius = 2.5): void {
    if (!position.toArray().every(Number.isFinite) || !Number.isFinite(radius) || radius <= 0 || this.inWater(position)) return;
    const bounded = Math.min(6, radius);
    const spread = { origin: position.clone(), remaining: MAX_SPREAD };
    for (const source of this.nearby(position, bounded)) this.add(source, spread);
    for (const hearth of this.hearths) if (hearth.position.distanceTo(position) <= bounded) this.setHearth(hearth, true);
  }

  private nearby(position: THREE.Vector3, radius: number): Fuel[] {
    const found: Fuel[] = [];
    let inspected = 0;
    const x = Math.floor(position.x / CELL), z = Math.floor(position.z / CELL), n = Math.ceil(radius / CELL);
    for (let dx = -n; dx <= n; dx++) for (let dz = -n; dz <= n; dz++) {
      const key = `${x + dx},${z + dz}`;
      for (const source of this.cells.get(key) ?? []) {
        if (++inspected > MAX_QUERY) return found;
        if (source.position.distanceTo(position) <= radius) found.push(source);
      }
      const grass = this.grass.get(key);
      if (grass && grass.distanceTo(position) <= radius) found.push({ id: `grass:${key}`, position: grass });
    }
    return found;
  }

  private indexObjects(): void {
    this.cells.clear();
    this.hearths = [];
    const insert = (source: Fuel) => {
      const key = this.cell(source.position);
      let bucket = this.cells.get(key);
      if (!bucket) this.cells.set(key, bucket = []);
      if (bucket.length < 32) bucket.push(source);
    };
    // Logical objects only, capped even if another system adds a huge population.
    for (const prop of this.ctx.world.interactables.slice(0, MAX_OBJECTS)) {
      if ((prop.kind === 'campfire' || (prop.kind === 'pot' && prop.data?.breakable !== true)) && this.hearths.length < 64) this.hearths.push(prop);
      if (prop.kind === 'tree' || (prop.kind === 'pickup' && prop.item && ITEMS[prop.item]?.flammable)) insert({ id: prop.id, position: prop.position, prop });
    }
    for (const target of this.ctx.world.targets.slice(0, MAX_OBJECTS)) {
      if (target.resource === 'log') insert({ id: target.id, position: target.position, target });
    }
  }

  private signature(hearth: Interactable): string {
    const flags = this.ctx.state.flags;
    return `${!!flags[FLAGS.lit(hearth.id)]}:${!!flags[FLAGS.extinguished(hearth.id)]}:${hearth.data?.lit !== false}`;
  }
  private hearthLit(hearth: Interactable): boolean {
    return !this.ctx.state.flags[FLAGS.extinguished(hearth.id)] && (this.ctx.state.flags[FLAGS.lit(hearth.id)] || hearth.data?.lit !== false);
  }
  private sheltered(hearth: Interactable): boolean { return hearth.data?.sheltered === true || hearth.data?.covered === true; }
  private setHearth(hearth: Interactable, lit: boolean): void {
    // Pair only nearby campfire/pot fixtures, never recursively chain entire camps.
    const group = this.hearths.filter(other => other === hearth || other.kind !== hearth.kind && other.position.distanceTo(hearth.position) < 4);
    if (group.some(other => this.inWater(other.position) || (this.raining() && !this.sheltered(other)))) lit = false;
    for (const other of group) {
      this.ctx.state.flags[FLAGS.lit(other.id)] = lit;
      this.ctx.state.flags[FLAGS.extinguished(other.id)] = !lit;
      (other.data ??= {}).lit = lit;
      this.hearthState.set(other.id, this.signature(other));
    }
  }
  private syncHearths(): void {
    for (const hearth of this.hearths) {
      if (this.inWater(hearth.position) || (this.raining() && !this.sheltered(hearth))) { this.setHearth(hearth, false); continue; }
      const previous = this.hearthState.get(hearth.id);
      if (previous !== undefined && previous !== this.signature(hearth)) this.setHearth(hearth, this.hearthLit(hearth));
    }
    for (const hearth of this.hearths) if (!this.hearthState.has(hearth.id)) {
      const out = this.hearths.some(other => (other === hearth || other.kind !== hearth.kind && other.position.distanceTo(hearth.position) < 4) && this.ctx.state.flags[FLAGS.extinguished(other.id)]);
      this.setHearth(hearth, !out && this.hearthLit(hearth));
    }
  }

  private nearHeat(position: THREE.Vector3): boolean {
    return this.flames.some(flame => flame.source.position.distanceToSquared(position) < 1.8 * 1.8) || this.hearths.some(hearth => this.hearthLit(hearth) && hearth.position.distanceToSquared(position) < 2.2 * 2.2);
  }

  /** Arrows crossing flames catch fire; water/rain and a short fuel timer put them out. */
  projectile(projectile: Projectile, dt: number): void {
    if ((projectile.item && !ITEMS[projectile.item.id]?.flammable) || this.inWater(projectile.position) || this.inWater(projectile.previous) || this.raining()) {
      projectile.burning = false;
      projectile.fireFuel = 0;
      return;
    }
    if (!projectile.burning && projectile.fireFuel === 0) {
      const crossing = (position: THREE.Vector3) => sphereHit(projectile.previous, projectile.position, position.clone().add(new THREE.Vector3(0, 0.7, 0)), 1.2) !== null;
      if (this.flames.some(flame => crossing(flame.source.position)) || this.hearths.some(hearth => this.hearthLit(hearth) && crossing(hearth.position))) projectile.burning = true;
    }
    if (projectile.burning) {
      if (projectile.fireFuel === 0) projectile.fireFuel = 4;
      projectile.fireFuel = Math.max(-1, projectile.fireFuel - dt);
      if (projectile.fireFuel <= 0) { projectile.fireFuel = -1; projectile.burning = false; }
    }
  }

  update(dt: number, enemies: CombatEnemy[]): void {
    for (const flame of this.flames) {
      flame.mesh.position.copy(flame.source.position).y += 0.5;
      const pulse = 0.85 + Math.sin(this.ctx.elapsed * 17 + flame.age) * 0.15;
      flame.mesh.scale.set(pulse, pulse * (flame.source.prop?.kind === 'tree' ? 2.5 : 1), pulse);
      flame.mesh.rotation.y += dt * 2;
    }
    this.tick += dt;
    if (this.tick < 0.25) return;
    const step = this.tick;
    this.tick = 0;
    this.indexClock -= step;
    if (this.indexClock <= 0) { this.indexObjects(); this.indexClock = 0.75; }
    this.syncHearths();
    this.damageClock += step;
    const damageTick = this.damageClock >= 1;
    if (damageTick) this.damageClock %= 1;
    const wet = this.raining() || this.inWater(this.ctx.actor.position) || this.ctx.state.player.movement === 'swim';
    this.actorWet = wet ? 4 : Math.max(0, this.actorWet - step);
    if (this.wetActor()) {
      this.actorBurn = 0;
      this.equipment.clear();
      this.ctx.state.flags.torchLit = false;
    } else {
      if (this.flames.some(flame => flame.source.position.distanceToSquared(this.ctx.actor.position) < 1.2 * 1.2)) this.igniteActor();
      const equipped = new Set<string>();
      for (const slot of ['weapon', 'bow', 'shield'] as const) {
        const item = this.ctx.state.inventory.find(candidate => candidate.uid === this.ctx.state.equipment[slot]);
        if (!item || !ITEMS[item.id]?.flammable) continue;
        equipped.add(item.uid);
        if ((this.nearHeat(this.ctx.actor.position) || (item.id === 'torch' && this.ctx.state.flags.torchLit)) && !this.equipment.has(item.uid)) this.equipment.set(item.uid, item.id === 'torch' ? 45 : 10);
        const fuel = this.equipment.get(item.uid);
        if (fuel === undefined) continue;
        this.equipment.set(item.uid, Math.max(0, fuel - step));
        if (item.id === 'torch') this.ctx.state.flags.torchLit = fuel > step;
        // Interaction already owns torch durability; other wood equipment burns here.
        else if (fuel > 0 && damageTick) this.ports.wear(item, 1);
        if (fuel > 0) this.ctx.effects.burst(this.ctx.actor.position.clone().add(new THREE.Vector3(0.35, 1.25, 0)), 0xff9b38, 2);
      }
      for (const uid of this.equipment.keys()) if (!equipped.has(uid)) this.equipment.delete(uid);
    }
    if (this.actorBurn > 0) {
      this.actorBurn = Math.max(0, this.actorBurn - step);
      this.ctx.effects.burst(this.ctx.actor.position.clone().add(new THREE.Vector3(0, 0.8, 0)), 0xff8b35, 3);
      if (damageTick && this.ctx.state.player.hp > 0) this.ctx.damage(1, '燃烧');
    }
    this.ctx.actor.model.userData.burning = this.actorBurn > 0;
    this.ctx.actor.model.userData.wetRemaining = this.actorWet;
    const weapon = this.ctx.state.inventory.find(item => item.uid === this.ctx.state.equipment.weapon);
    this.ctx.actor.model.userData.weaponBurning = this.weaponBurning(weapon);
    for (const enemy of enemies) {
      const wetTime = this.raining() || this.inWater(enemy.position) ? 4 : Math.max(0, (this.enemyWet.get(enemy.id) ?? 0) - step);
      this.enemyWet.set(enemy.id, wetTime);
      if (enemy.hp <= 0 || this.wetEnemy(enemy)) this.enemyBurn.delete(enemy.id);
      else if (this.flames.some(flame => flame.source.position.distanceToSquared(enemy.position) < 1.6 * 1.6)) this.igniteEnemy(enemy);
      const fuel = this.enemyBurn.get(enemy.id) ?? 0;
      if (fuel > 0) {
        if (fuel <= step) this.enemyBurn.delete(enemy.id); else this.enemyBurn.set(enemy.id, fuel - step);
        this.ctx.effects.burst(enemy.position.clone().add(new THREE.Vector3(0, 1, 0)), 0xff8b35, 3);
        if (damageTick) this.ports.damageEnemy(enemy, 2);
      }
      enemy.model.root.userData.burning = fuel > 0;
      enemy.model.root.userData.wetRemaining = wetTime;
    }
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const flame = this.flames[i];
      if (flame.source.prop?.kind === 'tree' && this.ctx.state.flags[FLAGS.chopped(flame.source.prop.id)]) {
        const log = this.ctx.world.targets.slice(0, MAX_OBJECTS).find(target => target.id === `log:${flame.source.prop!.id}` && !target.solved);
        if (log && !this.spent.has(log.id) && this.spent.size < MAX_OBJECTS) {
          if (flame.source.prop.mesh) flame.source.prop.mesh.userData.burning = false;
          flame.source = { id: log.id, position: log.position, target: log };
          log.mesh.userData.burning = true;
          this.spent.add(log.id);
        } else if (!log && !this.raining() && !this.wetFuel(flame.source)) {
          flame.logWait = (flame.logWait ?? 0) + step;
          flame.fuel -= step;
          if (flame.logWait < 1 && flame.fuel > 0) continue;
        }
      }
      const valid = this.available(flame.source);
      const extinguish = this.wetFuel(flame.source) || !valid;
      flame.age += step;
      flame.fuel -= step * (this.raining() ? 12 : 1);
      if (extinguish || flame.fuel <= 0) {
        flame.mesh.visible = false;
        const object = flame.source.target?.mesh ?? flame.source.prop?.mesh;
        if (object) object.userData.burning = false;
        this.flames.splice(i, 1);
        if (!extinguish && !this.raining()) this.consume(flame.source);
        continue;
      }
      if (!this.raining() && damageTick && flame.spread.remaining > 0) for (const source of this.nearby(flame.source.position, 3.8)) this.add(source, flame.spread);
    }
  }

  private consume(source: Fuel): void {
    if (source.target) this.ports.hitTarget(source.target, 24);
    else if (source.prop?.kind === 'tree') this.ports.hitTree(source.prop, 6);
    else if (source.prop) {
      this.ctx.state.flags[FLAGS.picked(source.prop.id)] = true;
      if (source.prop.mesh) source.prop.mesh.visible = false;
      const index = this.ctx.world.interactables.indexOf(source.prop);
      if (index >= 0) this.ctx.world.interactables.splice(index, 1);
    }
  }

  private clear(): void {
    for (const flame of this.flames) {
      const object = flame.source.target?.mesh ?? flame.source.prop?.mesh;
      if (object) object.userData.burning = false;
    }
    this.flames.length = 0;
    this.pool.forEach(mesh => { mesh.visible = false; });
    this.spent.clear(); this.equipment.clear(); this.enemyBurn.clear(); this.enemyWet.clear(); this.hearthState.clear(); this.grass.clear();
    this.actorBurn = this.actorWet = this.tick = this.indexClock = this.damageClock = 0;
    this.ctx.actor.model.userData.burning = false;
    this.ctx.actor.model.userData.weaponBurning = false;
    this.ctx.actor.model.userData.wetRemaining = 0;
    this.cells.clear();
    this.hearths = [];
  }

  reset(): void {
    this.clear();
    this.indexObjects();
    this.syncHearths();
    // Read the existing grass instances once; retain coarse fuel patches, never clone foliage.
    const stack: THREE.Object3D[] = [this.ctx.world.root];
    const matrix = new THREE.Matrix4(), point = new THREE.Vector3();
    let visited = 0, meshes = 0;
    while (stack.length && visited++ < 4096 && meshes < 32 && this.grass.size < MAX_OBJECTS) {
      const object = stack.pop()!;
      for (const child of object.children.slice(0, Math.max(0, 4096 - stack.length))) stack.push(child);
      if (!(object instanceof THREE.InstancedMesh)) continue;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (!materials.some(material => material.customProgramCacheKey() === 'asterfall-grass-wind-v1')) continue;
      meshes++;
      object.updateWorldMatrix(true, false);
      for (let i = 0; i < Math.min(256, object.count) && this.grass.size < MAX_OBJECTS; i++) {
        object.getMatrixAt(i, matrix);
        point.setFromMatrixPosition(matrix).applyMatrix4(object.matrixWorld);
        this.grass.set(this.cell(point), point.clone());
      }
    }
  }

  dispose(): void {
    this.clear();
    this.pool.forEach(mesh => mesh.removeFromParent());
    this.geometry.dispose();
    this.material.dispose();
  }
}
