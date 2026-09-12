import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { createState } from '../core/state';
import type { AbilityId, ActorView, GameContext, InputLike, Vec3 } from '../core/types';
import { AbilitySystem, buildTrial } from './AbilitySystem';
import { mechanism, trials, type Mechanism } from './mechanics';
import { CombatSystem } from '../combat/CombatSystem';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
function harness(id: AbilityId, stage = 0) {
  const state = createState();
  state.region = id;
  state.player.position = [0, 0, 9];
  state.abilities = ['magnet', 'bomb', 'stasis', 'ice'];
  state.selectedAbility = id;
  state.trialStages[id] = stage;
  const world = buildTrial(id, state);
  const scene = new THREE.Scene();
  scene.add(world.root);
  const camera = new THREE.PerspectiveCamera();
  const model = new THREE.Group();
  model.position.fromArray(state.player.position);
  const keys = new Set<string>();
  const messages: string[] = [];
  let saves = 0;
  const actor: ActorView = {
    position: model.position, velocity: new THREE.Vector3(), facing: new THREE.Vector3(0, 0, -1), grounded: true, model,
    teleport(position) { this.position.fromArray(position); this.velocity.set(0, 0, 0); },
  };
  const input: InputLike = { pressed: key => keys.has(key), down: key => keys.has(key), released: () => false, mouseDX: 0, mouseDY: 0, wheel: 0, clear: () => keys.clear() };
  const ctx: GameContext = {
    state, world, scene, camera, actor, input, elapsed: 0, realDt: 1 / 60, timeScale: 1, inCombat: false,
    effects: { burst() {}, ring() {}, shake() {} }, notify: text => messages.push(text), sound() {},
    damage: amount => { state.player.hp -= amount; }, addItem: () => true, save: () => { saves++; }, changeRegion() {}, cinematic() {},
  };
  // Emulate combat's generic prop destruction: puzzle-specific validation must survive this callback.
  const combat = new CombatSystem(ctx);
  const system = new AbilitySystem(ctx, (position, radius, damage, source) => {
    combat.hitArea(position, radius, damage, !source, source);
    for (const target of world.targets) {
      if (target.solved || !['cracked', 'barrel'].includes(target.kind) || target.position.distanceTo(position) > radius + 0.6) continue;
      target.solved = true;
      target.mesh.visible = false;
      if (target.collider) target.collider.enabled = false;
    }
  });
  cleanup.push(() => { system.dispose(); combat.dispose(); world.dispose(); });
  const tick = (frames = 1) => {
    for (let i = 0; i < frames; i++) {
      ctx.elapsed += 1 / 60;
      system.update(1 / 60);
      world.update(1 / 60, state);
      keys.clear();
    }
  };
  const aim = (position: Vec3) => {
    camera.position.copy(actor.position).add(new THREE.Vector3(0, 3, 6));
    camera.lookAt(...position);
    camera.updateMatrixWorld();
  };
  const move = (position: Vec3) => { actor.teleport(position); aim([position[0], 1, position[2] - 7]); };
  const press = (key = 'KeyF') => { keys.add(key); tick(); };
  const steerMetal = (position: Vec3) => {
    const eye = actor.position.clone().add(new THREE.Vector3(0, 1.25, 0));
    camera.position.copy(eye); camera.lookAt(...position); camera.updateMatrixWorld();
    const distance = eye.distanceTo(new THREE.Vector3(...position));
    for (let n = 0; n < 12; n++) {
      const current = Reflect.get(system, 'heldDistance') as number;
      input.wheel = THREE.MathUtils.clamp((distance - current) / 0.6, -4, 4);
      tick();
    }
    input.wheel = 0; tick(300);
  };
  const target = (role: Mechanism['role']) => world.targets.find(value => mechanism(value).role === role)!;
  const columns = () => world.colliders.filter(collider => collider.enabled && collider.id.startsWith('ability:ice:'));
  return { state, world, system, ctx, actor, input, move, aim, press, tick, steerMetal, target, columns, messages, saves: () => saves };
}

describe('trial contracts and progression', () => {
  it.each<AbilityId>(['magnet', 'bomb', 'stasis', 'ice'])('%s does not reward unlocked abilities or blind altar activation', id => {
    const h = harness(id);
    h.move([0, 0, 9]);
    h.press();
    expect(h.state.trialStages[id]).toBe(0);
    expect(h.world.interactables.some(value => value.kind === 'reward')).toBe(false);
    expect(h.world.colliders.filter(value => value.id.includes('seal-')).every(value => value.enabled)).toBe(true);
  });
  it('restores completed gates and recovers a save on a vanished pillar', () => {
    const state = createState();
    state.region = 'ice';
    state.player.position = [0, 8, -43];
    state.flags['trial:ice:2'] = true;
    const world = buildTrial('ice', state);
    cleanup.push(() => world.dispose());
    expect(state.trialStages.ice).toBe(3);
    expect(state.player.position).toEqual([0, 0, -55]);
    expect(world.colliders.filter(value => value.id.includes('seal-')).every(value => !value.enabled)).toBe(true);
    expect(world.interactables.some(value => value.kind === 'reward')).toBe(true);
  });
});

