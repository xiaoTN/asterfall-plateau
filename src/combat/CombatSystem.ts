import * as THREE from 'three';
import { CONFIG } from '../config/game';
import { ITEMS } from '../config/items';
import type { AbilityTarget, GameContext, Interactable, InventoryItem, ItemDefinition } from '../core/types';
import { EnemyDirector, enemyStats } from './enemies';
import type { CombatEnemy } from './enemies';
import { ProjectilePool, boxHit, sphereHit, terrainHit } from './projectiles';
import type { Projectile } from './projectiles';
import { CombatDrops } from './drops';
import { LocalFire } from './fire';

export type { CombatEnemy, EnemyState } from './enemies';
interface Swing {
  item: InventoryItem | undefined;
  definition: ItemDefinition | undefined;
  time: number;
  duration: number;
  charged: boolean;
  airborne: boolean;
  sprinting: boolean;
  combo: number;
  hit: Set<string>;
  wallHit: boolean;
  ignited: boolean;
}
interface FallingTree { item: Interactable; time: number; rotation: THREE.Quaternion; axis: THREE.Vector3; }

/** Feet-space combat; update receives scaled world delta, while reaction windows use realDt. */
export class CombatSystem {
  readonly enemies: CombatEnemy[];
  focusRemaining = 0;
  lockedTarget: CombatEnemy | null = null;
  private readonly root = new THREE.Group();
  private readonly director: EnemyDirector;
  private readonly projectiles: ProjectilePool;
  private readonly drops: CombatDrops;
  private readonly fire: LocalFire;
  private readonly marker: THREE.Mesh;
  private readonly aimDirection = new THREE.Vector3();
  private readonly temporary = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly trees: FallingTree[] = [];
  private readonly targetHealth = new Map<string, number>();
  private readonly contactHits = new Map<string, number>();
  private readonly warned = new Set<string>();
  private swing: Swing | null = null;
  private charge = 0;
  private attackHeld = false;
  private bowHeld = false;
  private bowCharge = 0;
  private bowUid: string | null = null;
  private combo = 0;
  private comboRemaining = 0;
  private parryRemaining = 0;
  private parryCooldown = 0;
  private invulnerable = 0;
  private dodgeRemaining = 0;
  private dodgeCooldown = 0;
  private readonly dodgeDirection = new THREE.Vector3();
  private dodgeThreat: CombatEnemy | null = null;
  private dodgeThreatRemaining = 0;
  private noiseCooldown = 0;
  private restoreApples = 0;
  private disposed = false;

