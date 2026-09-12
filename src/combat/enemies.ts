import * as THREE from 'three';
import { CONFIG } from '../config/game';
import type { EnemySpawn, GameContext } from '../core/types';
import { createBogModel, disposeObject } from './models';
import type { BogModel } from './models';
import { boxHit, terrainHit } from './projectiles';

export type EnemyState = 'patrol' | 'sleep' | 'suspicious' | 'investigate' | 'chase' | 'telegraph' | 'attack' | 'stunned' | 'return' | 'dead';
export interface CombatEnemy {
  id: string;
  type: EnemySpawn['type'];
  camp: string;
  hp: number;
  maxHp: number;
  position: THREE.Vector3;
  home: THREE.Vector3;
  facing: THREE.Vector3;
  lastSeen: THREE.Vector3;
  impulse: THREE.Vector3;
  model: BogModel;
  state: EnemyState;
  stateTime: number;
  suspicion: number;
  lostTime: number;
  cooldown: number;
  frozen: number;
  disarmed: number;
  weaponId: string;
  retrievalTime: number;
  grounded: boolean;
  stunDuration: number;
  attackLanded: boolean;
  attackDirection: THREE.Vector3;
  patrolPhase: number;
  awareness: number;
}

const STATS = {
  melee: { hp: 28, speed: 3.7, reach: 2.1, damage: 2, windup: 0.8 },
  shield: { hp: 44, speed: 3.1, reach: 2.3, damage: 3, windup: 0.95 },
  archer: { hp: 22, speed: 3.4, reach: 19, damage: 2, windup: 1.05 },
  guardian: { hp: 62, speed: 3.6, reach: 2.7, damage: 4, windup: 1.1 },
} as const;
export const enemyStats = (enemy: CombatEnemy) => STATS[enemy.type];

export interface EnemyPorts {
  strike(enemy: CombatEnemy): void;
  shoot(enemy: CombatEnemy): void;
  dropWeapon(enemy: CombatEnemy): void;
  weaponPosition(id: string): THREE.Vector3 | undefined;
  retrieveWeapon(id: string): boolean;
  environmentalDamage(enemy: CombatEnemy, amount: number): void;
}

export class EnemyDirector {
  readonly enemies: CombatEnemy[] = [];
  private readonly eye = new THREE.Vector3();
  private readonly playerEye = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly candidate = new THREE.Vector3();
  private readonly waypoint = new THREE.Vector3();
  private clock = 0;

  constructor(private readonly ctx: GameContext, private readonly root: THREE.Group, private readonly ports: EnemyPorts) {}

