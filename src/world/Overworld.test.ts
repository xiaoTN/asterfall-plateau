import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, LOCATIONS } from '../config/game';
import { createState } from '../core/state';
import type { GameState } from '../core/types';
import { PlayerCollision } from '../player/PlayerCollision';
import { Overworld, terrainHeight } from './Overworld';
import { LAKES } from './terrain';

describe('overworld contract and traversable geometry', () => {
  let world: Overworld;
  let state: GameState;
  beforeAll(() => { state = createState(); world = new Overworld(state); });
  afterAll(() => world.dispose());

  it('keeps flattened anchors at deterministic feet heights', () => {
    const elevations: Record<string, number> = { chamber: 22, outlook: 20, elder: 12, tower: 8, magnet: 11, bomb: 10, stasis: 14, ice: 27, temple: 12, camp1: 10, camp2: 12, camp3: 10, cabin: 21 };
    for (const [id, y] of Object.entries(elevations)) {
      const [x, , z] = LOCATIONS[id].position;
      expect(terrainHeight(x, z), id).toBeCloseTo(y, 5);
      expect(world.heightAt(x, z)).toBe(terrainHeight(x, z));
    }
    expect(terrainHeight(170, 0)).toBeLessThan(-35);
  });

  it('samples the same triangle planes as the visual terrain', () => {
    const terrain = world.root.getObjectByName('Asterfall triangulated plateau')!;
    const ray = new THREE.Raycaster();
    world.root.updateMatrixWorld(true);
    for (const [x, z] of [[14.3, 54.8], [-73.7, -53.9], [142.1, 2.7], [-31.7, 44.9], [65.25, -60.7]]) {
      ray.set(new THREE.Vector3(x, 200, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(terrain, true)[0];
      expect(hit).toBeDefined();
      expect(hit.point.y).toBeCloseTo(terrainHeight(x, z), 4);
    }
  });

  it('provides all required stable interactions, nine enemy spawns, and solvable chest links', () => {
    const ids = world.interactables.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['terminal', 'chamber-door', 'chamber-exit', 'elder', 'tower', 'shrine-magnet', 'shrine-bomb', 'shrine-stasis', 'shrine-ice', 'temple-altar', 'glider']) expect(ids).toContain(id);
    expect(world.interactables.filter(item => item.kind === 'chest').length).toBeGreaterThanOrEqual(10);
    expect(world.spawns).toHaveLength(9);
    for (const camp of ['camp1', 'camp2', 'camp3']) expect(world.spawns.filter(spawn => spawn.camp === camp).map(spawn => spawn.type).sort()).toEqual(['archer', 'melee', 'shield']);
    for (const chest of world.interactables.filter(item => item.kind === 'chest' && item.data?.requires)) {
      expect(world.targets.some(target => target.id === chest.data?.targetId), chest.id).toBe(true);
    }
    const collision = new PlayerCollision(() => world);
    expect(collision.canOccupy(new THREE.Vector3(0, 22, 105), CONFIG.playerHeight)).toBe(true);
  });

  it('has lakebeds deep enough to swim, matching water zones, and underwater metal chests', () => {
    for (const lake of LAKES) {
      const area = world.waters.find(w => lake.x >= w.minX && lake.x <= w.maxX && lake.z >= w.minZ && lake.z <= w.maxZ);
      expect(area?.level).toBe(lake.level);
      expect(lake.level - terrainHeight(lake.x, lake.z)).toBeGreaterThan(1.8);
      expect(lake.level - terrainHeight(lake.x, lake.z)).toBeCloseTo(lake.depth, 1);
    }
    const chest = world.targets.find(target => target.id === 'lake-metal-chest')!;
    expect(chest.collider!.box.max.y).toBeLessThan(LAKES[0].level);
  });

  it('restores flag-driven pickups, opened chests, felled trees and door collision', () => {
    state.flags['picked:elder-axe'] = true;
    state.flags['opened:chamber-shirt'] = true;
    state.flags['felled:tree-001'] = true;
    state.flags.chamberDoor = true;
    world.update(0.05, state);
    expect(world.interactables.find(item => item.id === 'elder-axe')!.mesh!.visible).toBe(false);
    expect(world.interactables.find(item => item.id === 'chamber-shirt')!.radius).toBe(0);
    expect(world.colliders.find(collider => collider.id === 'tree-001')!.enabled).toBe(false);
    expect(world.colliders.find(collider => collider.id === 'chamber-door')!.enabled).toBe(false);
    state.flags.chamberDoor = false;
    state.flags.doorOpen = true;
    world.update(0, state);
    expect(world.colliders.find(collider => collider.id === 'chamber-door')!.enabled).toBe(false);
  });

  it('keeps the tower teleport safe and allows walking up and back down every switchback', () => {
    state.tower = true;
    world.update(0.05, state);
    const collision = new PlayerCollision(() => world);
    const position = new THREE.Vector3(7.6, 8, 10.7);
    const velocity = new THREE.Vector3();
    let grounded = true;
    const walk = (x: number, z: number): void => {
      for (let i = 0; i < 1600 && Math.hypot(position.x - x, position.z - z) > 0.075; i++) {
        const dx = x - position.x, dz = z - position.z;
        const distance = Math.hypot(dx, dz);
        const speed = Math.min(4, distance / 0.025);
        velocity.set(dx / distance * speed, -0.5, dz / distance * speed);
        grounded = collision.move(position, velocity, 0.025, CONFIG.playerHeight, grounded, true);
      }
      expect(Math.hypot(position.x - x, position.z - z)).toBeLessThan(0.1);
    };
    expect(collision.canOccupy(new THREE.Vector3(0, 28, 0), CONFIG.playerHeight)).toBe(true);
    expect(collision.floor(new THREE.Vector3(0, 28, 0))).toBe(28);
    walk(7.6, -9.1); walk(-7.6, -9.1); walk(-7.6, 8.4); walk(0, 8.4); walk(0, 0);
    expect(position.y).toBeCloseTo(28, 2);
    walk(0, 8.4); walk(-7.6, 8.4); walk(-7.6, -9.1); walk(7.6, -9.1); walk(7.6, 10.7);
    expect(position.y).toBeCloseTo(8, 2);
  });

  it('has an accessible glider pedestal and does not overwrite ability motion', () => {
    const collision = new PlayerCollision(() => world);
    expect(collision.floor(new THREE.Vector3(0, 19, -75))).toBe(19);
    expect(collision.canOccupy(new THREE.Vector3(0, 19, -75), CONFIG.playerHeight)).toBe(true);
    const target = world.targets.find(item => item.id === 'lake-metal-chest')!;
    target.position.set(-25, 12, 45);
    target.mesh.position.copy(target.position);
    world.update(0.05, state);
    expect(target.position.toArray()).toEqual([-25, 12, 45]);
    expect(world.interactables.find(item => item.id === target.id)!.position.toArray()).toEqual([-25, 12.35, 45]);
  });
});
