import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config/game';
import { createState, migrateSave } from '../core/state';
import type { AbilityTarget, EnemySpawn, GameContext, InputLike, InventoryItem } from '../core/types';
import { CombatSystem } from './CombatSystem';
import { ProjectilePool, boxHit, sphereHit } from './projectiles';

class InputFixture implements InputLike {
  held = new Set<string>();
  press = new Set<string>();
  release = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  down(code: string): boolean { return this.held.has(code); }
  pressed(code: string): boolean { return this.press.has(code); }
  released(code: string): boolean { return this.release.has(code); }
  clear(): void { this.held.clear(); this.edges(); }
  edges(): void { this.press.clear(); this.release.clear(); this.wheel = 0; }
  push(code: string): void { this.held.add(code); this.press.add(code); }
  lift(code: string): void { this.held.delete(code); this.release.add(code); }
}
const systems: CombatSystem[] = [];
afterEach(() => { systems.splice(0).forEach(system => system.dispose()); });

function fixture(spawns: EnemySpawn[] = [{ id: 'bog-test', camp: 'test', type: 'melee', position: [0, 0, -2] }]) {
  const state = createState();
  state.time = 12;
  state.player.position = [0, 0, 0];
  const input = new InputFixture();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.set(0, 1.7, 5);
  camera.lookAt(0, 1.7, -20);
  camera.updateMatrixWorld();
  const ctx: GameContext = {
    state, input, camera, scene: new THREE.Scene(), elapsed: 0, realDt: 1 / 60, timeScale: 1, inCombat: false,
    world: { root: new THREE.Group(), spawns, colliders: [], targets: [], interactables: [], waters: [], heightAt: () => 0, update: () => {}, dispose: () => {} },
    actor: { position: new THREE.Vector3(), facing: new THREE.Vector3(0, 0, -1), velocity: new THREE.Vector3(), grounded: true, model: new THREE.Group(), teleport: () => {} },
    effects: { burst: vi.fn(), ring: vi.fn(), shake: vi.fn() }, notify: vi.fn(), sound: vi.fn(),
    damage: vi.fn((amount: number) => { state.player.hp -= amount; }), addItem: vi.fn(() => true), save: vi.fn(), changeRegion: vi.fn(), cinematic: vi.fn(),
  };
  const combat = new CombatSystem(ctx);
  systems.push(combat);
  const step = (frames = 1) => {
    for (let index = 0; index < frames; index++) {
      const scale = ctx.timeScale;
      ctx.timeScale = 1;
      ctx.elapsed += 1 / 60;
      combat.update(scale / 60);
      input.edges();
    }
  };
  const equip = (id: string, durability = 30, slot: 'weapon' | 'shield' | 'bow' = 'weapon') => {
    const item: InventoryItem = { uid: `${id}-unit`, id, count: 1, durability };
    state.inventory.push(item);
    state.equipment[slot] = item.uid;
    return item;
  };
  return { ctx, state, input, combat, step, equip };
}

