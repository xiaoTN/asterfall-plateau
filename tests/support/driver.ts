import * as THREE from 'three';
import { advanceClock } from '../../src/core/clock';
import type { Vec3 } from '../../src/core/types';

/** Browser-only deterministic input driver. It never grants items, changes quests,
 * teleports actors, disables collision, or rewrites puzzle state. Rendering is
 * sampled at checkpoints; the real controllers run at 60 simulation steps/sec. */
export function installDriver() {
  const g = (window as unknown as { __asterfall: any }).__asterfall;
  g.rendering = false; // Stop wall-clock RAF while this test owns stepping.
  const held = new Set<string>();
  function keys(next: string[]) {
    for (const key of held) if (!next.includes(key)) {
      if (key.startsWith('Mouse')) window.dispatchEvent(new MouseEvent('mouseup', { button: Number(key.at(-1)) }));
      else window.dispatchEvent(new KeyboardEvent('keyup', { code: key }));
      held.delete(key);
    }
    for (const key of next) if (!held.has(key)) {
      if (key.startsWith('Mouse')) {
        // Avoid synthetic pointer-lock requests; Input receives the same button event.
        const original = g.input.lock; g.input.lock = () => {};
        g.renderer.domElement.dispatchEvent(new MouseEvent('mousedown', { button: Number(key.at(-1)) }));
        g.input.lock = original;
      } else window.dispatchEvent(new KeyboardEvent('keydown', { code: key }));
      held.add(key);
    }
  }
  function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(`${message}\n${JSON.stringify({ position: g.player.position.toArray(), hp: g.state.player.hp, movement: g.player.movement, region: g.state.region, stage: g.state.trialStages, panel: g.panel, prompt: g.nearest()?.id, notices: g.notices.map((n: any) => n.text) })}`);
  }
  function step(frames = 1) {
    for (let n = 0; n < frames; n++) {
      const dt = 1 / 60;
      g.ctx.realDt = dt;
      g.controls();
      if (g.cinema) { g.cinema.remaining -= dt; if (g.cinema.remaining <= 0) g.finishCinema(); }
      if (g.canSimulate()) {
        const scaled = dt * g.ctx.timeScale; g.ctx.timeScale = 1; g.ctx.elapsed += scaled;
        g.player.update(scaled);
        if (g.canSimulate()) g.combat.update(scaled);
        if (g.canSimulate()) g.abilities.update(scaled);
        if (g.canSimulate()) g.gameplay.update(scaled);
        if (g.canSimulate()) advanceClock(g.state, scaled);
        g.ctx.world.update(scaled, g.state); g.effects.update(scaled);
      } else g.ctx.world.update(dt, g.state);
      g.player.updateCamera(dt);
      g.input.endFrame();
      check(g.state.player.hp > 0, 'Player died during journey');
    }
  }
  function press(key: string) { keys([key]); step(); keys([]); step(); }
  function skip() { if (g.cinema) press('Enter'); check(!g.cinema, 'Cinematic did not skip'); }
  function choose(label: string) {
    const option = g.dialogue?.options.find((o: { label: string }) => o.label.includes(label));
    check(option, `Missing dialogue option: ${label}`); option.action(); keys([]); step();
  }
  function walk(x: number, z: number, climb = false, max = 4500, route = true) {
    if (route && g.state.region === 'overworld' && Math.hypot(x - g.player.position.x, z - g.player.position.z) > 25) {
      for (const point of path(x, z)) walk(point[0], point[1], climb, max, false);
      return;
    }
    const startX = g.player.position.x, startZ = g.player.position.z;
    const segmentX = x - startX, segmentZ = z - startZ, length = Math.hypot(segmentX, segmentZ);
    for (let n = 0; n < max; n++) {
      if (g.cinema) { keys([]); return; }
      check(g.panel === 'none', 'Menu interrupted walking');
      if (Math.hypot(x - g.player.position.x, z - g.player.position.z) < 0.22) { keys([]); step(12); return; }
      const t = Math.min(1, Math.max(0, ((g.player.position.x - startX) * segmentX + (g.player.position.z - startZ) * segmentZ) / (length * length)) + 1 / length);
      const dx = startX + segmentX * t - g.player.position.x, dz = startZ + segmentZ * t - g.player.position.z;
      const yaw = g.player.orbitYaw;
      const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const forward = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
      const next: string[] = [];
      if (Math.abs(right) > 0.1) next.push(right > 0 ? 'KeyD' : 'KeyA');
      if (Math.abs(forward) > 0.1) next.push(forward > 0 ? 'KeyW' : 'KeyS');
      if (climb) next.push('Space');
      keys(next); step();
    }
    keys([]); check(false, `Could not walk to ${x},${z}`);
  }
  function path(x: number, z: number): [number, number][] {
    // Route around actual trees, buildings and deep water. All waypoints are still
    // traversed by keyboard movement and the production collision controller.
    const scale = 2, start = [Math.round(g.player.position.x / scale), Math.round(g.player.position.z / scale)];
    const end = [Math.round(x / scale), Math.round(z / scale)];
    const key = (a: number, b: number) => `${a},${b}`;
    const terrain = g.ctx.world;
    const occupancy = new Map<string, number>();
    const height = (a: number, b: number) => {
      const id = key(a, b); if (occupancy.has(id)) return occupancy.get(id)!;
      const px = a * scale, pz = b * scale, y = terrain.heightAt(px, pz);
      const box = new THREE.Box3(new THREE.Vector3(px - 0.5, y + 0.56, pz - 0.5), new THREE.Vector3(px + 0.5, y + 1.75, pz + 0.5));
      const blocked = Math.hypot(px, pz) > 141 || terrain.colliders.some((c: any) => c.enabled && c.box.intersectsBox(box))
        || terrain.spawns.some((s: any) => Math.hypot(px - s.position[0], pz - s.position[2]) < 24)
        || terrain.waters.some((w: any) => px >= w.minX - 1 && px <= w.maxX + 1 && pz >= w.minZ - 1 && pz <= w.maxZ + 1 && w.level - y > 0.8);
      occupancy.set(id, blocked ? Infinity : y); return blocked ? Infinity : y;
    };
    const begin = key(start[0]!, start[1]!);
    const open = [{ a: start[0]!, b: start[1]!, cost: 0, score: 0 }];
    const costs = new Map([[begin, 0]]), parents = new Map<string, string>();
    let found = '';
    for (let n = 0; open.length && n < 30000; n++) {
      let best = 0; for (let i = 1; i < open.length; i++) if (open[i]!.score < open[best]!.score) best = i;
      const node = open.splice(best, 1)[0]!;
      const id = key(node.a, node.b);
      if (node.cost > costs.get(id)!) continue;
      if (Math.hypot(node.a - end[0]!, node.b - end[1]!) <= 1) { found = id; break; }
      for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = node.a + da!, b = node.b + db!, next = key(a, b), h = height(a, b);
        const previous = terrain.heightAt(node.a * scale, node.b * scale);
        if (!Number.isFinite(h) || Math.abs(h - previous) > 2.2) continue;
        const cost = node.cost + 1 + Math.abs(h - previous) * 0.1;
        if (cost >= (costs.get(next) ?? Infinity)) continue;
        costs.set(next, cost); parents.set(next, id); open.push({ a, b, cost, score: cost + Math.abs(a - end[0]!) + Math.abs(b - end[1]!) });
      }
    }
    if (!found) return [[x, z]];
    const result: [number, number][] = [[x, z]];
    while (found !== begin) { const [a, b] = found.split(',').map(Number); result.push([a! * scale, b! * scale]); found = parents.get(found)!; }
    return result.reverse();
  }
  function interact(id: string) {
    for (let n = 0; n < 8; n++) {
      const nearest = g.nearest(); check(nearest, `Nothing within reach of ${id}`);
      press('KeyE');
      if (nearest.id === id) return;
      check(g.panel === 'none' && !g.cinema, `Another interaction intercepted ${id}: ${nearest.id}`);
    }
    check(false, `Cannot interact with ${id}`);
  }
  function travel(x: number, z: number) { for (const point of path(x, z)) walk(point[0], point[1], false, 4500, false); }
  function look(point: Vec3, metal = false) {
    keys([]);
    const direction = new THREE.Vector3(...point).sub(g.player.position).sub(new THREE.Vector3(0, metal ? 1.25 : 1.32, 0));
    const yaw = Math.atan2(-direction.x, -direction.z);
    // These are mouse-controlled camera angles, constrained to the real supported pitch.
    g.player.orbitYaw = yaw;
    g.player.orbitPitch = THREE.MathUtils.clamp(Math.atan2(-direction.y, Math.hypot(direction.x, direction.z) - (metal ? 0 : 0.62)), -0.24, 1.18);
    step(60);
  }
  function carry(point: Vec3) {
    const stageBefore = g.state.trialStages[g.state.region];
    if (stageBefore === 3) return;
    look(point, true);
    const distance = g.player.position.clone().add(new THREE.Vector3(0, 1.25, 0)).distanceTo(new THREE.Vector3(...point));
    for (let n = 0; n < 12; n++) {
      g.input.wheel = THREE.MathUtils.clamp((distance - g.abilities.heldDistance) / 0.6, -4, 4); step();
    }
    for (let n = 0; n < 300; n++) {
      if (g.state.trialStages[g.state.region] !== stageBefore) break;
      step();
    }
  }
  function attack(times = 1) { for (let i = 0; i < times; i++) { keys(['Mouse0']); step(12); keys([]); step(75); } }
  function screenshot() { keys([]); g.renderUI(); g.updateLighting(0.05); g.renderer.render(g.scene, g.camera); }
  function stage(id: string, expected: number) { check(g.state.trialStages[id] === expected, `${id} expected stage ${expected}`); }
  function finishTrial(id: string) {
    stage(id, 3); walk(0, -57.7); interact(`${id}:reward`); skip();
    check(g.state.completed.includes(id), 'Reward missing'); choose('返回台地'); skip();
    if (g.panel === 'dialogue') choose('四座');
  }
  return { g, step, keys, check, press, skip, choose, walk, travel, interact, look, carry, attack, screenshot, stage, finishTrial };
}