  constructor(private readonly ctx: GameContext) {
    this.root.name = 'asterfall-combat';
    ctx.scene.add(this.root);
    this.projectiles = new ProjectilePool(this.root);
    this.drops = new CombatDrops(ctx, this.root);
    this.director = new EnemyDirector(ctx, this.root, {
      strike: enemy => this.enemyStrike(enemy),
      shoot: enemy => this.enemyShoot(enemy),
      dropWeapon: enemy => this.dropEnemyWeapon(enemy),
      weaponPosition: id => this.drops.position(id),
      retrieveWeapon: id => this.drops.retrieve(id),
      environmentalDamage: (enemy, amount) => this.damageEnemy(enemy, amount, enemy.position, { unblockable: true, environmental: true }),
    });
    this.fire = new LocalFire(ctx, this.root, {
      hitTarget: (target, amount) => this.hitTarget(target, amount),
      hitTree: (tree, amount) => this.hitProp(tree, amount),
      damageEnemy: (enemy, amount) => this.damageEnemy(enemy, amount, enemy.position, { unblockable: true, environmental: true }),
      wear: (item, amount) => this.wear(item, amount),
    });
    this.enemies = this.director.enemies;
    this.marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.15, 0), new THREE.MeshBasicMaterial({ color: 0xf8df98, depthTest: false }));
    this.marker.renderOrder = 20;
    this.marker.visible = false;
    this.root.add(this.marker);
    this.reset();
  }

  get arrowCount(): number {
    return this.ctx.state.inventory.reduce((total, item) => total + (ITEMS[item.id]?.category === 'arrow' ? item.count : 0), 0);
  }
  get guarding(): boolean {
    const weapon = this.equipped('weapon');
    return this.ctx.input.down('Mouse2') && this.ctx.state.player.stamina > 0 && !!this.equipped('shield') &&
      !this.swing && !this.bowHeld && this.dodgeRemaining <= 0 && (!weapon || this.oneHanded(weapon.id));
  }
  get aiming(): boolean { return this.bowHeld; }

  private equipped(slot: 'weapon' | 'bow' | 'shield'): InventoryItem | undefined {
    const uid = this.ctx.state.equipment[slot];
    return uid ? this.ctx.state.inventory.find(item => item.uid === uid && item.count > 0 && (item.durability ?? 1) > 0) : undefined;
  }
  private oneHanded(id: string): boolean { return !['axe', 'spear', 'club'].includes(id) && (ITEMS[id]?.weight ?? 1) < 2; }
  private spendStamina(amount: number): boolean {
    if (this.ctx.state.player.stamina < amount) return false;
    this.ctx.state.player.stamina = Math.max(0, this.ctx.state.player.stamina - amount);
    this.ctx.actor.model.userData.staminaDelay = CONFIG.staminaDelay;
    return true;
  }

  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(CONFIG.maxDelta, dt);
    if (this.restoreApples > 0) {
      this.restoreApples--;
      for (const target of this.ctx.world.targets) if (target.resource === 'apple' && this.ctx.state.flags[`apples:detached:${target.id}`]) target.attached = false;
    }
    const realDt = Math.min(CONFIG.maxDelta, Math.max(0, this.ctx.realDt || dt));
    this.focusRemaining = Math.max(0, this.focusRemaining - realDt);
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.parryRemaining = Math.max(0, this.parryRemaining - realDt);
    this.parryCooldown = Math.max(0, this.parryCooldown - realDt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - realDt);
    this.comboRemaining = Math.max(0, this.comboRemaining - realDt);
    this.dodgeThreatRemaining = Math.max(0, this.dodgeThreatRemaining - dt);
    if (this.dodgeThreatRemaining <= 0) this.dodgeThreat = null;
    this.noiseCooldown -= dt;
    if (this.ctx.state.player.hp > 0) {
      this.updateLock(realDt);
      this.updateInput(realDt);
      this.updateDodge(realDt);
      this.updateSwing(this.focusRemaining > 0 ? realDt : dt);
      if (this.ctx.state.player.movement === 'sprint' && this.noiseCooldown <= 0) {
        this.director.noise(this.ctx.actor.position, 14);
        this.noiseCooldown = 0.35;
      }
    } else this.cancelActions();
    if (this.focusRemaining > 0) this.ctx.timeScale = Math.min(this.ctx.timeScale, CONFIG.focusScale);
    if (this.bowHeld && !this.ctx.actor.grounded && this.ctx.state.player.stamina > 0) {
      this.ctx.timeScale = Math.min(this.ctx.timeScale, 0.28);
      this.ctx.state.player.stamina = Math.max(0, this.ctx.state.player.stamina - realDt * 24);
      this.ctx.actor.model.userData.staminaDelay = CONFIG.staminaDelay;
      if (this.ctx.state.player.stamina <= 0) this.cancelBow();
    }
    this.director.update(dt);
    this.fire.update(dt, this.enemies);
    this.projectiles.update(dt, projectile => { this.fire.projectile(projectile, dt); this.projectileCollision(projectile); }, projectile => this.landProjectile(projectile, true));
    this.drops.update(dt);
    this.updateTrees(dt);
    this.ctx.inCombat = this.enemies.some(enemy => enemy.hp > 0 && enemy.position.distanceToSquared(this.ctx.actor.position) < 45 * 45 &&
      (['chase', 'telegraph', 'attack', 'stunned'].includes(enemy.state) || enemy.frozen > 0)) ||
      this.projectiles.projectiles.some(projectile => projectile.active && projectile.owner === 'enemy' && projectile.position.distanceToSquared(this.ctx.actor.position) < 30 * 30);
    this.animationFlags();
  }

  private updateInput(dt: number): void {
    const { input, state } = this.ctx;
    const restricted = state.player.movement === 'swim' || state.player.movement === 'climb' || state.player.movement === 'dead';
    if (restricted) { this.cancelActions(); return; }
    if (input.pressed('KeyG') && this.guarding && this.parryCooldown <= 0) {
      this.parryRemaining = CONFIG.parryWindow;
      this.parryCooldown = 0.48;
      this.ctx.sound('shield-raise');
    }
    if (input.pressed('Space') && input.down('Mouse2') && this.dodgeCooldown <= 0 &&
      (this.ctx.actor.grounded || this.ctx.actor.position.y - this.ctx.world.heightAt(this.ctx.actor.position.x, this.ctx.actor.position.z) < 0.45) &&
      (input.down('KeyA') || input.down('KeyD') || input.down('KeyS'))) this.beginDodge();
    if (input.pressed('KeyQ') && !this.swing && !this.bowHeld && !this.ctx.actor.model.userData.magnetTarget && !this.ctx.actor.model.userData.holdingMetal && !this.ctx.actor.model.userData.magnetHeld) this.throwWeapon();
    if (input.pressed('Mouse0') && !this.bowHeld && this.dodgeRemaining <= 0) { this.attackHeld = true; this.charge = 0; }
    if (this.attackHeld && input.down('Mouse0')) {
      this.charge = Math.min(1.8, this.charge + dt);
      if (this.charge > 0.45 && !this.spendStamina(dt * 8)) this.charge = 0.45;
    }
    if (input.released('Mouse0')) {
      if (this.attackHeld && !this.bowHeld) this.beginSwing(this.charge);
      this.attackHeld = false;
      this.charge = 0;
    } else if (this.attackHeld && !input.down('Mouse0')) { this.attackHeld = false; this.charge = 0; }
    if (input.pressed('KeyR') && !this.swing && this.dodgeRemaining <= 0) {
      const bow = this.equipped('bow');
      if (!bow) this.ctx.notify('先在背包中装备弓。', 'info');
      else if (this.arrowCount <= 0) this.ctx.notify('箭袋空了。', 'warning');
      else {
        this.bowHeld = true;
        this.bowUid = bow.uid;
        this.bowCharge = 0;
        this.attackHeld = false;
        this.ctx.sound('bow-draw');
      }
    }
    if (this.bowHeld) {
      if (this.equipped('bow')?.uid !== this.bowUid) this.cancelBow();
      else if (input.released('KeyR')) { this.shootBow(); this.cancelBow(); }
      else if (!input.down('KeyR')) this.cancelBow();
      else this.bowCharge = Math.min(1, this.bowCharge + dt / 0.7);
    }
  }

  private updateLock(dt: number): void {
    if (!this.ctx.input.down('Mouse2') || this.bowHeld) { this.lockedTarget = null; this.marker.visible = false; return; }
    const origin = this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1.4, 0));
    this.ctx.camera.getWorldDirection(this.aimDirection);
    const candidates = this.enemies.filter(enemy => {
      if (enemy.hp <= 0 || enemy.position.distanceToSquared(origin) > 27 * 27) return false;
      const eye = enemy.position.clone().add(new THREE.Vector3(0, 1.4, 0));
      const toEnemy = eye.clone().sub(this.ctx.camera.position).normalize();
      return toEnemy.dot(this.aimDirection) > 0.45 && this.director.clearSight(origin, eye) && this.director.clearSight(this.ctx.camera.position, eye);
    }).sort((a, b) => {
      const score = (enemy: CombatEnemy) => enemy.position.clone().add(new THREE.Vector3(0, 1.4, 0)).sub(this.ctx.camera.position).normalize().dot(this.aimDirection) * 20 - enemy.position.distanceTo(origin) * 0.12;
      return score(b) - score(a);
    });
    if (!this.lockedTarget || !candidates.includes(this.lockedTarget)) this.lockedTarget = candidates[0] ?? null;
    else if (this.ctx.input.wheel !== 0 && candidates.length > 1) {
      this.lockedTarget = candidates[(candidates.indexOf(this.lockedTarget) + (this.ctx.input.wheel > 0 ? 1 : candidates.length - 1)) % candidates.length];
    }
    if (!this.lockedTarget) { this.marker.visible = false; return; }
    this.temporary.copy(this.lockedTarget.position).sub(this.ctx.actor.position).setY(0).normalize();
    if (!this.swing) this.ctx.actor.facing.lerp(this.temporary, Math.min(1, dt * 18)).normalize();
    this.marker.visible = true;
    this.marker.position.copy(this.lockedTarget.position).y += 3.0 + Math.sin(this.ctx.elapsed * 4) * 0.08;
    this.marker.rotation.y += dt * 1.5;
  }

  private beginSwing(charge: number): void {
    if (this.swing && this.swing.time < this.swing.duration * 0.78) return;
    const item = this.equipped('weapon');
    const definition = item ? ITEMS[item.id] : undefined;
    const charged = charge >= 0.65 && this.spendStamina(9);
    this.combo = this.comboRemaining > 0 ? (this.combo + 1) % 3 : 0;
    this.comboRemaining = 1.1;
    this.swing = { item, definition, time: 0, duration: (charged ? 0.86 : 0.55) / (definition?.speed ?? 1.3), charged,
      airborne: !this.ctx.actor.grounded, sprinting: this.ctx.state.player.movement === 'sprint', combo: this.combo, hit: new Set(), wallHit: false, ignited: false };
    this.director.noise(this.ctx.actor.position, charged ? 18 : 10);
    this.ctx.sound(charged ? 'attack-charge' : 'swing');
  }

  private updateSwing(dt: number): void {
    const swing = this.swing;
    if (!swing) return;
    if ((swing.item && this.equipped('weapon')?.uid !== swing.item.uid) || (!swing.item && this.equipped('weapon'))) { this.swing = null; return; }
    swing.time += dt;
    if (swing.time >= swing.duration) { this.swing = null; return; }
    const phase = swing.time / swing.duration;
    if (phase < 0.18 || phase > 0.66) return;
    const position = this.ctx.actor.position;
    const range = (swing.definition?.range ?? 1.65) + (swing.sprinting ? 0.5 : 0);
    const spear = swing.item?.id === 'spear';
    const flaming = this.fire.weaponBurning(swing.item);
    if (flaming && !swing.ignited) {
      swing.ignited = true;
      const point = position.clone().addScaledVector(this.ctx.actor.facing, range * 0.65);
      const eye = position.clone().add(new THREE.Vector3(0, 1, 0));
      if (this.director.clearSight(eye, point.clone().add(new THREE.Vector3(0, 1, 0)))) this.fire.ignite(point, 2);
    }
    const minDot = swing.charged && !spear ? -1 : spear ? 0.9 : -0.05;
    const inArc = (target: THREE.Vector3) => {
      this.temporary.copy(target).sub(position);
      if (Math.abs(this.temporary.y) > (swing.airborne ? 3.2 : 2.2)) return false;
      this.temporary.y = 0;
      const distance = this.temporary.length();
      return distance <= range && (distance < 0.4 || this.temporary.normalize().dot(this.ctx.actor.facing) >= minDot);
    };
    this.center.copy(position).y += 1;
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0 || swing.hit.has(enemy.id) || !inArc(enemy.position)) continue;
      this.end.copy(enemy.position).y += 1;
      if (!this.director.clearSight(this.center, this.end)) continue;
      swing.hit.add(enemy.id);
      const stealth = ['patrol', 'sleep', 'return', 'suspicious', 'investigate'].includes(enemy.state) && enemy.suspicion < 0.8 &&
        (enemy.state === 'sleep' || enemy.facing.dot(this.temporary.copy(position).sub(enemy.position).setY(0).normalize()) < -0.15);
      const breaking = swing.item && (swing.item.durability ?? swing.definition?.durability ?? 1) <= 1;
      const multiplier = (swing.charged ? 2 : 1) * (swing.airborne ? 1.6 : swing.sprinting ? 1.35 : 1) * (stealth ? 5 : 1) * (swing.combo === 2 ? 1.25 : 1) * (breaking ? 1.5 : 1);
      this.damageEnemy(enemy, (swing.definition?.attack ?? 1) * multiplier, position, { stagger: swing.charged || swing.airborne || swing.combo === 2 || !!breaking, unblockable: stealth || swing.charged, fire: flaming });
      if (stealth) this.ctx.notify('无声突袭', 'success');
      if (swing.item && this.wear(swing.item, 1)) { this.swing = null; return; }
    }
    for (const target of this.ctx.world.targets) {
      const contact = target.collider ? target.collider.box.clampPoint(position, new THREE.Vector3()) : target.position;
      if (target.solved || swing.hit.has(target.id) || !inArc(contact)) continue;
      swing.hit.add(target.id);
      if (flaming) this.fire.ignite(target.position, 1.5);
      this.hitTarget(target, (swing.definition?.attack ?? 1) * (swing.charged ? 2 : 1));
      if (swing.item && this.wear(swing.item, 1)) { this.swing = null; return; }
    }
    for (const item of [...this.ctx.world.interactables]) {
      if (!['tree', 'pot'].includes(item.kind) || swing.hit.has(item.id) || !inArc(item.position)) continue;
      if ((item.kind === 'pot' && item.data?.breakable !== true) || (item.kind === 'tree' && this.ctx.state.flags[`felled:${item.id}`])) continue;
      swing.hit.add(item.id);
      if (flaming) this.fire.ignite(item.position, 1.5);
      this.hitProp(item, swing.item?.id === 'axe' ? 3 : swing.charged ? 2 : 1);
      if (swing.item && this.wear(swing.item, 1)) { this.swing = null; return; }
    }
    if (!swing.wallHit && swing.hit.size === 0) {
      this.end.copy(position).addScaledVector(this.ctx.actor.facing, range * 0.85).y += 1;
      if (this.ctx.world.colliders.some(collider => collider.enabled && !collider.box.containsPoint(this.center) && boxHit(this.center, this.end, collider.box) !== null)) {
        swing.wallHit = true;
        if (swing.item && this.wear(swing.item, 1)) { this.swing = null; return; }
        this.ctx.effects.burst(this.end, 0xd6caaa, 5);
        this.ctx.sound('hit-stone');
      }
    }
  }

  private wear(item: InventoryItem, amount: number): boolean {
    const maximum = ITEMS[item.id]?.durability;
    if (maximum === undefined) return false;
    item.durability = Math.max(0, (item.durability ?? maximum) - amount);
    if (item.durability <= 0) {
      const index = this.ctx.state.inventory.findIndex(candidate => candidate.uid === item.uid);
      if (index >= 0) this.ctx.state.inventory.splice(index, 1);
      for (const slot of ['weapon', 'bow', 'shield'] as const) if (this.ctx.state.equipment[slot] === item.uid) this.ctx.state.equipment[slot] = null;
      if (!this.warned.has(`broken:${item.uid}`)) {
        this.warned.add(`broken:${item.uid}`);
        this.ctx.notify(`${ITEMS[item.id].name}碎裂了！`, 'warning');
        this.ctx.sound('weapon-break');
        this.ctx.effects.burst(this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1, 0)), 0xffd6a0, 12);
      }
      return true;
    }
    if (item.durability <= Math.max(3, maximum * 0.15) && !this.warned.has(item.uid)) {
      this.warned.add(item.uid);
      this.ctx.notify(`${ITEMS[item.id].name}快要损坏了。`, 'warning');
    }
    return false;
  }

  private damageEnemy(enemy: CombatEnemy, damage: number, origin: THREE.Vector3, options: { stagger?: boolean; unblockable?: boolean; headshot?: boolean; fire?: boolean; environmental?: boolean } = {}): void {
    if (enemy.hp <= 0 || damage <= 0 || !Number.isFinite(damage)) return;
    if (options.fire && this.fire.igniteEnemy(enemy)) damage += 3;
    const frontal = enemy.facing.dot(this.temporary.copy(origin).sub(enemy.position).setY(0).normalize()) > 0.25;
    const blocked = enemy.type === 'shield' && enemy.disarmed <= 0 && enemy.frozen <= 0 && ['chase', 'suspicious', 'investigate'].includes(enemy.state) && frontal && !options.unblockable && !options.headshot;
    if (blocked) {
      damage *= 0.18;
      this.ctx.effects.ring(enemy.position.clone().add(new THREE.Vector3(0, 1.1, 0)), 0xc6e1de, 0.55);
      this.ctx.sound('shield-block', enemy.position);
    }
    enemy.hp = Math.max(0, enemy.hp - damage);
    this.ctx.effects.burst(enemy.position.clone().add(new THREE.Vector3(0, options.headshot ? 1.75 : 1.05, 0)), options.headshot ? 0xffeaa0 : 0xe0c0a0, options.headshot ? 12 : 7);
    this.ctx.sound(options.headshot ? 'headshot' : 'hit', enemy.position);
    this.ctx.effects.shake(options.stagger ? 0.13 : 0.045);
    if (!options.environmental) this.director.alert(enemy);
    if (enemy.hp <= 0) this.kill(enemy);
    else if (!options.environmental && (!blocked || options.stagger)) {
      this.director.stun(enemy, options.headshot ? 1.7 : options.stagger ? 1.1 : 0.24, !!options.stagger && damage >= 12);
      const vertical = enemy.impulse.y;
      enemy.impulse.copy(enemy.position).sub(origin).setY(0).normalize().multiplyScalar(options.stagger ? 9 : 2.8);
      enemy.impulse.y = vertical;
    }
    this.director.persist(enemy);
  }

  private kill(enemy: CombatEnemy): void {
    enemy.hp = 0;
    enemy.frozen = 0;
    this.director.transition(enemy, 'dead');
    this.director.persist(enemy);
    enemy.model.healthRoot.visible = false;
    this.ctx.sound('enemy-death', enemy.position);
    this.spawnEnemyDrops(enemy);
    if (this.lockedTarget === enemy) this.lockedTarget = null;
    if (this.enemies.every(candidate => candidate.camp !== enemy.camp || candidate.hp <= 0)) {
      this.ctx.state.flags[`campCleared:${enemy.camp}`] = true;
      this.ctx.state.flags[`camp:${enemy.camp}:cleared`] = true;
      for (const item of this.ctx.world.interactables) if (item.kind === 'chest' && item.data?.camp === enemy.camp) item.data.locked = false;
      this.ctx.notify('营地安静下来了。宝箱的封印已解除。', 'success');
      this.ctx.sound('camp-clear');
    }
  }

  private dropEnemyWeapon(enemy: CombatEnemy): void {
    const weapon = enemy.type === 'archer' ? 'bow' : enemy.type === 'shield' ? 'sword' : enemy.type === 'guardian' ? 'spear' : 'branch';
    const position = enemy.position.clone().addScaledVector(enemy.facing, 1.8);
    // Repeated disarm/death uses the same life-bound ID, so player collection cannot duplicate it.
    this.drops.spawn(enemy.weaponId, weapon, position, 1, { durability: Math.ceil((ITEMS[weapon]?.durability ?? 12) * 0.65) });
  }

  private spawnEnemyDrops(enemy: CombatEnemy): void {
    if (this.ctx.state.flags[`loot-emitted:${enemy.id}`]) return;
    this.ctx.state.flags[`loot-emitted:${enemy.id}`] = true;
    const prefix = `loot:${enemy.id}:${this.ctx.state.bloodMoonCount}`;
    this.drops.spawn(`${prefix}:material`, 'monster', enemy.position.clone().add(new THREE.Vector3(0.4, 0, 0.2)));
    if (enemy.disarmed <= 0) this.dropEnemyWeapon(enemy);
    if (enemy.type === 'archer') this.drops.spawn(`${prefix}:arrows`, 'arrows', enemy.position, 3);
    else this.drops.spawn(`${prefix}:food`, 'apple', enemy.position.clone().add(new THREE.Vector3(0.1, 0, -0.45)));
  }

  private beginDodge(): void {
    if (!this.spendStamina(12)) return;
    const forward = this.ctx.actor.facing;
    if (this.ctx.input.down('KeyA')) this.dodgeDirection.set(forward.z, 0, -forward.x);
    else if (this.ctx.input.down('KeyD')) this.dodgeDirection.set(-forward.z, 0, forward.x);
    else this.dodgeDirection.copy(forward).negate().setY(0);
    this.dodgeDirection.normalize();
    this.dodgeRemaining = 0.27;
    this.dodgeCooldown = 0.55;
    this.swing = null;
    this.attackHeld = false;
    this.cancelBow();
    this.ctx.actor.velocity.y = Math.min(0, this.ctx.actor.velocity.y);
    this.ctx.actor.grounded = true;
    this.dodgeThreat = null;
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0 || enemy.frozen > 0 || enemy.type === 'archer' || enemy.attackLanded) continue;
      const timing = enemy.state === 'telegraph' ? enemyStats(enemy).windup - enemy.stateTime + 0.1 : enemy.state === 'attack' ? 0.1 - enemy.stateTime : Infinity;
      if (timing < 0 || timing > CONFIG.dodgeWindow || !this.enemyCanHit(enemy)) continue;
      this.dodgeThreat = enemy;
      this.dodgeThreatRemaining = CONFIG.dodgeWindow + 0.3;
      break;
    }
    this.ctx.sound('dodge');
  }

  private updateDodge(dt: number): void {
    if (this.dodgeRemaining <= 0) return;
    const step = Math.min(dt, this.dodgeRemaining);
    this.dodgeRemaining -= step;
    const actor = this.ctx.actor;
    this.center.copy(actor.position).y += CONFIG.playerHeight * 0.5;
    this.end.copy(this.center).addScaledVector(this.dodgeDirection, step * 13);
    let fraction = 1;
    for (const collider of this.ctx.world.colliders) {
      if (!collider.enabled || collider.box.containsPoint(this.center)) continue;
      const time = boxHit(this.center, this.end, collider.box, CONFIG.playerRadius);
      if (time !== null) fraction = Math.min(fraction, Math.max(0, time - 0.05));
    }
    this.temporary.copy(actor.position).addScaledVector(this.dodgeDirection, step * 13 * fraction);
    const height = this.ctx.world.heightAt(this.temporary.x, this.temporary.z);
    if (height - actor.position.y <= CONFIG.stepHeight) {
      actor.position.x = this.temporary.x;
      actor.position.z = this.temporary.z;
      if (Math.abs(height - actor.position.y) < 0.6) actor.position.y = height;
      else actor.grounded = false;
    }
    actor.velocity.x = this.dodgeDirection.x * 8;
    actor.velocity.z = this.dodgeDirection.z * 8;
  }

  private enemyCanHit(enemy: CombatEnemy): boolean {
    this.temporary.copy(this.ctx.actor.position).sub(enemy.position);
    if (Math.abs(this.temporary.y) > 2.2) return false;
    this.temporary.y = 0;
    const forward = this.temporary.dot(enemy.attackDirection);
    const lateral = Math.abs(this.temporary.x * enemy.attackDirection.z - this.temporary.z * enemy.attackDirection.x);
    return forward > -0.3 && forward < enemyStats(enemy).reach + CONFIG.playerRadius && lateral < 1.0;
  }

  private enemyStrike(enemy: CombatEnemy): void {
    const hit = this.enemyCanHit(enemy);
    const from = enemy.position.clone().add(new THREE.Vector3(0, 1, 0));
    const to = this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1, 0));
    if (!hit) {
      if (this.dodgeThreat === enemy && this.dodgeThreatRemaining > 0 && this.director.clearSight(from, to)) {
        this.focusRemaining = CONFIG.focusDuration;
        this.ctx.timeScale = Math.min(this.ctx.timeScale, CONFIG.focusScale);
        this.ctx.notify('星隙专注 · 反击时机', 'success');
        this.ctx.effects.ring(this.ctx.actor.position.clone().add(new THREE.Vector3(0, 0.1, 0)), 0x9be3e7, 1.3);
        this.ctx.sound('perfect-dodge');
        this.dodgeThreat = null;
      }
      return;
    }
    if (this.director.clearSight(from, to)) this.receiveEnemyHit(enemyStats(enemy).damage, enemy.position, enemy);
  }

  /** Every hostile hit passes this deflection gate before reaching context damage. */
  private receiveEnemyHit(amount: number, origin: THREE.Vector3, enemy?: CombatEnemy, projectile?: Projectile): 'hit' | 'blocked' | 'reflected' {
    if (this.ctx.state.player.hp <= 0 || this.invulnerable > 0) return 'blocked';
    const facing = this.ctx.actor.facing.dot(this.temporary.copy(origin).sub(this.ctx.actor.position).setY(0).normalize()) > 0.15;
    const shield = this.equipped('shield');
    if (this.guarding && facing && shield) {
      if (this.parryRemaining > 0) {
        this.parryRemaining = 0;
        this.invulnerable = 0.15;
        this.ctx.effects.ring(this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1, 0)), 0xffedb5, 1.1);
        this.ctx.sound('parry');
        if (enemy) this.director.stun(enemy, 2.1, true);
        if (projectile) {
          projectile.owner = 'player';
          projectile.reflected = true;
          projectile.damage *= 2;
          const shooter = this.enemies.find(candidate => candidate.id === projectile.enemyId && candidate.hp > 0);
          this.temporary.copy(shooter ? shooter.position : origin);
          this.temporary.y += 1.45;
          projectile.velocity.copy(this.temporary).sub(projectile.position).normalize().multiplyScalar(38);
          projectile.position.addScaledVector(projectile.velocity, 0.025);
          this.director.noise(this.ctx.actor.position, 20);
          return 'reflected';
        }
        return 'blocked';
      }
      const blocked = this.spendStamina(Math.max(4, amount * 3));
      const broken = this.wear(shield, Math.max(1, Math.ceil(amount / 2)));
      this.ctx.sound('shield-block');
      this.ctx.effects.burst(this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1, 0)), 0xffd8a2, 6);
      if (blocked && !broken) { this.invulnerable = 0.2; return 'blocked'; }
      amount = Math.max(1, amount * 0.5);
    }
    this.ctx.damage(amount, projectile ? '灰牙弓手' : enemy?.type === 'guardian' ? '遗迹守卫' : '灰牙沼民');
    this.invulnerable = 0.65;
    this.swing = null;
    this.attackHeld = false;
    this.cancelBow();
    return 'hit';
  }

  private shootBow(): void {
    const bow = this.equipped('bow');
    const ammo = this.ctx.state.inventory.find(item => ITEMS[item.id]?.category === 'arrow' && item.count > 0);
    if (!bow || !ammo) return;
    const direction = this.cameraAim();
    const position = this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1.4, 0)).addScaledVector(direction, 0.65);
    const charge = Math.max(0.08, this.bowCharge);
    const velocity = direction.multiplyScalar(22 + charge * 33);
    const projectile = this.projectiles.spawn(position, velocity, (ITEMS[bow.id]?.attack ?? 6) * (0.65 + charge * 0.35), 'player');
    if (!projectile) { this.ctx.notify('先等待飞箭落地。', 'info'); return; }
    projectile.burning = this.fire.weaponBurning(bow) || this.fire.weaponBurning(this.equipped('weapon'));
    ammo.count--;
    if (ammo.count <= 0) this.ctx.state.inventory.splice(this.ctx.state.inventory.indexOf(ammo), 1);
    this.wear(bow, 1);
    this.ctx.sound('bow-fire');
    this.director.noise(this.ctx.actor.position, 8);
  }

  private cameraAim(): THREE.Vector3 {
    this.ctx.camera.getWorldDirection(this.aimDirection);
    const cameraEnd = this.ctx.camera.position.clone().addScaledVector(this.aimDirection, 90);
    let nearest = 1;
    for (const collider of this.ctx.world.colliders) {
      if (!collider.enabled || collider.box.containsPoint(this.ctx.camera.position)) continue;
      const time = boxHit(this.ctx.camera.position, cameraEnd, collider.box);
      if (time !== null) nearest = Math.min(nearest, time);
    }
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0) continue;
      const time = sphereHit(this.ctx.camera.position, cameraEnd, enemy.position.clone().add(new THREE.Vector3(0, 1.3, 0)), 0.7);
      if (time !== null) nearest = Math.min(nearest, time);
    }
    const terrain = terrainHit(this.ctx.camera.position, cameraEnd, this.ctx.world);
    if (terrain !== null) nearest = Math.min(nearest, terrain);
    const target = this.ctx.camera.position.clone().lerp(cameraEnd, nearest);
    const hand = this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1.4, 0));
    return target.sub(hand).normalize();
  }

  private throwWeapon(): void {
    const item = this.equipped('weapon');
    if (!item) return;
    const direction = this.cameraAim();
    const position = this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1.35, 0)).addScaledVector(direction, 0.75);
    const velocity = direction.multiplyScalar(21);
    velocity.y += 2.2;
    const projectile = this.projectiles.spawn(position, velocity, (ITEMS[item.id]?.attack ?? 2) * 2, 'player', undefined, item);
    if (!projectile) return;
    projectile.burning = this.fire.weaponBurning(item);
    this.ctx.state.inventory.splice(this.ctx.state.inventory.indexOf(item), 1);
    this.ctx.state.equipment.weapon = null;
    // Persist a recoverable landing record immediately so saving mid-flight cannot delete equipment.
    this.drops.spawn(`thrown:${item.uid}`, item.id, this.ctx.actor.position, 1, item);
    this.drops.defer(`thrown:${item.uid}`);
    this.ctx.sound('throw');
    this.director.noise(this.ctx.actor.position, 10);
    this.attackHeld = false;
  }

  private enemyShoot(enemy: CombatEnemy): void {
    const origin = enemy.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    const target = this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1.05, 0));
    if (!this.director.clearSight(origin, target)) return;
    const distance = origin.distanceTo(target);
    const flightTime = Math.max(0.12, distance / 26);
    target.addScaledVector(this.ctx.actor.velocity, Math.min(0.3, flightTime * 0.5));
    const velocity = target.sub(origin).divideScalar(flightTime);
    velocity.y += CONFIG.gravity * 0.38 * flightTime * 0.5;
    this.projectiles.spawn(origin, velocity, enemyStats(enemy).damage, 'enemy', enemy.id);
    this.ctx.sound('enemy-bow', origin);
  }

  private projectileCollision(projectile: Projectile): void {
    let nearest = 1.01;
    let enemyHit: CombatEnemy | null = null;
    let headshot = false;
    let targetHit: AbilityTarget | null = null;
    let propHit: Interactable | null = null;
    let playerHit = false;
    const consider = (time: number | null, action: () => void) => {
      if (time !== null && time <= nearest) { nearest = time; enemyHit = null; targetHit = null; propHit = null; playerHit = false; headshot = false; action(); }
    };
    for (const collider of this.ctx.world.colliders) {
      if (!collider.enabled) continue;
      consider(boxHit(projectile.previous, projectile.position, collider.box, 0.025), () => {});
    }
    consider(terrainHit(projectile.previous, projectile.position, this.ctx.world), () => {});
    if (projectile.owner === 'player') {
      for (const enemy of this.enemies) {
        if (enemy.hp <= 0) continue;
        this.center.copy(enemy.position).y += 0.9;
        consider(sphereHit(projectile.previous, projectile.position, this.center, 0.58), () => { enemyHit = enemy; });
        this.center.copy(enemy.position).y += enemy.type === 'guardian' ? 2 : 1.7;
        consider(sphereHit(projectile.previous, projectile.position, this.center, 0.38), () => { enemyHit = enemy; headshot = true; });
      }
    } else {
      this.center.copy(this.ctx.actor.position).y += 0.6;
      consider(sphereHit(projectile.previous, projectile.position, this.center, 0.53), () => { playerHit = true; });
      this.center.y += 0.65;
      consider(sphereHit(projectile.previous, projectile.position, this.center, 0.48), () => { playerHit = true; });
    }
    // Either side's arrows can detach fruit and hit environmental bodies.
    for (const target of this.ctx.world.targets) {
      if (target.solved) continue;
      const time = target.collider ? boxHit(projectile.previous, projectile.position, target.collider.box, 0.04) : sphereHit(projectile.previous, projectile.position, target.position, target.resource === 'apple' ? 0.24 : 0.7);
      consider(time, () => { targetHit = target; });
    }
    for (const prop of this.ctx.world.interactables) {
      if (prop.mesh?.visible === false || prop.data?.disabled === true || this.ctx.state.flags[`picked:${prop.id}`]) continue;
      if (prop.kind === 'tree' && !this.ctx.state.flags[`felled:${prop.id}`]) {
        this.center.copy(prop.position).y += 1.5;
        consider(sphereHit(projectile.previous, projectile.position, this.center, 0.8), () => { propHit = prop; });
      } else if (prop.item === 'apple' && prop.kind === 'pickup' && prop.position.y > this.ctx.world.heightAt(prop.position.x, prop.position.z) + 0.7) {
        consider(sphereHit(projectile.previous, projectile.position, prop.position, 0.35), () => { propHit = prop; });
      } else if (prop.kind === 'pot') consider(sphereHit(projectile.previous, projectile.position, prop.position, 0.55), () => { propHit = prop; });
    }
    if (nearest > 1) return;
    projectile.position.lerpVectors(projectile.previous, projectile.position, nearest);
    if (playerHit) {
      const origin = projectile.position.clone().addScaledVector(projectile.velocity, -0.1);
      const result = this.receiveEnemyHit(projectile.damage, origin, undefined, projectile);
      if (result === 'reflected') return;
      if (result === 'hit' && projectile.burning) this.fire.igniteActor();
    } else if (enemyHit) {
      this.damageEnemy(enemyHit, projectile.damage * (headshot ? 2.5 : 1), projectile.previous, { headshot, stagger: headshot || !!projectile.item, unblockable: projectile.reflected, fire: projectile.burning });
    } else if (targetHit) this.hitTarget(targetHit, projectile.damage, projectile.previous);
    else if (propHit) {
      const prop = propHit as Interactable;
      if (prop.item === 'apple' && prop.kind !== 'tree') this.dropHangingApple(prop, projectile.previous);
      else if (prop.kind === 'tree') this.shakeApples(prop);
      else this.hitProp(prop, 1);
    }
    if (projectile.burning) {
      this.fire.ignite(projectile.position, 3);
      this.ctx.effects.burst(projectile.position, 0xff9e3a, 8);
    }
    if (projectile.item && (enemyHit || targetHit || propHit)) this.wear(projectile.item, 1);
    this.director.noise(projectile.position, 7);
    this.landProjectile(projectile);
  }

  private landProjectile(projectile: Projectile, expired = false): void {
    const safe = projectile.position.clone();
    if (expired && (safe.y < -50 || Math.hypot(safe.x, safe.z) > CONFIG.radius + 20)) safe.copy(this.ctx.actor.position);
    if (projectile.item) {
      // The pending record is moved atomically, keeping its original durability and UID identity.
      this.drops.relocate(`thrown:${projectile.item.uid}`, safe, projectile.item.durability ?? ITEMS[projectile.item.id]?.durability ?? 1);
    } else this.drops.spawn(this.drops.uniqueId('arrow'), 'arrows', safe);
    this.projectiles.release(projectile);
  }

  hitArea(position: THREE.Vector3, radius: number, damage: number, explosive = true, source?: AbilityTarget): void {
    if (!position.toArray().every(Number.isFinite) || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(damage) || damage <= 0) return;
    this.director.noise(position, Math.max(24, radius * 5));
    if (explosive) this.fire.ignite(position, radius);
    for (const enemy of this.enemies) {
      const distance = enemy.position.distanceTo(position);
      if (enemy.hp <= 0 || distance > radius + 0.5) continue;
      if (source?.collider) {
        this.center.copy(enemy.position).y += 1;
        if (source.collider.box.distanceToPoint(this.center) > 0.6) continue;
      }
      if (source) {
        const key = `${source.id}:${enemy.id}`;
        if (this.ctx.elapsed < (this.contactHits.get(key) ?? -Infinity)) continue;
        this.contactHits.set(key, this.ctx.elapsed + 0.45);
      }
      const power = Math.max(0.3, 1 - distance / (radius + 1));
      const previousHp = enemy.hp;
      this.damageEnemy(enemy, damage * power, position, { stagger: true, unblockable: true, fire: explosive });
      if (source?.kind === 'metal' && enemy.hp < previousHp) this.ctx.state.flags[`metal-hit:${enemy.id}`] = true;
      const vertical = enemy.impulse.y;
      enemy.impulse.copy(enemy.position).sub(position).setY(0);
      if (enemy.impulse.lengthSq() < 0.01) enemy.impulse.copy(enemy.facing).negate();
      enemy.impulse.normalize().multiplyScalar(14 * power);
      enemy.impulse.y = explosive ? 6 + 8 * power : vertical;
      if (explosive) enemy.grounded = false;
      if (enemy.hp > 0) this.director.stun(enemy, 1.6);
    }
    for (const target of this.ctx.world.targets) if (target !== source && !target.solved && target.position.distanceTo(position) <= radius + 0.6) {
      const key = source ? `${source.id}:prop:${target.id}` : '';
      if (source && this.ctx.elapsed < (this.contactHits.get(key) ?? -Infinity)) continue;
      if (source) this.contactHits.set(key, this.ctx.elapsed + 0.45);
      this.hitTarget(target, damage, position);
    }
    for (const item of [...this.ctx.world.interactables]) if (item.position.distanceTo(position) <= radius + 1) {
      if (item.kind === 'tree' || item.kind === 'pot') this.hitProp(item, Math.max(1, damage / 6));
    }
    if (explosive) for (const projectile of this.projectiles.projectiles) if (projectile.active && projectile.position.distanceTo(position) < radius && !this.fire.inWater(projectile.position) && (!projectile.item || ITEMS[projectile.item.id]?.flammable)) projectile.burning = true;
  }

  hitTarget(target: AbilityTarget, amount: number, origin = this.ctx.actor.position): void {
    if (target.solved || !Number.isFinite(amount) || amount <= 0) return;
    if (target.resource === 'apple') {
      this.detachApple(target, origin, Math.min(9, 1 + amount * 0.25));
      return;
    }
    if ((target.frozen ?? 0) > 0) {
      target.charge = Math.min(6, (target.charge ?? 0) + (amount >= 14 ? 2 : 1));
      this.ctx.effects.burst(target.position, 0xffd877, 8);
      this.ctx.effects.ring(target.position, 0xffd877, 0.5 + target.charge / 3);
      this.ctx.sound('stasis-hit', target.position);
      return;
    }
    if (target.kind === 'orb' && target.resource === 'log') {
      const broken = `broken:${target.id}`;
      if (!this.ctx.state.flags[broken]) {
        const hp = (this.targetHealth.get(target.id) ?? 12) - amount;
        this.targetHealth.set(target.id, hp);
        this.ctx.effects.burst(target.position, 0xbd9768, 7);
        this.ctx.sound('chop', target.position);
        if (hp > 0) return;
        this.ctx.state.flags[broken] = true;
        this.drops.spawn(`wood:${target.id}:${this.ctx.state.bloodMoonCount}`, 'wood', target.position, 3);
      }
      target.solved = true;
      target.mesh.visible = false;
      target.velocity?.set(0, 0, 0);
      if (target.collider) target.collider.enabled = false;
      this.targetHealth.delete(target.id);
      return;
    }
    if (target.kind === 'barrel' || target.kind === 'cracked') {
      const hp = (this.targetHealth.get(target.id) ?? (target.kind === 'barrel' ? 8 : 18)) - amount;
      this.targetHealth.set(target.id, hp);
      if (hp > 0) { this.ctx.effects.burst(target.position, 0xc0ab85, 5); return; }
      target.solved = true; // Mark first: chained blast barrels cannot recurse back into themselves.
      this.ctx.state.flags[`destroyed:${target.id}`] = true;
      if (target.collider) target.collider.enabled = false;
      target.mesh.visible = false;
      this.ctx.effects.burst(target.position, target.kind === 'barrel' ? 0xffb56d : 0xc1c5b8, 22);
      this.ctx.sound(target.kind === 'barrel' ? 'explosion' : 'stone-break', target.position);
      if (target.kind === 'barrel') {
        this.hitArea(target.position.clone(), 5.3, 24);
        if (this.ctx.actor.position.distanceTo(target.position) < 5.3) this.receiveEnemyHit(4, target.position);
      }
    } else if (target.kind === 'orb' || target.kind === 'metal' || target.kind === 'rotor') {
      if (!target.velocity) target.velocity = new THREE.Vector3();
      target.velocity.add(this.temporary.copy(target.position).sub(origin).setY(0).normalize().multiplyScalar(Math.min(9, amount * 0.4)));
      target.velocity.clampLength(0, 15);
      this.ctx.effects.burst(target.position, 0xc8e3e2, 5);
      this.ctx.sound('hit-metal', target.position);
    }
  }

  /** Enemy stasis bridge: enemy is deliberately not added to the locked AbilityTarget union. */
  freezeNearest(origin: THREE.Vector3, radius: number, duration: number): CombatEnemy | null {
    if (radius <= 0 || duration <= 0) return null;
    const enemy = this.enemies.filter(candidate => candidate.hp > 0 && candidate.position.distanceTo(origin) <= radius)
      .sort((a, b) => a.position.distanceToSquared(origin) - b.position.distanceToSquared(origin))[0];
    if (!enemy) return null;
    enemy.frozen = Math.min(enemy.type === 'guardian' ? 1.3 : 3.5, duration);
    this.ctx.effects.ring(enemy.position, 0xffd978, 1);
    this.ctx.sound('stasis', enemy.position);
    return enemy;
  }

  private hitProp(item: Interactable, amount: number): void {
    if (item.kind === 'tree') {
      if (this.ctx.state.flags[`felled:${item.id}`] || item.data?.felled) return;
      this.shakeApples(item);
      item.data ??= {};
      item.data.chops = Number(item.data.chops ?? 0) + amount;
      this.ctx.effects.burst(item.position.clone().add(new THREE.Vector3(0, 1, 0)), 0xbd9768, 7);
      this.ctx.sound('chop', item.position);
      if (Number(item.data.chops) < 6) return;
      item.data.felled = true;
      this.ctx.state.flags[`felled:${item.id}`] = true;
      this.disablePropCollider(item);
      if (item.mesh) {
        const axis = this.ctx.actor.facing.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
        this.trees.push({ item, time: 0, rotation: item.mesh.quaternion.clone(), axis });
      }
      // World creates log:<tree-id>; only breaking that physical body yields wood.
      this.director.noise(item.position, 24);
    } else if (item.kind === 'pot' && item.data?.breakable === true && !this.ctx.state.flags[`broken:${item.id}`]) {
      this.ctx.state.flags[`broken:${item.id}`] = true;
      if (item.mesh) item.mesh.visible = false;
      this.disablePropCollider(item);
      this.ctx.effects.burst(item.position, 0xc7966c, 12);
      this.ctx.sound('pot-break', item.position);
      this.drops.spawn(`pot:${item.id}:${this.ctx.state.bloodMoonCount}`, item.item ?? 'apple', item.position);
      const index = this.ctx.world.interactables.indexOf(item);
      if (index >= 0) this.ctx.world.interactables.splice(index, 1);
    }
  }

  private disablePropCollider(item: Interactable): void {
    for (const collider of this.ctx.world.colliders) {
      let attached = collider.mesh;
      while (attached && attached !== item.mesh) attached = attached.parent ?? undefined;
      if (collider.id === item.id || collider.id === `${item.id}:trunk` || (item.mesh && attached === item.mesh)) collider.enabled = false;
    }
  }

  private shakeApples(tree: Interactable): void {
    this.ctx.state.flags[`shaken:${tree.id}`] = true;
    for (const apple of this.ctx.world.targets) {
      if (apple.resource === 'apple' && !apple.solved && apple.attached && apple.mesh.userData.treeId === tree.id) this.detachApple(apple, tree.position, 2.2);
    }
  }

  private dropHangingApple(apple: Interactable, origin = this.ctx.actor.position): void {
    const body = this.ctx.world.targets.find(target => target.id === apple.id && target.resource === 'apple');
    if (body && !body.solved) this.detachApple(body, origin, 3);
  }

  private detachApple(apple: AbilityTarget, origin: THREE.Vector3, strength: number): void {
    if (apple.solved || this.ctx.state.flags[`picked:${apple.id}`]) return;
    apple.attached = false;
    this.ctx.state.flags[`apples:detached:${apple.id}`] = true;
    const pickup = this.ctx.world.interactables.find(item => item.id === apple.id);
    if (pickup) (pickup.data ??= {}).fallen = true;
    const direction = apple.position.clone().sub(origin).setY(0);
    if (direction.lengthSq() < 0.01) direction.copy(this.ctx.actor.facing);
    direction.normalize().multiplyScalar(strength);
    direction.y = Math.min(4, 0.8 + strength * 0.35);
    (apple.velocity ??= new THREE.Vector3()).add(direction).clampLength(0, 12);
    if ((apple.frozen ?? 0) > 0) apple.charge = Math.min(6, (apple.charge ?? 0) + 1);
    // Keep its world position and visible mesh; AbilitySystem owns gravity, rolling and buoyancy.
    this.ctx.effects.burst(apple.position, 0xb6c878, 3);
  }

  private updateTrees(dt: number): void {
    for (let index = this.trees.length - 1; index >= 0; index--) {
      const tree = this.trees[index];
      tree.time = Math.min(1, tree.time + dt / 0.8);
      tree.item.mesh?.quaternion.copy(tree.rotation).premultiply(new THREE.Quaternion().setFromAxisAngle(tree.axis, tree.time * tree.time * Math.PI * 0.48));
      if (tree.time >= 1) {
        this.ctx.effects.burst(tree.item.position, 0xafaa80, 15);
        this.trees.splice(index, 1);
      }
    }
  }

  private cancelBow(): void { this.bowHeld = false; this.bowCharge = 0; this.bowUid = null; }
  private cancelActions(): void {
    this.swing = null;
    this.attackHeld = false;
    this.charge = 0;
    this.cancelBow();
    this.lockedTarget = null;
    this.marker.visible = false;
    this.dodgeRemaining = 0;
    this.parryRemaining = 0;
  }

  private animationFlags(): void {
    const data = this.ctx.actor.model.userData;
    data.attacking = !!this.swing;
    data.attackProgress = this.swing ? this.swing.time / this.swing.duration : 0;
    data.attackCombo = this.combo;
    data.charging = this.attackHeld && this.charge >= 0.4;
    data.chargedAttack = this.swing?.charged ?? false;
    data.guarding = this.guarding;
    data.parrying = this.parryRemaining > 0;
    data.dodging = this.dodgeRemaining > 0;
    data.aiming = this.bowHeld;
    data.bowDraw = this.bowCharge;
    data.focusRemaining = this.focusRemaining;
    data.lockTarget = this.lockedTarget?.position ?? null;
    data.lockedTargetId = this.lockedTarget?.id ?? null;
    data.cameraMode = this.bowHeld ? 'aim' : this.lockedTarget ? 'lock' : 'explore';
    data.shoulderOffset = this.bowHeld ? 0.65 : 0;
    data.weaponWarning = !!this.equipped('weapon') && (this.equipped('weapon')?.durability ?? 100) <= 4;
  }

  reset(): void {
    this.cancelActions();
    this.projectiles.reset();
    this.focusRemaining = 0;
    this.invulnerable = 0;
    this.parryCooldown = 0;
    this.dodgeCooldown = 0;
    this.dodgeThreat = null;
    this.dodgeThreatRemaining = 0;
    this.comboRemaining = 0;
    this.combo = 0;
    this.trees.length = 0;
    this.targetHealth.clear();
    this.contactHits.clear();
    this.warned.clear();
    this.ctx.inCombat = false;
    this.drops.reset();
    this.director.reset();
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0) this.spawnEnemyDrops(enemy);
      else {
        delete this.ctx.state.flags[`loot-emitted:${enemy.id}`];
        delete this.ctx.state.flags[`campCleared:${enemy.camp}`];
        delete this.ctx.state.flags[`camp:${enemy.camp}:cleared`];
      }
    }
    for (const target of this.ctx.world.targets) {
      if (this.ctx.state.flags[`destroyed:${target.id}`] || (target.resource === 'log' && this.ctx.state.flags[`broken:${target.id}`])) {
        target.solved = true;
        target.mesh.visible = false;
        if (target.collider) target.collider.enabled = false;
      }
      if (target.resource === 'apple' && (this.ctx.state.flags[`apples:detached:${target.id}`] || this.ctx.state.flags[`shaken:${String(target.mesh.userData.treeId)}`])) target.attached = false;
    }
    for (const item of this.ctx.world.interactables) if (item.kind === 'tree') {
      if (this.ctx.state.flags[`felled:${item.id}`]) {
        if (item.mesh) item.mesh.visible = false;
        this.disablePropCollider(item);
      } else if (item.data?.felled) {
        item.data.felled = false;
        item.data.chops = 0;
        if (item.mesh) { item.mesh.visible = true; item.mesh.quaternion.identity(); }
      }
    }
    this.fire.reset();
    this.restoreApples = 2;
    this.animationFlags();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelActions();
    this.focusRemaining = 0;
    this.animationFlags();
    this.fire.dispose();
    this.director.dispose();
    this.projectiles.dispose();
    this.drops.dispose();
    this.marker.geometry.dispose();
    (this.marker.material as THREE.Material).dispose();
    this.root.removeFromParent();
    this.ctx.inCombat = false;
    this.disposed = true;
  }
}