describe('magnet puzzles and swept heavy bodies', () => {
  it('lifts the panel within the supported camera pitch', () => {
    const h = harness('magnet');
    h.move([0, 0, -2]); h.aim([0, 1, -7]); h.press();
    h.aim([0, 6, -9]); h.tick(100);
    expect(h.state.trialStages.magnet).toBe(1);
    expect(h.state.flags['trial:magnet:0']).toBe(true);
    expect(h.saves()).toBe(1);
  });
  it('requires two settled bridge cubes and physically crossing them', () => {
    const h = harness('magnet', 1);
    for (const [x, z] of [[4, -27.5], [-4, -24.5]]) {
      h.move([x, 0, -17]); h.aim([x, 1.5, -20.5]); h.press();
      expect(h.actor.model.userData.holdingMetal).toBe(true);
      h.move([0, 0, -19]);
      // Match the eye-to-slot direction and distance through the public wheel input.
      h.steerMetal([0, -1.5, z]); h.press(); h.tick(90);
      const cube = h.world.targets.find(t => t.origin?.[0] === x && mechanism(t).role === 'bridgeCube')!;
      expect(cube.position.distanceTo(new THREE.Vector3(0, -1.5, z))).toBeLessThan(0.2);
    }
    expect(h.state.trialStages.magnet).toBe(1);
    h.move([0, 0, -25]); h.tick();
    h.move([0, 0, -30]); h.tick();
    expect(h.state.trialStages.magnet).toBe(2);
    expect(h.actor.model.userData.holdingMetal).toBe(false);
  });
  it('pulls the door, then hits a real guardian with the moving metal striker', () => {
    const h = harness('magnet', 2);
    h.move([0, 0, -37]); h.aim([0, 2, -42]); h.press();
    h.move([0, 0, -32.9]); h.aim([0, 2, -42]); h.tick(100);
    expect(trials.get(h.world)!.doorPulled).toBe(true);
    expect(h.state.trialStages.magnet).toBe(2);
    h.move([-5, 0, -35]); h.aim([-5, 1, -38]); h.press();
    h.move([0, 0, -35]); h.aim([0, 1, -40]); h.tick(100);
    h.move([0, 0, -40]); h.aim([0, 1, -45]); h.tick(100);
    h.move([4, 0, -41]); h.steerMetal([4, 1, -44.5]);
    expect(h.state.flags['metal-hit:trial:magnet:guardian']).toBe(true);
    expect(h.state.trialStages.magnet).toBe(3);
  });
  it('cancels holding with Q without leaving camera ownership flags', () => {
    const h = harness('magnet', 1);
    h.move([-4, 0, -19]); h.aim([-4, 1, -23]); h.press();
    expect(h.actor.model.userData.holdingMetal).toBe(true);
    h.press('KeyQ');
    expect(h.actor.model.userData.holdingMetal).toBe(false);
    expect(h.actor.model.userData.magnetTarget).toBeUndefined();
    expect(h.state.trialStages.magnet).toBe(1);
  });
});

describe('bomb shapes, mechanisms and reset', () => {
  it('breaks the first wall with a placed blast despite generic combat destruction', () => {
    const h = harness('bomb');
    h.move([0, 0, -4]); h.press('KeyV'); h.press();
    h.move([0, 0, 2]); h.press();
    expect(h.state.trialStages.bomb).toBe(1);
    expect(h.system.cooldown).toBeGreaterThan(0);
    expect(h.state.player.hp).toBe(12);
  });
  it('rejects cube shortcuts and accepts a sphere that actually travels through the pipe', () => {
    const h = harness('bomb', 1);
    h.move([-4, 0, -19.8]); h.press('KeyV'); h.press(); h.tick(150);
    h.move([-4, 0, -18]); h.press();
    expect(h.state.trialStages.bomb).toBe(1);
    h.tick(185);
    h.move([-4, 0, -19.8]); h.press('KeyV'); h.press(); h.tick(150);
    h.move([-4, 0, -18]); h.press();
    expect(h.state.trialStages.bomb).toBe(2);
  });
  it('requires a launcher blast and physical orb impact against the remote seal', () => {
    const h = harness('bomb', 2);
    h.move([0, 0, -36.9]); h.press('KeyV'); h.press();
    h.move([0, 0, -33]); h.tick(60); h.press();
    expect(h.state.trialStages.bomb).toBe(2);
    h.tick(120);
    expect(h.state.trialStages.bomb).toBe(3);
    expect(h.world.interactables.some(value => value.kind === 'reward')).toBe(true);
  });
  it('clears a live bomb on blood moon without detonating or resetting key progress', () => {
    const h = harness('bomb', 1);
    h.move([-4, 0, -19.8]); h.press();
    h.state.bloodMoonCount++;
    h.tick();
    expect(h.state.trialStages.bomb).toBe(1);
    expect(h.state.flags['trial:bomb:0']).toBe(true);
    expect(h.world.targets.find(value => mechanism(value).role === 'pipeReceiver')!.solved).not.toBe(true);
    expect(h.system.cooldown).toBe(0);
  });
});