describe('CombatSystem', () => {
  it('attacks on release, hits once per swing, and wears only effective hits', () => {
    const f = fixture();
    const weapon = f.equip('sword');
    const enemy = f.combat.enemies[0];
    enemy.frozen = 10;
    enemy.state = 'chase';
    f.input.push('Mouse0');
    f.step(8);
    expect(enemy.hp).toBe(enemy.maxHp);
    f.input.lift('Mouse0');
    f.step(28);
    expect(enemy.hp).toBe(enemy.maxHp - 9);
    expect(weapon.durability).toBe(29);
    f.ctx.actor.facing.set(0, 0, 1);
    f.input.push('Mouse0'); f.step(); f.input.lift('Mouse0'); f.step(35);
    expect(weapon.durability).toBe(29);
  });

  it('clearing paused input cancels charge without firing a phantom swing', () => {
    const f = fixture();
    f.equip('sword');
    f.combat.enemies[0].frozen = 10;
    f.input.push('Mouse0'); f.step(10);
    f.input.clear(); f.step(35);
    expect(f.combat.enemies[0].hp).toBe(f.combat.enemies[0].maxHp);
  });

  it('persists deaths and loot across reload, but permits explicit enemy reset', () => {
    const f = fixture();
    f.combat.hitArea(new THREE.Vector3(0, 0, -2), 3, 100);
    expect(f.state.enemies['bog-test'].dead).toBe(true);
    const lootIds = f.ctx.world.interactables.map(item => item.id);
    expect(lootIds.length).toBeGreaterThan(1);
    f.ctx.state = migrateSave(JSON.parse(JSON.stringify(f.state)));
    f.combat.reset();
    expect(f.combat.enemies[0].state).toBe('dead');
    expect(f.ctx.world.interactables.map(item => item.id).sort()).toEqual(lootIds.sort());
    for (const key of Object.keys(f.ctx.state.flags)) expect(key.length).toBeLessThan(120);
    f.ctx.state.enemies = {};
    f.ctx.state.bloodMoonCount++;
    f.combat.reset();
    expect(f.combat.enemies[0].hp).toBe(f.combat.enemies[0].maxHp);
  });

  it('routes frontal melee through guard and a configured perfect parry', () => {
    const f = fixture();
    const shield = f.equip('shield', 28, 'shield');
    const enemy = f.combat.enemies[0];
    enemy.state = 'attack'; enemy.stateTime = 0.09;
    enemy.attackDirection.set(0, 0, 1);
    f.input.push('Mouse2'); f.input.push('KeyG'); f.step();
    expect(f.ctx.damage).not.toHaveBeenCalled();
    expect(enemy.state).toBe('stunned');
    expect(enemy.disarmed).toBeGreaterThan(0);
    expect(shield.durability).toBe(28);
  });

  it('two-handed weapons cannot guard', () => {
    const f = fixture();
    f.equip('axe'); f.equip('shield', 28, 'shield');
    const enemy = f.combat.enemies[0];
    enemy.state = 'attack'; enemy.stateTime = 0.09; enemy.attackDirection.set(0, 0, 1);
    f.input.push('Mouse2'); f.input.push('KeyG'); f.step();
    expect(f.ctx.damage).toHaveBeenCalledTimes(1);
  });

  it('only activates focus when a correctly timed dodge actually avoids an attack', () => {
    const f = fixture();
    const enemy = f.combat.enemies[0];
    enemy.state = 'telegraph'; enemy.stateTime = 0.78; enemy.attackDirection.set(0, 0, 1); enemy.facing.set(0, 0, 1);
    f.input.push('Mouse2'); f.input.push('KeyA'); f.input.push('Space'); f.step(13);
    expect(f.combat.focusRemaining).toBeGreaterThan(1.5);
    expect(f.ctx.timeScale).toBe(CONFIG.focusScale);
    expect(f.ctx.damage).not.toHaveBeenCalled();
    const idle = fixture();
    idle.combat.enemies[0].frozen = 10;
    idle.input.push('Mouse2'); idle.input.push('KeyA'); idle.input.push('Space'); idle.step(20);
    expect(idle.combat.focusRemaining).toBe(0);
  });

  it('draws and releases ballistic arrows that damage enemies', () => {
    const f = fixture([{ id: 'archery-target', type: 'melee', position: [0, 0, -9], camp: 'test' }]);
    f.equip('bow', 36, 'bow');
    f.state.inventory.push({ uid: 'ammo', id: 'arrows', count: 4 });
    f.combat.enemies[0].frozen = 20;
    f.input.push('KeyR'); f.step(50);
    expect(f.combat.arrowCount).toBe(4);
    f.input.lift('KeyR'); f.step(30);
    expect(f.combat.arrowCount).toBe(3);
    expect(f.combat.enemies[0].hp).toBeLessThan(f.combat.enemies[0].maxHp);
    expect(f.ctx.world.interactables.some(item => item.item === 'arrows')).toBe(true);
  });

  it('throws equipped weapons as actual flight objects and preserves landing durability', () => {
    const f = fixture([]);
    f.equip('sword', 17);
    f.input.push('KeyQ'); f.step();
    expect(f.state.equipment.weapon).toBeNull();
    expect(f.state.inventory).toHaveLength(0);
    expect(f.ctx.world.interactables).toHaveLength(0);
    f.step(180);
    const pickup = f.ctx.world.interactables.find(item => item.item === 'sword');
    expect(pickup?.data?.durability).toBe(17);
    expect(pickup?.position.distanceTo(f.ctx.actor.position)).toBeGreaterThan(3);
    f.ctx.state = migrateSave(JSON.parse(JSON.stringify(f.state)));
    f.combat.reset();
    expect(f.ctx.world.interactables.find(item => item.item === 'sword')?.data?.durability).toBe(17);
  });

  it('reflects hostile arrows during the parry window', () => {
    const f = fixture([{ id: 'enemy-bow', type: 'archer', camp: 'test', position: [0, 0, -8] }]);
    f.equip('shield', 28, 'shield');
    const enemy = f.combat.enemies[0];
    enemy.state = 'attack'; enemy.stateTime = 0.09;
    f.input.push('Mouse2'); f.step(8);
    f.input.push('KeyG'); f.step(40);
    expect(f.ctx.damage).not.toHaveBeenCalled();
    expect(enemy.hp).toBeLessThan(enemy.maxHp);
    expect(f.ctx.sound).toHaveBeenCalledWith('parry');
  });

  it('recovers a saved weapon even when a reload interrupts its flight', () => {
    const f = fixture([]);
    f.equip('axe', 19);
    f.input.push('KeyQ'); f.step();
    expect(f.ctx.world.interactables).toHaveLength(0);
    f.ctx.state = migrateSave(JSON.parse(JSON.stringify(f.state)));
    f.combat.reset();
    expect(f.ctx.world.interactables.find(item => item.item === 'axe')?.data?.durability).toBe(19);
  });

  it('breaks worn-out weapons only on an effective hit', () => {
    const f = fixture();
    f.equip('sword', 1);
    f.combat.enemies[0].frozen = 10;
    f.combat.enemies[0].state = 'chase';
    f.input.push('Mouse0'); f.step(); f.input.lift('Mouse0'); f.step(20);
    expect(f.state.equipment.weapon).toBeNull();
    expect(f.state.inventory).toHaveLength(0);
    expect(f.combat.enemies[0].hp).toBe(f.combat.enemies[0].maxHp - 13.5);
  });

  it('freezes enemies without altering the shared ability-target union', () => {
    const f = fixture();
    expect(f.combat.freezeNearest(new THREE.Vector3(), 5, 8)?.id).toBe('bog-test');
    expect(f.combat.enemies[0].frozen).toBe(3.5);
    f.step(30);
    expect(f.combat.enemies[0].position.toArray()).toEqual([0, 0, -2]);
  });

  it('accumulates stasis charge and terminates chained barrel explosions', () => {
    const f = fixture([]);
    const frozen: AbilityTarget = { id: 'frozen-orb', kind: 'orb', position: new THREE.Vector3(5, 0, 0), mesh: new THREE.Group(), frozen: 3, charge: 0 };
    f.combat.hitTarget(frozen, 10);
    expect(frozen.charge).toBe(1);
    const barrels: AbilityTarget[] = [0, 1, 2].map(index => ({ id: `barrel-${index}`, kind: 'barrel', position: new THREE.Vector3(10 + index, 0, 0), mesh: new THREE.Group() }));
    f.ctx.world.targets.push(...barrels);
    f.combat.hitTarget(barrels[0], 10);
    expect(barrels.every(barrel => barrel.solved)).toBe(true);
    expect(f.ctx.sound).toHaveBeenCalledWith('explosion', barrels[0].position);
  });

  it('chops trees into wood without destroying cooking stations', () => {
    const f = fixture([]);
    const tree = { id: 'tree-test', kind: 'tree' as const, name: 'tree', position: new THREE.Vector3(0, 0, -1), radius: 2, mesh: new THREE.Group(), data: { apples: 2 } };
    const pot = { id: 'cooking', kind: 'pot' as const, name: 'pot', position: new THREE.Vector3(0, 0, -1), radius: 2, mesh: new THREE.Group() };
    f.ctx.world.interactables.push(tree, pot);
    f.combat.hitArea(new THREE.Vector3(0, 0, -1), 3, 40);
    expect(f.state.flags['felled:tree-test']).toBe(true);
    expect(f.ctx.world.interactables.some(item => item.item === 'wood')).toBe(false);
    const log = { id: 'log:tree-test', kind: 'orb' as const, resource: 'log' as const, position: new THREE.Vector3(0, 0, -1), mesh: new THREE.Group() };
    f.ctx.world.targets.push(log);
    f.combat.hitTarget(log, 20);
    expect(f.ctx.world.interactables.some(item => item.item === 'wood')).toBe(true);
    expect(pot.mesh.visible).toBe(true);
  });

  it('does not detect a player through a solid vision blocker', () => {
    const f = fixture([{ id: 'watcher', type: 'melee', camp: 'test', position: [0, 0, -8] }]);
    const enemy = f.combat.enemies[0];
    enemy.state = 'suspicious'; enemy.facing.set(0, 0, 1);
    f.ctx.world.colliders.push({ id: 'wall', box: new THREE.Box3(new THREE.Vector3(-10, -1, -5), new THREE.Vector3(10, 6, -4)), enabled: true, climbable: false });
    f.step(120);
    expect(enemy.suspicion).toBeLessThan(1);
    expect(f.ctx.inCombat).toBe(false);
  });
});

describe('continuous collision and projectile pooling', () => {
  it('detects high speed segments through small bodies and blockers', () => {
    const start = new THREE.Vector3(-10, 1, 0), end = new THREE.Vector3(10, 1, 0);
    expect(sphereHit(start, end, new THREE.Vector3(0, 1, 0), 0.2)).toBeCloseTo(0.49);
    expect(boxHit(start, end, new THREE.Box3(new THREE.Vector3(-0.1, 0, -1), new THREE.Vector3(0.1, 2, 1)))).toBeCloseTo(0.495);
  });
  it('never allocates above the configured projectile pool size', () => {
    const pool = new ProjectilePool(new THREE.Group());
    for (let index = 0; index < CONFIG.arrowPoolSize; index++) expect(pool.spawn(new THREE.Vector3(0, 3, 0), new THREE.Vector3(0, 0, -1), 2, 'player')).not.toBeNull();
    expect(pool.spawn(new THREE.Vector3(), new THREE.Vector3(), 2, 'player')).toBeNull();
    pool.reset();
    expect(pool.spawn(new THREE.Vector3(), new THREE.Vector3(), 2, 'player')).not.toBeNull();
    pool.dispose();
  });
});