  reset(): void {
    this.enemies.forEach(enemy => disposeObject(enemy.model.root));
    this.enemies.length = 0;
    for (const spawn of this.ctx.world.spawns) {
      const model = createBogModel(spawn.type);
      const save = this.ctx.state.enemies[spawn.id];
      const maxHp = STATS[spawn.type].hp;
      const dead = save?.dead || save?.hp === 0;
      const position = new THREE.Vector3().fromArray(save?.position ?? spawn.position);
      // A deferred blood-moon spawn keeps the previous life's weapon identity.
      const lifePrefix = `weapon-life:${spawn.id}:`;
      const lifeKeys = Object.keys(this.ctx.state.flags).filter(key => key.startsWith(lifePrefix));
      const life = save ? lifeKeys.find(key => this.ctx.state.flags[key])?.slice(lifePrefix.length) ?? String(this.ctx.state.bloodMoonCount) : String(this.ctx.state.bloodMoonCount);
      for (const key of lifeKeys) delete this.ctx.state.flags[key];
      this.ctx.state.flags[lifePrefix + life] = true;
      if (!save) delete this.ctx.state.flags[`disarmed:${spawn.id}`];
      const enemy: CombatEnemy = {
        id: spawn.id, type: spawn.type, camp: spawn.camp,
        hp: dead ? 0 : Math.max(1, Math.min(maxHp, save?.hp ?? maxHp)), maxHp,
        position, home: new THREE.Vector3().fromArray(spawn.position), facing: new THREE.Vector3(0, 0, -1),
        lastSeen: position.clone(), impulse: new THREE.Vector3(), model,
        state: dead ? 'dead' : this.isNight() && spawn.type !== 'archer' ? 'sleep' : 'patrol',
        stateTime: 0, suspicion: 0, lostTime: 0, cooldown: 0.8, frozen: 0,
        disarmed: this.ctx.state.flags[`disarmed:${spawn.id}`] ? 1 : 0,
        weaponId: `weapon:${spawn.id}:${life}`, retrievalTime: 0,
        grounded: position.y <= this.supportHeight(position, position.y + 0.15) + 0.1,
        stunDuration: 0, attackLanded: false, attackDirection: new THREE.Vector3(0, 0, -1),
        patrolPhase: [...spawn.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 50,
        awareness: 0,
      };
      model.root.position.copy(position);
      model.root.visible = !dead;
      model.weapon.visible = enemy.disarmed <= 0;
      model.root.userData.enemyId = enemy.id;
      this.root.add(model.root);
      this.enemies.push(enemy);
      this.persist(enemy);
    }
  }

  private isNight(): boolean { const hour = ((this.ctx.state.time % 24) + 24) % 24; return hour < 6 || hour > 20; }

  persist(enemy: CombatEnemy): void {
    this.ctx.state.enemies[enemy.id] = { hp: enemy.hp, dead: enemy.hp <= 0, position: [enemy.position.x, enemy.position.y, enemy.position.z] };
  }

  transition(enemy: CombatEnemy, state: EnemyState): void {
    enemy.state = state;
    enemy.stateTime = 0;
    enemy.model.root.userData.state = state;
    if (state === 'telegraph') {
      enemy.attackLanded = false;
      enemy.attackDirection.copy(this.ctx.actor.position).sub(enemy.position).setY(0).normalize();
      enemy.facing.copy(enemy.attackDirection);
      this.ctx.effects.ring(enemy.position.clone().addScalar(0.02), 0xf6b369, enemyStats(enemy).reach);
      this.ctx.sound('enemy-windup', enemy.position);
    }
  }

  clearSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    for (const collider of this.ctx.world.colliders) {
      if (!collider.enabled || collider.box.containsPoint(from)) continue;
      const hit = boxHit(from, to, collider.box);
      if (hit !== null && hit < 0.985) return false;
    }
    return terrainHit(from, to, this.ctx.world) === null;
  }

  alert(enemy: CombatEnemy, companions = true): void {
    if (enemy.hp <= 0) return;
    const wasAware = ['chase', 'telegraph', 'attack'].includes(enemy.state);
    if (enemy.state !== 'stunned' && enemy.state !== 'attack' && enemy.state !== 'telegraph') this.transition(enemy, 'chase');
    enemy.suspicion = 1;
    enemy.lostTime = 0;
    enemy.lastSeen.copy(this.ctx.actor.position);
    if (!wasAware) {
      this.ctx.sound('enemy-alert', enemy.position);
      this.ctx.effects.burst(enemy.position.clone().add(new THREE.Vector3(0, 2.5, 0)), 0xf6b369, 4);
    }
    if (companions) for (const friend of this.enemies) {
      if (friend === enemy || friend.hp <= 0 || friend.camp !== enemy.camp || friend.position.distanceTo(enemy.position) > 28) continue;
      if (friend.state === 'patrol' || friend.state === 'sleep' || friend.state === 'return' || friend.state === 'suspicious') {
        friend.lastSeen.copy(enemy.lastSeen);
        friend.suspicion = 0.65;
        this.transition(friend, 'investigate');
      }
    }
  }

  noise(position: THREE.Vector3, radius: number): void {
    for (const enemy of this.enemies) {
      if (enemy.hp <= 0 || enemy.position.distanceTo(position) > radius || ['chase', 'attack', 'telegraph', 'stunned'].includes(enemy.state)) continue;
      enemy.lastSeen.copy(position);
      enemy.suspicion = Math.max(enemy.suspicion, 0.32);
      if (enemy.state !== 'investigate') this.transition(enemy, 'suspicious');
    }
  }

  stun(enemy: CombatEnemy, duration: number, disarm = false): void {
    if (enemy.hp <= 0) return;
    enemy.stunDuration = Math.max(enemy.stunDuration, duration);
    if (disarm && enemy.disarmed <= 0) {
      enemy.disarmed = 1;
      enemy.retrievalTime = 0;
      enemy.model.weapon.visible = false;
      this.ctx.state.flags[`disarmed:${enemy.id}`] = true;
      this.ports.dropWeapon(enemy);
    }
    this.transition(enemy, 'stunned');
    this.persist(enemy);
  }

