import * as THREE from 'three';
import { CONFIG } from '../config/game';
import type { GameState, Vec3, WorldView } from './types';

/** Validate both the loaded position and its fallback; old saves can contain a
 * waterlogged "safe" point after opening an underwater chest. */
export function recoverSavedPosition(state: GameState, world: WorldView): void {
  const box = new THREE.Box3();
  const valid = (candidate: Vec3): Vec3 | undefined => {
    if (!candidate.every(Number.isFinite) || Math.abs(candidate[1]) > 200 || Math.hypot(candidate[0], candidate[2]) > 170 || candidate[1] < -35) return;
    const floor = world.heightAt(candidate[0], candidate[2]);
    if (!Number.isFinite(floor) || floor < -35) return;
    const p: Vec3 = [candidate[0], Math.max(candidate[1], floor + 0.05), candidate[2]];
    if (world.waters.some(w => p[0] >= w.minX && p[0] <= w.maxX && p[2] >= w.minZ && p[2] <= w.maxZ && w.level - floor > 0.94 && p[1] < w.level + 0.12)) return;
    box.min.set(p[0] - CONFIG.playerRadius, p[1] + 0.08, p[2] - CONFIG.playerRadius);
    box.max.set(p[0] + CONFIG.playerRadius, p[1] + CONFIG.playerHeight - 0.05, p[2] + CONFIG.playerRadius);
    if (world.colliders.some(c => c.enabled && c.box.intersectsBox(box))) return;
    return p;
  };
  const canonical: Vec3 = state.region === 'overworld' ? [0, 0, state.terminal ? 82 : 105] : [0, 0, 9];
  const shore = valid(state.safePosition) ?? valid(canonical) ?? canonical;
  state.safePosition = [...shore];
  state.player.position = valid(state.player.position) ?? [...shore];
  state.player.movement = 'idle';
}
