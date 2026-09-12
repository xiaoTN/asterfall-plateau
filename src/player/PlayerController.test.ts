import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CONFIG } from '../config/game';
import { createState } from '../core/state';
import type { ActorView, Collider, GameContext, InputLike, Vec3, WorldView } from '../core/types';
import { Overworld } from '../world/Overworld';
import { PlayerController } from './PlayerController';

class TestInput implements InputLike {
  held = new Set<string>();
  edges = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  down(code: string): boolean { return this.held.has(code); }
  pressed(code: string): boolean { return this.edges.has(code); }
  released(): boolean { return false; }
  clear(): void { this.held.clear(); this.end(); }
  end(): void { this.edges.clear(); this.mouseDX = this.mouseDY = this.wheel = 0; }
  press(...codes: string[]): void { for (const code of codes) { this.held.add(code); this.edges.add(code); } }
}

const actors: PlayerController[] = [];
const worlds: WorldView[] = [];
afterEach(() => {
  for (const actor of actors.splice(0)) actor.dispose();
  for (const world of worlds.splice(0)) world.dispose();
});

function box(min: Vec3, max: Vec3, climbable = false): Collider {
  return { id: `box-${min.join('-')}`, box: new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)), enabled: true, climbable };
}

function setup(position: Vec3 = [0, 0, 0], colliders: Collider[] = []) {
  const input = new TestInput();
  const state = createState();
  state.player.position = [...position];
  state.safePosition = [8, 0, 0];
  const world: WorldView = { root: new THREE.Group(), colliders, waters: [], targets: [], interactables: [], spawns: [], heightAt: () => 0, update: () => undefined, dispose: () => undefined };
  const ctx: GameContext = {
    state, world, input, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, 1.6, 0.1, 600),
    actor: undefined as unknown as ActorView, elapsed: 0, realDt: 1 / 60, timeScale: 1, inCombat: false,
    effects: { burst: vi.fn(), ring: vi.fn(), shake: vi.fn() }, notify: vi.fn(), sound: vi.fn(),
    damage: vi.fn((amount: number) => { state.player.hp = Math.max(0, state.player.hp - amount); }),
    addItem: () => true, save: vi.fn(), changeRegion: vi.fn(), cinematic: vi.fn(),
  };
  const player = new PlayerController(ctx);
  ctx.actor = player;
  actors.push(player);
  function run(seconds: number, realStep = 1 / 60) {
    for (let time = 0; time < seconds - 0.000001; time += realStep) {
      ctx.realDt = realStep;
      ctx.elapsed += realStep;
      player.update(realStep * ctx.timeScale);
      input.end();
    }
  }
  return { player, ctx, state, world, input, run };
}

function setupOverworld(position: Vec3) {
  const fixture = setup(position);
  fixture.state.flags.doorOpen = true;
  fixture.state.tower = true;
  fixture.state.terminal = true;
  const world = new Overworld(fixture.state);
  worlds.push(world);
  fixture.ctx.world = world;
  fixture.player.teleport([position[0], world.heightAt(position[0], position[2]), position[2]]);
  return { ...fixture, world };
}