  update(dt: number): void {
    this.clock += dt;
    for (const enemy of this.enemies) {
      enemy.frozen = Math.max(0, enemy.frozen - dt);
      enemy.model.root.userData.frozen = enemy.frozen > 0;
      if (enemy.frozen > 0 && enemy.hp > 0) { this.animate(enemy, 0); continue; }
      this.updateMotion(enemy, dt);
      if (enemy.hp > 0) {
        const water = this.ctx.world.waters.find(area => enemy.position.x >= area.minX && enemy.position.x <= area.maxX && enemy.position.z >= area.minZ && enemy.position.z <= area.maxZ && enemy.position.y + 1.4 < area.level);
        if (water) {
          this.ctx.effects.burst(enemy.position.clone().setY(water.level), 0x94dfe8, 12);
          this.ports.environmentalDamage(enemy, enemy.hp);
        }
      }
      if (enemy.hp <= 0) {
        enemy.model.root.position.copy(enemy.position);
        if (enemy.model.root.visible) {
          enemy.stateTime += dt;
          enemy.model.body.rotation.z = Math.min(Math.PI / 2, enemy.stateTime * 4);
          enemy.model.root.scale.multiplyScalar(Math.max(0.01, 1 - dt * 2));
          if (enemy.stateTime > 1.2) enemy.model.root.visible = false;
        }
        this.persist(enemy);
        continue;
      }
      const distance = enemy.position.distanceTo(this.ctx.actor.position);
      enemy.stateTime += dt;
      enemy.cooldown = Math.max(0, enemy.cooldown - dt);
      if (distance > 72 || !enemy.grounded) {
        this.animate(enemy, dt);
        if (distance > 72) enemy.model.healthRoot.visible = false;
        this.persist(enemy);
        continue;
      }
      if (enemy.state === 'stunned') {
        enemy.stunDuration -= dt;
        if (enemy.stunDuration <= 0) this.transition(enemy, 'chase');
        this.animate(enemy, dt);
        this.persist(enemy);
        continue;
      }
      if (enemy.disarmed > 0) {
        this.recoverWeapon(enemy, dt);
        this.animate(enemy, dt);
        this.persist(enemy);
        continue;
      }
      const crouched = this.ctx.state.player.movement === 'crouch';
      const vision = (this.isNight() ? 15 : 25) * (crouched ? 0.56 : 1);
      this.direction.copy(this.ctx.actor.position).sub(enemy.position).setY(0).normalize();
      this.eye.copy(enemy.position).y += 1.65;
      this.playerEye.copy(this.ctx.actor.position).y += crouched ? 0.65 : 1.3;
      enemy.awareness -= dt;
      let sees = enemy.model.root.userData.seesPlayer === true;
      if (enemy.awareness <= 0) {
        enemy.awareness = 0.12 + (enemy.patrolPhase % 4) * 0.015;
        sees = this.ctx.state.player.hp > 0 && enemy.state !== 'sleep' && distance < vision &&
          (distance < 2.3 || enemy.facing.dot(this.direction) > (enemy.state === 'chase' ? -0.35 : 0.3)) && this.clearSight(this.eye, this.playerEye);
        enemy.model.root.userData.seesPlayer = sees;
      }
      if (sees) {
        enemy.lastSeen.copy(this.ctx.actor.position);
        enemy.lostTime = 0;
        enemy.suspicion = Math.min(1, enemy.suspicion + dt * (crouched ? 0.85 : 2.1));
        if (enemy.suspicion >= 1 && enemy.state !== 'attack' && enemy.state !== 'telegraph') this.alert(enemy);
        else if (enemy.state === 'patrol' || enemy.state === 'return') this.transition(enemy, 'suspicious');
      } else enemy.lostTime += dt;
      const stats = enemyStats(enemy);
      switch (enemy.state) {
        case 'sleep':
          if (!this.isNight()) this.transition(enemy, 'patrol');
          break;
        case 'patrol': {
          const angle = this.clock * 0.13 + enemy.patrolPhase;
          this.waypoint.copy(enemy.home).add(new THREE.Vector3(Math.cos(angle) * 3.5, 0, Math.sin(angle) * 3.5));
          this.walkToward(enemy, this.waypoint, 1.15, dt);
          if (this.isNight() && enemy.type !== 'archer' && enemy.stateTime > 8) this.transition(enemy, 'sleep');
          break;
        }
        case 'suspicious':
          enemy.facing.lerp(this.direction.copy(enemy.lastSeen).sub(enemy.position).setY(0).normalize(), Math.min(1, dt * 3)).normalize();
          if (enemy.stateTime > 0.6) this.transition(enemy, 'investigate');
          break;
        case 'investigate':
          this.walkToward(enemy, enemy.lastSeen, 1.8, dt);
          if (enemy.stateTime > 8) { enemy.suspicion = 0; this.transition(enemy, 'return'); }
          break;
        case 'chase':
          if (enemy.position.distanceTo(enemy.home) > 38 || enemy.lostTime > 6 || this.ctx.state.player.hp <= 0) {
            enemy.suspicion = 0.3;
            this.transition(enemy, 'return');
          } else if (sees && distance < stats.reach && Math.abs(this.ctx.actor.position.y - enemy.position.y) < (enemy.type === 'archer' ? 14 : 2.2) && enemy.cooldown <= 0 && enemy.disarmed <= 0) {
            this.transition(enemy, 'telegraph');
          } else if (enemy.type === 'archer' && distance < 6 && sees) {
            this.waypoint.copy(enemy.position).add(this.direction.copy(enemy.position).sub(this.ctx.actor.position).setY(0));
            this.walkToward(enemy, this.waypoint, 2.5, dt);
          } else if (distance > stats.reach * 0.85 || !sees) this.walkToward(enemy, enemy.lastSeen, enemy.disarmed > 0 ? 1.3 : stats.speed, dt);
          else enemy.facing.copy(this.direction);
          break;
        case 'telegraph':
          if (enemy.stateTime >= stats.windup) { this.transition(enemy, 'attack'); enemy.attackLanded = false; }
          break;
        case 'attack':
          if (enemy.stateTime >= 0.1 && !enemy.attackLanded) {
            enemy.attackLanded = true;
            if (enemy.type === 'archer') this.ports.shoot(enemy); else this.ports.strike(enemy);
          }
          if (enemy.stateTime >= 0.5) { enemy.cooldown = 0.9 + (enemy.patrolPhase % 3) * 0.12; this.transition(enemy, 'chase'); }
          break;
        case 'return':
          this.walkToward(enemy, enemy.home, 2.1, dt);
          if (Math.hypot(enemy.position.x - enemy.home.x, enemy.position.z - enemy.home.z) < 1.5 || enemy.stateTime > 14) {
            // A knockback can make the original elevated home unreachable; settle below it.
            if (Math.abs(enemy.position.y - enemy.home.y) > 1.4 || enemy.stateTime > 14) enemy.home.copy(enemy.position);
            enemy.suspicion = 0;
            this.transition(enemy, this.isNight() && enemy.type !== 'archer' ? 'sleep' : 'patrol');
          }
          break;
      }
      this.animate(enemy, dt);
      this.persist(enemy);
    }
  }

