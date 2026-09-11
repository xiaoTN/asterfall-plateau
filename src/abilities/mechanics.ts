import * as THREE from 'three';
import type { AbilityId, AbilityTarget, Collider, Interactable, WorldView } from '../core/types';

/** Private metadata: shared contracts remain independent of individual puzzles. */
export interface Mechanism {
  role?: 'panel' | 'bridgeCube' | 'pullDoor' | 'striker' | 'lantern' | 'crack' | 'pipeReceiver' | 'launchOrb' | 'remoteWall' | 'rotor' | 'roller' | 'chargeOrb' | 'iceGate';
  bridgeSlot?: number;
  launchedBlast?: boolean;
  weight?: number;
  anchored?: boolean;
  impulse?: THREE.Vector3;
  releasedCharge?: number;
  brokenByAbility?: boolean;
  frozenFromZ?: number;
  lifted?: boolean;
}
export interface TrialRuntime {
  id: AbilityId;
  gates: { mesh: THREE.Object3D; collider: Collider; stage: number }[];
  reward: Interactable;
  hints: readonly string[];
  bridgeSlots: THREE.Vector3[];
  pipeEntry: THREE.Vector3;
  pipeEnd: THREE.Vector3;
  launcher: THREE.Vector3;
  launcherArm?: THREE.Object3D;
  launcherMarker?: THREE.Object3D;
  stoodOnBridge: boolean;
  bridgePlaced: boolean;
  gateLifted: boolean;
  exitPillar: boolean;
  doorPulled: boolean;
  clock: number;
}
export const mechanisms = new WeakMap<AbilityTarget, Mechanism>();
export const trials = new WeakMap<WorldView, TrialRuntime>();
export function mechanism(target: AbilityTarget): Mechanism {
  let value = mechanisms.get(target);
  if (!value) {
    value = {};
    mechanisms.set(target, value);
  }
  return value;
}
export function disposeResources(geometries: Iterable<THREE.BufferGeometry>, materials: Iterable<THREE.Material>, textures: Iterable<THREE.Texture> = []): void {
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