describe('PlayerController actual-world traversal', () => {
  it('exits the open chamber and climbs the tutorial ledge', () => {
    const { player, input, run } = setupOverworld([0, 0, 105]);
    input.press('KeyW', 'Space');
    run(4.5);
    expect(player.position.z).toBeLessThan(86);
    expect(player.position.y).toBeGreaterThan(18);
  });

  it('walks up the first tower stair flight without jumping', () => {
    const { player, input, run } = setupOverworld([7.6, 0, 9.5]);
    input.press('KeyW');
    run(3.2);
    expect(player.position.y).toBeGreaterThan(17.7);
    expect(player.position.z).toBeLessThan(-8.4);
    expect(player.grounded).toBe(true);
  });

  it('walks up the temple stairs without jumping', () => {
    const { player, input, run } = setupOverworld([5.3, 0, -67]);
    input.press('KeyW');
    run(1.75);
    expect(player.position.y).toBeGreaterThan(18.7);
    expect(player.grounded).toBe(true);
  });

  it('enters the actual lake then walks out onto its sloped eastern shore', () => {
    const { player, input, run } = setupOverworld([-15, 0, 46]);
    input.press('KeyA');
    run(3.5);
    expect(player.movement).toBe('swim');
    input.clear();
    input.press('KeyD');
    run(5);
    expect(player.movement).not.toBe('swim');
    expect(player.grounded).toBe(true);
    expect(player.position.x).toBeGreaterThan(-20);
  });

  it('can walk the marked snow-cabin approach without climbing a terrain seam', () => {
    const { player, input, run } = setupOverworld([-26, 0, -30]);
    for (let n = 0; n < 1000 && player.position.distanceTo(new THREE.Vector3(-40, 21, -41)) > 0.3; n++) {
      input.clear();
      if (player.position.x > -39.9) input.press('KeyA');
      if (player.position.z > -40.9) input.press('KeyW');
      run(1 / 60);
    }
    expect(player.position.x).toBeLessThan(-39.5);
    expect(player.position.z).toBeLessThan(-40.5);
    expect(player.position.y).toBeGreaterThan(20.5);
  });
});

describe('PlayerController locomotion and collisions', () => {
  it('constructs without ctx.actor and walks camera-relative toward -Z', () => {
    const { player, input, run, state } = setup();
    input.press('KeyW');
    run(1);
    expect(player.position.z).toBeLessThan(-5);
    expect(player.position.x).toBeCloseTo(0);
    expect(player.position.y).toBeCloseTo(0);
    expect(player.grounded).toBe(true);
    expect(state.player.movement).toBe('run');
    expect(state.player.position).toEqual(player.position.toArray());
    input.clear();
    run(0.5);
    expect(Math.abs(player.velocity.z)).toBeLessThan(0.01);
  });

  it('jumps and lands without taking damage from an ordinary jump', () => {
    const { player, input, run, ctx } = setup();
    input.press('Space');
    run(0.3);
    expect(player.position.y).toBeGreaterThan(1.1);
    expect(player.grounded).toBe(false);
    input.clear();
    run(1);
    expect(player.position.y).toBeCloseTo(0);
    expect(player.grounded).toBe(true);
    expect(ctx.damage).not.toHaveBeenCalled();
  });

  it('cannot tunnel through a thin wall at a low simulation frame rate', () => {
    const { player, input, run } = setup([0, 0, 3], [box([-4, 0, -0.04], [4, 8, 0.04])]);
    input.press('KeyW', 'ShiftLeft');
    run(2, 0.05);
    expect(player.position.z).toBeGreaterThanOrEqual(CONFIG.playerRadius + 0.039);
    expect(player.position.y).toBeCloseTo(0);
  });

  it('steps onto a low box, but not when the step has insufficient headroom', () => {
    const step = box([-2, 0, -3], [2, 0.45, 1]);
    const a = setup([0, 0, 2], [step]);
    a.input.press('KeyW');
    a.run(0.35);
    expect(a.player.position.y).toBeCloseTo(0.45, 2);
    const b = setup([0, 0, 2], [step, box([-2, 2.1, -3], [2, 3, 1])]);
    b.input.press('KeyW');
    b.run(0.5);
    expect(b.player.position.y).toBeCloseTo(0);
    expect(b.player.position.z).toBeGreaterThan(1.4);
  });

  it('sweeps the head against ceilings during a jump', () => {
    const { player, input, run } = setup([0, 0, 0], [box([-4, 2.2, -4], [4, 2.3, 4])]);
    input.press('Space');
    for (let i = 0; i < 30; i++) {
      run(1 / 60);
      expect(player.position.y + CONFIG.playerHeight).toBeLessThanOrEqual(2.201);
    }
  });

  it('keeps crouching after release when standing would hit a low ceiling', () => {
    const { player, input, run, world } = setup();
    input.press('KeyC');
    run(1 / 60);
    world.colliders.push(box([-2, 1.4, -2], [2, 2, 2]));
    input.clear();
    run(0.3);
    expect(player.crouched).toBe(true);
    world.colliders[0].enabled = false;
    run(1 / 60);
    expect(player.crouched).toBe(false);
  });

  it('ignores disabled colliders', () => {
    const wall = box([-4, 0, -0.04], [4, 8, 0.04]);
    wall.enabled = false;
    const { player, input, run } = setup([0, 0, 3], [wall]);
    input.press('KeyW');
    run(1);
    expect(player.position.z).toBeLessThan(-2);
  });

  it('carries a grounded actor with a translated support', () => {
    const platform = box([-2, 0, -2], [2, 2, 2]);
    const { player, run } = setup([0, 2, 0], [platform]);
    run(0.1);
    platform.box.translate(new THREE.Vector3(0.3, 0.2, 0));
    run(1 / 60);
    expect(player.position.x).toBeCloseTo(0.3);
    expect(player.position.y).toBeCloseTo(2.2);
  });

  it('applies fall damage on a hard landing', () => {
    const { ctx, player, run } = setup([0, 18, 0]);
    run(2);
    expect(player.grounded).toBe(true);
    expect(ctx.damage).toHaveBeenCalledWith(expect.any(Number), '坠落');
  });
});