  private recoverWeapon(enemy: CombatEnemy, dt: number): void {
    enemy.retrievalTime += dt;
    const weapon = this.ports.weaponPosition(enemy.weaponId);
    if (weapon && enemy.retrievalTime < 8 && weapon.distanceTo(enemy.position) < 28) {
      if (enemy.state !== 'investigate') this.transition(enemy, 'investigate');
      if (weapon.distanceTo(enemy.position) < 1.3 && this.clearSight(enemy.position.clone().add(new THREE.Vector3(0, 0.6, 0)), weapon.clone().add(new THREE.Vector3(0, 0.3, 0))) && this.ports.retrieveWeapon(enemy.weaponId)) {
        enemy.disarmed = 0;
        enemy.retrievalTime = 0;
        delete this.ctx.state.flags[`disarmed:${enemy.id}`];
        enemy.cooldown = 0.8;
        this.transition(enemy, 'chase');
      } else this.walkToward(enemy, weapon, 2.8, dt);
    } else {
      if (enemy.state !== 'return') this.transition(enemy, 'return');
      this.waypoint.copy(enemy.home);
      if (enemy.position.distanceTo(this.ctx.actor.position) < 7) {
        this.direction.copy(enemy.position).sub(this.ctx.actor.position).setY(0);
        if (this.direction.lengthSq() < 0.01) this.direction.copy(enemy.facing).negate();
        this.waypoint.copy(enemy.position).addScaledVector(this.direction.normalize(), 5);
      }
      this.walkToward(enemy, this.waypoint, 2.5, dt);
      if (weapon && enemy.retrievalTime > 16) enemy.retrievalTime = 0;
    }
    enemy.model.root.userData.retrievingWeapon = !!weapon && enemy.retrievalTime < 8;
  }