describe('stasis timing, traversal and distinct impacts', () => {
  it('freezes the rotor and requires crossing while frozen', () => {
    const h = harness('stasis');
    h.move([0, 0, -5]); h.aim([0, 0.3, -9]); h.press();
    expect(h.state.trialStages.stasis).toBe(0);
    h.move([0, 0, -12]); h.tick();
    expect(h.state.trialStages.stasis).toBe(1);
  });
  it('freezes the rolling stone before the second crossing', () => {
    const h = harness('stasis', 1);
    h.move([0, 0, -20]); h.aim([0, 1.2, -24]); h.press();
    h.move([0, 0, -27.5]); h.tick();
    expect(h.state.trialStages.stasis).toBe(2);
  });
  it('normalizes combat damage to distinct blows, recovers weak releases and launches a two-hit orb', () => {
    const h = harness('stasis', 2);
    h.actor.model.userData.attackProgress = 0;
    h.move([0, 0, -39]); h.aim([0, 1.15, -42]); h.press();
    const orb = h.target('chargeOrb');
    orb.charge = 30; h.tick();
    expect(orb.charge).toBe(1);
    h.press(); h.tick(600);
    expect(h.state.trialStages.stasis).toBe(2);
    expect(orb.position.z).toBeCloseTo(-42);
    h.aim([0, 1.15, -42]); h.press();
    orb.charge! += 20; h.tick();
    orb.charge! += 20; h.tick();
    expect(orb.charge).toBe(2);
    h.press(); h.tick(120);
    expect(h.state.trialStages.stasis).toBe(3);
  });
});

describe('ice surface validation and ascending traversal', () => {
  it('raises a swimmer safely when a pillar forms directly underneath', () => {
    const h = harness('ice'); h.move([0, -0.8, -8]); h.aim([0, 0.08, -8]); h.press();
    expect(h.columns()).toHaveLength(1);
    expect(h.actor.position.y).toBeGreaterThan(h.columns()[0]!.box.max.y);
    expect(h.actor.velocity.y).toBe(0);
  });
  it('creates two climbable bridge columns and requires using them before reaching the bank', () => {
    const h = harness('ice');
    h.move([0, 0, -2]); h.aim([0, 0.08, -7.4]); h.press(); h.tick(25);
    h.move([5, -0.8, -9]); h.aim([0, 0.08, -12.3]); h.press();
    expect(h.columns()).toHaveLength(2);
    expect(h.columns().every(column => column.climbable)).toBe(true);
    h.move([0, 2.48, -12.3]); h.tick();
    h.move([0, 0, -15.7]); h.tick();
    expect(h.state.trialStages.ice).toBe(1);
  });
  it('lifts a water gate only with a pillar underneath, then requires crossing', () => {
    const h = harness('ice', 1);
    h.move([0, 0, -20]); h.aim([0, 0.08, -25]); h.press();
    expect(trials.get(h.world)!.gateLifted).toBe(true);
    expect(h.target('iceGate').collider!.enabled).toBe(false);
    expect(h.state.trialStages.ice).toBe(1);
    h.move([0, 0, -29]); h.tick();
    expect(h.state.trialStages.ice).toBe(2);
  });
  it('requires a pillar before ascending the final landing and preserves completion through resets', () => {
    const h = harness('ice', 2);
    h.move([0, 3.2, -46]); h.tick();
    expect(h.state.trialStages.ice).toBe(2);
    h.move([0, 0, -36]); h.aim([0, 0.08, -42.8]); h.press();
    h.move([0, 3.2, -46]); h.tick();
    expect(h.state.trialStages.ice).toBe(3);
    h.state.bloodMoonCount++; h.tick();
    expect(h.columns()).toHaveLength(0);
    expect(h.state.flags['trial:ice:2']).toBe(true);
  });
  it('recycles the oldest of three pillars instead of allocating additional colliders', () => {
    const h = harness('ice');
    h.move([0, 0, -2]);
    for (const x of [-7, 0, 7]) { h.aim([x, 0.08, -7.2]); h.press(); h.tick(25); }
    expect(h.columns()).toHaveLength(3);
    h.move([-11.2, -0.8, -10]); h.aim([-7, 0.08, -12.2]); h.press();
    expect(h.columns()).toHaveLength(3);
    expect(h.world.colliders.filter(value => value.id.startsWith('ability:ice:'))).toHaveLength(3);
    expect(h.columns().some(column => Math.abs(column.box.getCenter(new THREE.Vector3()).z + 12.2) < 0.2)).toBe(true);
  });
  it('safely returns a supported player to a dry bank when ice is reset', () => {
    const h = harness('ice');
    h.move([0, 0, -2]); h.aim([0, 0.08, -7.4]); h.press();
    h.move([0, 2.48, -7.4]); h.system.reset();
    expect(h.columns()).toHaveLength(0);
    expect(h.actor.position.y).toBeGreaterThanOrEqual(0);
    expect(h.world.waters.some(water => h.actor.position.z > water.minZ && h.actor.position.z < water.maxZ)).toBe(false);
  });
});