describe('PlayerController stamina and traversal', () => {
  it('drains sprint stamina in real time even during slowed simulation', () => {
    const { ctx, state, input, run, player } = setup();
    ctx.timeScale = 0.2;
    input.press('KeyW', 'ShiftLeft');
    run(1);
    expect(state.player.stamina).toBeCloseTo(100 - CONFIG.sprintDrain, 4);
    expect(Math.abs(player.position.z)).toBeLessThan(2.2);
  });

  it('regenerates only after a delay and never while paused', () => {
    const { state, input, run, ctx } = setup();
    input.press('KeyW', 'ShiftLeft');
    run(1);
    input.clear();
    const stamina = state.player.stamina;
    run(0.5);
    expect(state.player.stamina).toBeCloseTo(stamina);
    ctx.timeScale = 0;
    run(1);
    expect(state.player.stamina).toBeCloseTo(stamina);
    ctx.timeScale = 1;
    run(0.5);
    expect(state.player.stamina).toBeGreaterThan(stamina);
  });

  it('climbs a rough wall and mantles onto its clear top', () => {
    const { input, run, player, state } = setup([0, 0, 0.6], [box([-3, 0, -3], [3, 6, 0], true)]);
    input.press('KeyW', 'Space');
    run(1.8);
    expect(player.position.y).toBeCloseTo(6, 1);
    expect(player.grounded).toBe(true);
    expect(player.position.z).toBeLessThan(0);
    expect(state.player.stamina).toBeLessThan(95);
  });

  it('drops immediately on Q and cannot regrab while Q stays held', () => {
    const { input, run, player } = setup([0, 0, 0.6], [box([-3, 0, -3], [3, 30, 0], true)]);
    input.press('KeyW', 'Space');
    run(0.8);
    expect(player.movement).toBe('climb');
    input.press('KeyQ');
    run(1 / 60);
    expect(player.movement).toBe('fall');
    run(0.6);
    expect(player.movement).not.toBe('climb');
  });

  it('periodically loses height in rain rather than climbing at dry speed', () => {
    const dry = setup([0, 0, 0.6], [box([-3, 0, -3], [3, 40, 0], true)]);
    const wet = setup([0, 0, 0.6], [box([-3, 0, -3], [3, 40, 0], true)]);
    wet.state.weather = 'rain';
    dry.input.press('KeyW', 'Space');
    wet.input.press('KeyW', 'Space');
    dry.run(3.2);
    wet.run(3.2);
    expect(wet.player.position.y).toBeLessThan(dry.player.position.y - 1);
    expect(wet.player.movement).toBe('climb');
  });

  it('does not regenerate while hanging motionless on a wall', () => {
    const { input, run, player, state } = setup([0, 0, 0.6], [box([-3, 0, -3], [3, 30, 0], true)]);
    input.press('KeyW', 'Space');
    run(0.8);
    input.clear();
    const stamina = state.player.stamina;
    run(1);
    expect(player.movement).toBe('climb');
    expect(state.player.stamina).toBeLessThan(stamina);
  });

  it('swims, forbids melee, and rescues an exhausted swimmer to dry shore', () => {
    const { world, player, state, run, ctx } = setup();
    world.heightAt = (x, z) => Math.abs(x) < 5 && Math.abs(z) < 5 ? -4 : 0;
    world.waters.push({ minX: -5, maxX: 5, minZ: -5, maxZ: 5, level: 0, depth: 4 });
    player.teleport([0, -1, 0]);
    state.player.stamina = 2;
    run(0.1);
    expect(player.movement).toBe('swim');
    expect(player.model.userData.canMelee).toBe(false);
    run(3.2);
    expect(ctx.damage).toHaveBeenCalledWith(2, '溺水');
    expect(player.position.x).toBeCloseTo(8);
    expect(player.grounded).toBe(true);
    expect(state.player.stamina).toBeGreaterThan(0);
  });

  it('walks normally on a solid bridge above deep water', () => {
    const bridge = box([-1, -3, -4], [1, 0.1, 4]);
    const { world, player, run } = setup([0, 0.1, 0], [bridge]);
    world.heightAt = () => -4;
    world.waters.push({ minX: -5, maxX: 5, minZ: -5, maxZ: 5, level: 0, depth: 4 });
    run(0.5);
    expect(player.movement).toBe('idle');
    expect(player.grounded).toBe(true);
  });

  it('only glides after unlocking and closes the glider at zero stamina', () => {
    const { player, state, input, run } = setup([0, 25, 0]);
    input.press('Space');
    run(0.2);
    expect(player.movement).toBe('fall');
    state.glider = true;
    state.player.stamina = 4;
    run(0.2);
    expect(player.movement).toBe('glide');
    expect(player.velocity.y).toBeGreaterThan(-6);
    run(0.35);
    expect(player.movement).toBe('fall');
    expect(state.player.stamina).toBe(0);
  });
});