  private supportHeight(position: THREE.Vector3, ceiling: number): number {
    let height = this.ctx.world.heightAt(position.x, position.z);
    for (const collider of this.ctx.world.colliders) {
      const box = collider.box;
      if (collider.enabled && box.max.y <= ceiling && position.x > box.min.x - 0.25 && position.x < box.max.x + 0.25 && position.z > box.min.z - 0.25 && position.z < box.max.z + 0.25) height = Math.max(height, box.max.y);
    }
    return height;
  }

  private updateMotion(enemy: CombatEnemy, dt: number): void {
    if (enemy.impulse.y > 0) enemy.grounded = false;
    if (enemy.impulse.x * enemy.impulse.x + enemy.impulse.z * enemy.impulse.z > 0.03) {
      if (!this.move(enemy, enemy.impulse, dt, false)) { enemy.impulse.x = 0; enemy.impulse.z = 0; }
      const drag = Math.exp(-(enemy.grounded ? 7 : 0.8) * dt);
      enemy.impulse.x *= drag;
      enemy.impulse.z *= drag;
    }
    const support = this.supportHeight(enemy.position, enemy.position.y + 0.15);
    if (!Number.isFinite(support)) return;
    if (enemy.grounded && enemy.position.y > support + 0.18) enemy.grounded = false;
    if (enemy.grounded) return;
    const oldY = enemy.position.y;
    enemy.impulse.y -= CONFIG.gravity * dt;
    let nextY = oldY + enemy.impulse.y * dt;
    if (enemy.impulse.y > 0) for (const collider of this.ctx.world.colliders) {
      const box = collider.box;
      if (collider.enabled && enemy.position.x > box.min.x - 0.35 && enemy.position.x < box.max.x + 0.35 && enemy.position.z > box.min.z - 0.35 && enemy.position.z < box.max.z + 0.35 && oldY + 1.8 <= box.min.y && nextY + 1.8 >= box.min.y) {
        nextY = box.min.y - 1.8;
        enemy.impulse.y = 0;
      }
    }
    if (nextY <= support && enemy.impulse.y <= 0) {
      const speed = -enemy.impulse.y;
      enemy.position.y = support;
      enemy.impulse.y = 0;
      enemy.grounded = true;
      const water = this.ctx.world.waters.some(area => enemy.position.x >= area.minX && enemy.position.x <= area.maxX && enemy.position.z >= area.minZ && enemy.position.z <= area.maxZ && area.level > support + 0.8);
      if (speed > 10 && enemy.hp > 0 && !water) {
        this.ctx.effects.burst(enemy.position, 0xc5b999, 8);
        this.ports.environmentalDamage(enemy, (speed - 10) * 1.5);
      }
    } else enemy.position.y = nextY;
  }

  private move(enemy: CombatEnemy, velocity: THREE.Vector3, dt: number, avoidWater: boolean): boolean {
    this.candidate.copy(enemy.position);
    this.candidate.x += velocity.x * dt;
    this.candidate.z += velocity.z * dt;
    const height = this.supportHeight(this.candidate, enemy.position.y + (enemy.grounded ? 0.45 : 0.1));
    if (!Number.isFinite(height) || height - enemy.position.y > (enemy.grounded ? 1.4 : 0.1)) return false;
    if (avoidWater && this.ctx.world.waters.some(water => this.candidate.x > water.minX && this.candidate.x < water.maxX && this.candidate.z > water.minZ && this.candidate.z < water.maxZ && water.level - height > 0.8)) return false;
    if (enemy.grounded && height >= enemy.position.y - 0.45) this.candidate.y = height;
    this.eye.copy(enemy.position).y += 0.85;
    this.playerEye.copy(this.candidate).y += 0.85;
    for (const collider of this.ctx.world.colliders) {
      const box = collider.box;
      if (!collider.enabled || box.max.y <= this.candidate.y + 0.1) continue;
      if (this.candidate.x > box.min.x - 0.38 && this.candidate.x < box.max.x + 0.38 && this.candidate.z > box.min.z - 0.38 && this.candidate.z < box.max.z + 0.38 && this.candidate.y + 1.7 > box.min.y && this.candidate.y + 0.2 < box.max.y) return false;
      if (!box.containsPoint(this.eye) && boxHit(this.eye, this.playerEye, box, 0.2) !== null) return false;
    }
    enemy.position.copy(this.candidate);
    if (enemy.grounded && height < enemy.position.y - 0.45) {
      enemy.grounded = false;
      if (avoidWater) { enemy.impulse.x = velocity.x; enemy.impulse.z = velocity.z; }
    }
    return true;
  }

