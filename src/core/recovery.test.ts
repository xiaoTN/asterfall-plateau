import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createState } from './state';
import { recoverSavedPosition } from './recovery';
import type { WorldView } from './types';

function world(): WorldView {
  return { root: new THREE.Group(), targets: [], interactables: [], colliders: [], spawns: [],
    waters: [{ minX: -40, maxX: -30, minZ: 40, maxZ: 50, level: 9, depth: 5 }],
    heightAt: (x) => x < -30 ? 4 : 20, update() {}, dispose() {} };
}
describe('validated respawn recovery', () => {
  it('rejects a deep-water save even when its safe point is also submerged', () => {
    const s = createState(); s.terminal = true; s.player.position = [-35, 4, 46]; s.safePosition = [-35, 4, 46];
    recoverSavedPosition(s, world());
    expect(s.player.position).toEqual([0, 20.05, 82]); expect(s.safePosition).toEqual(s.player.position);
  });
  it('rejects blocked positions and preserves a valid tower deck', () => {
    const s = createState(); s.terminal = true; s.player.position = [0, 28, 0]; s.safePosition = [0, 28, 0];
    const w = world(); w.colliders.push({ id: 'deck', enabled: true, climbable: true, box: new THREE.Box3(new THREE.Vector3(-4, 26, -4), new THREE.Vector3(4, 28, 4)) });
    recoverSavedPosition(s, w); expect(s.player.position).toEqual([0, 28, 0]);
    s.player.position = [0, 27, 0]; recoverSavedPosition(s, w); expect(s.player.position).toEqual([0, 28, 0]);
  });
});