describe('PlayerController camera and lifecycle', () => {
  it('starts behind the player looking north and uses mouse yaw for movement', () => {
    const { player, ctx, input, run } = setup();
    player.updateCamera(1 / 60);
    expect(ctx.camera.position.z).toBeGreaterThan(4);
    expect(ctx.camera.position.y).toBeGreaterThan(3);
    input.mouseDX = 500;
    player.updateCamera(1 / 60);
    input.end();
    input.press('KeyW');
    run(0.5);
    expect(player.position.x).toBeGreaterThan(1.5);
  });

  it('shortens the boom before a wall and restores it after the wall is disabled', () => {
    const wall = box([-4, 0, 2.5], [4, 6, 2.7]);
    const { player, ctx } = setup([0, 0, 0], [wall]);
    player.updateCamera(1 / 60);
    expect(ctx.camera.position.z).toBeLessThan(2.4);
    wall.enabled = false;
    for (let i = 0; i < 120; i++) player.updateCamera(1 / 60);
    expect(ctx.camera.position.z).toBeGreaterThan(5);
  });

  it('uses normalized scroll notches but yields the wheel to abilities', () => {
    const { player, ctx, input } = setup();
    player.updateCamera(1 / 60);
    const before = ctx.camera.position.clone();
    input.wheel = -3;
    player.model.userData.abilityMode = true;
    player.updateCamera(1 / 60);
    expect(ctx.camera.position.distanceTo(before)).toBeLessThan(0.01);
    player.model.userData.abilityMode = false;
    player.updateCamera(1 / 60);
    input.end();
    for (let i = 0; i < 60; i++) player.updateCamera(1 / 60);
    expect(ctx.camera.position.distanceTo(player.position)).toBeLessThan(before.length() - 1);
  });

  it('leaves shared context resources intact and disposes its own mesh resources', () => {
    const { player, ctx } = setup();
    const count = ctx.scene.children.length;
    const mesh = player.model.getObjectsByProperty('type', 'Mesh')[0] as THREE.Mesh;
    const dispose = vi.spyOn(mesh.geometry, 'dispose');
    player.dispose();
    player.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(ctx.scene.children.length).toBe(count - 1);
  });
});