  private walkToward(enemy: CombatEnemy, target: THREE.Vector3, speed: number, dt: number): void {
    this.direction.copy(target).sub(enemy.position).setY(0);
    if (this.direction.lengthSq() < 0.4) return;
    this.direction.normalize();
    for (const other of this.enemies) {
      if (enemy === other || other.hp <= 0) continue;
      const distance = enemy.position.distanceTo(other.position);
      if (distance > 0.01 && distance < 1.1) this.direction.addScaledVector(this.candidate.copy(enemy.position).sub(other.position).setY(0), (1.1 - distance) * 1.5 / distance);
    }
    this.direction.normalize();
    enemy.facing.lerp(this.direction, Math.min(1, dt * 7)).normalize();
    this.direction.multiplyScalar(speed);
    if (!this.move(enemy, this.direction, dt, true)) {
      const x = this.direction.x;
      this.direction.x = -this.direction.z;
      this.direction.z = x;
      if (!this.move(enemy, this.direction, dt, true)) this.move(enemy, this.direction.negate(), dt, true);
    }
  }

  private animate(enemy: CombatEnemy, dt: number): void {
    const { model } = enemy;
    model.root.position.copy(enemy.position);
    model.root.rotation.y = Math.atan2(-enemy.facing.x, -enemy.facing.z);
    model.health.scale.x = Math.max(0.001, enemy.hp / enemy.maxHp);
    model.health.position.x = -(1 - enemy.hp / enemy.maxHp) * 0.5;
    model.healthRoot.visible = enemy.hp < enemy.maxHp || enemy.suspicion > 0.5;
    model.healthRoot.quaternion.copy(this.ctx.camera.quaternion).premultiply(model.root.quaternion.clone().invert());
    model.weapon.visible = enemy.disarmed <= 0;
    model.root.userData.state = enemy.state;
    model.root.userData.hp = enemy.hp;
    model.eyes.emissive.setHex(enemy.frozen > 0 ? 0x7bddff : enemy.state === 'telegraph' ? 0xff643e : 0xffa64f);
    if (dt === 0) return;
    const walking = enemy.state === 'patrol' || enemy.state === 'chase' || enemy.state === 'return' || enemy.state === 'investigate';
    const wave = Math.sin(this.clock * (enemy.state === 'chase' ? 10 : 5) + enemy.patrolPhase);
    model.body.position.y = 0.94 + (walking ? Math.abs(wave) * 0.05 : Math.sin(this.clock * 2 + enemy.patrolPhase) * 0.025);
    model.body.rotation.z = enemy.state === 'stunned' ? Math.sin(this.clock * 24) * 0.12 : 0;
    model.body.rotation.x = enemy.state === 'sleep' ? -0.7 : enemy.state === 'attack' ? 0.2 : 0;
    model.legs[0].rotation.x = walking ? wave * 0.45 : 0;
    model.legs[1].rotation.x = walking ? -wave * 0.45 : 0;
    model.arms[0].rotation.x = enemy.type === 'shield' && enemy.state === 'chase' ? -0.8 : walking ? -wave * 0.3 : 0;
    model.arms[1].rotation.x = enemy.state === 'telegraph' ? -2.3 : enemy.state === 'attack' ? -2.3 + Math.min(1, enemy.stateTime / 0.25) * 3.2 : walking ? wave * 0.3 : 0;
    model.head.rotation.z = enemy.state === 'suspicious' ? 0.25 : 0;
  }

  dispose(): void { this.enemies.forEach(enemy => disposeObject(enemy.model.root)); this.enemies.length = 0; }
}
