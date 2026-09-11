import * as THREE from 'three';
import type { AbilityTarget, Collider, GameState, Interactable, Vec3 } from '../core/types';
import { isColdTerrain, outsideStructures, pathDistance, seededRandom, terrainHeight } from './terrain';

interface AppleRecord { target: AbilityTarget; pickup: Interactable; radius: number; }
interface LogRecord { target: AbilityTarget; half: THREE.Vector3; yaw: number; }
interface TreeRecord {
  id: string; position: THREE.Vector3; scale: number; yaw: number; pine: boolean;
  collider: Collider; interaction: Interactable; index: number; felled: boolean; shaken: boolean;
  apples: AppleRecord[]; log?: LogRecord;
}
interface GrassPatch { mesh: THREE.InstancedMesh; x: number; z: number; }

/** Trees remain instanced; harvestable fruit and reusable felled logs have individual bodies. */
export class PlateauFoliage {
  readonly root = new THREE.Group();
  private readonly trees: TreeRecord[] = [];
  private readonly grass: GrassPatch[] = [];
  private readonly trunks: THREE.InstancedMesh;
  private readonly crowns: THREE.InstancedMesh;
  private readonly snowCrowns: THREE.InstancedMesh;
  private readonly appleGeometry = new THREE.IcosahedronGeometry(0.22, 1);
  private logGeometry?: THREE.BufferGeometry;
  private readonly appleMaterial = new THREE.MeshStandardMaterial({ color: '#d65d3e', roughness: 0.72, flatShading: true });
  private readonly bark = new THREE.MeshStandardMaterial({ color: '#665344', roughness: 1, flatShading: true });
  private readonly transform = new THREE.Object3D();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly wind = { value: 0 };
  private lodClock = 0;
  private bloodMoonCount?: number;

  constructor(private readonly colliders: Collider[], private readonly interactions: Interactable[], private readonly targets: AbilityTarget[]) {
    this.root.name = 'Instanced woodland, meadow and wildflowers';
    const random = seededRandom(824113);
    const treeCount = 158;
    const leaf = new THREE.MeshStandardMaterial({ color: '#597d44', roughness: 1, flatShading: true });
    const snow = new THREE.MeshStandardMaterial({ color: '#dbe5df', roughness: 1, flatShading: true });
    const trunkGeometry = new THREE.CylinderGeometry(0.26, 0.46, 3.7, 5).translate(0, 1.85, 0);
    this.trunks = new THREE.InstancedMesh(trunkGeometry, this.bark, treeCount);
    this.crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), leaf, treeCount * 3);
    this.snowCrowns = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 2.3, 6), snow, treeCount * 2);
    for (const mesh of [this.trunks, this.crowns, this.snowCrowns]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Population is spread across the plateau; zeroed removed instances must not shrink its bound.
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, 0), 155);
      this.root.add(mesh);
    }
    const orchard = [[20, 69], [25, 74], [30, 64], [19, 79], [-13, 62], [-17, 70], [-21, 78], [24, 84]];
    for (let i = 0; i < treeCount; i++) {
      let x = 0, z = 0;
      let valid = false;
      for (let attempt = 0; attempt < 1000 && !valid; attempt++) {
        if (i < orchard.length && attempt === 0) [x, z] = orchard[i];
        else { x = (random() - 0.5) * 266; z = (random() - 0.5) * 266; }
        const slope = Math.abs(terrainHeight(x + 1, z) - terrainHeight(x - 1, z)) + Math.abs(terrainHeight(x, z + 1) - terrainHeight(x, z - 1));
        valid = outsideStructures(x, z, 2) && pathDistance(x, z) > 3.5 && slope < 2.1
          && !this.trees.some(tree => Math.hypot(tree.position.x - x, tree.position.z - z) < 4.5);
      }
      if (!valid) { this.trunks.count = i; break; }
      const y = terrainHeight(x, z);
      const scale = 0.85 + random() * 0.65;
      const id = `tree-${String(i + 1).padStart(3, '0')}`;
      const position = new THREE.Vector3(x, y, z);
      const logical = new THREE.Group();
      logical.name = id;
      logical.position.copy(position);
      logical.userData.tree = true;
      this.root.add(logical);
      const collider: Collider = {
        id, enabled: true, climbable: true, mesh: logical,
        box: new THREE.Box3(new THREE.Vector3(x - 0.32 * scale, y, z - 0.32 * scale), new THREE.Vector3(x + 0.32 * scale, y + 3.7 * scale, z + 0.32 * scale)),
      };
      const pine = isColdTerrain(x, z);
      const interaction: Interactable = {
        id, kind: 'tree', name: pine ? '霜杉' : '星叶苹果树', position: position.clone(), radius: 2.8,
        mesh: logical, item: 'apple', data: { apples: pine ? 0 : 3, wood: 2, hp: 3, pine },
      };
      const tree: TreeRecord = { id, position, scale, yaw: random() * Math.PI * 2, pine, collider, interaction, index: i, felled: false, shaken: false, apples: [] };
      this.trees.push(tree);
      colliders.push(collider);
      interactions.push(interaction);
      if (!pine) for (let k = 0; k < 3; k++) this.addApple(tree, k);
      const tint = new THREE.Color().setHSL(0.21 + random() * 0.05, 0.26 + random() * 0.11, 0.35 + random() * 0.13);
      for (let k = 0; k < 3; k++) this.crowns.setColorAt(i * 3 + k, tint);
      this.paintTree(tree);
    }
    this.trunks.count = this.trees.length;
    this.crowns.count = this.trees.length * 3;
    this.snowCrowns.count = this.trees.length * 2;
    this.buildGroundCover(random);
    this.buildRocks(random, colliders);
  }

  private addApple(tree: TreeRecord, index: number): void {
    const id = `resource-apple:${tree.id}:${index}`;
    const angle = tree.yaw + index * Math.PI * 2 / 3;
    const mesh = new THREE.Mesh(this.appleGeometry, this.appleMaterial);
    mesh.name = id;
    mesh.position.set(tree.position.x + Math.cos(angle) * 1.8 * tree.scale,
      tree.position.y + 2.8 * tree.scale, tree.position.z + Math.sin(angle) * 1.8 * tree.scale);
    mesh.scale.setScalar(tree.scale);
    mesh.castShadow = true;
    mesh.userData = { treeId: tree.id, abilityTarget: id, resource: 'apple', item: 'apple', mass: 0.2, shape: 'sphere', radius: 0.22 * tree.scale };
    this.root.add(mesh);
    // Body and pickup share a logical position; AbilitySystem moves the renderer separately.
    const target: AbilityTarget = { id, kind: 'orb', resource: 'apple', attached: true,
      mesh, position: mesh.position.clone(), origin: mesh.position.toArray() as Vec3, velocity: new THREE.Vector3() };
    const pickup: Interactable = { id, kind: 'pickup', name: '星叶苹果', item: 'apple', mesh,
      position: target.position, radius: 2.5, data: { count: 1, treeId: tree.id, targetId: id } };
    tree.apples.push({ target, pickup, radius: 0.22 * tree.scale });
    this.targets.push(target);
    this.interactions.push(pickup);
  }

  private addLog(tree: TreeRecord): LogRecord {
    const id = `log:${tree.id}`;
    const length = 3.7 * tree.scale, radius = 0.38 * tree.scale;
    // X-axis logs roll around X in AbilitySystem, staying horizontal and aligned with their bridge AABB.
    const sign = Math.cos(tree.yaw) < 0 ? -1 : 1;
    const x = tree.position.x + sign * length / 2, z = tree.position.z;
    let floor = tree.position.y;
    for (let i = 0; i <= 4; i++) floor = Math.max(floor, terrainHeight(x + (i / 4 - 0.5) * length, z));
    this.logGeometry ??= new THREE.CylinderGeometry(1, 1, 1, 8).rotateZ(-Math.PI / 2);
    const mesh = new THREE.Mesh(this.logGeometry, this.bark);
    mesh.name = id;
    mesh.position.set(x, floor + radius, z);
    mesh.scale.set(length, radius, radius);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData = { treeId: tree.id, abilityTarget: id, resource: 'log', mass: 12 * tree.scale,
      weight: 12 * tree.scale, shape: 'cylinder', axis: 'x', length, radius };
    this.root.add(mesh);
    const half = new THREE.Vector3(length / 2, radius, radius);
    const collider: Collider = { id, mesh, enabled: true, climbable: true,
      box: new THREE.Box3(mesh.position.clone().sub(half), mesh.position.clone().add(half)) };
    const target: AbilityTarget = { id, kind: 'orb', resource: 'log', attached: false,
      mesh, position: mesh.position.clone(), origin: mesh.position.toArray() as Vec3, collider, velocity: new THREE.Vector3() };
    this.colliders.push(collider);
    this.targets.push(target);
    return { target, half, yaw: mesh.rotation.y };
  }

  private resetBody(target: AbilityTarget): void {
    target.position.set(...target.origin!);
    target.mesh.position.copy(target.position);
    target.velocity!.set(0, 0, 0);
    target.frozen = target.charge = 0;
    target.solved = false;
    target.mesh.rotation.set(0, 0, 0);
  }

  private matrix(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0, lean = 0): THREE.Matrix4 {
    this.transform.position.set(x, y, z);
    this.transform.scale.set(sx, sy, sz);
    this.transform.rotation.set(0, yaw, lean);
    this.transform.updateMatrix();
    return this.transform.matrix;
  }

  private paintTree(tree: TreeRecord): void {
    const { x, y, z } = tree.position;
    const s = tree.scale, i = tree.index;
    this.trunks.setMatrixAt(i, tree.felled ? this.hidden : this.matrix(x, y, z, s, s, s, tree.yaw));
    for (let k = 0; k < 3; k++) {
      const angle = tree.yaw + k * Math.PI * 2 / 3;
      this.crowns.setMatrixAt(i * 3 + k, tree.felled || tree.pine ? this.hidden
        : this.matrix(x + Math.cos(angle) * 1.05 * s, y + (3.7 + (k === 0 ? 0.7 : 0)) * s, z + Math.sin(angle) * 1.05 * s, 2.2 * s, 1.75 * s, 2.1 * s, angle));
    }
    for (let k = 0; k < 2; k++) this.snowCrowns.setMatrixAt(i * 2 + k, tree.felled || !tree.pine ? this.hidden
      : this.matrix(x, y + (3.1 + k * 1.55) * s, z, (2.3 - k * 0.7) * s, (1.6 - k * 0.2) * s, (2.3 - k * 0.7) * s, tree.yaw));
    tree.collider.enabled = !tree.felled;
    tree.interaction.mesh!.visible = !tree.felled;
    tree.interaction.radius = tree.felled ? 0 : 2.8;
    tree.interaction.data!.disabled = tree.felled;
    for (const mesh of [this.trunks, this.crowns, this.snowCrowns]) mesh.instanceMatrix.needsUpdate = true;
  }

  private buildGroundCover(random: () => number): void {
    const grassGeometry = new THREE.BufferGeometry();
    grassGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.15, 0, 0, 0.05, 0.7, 0.06, 0.15, 0, 0,
      0, 0, -0.14, 0.06, 0.54, 0.01, 0, 0, 0.14,
    ], 3));
    grassGeometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: '#829d47', roughness: 1, side: THREE.DoubleSide, flatShading: true });
    material.onBeforeCompile = shader => {
      shader.uniforms.worldWind = this.wind;
      shader.vertexShader = `uniform float worldWind;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n transformed.x += sin(worldWind * 1.6 + instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.12) * position.y * 0.19;');
    };
    material.customProgramCacheKey = () => 'asterfall-grass-wind-v1';
    for (let cz = -2; cz < 3; cz++) {
      for (let cx = -2; cx < 3; cx++) {
        const matrices: THREE.Matrix4[] = [];
        const centerX = cx * 48, centerZ = cz * 48;
        for (let i = 0; i < 210; i++) {
          const x = centerX + (random() - 0.5) * 48, z = centerZ + (random() - 0.5) * 48;
          if (!outsideStructures(x, z) || isColdTerrain(x, z) || pathDistance(x, z) < 2) continue;
          const y = terrainHeight(x, z);
          if (Math.abs(terrainHeight(x + 1, z) - y) > 1) continue;
          const size = 0.5 + random() * 1.1;
          matrices.push(this.matrix(x, y - 0.05, z, size, size, size, random() * 6.28).clone());
        }
        const mesh = new THREE.InstancedMesh(grassGeometry, material, matrices.length);
        matrices.forEach((matrix, i) => {
          mesh.setMatrixAt(i, matrix);
          mesh.setColorAt(i, new THREE.Color().setHSL(0.18 + random() * 0.05, 0.35, 0.6 + random() * 0.15));
        });
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        this.grass.push({ mesh, x: centerX, z: centerZ });
        this.root.add(mesh);
      }
    }
    const flowerGeometry = new THREE.IcosahedronGeometry(0.09, 0);
    const flowers = new THREE.InstancedMesh(flowerGeometry, new THREE.MeshStandardMaterial({ color: '#f2e7bb', roughness: 1 }), 350);
    let count = 0;
    for (let i = 0; i < 1800 && count < 350; i++) {
      const x = (random() - 0.5) * 240, z = (random() - 0.5) * 240;
      if (!outsideStructures(x, z) || isColdTerrain(x, z) || pathDistance(x, z) < 2) continue;
      flowers.setMatrixAt(count, this.matrix(x, terrainHeight(x, z) + 0.25, z, 1.2, 0.6, 1.2));
      flowers.setColorAt(count, new THREE.Color(count % 4 === 0 ? '#b5abce' : count % 3 === 0 ? '#f5d981' : '#efebcf'));
      count++;
    }
    flowers.count = count;
    flowers.computeBoundingSphere();
    this.root.add(flowers);
  }

  private buildRocks(random: () => number, colliders: Collider[]): void {
    const geometry = new THREE.DodecahedronGeometry(1, 0);
    const material = new THREE.MeshStandardMaterial({ color: '#909a86', roughness: 1, flatShading: true });
    const mesh = new THREE.InstancedMesh(geometry, material, 180);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    let count = 0;
    for (let i = 0; i < 3000 && count < 180; i++) {
      const x = (random() - 0.5) * 266, z = (random() - 0.5) * 266;
      if (!outsideStructures(x, z, 1) || pathDistance(x, z) < 3) continue;
      const size = 0.4 + random() * 1.1;
      const y = terrainHeight(x, z);
      mesh.setMatrixAt(count, this.matrix(x, y + size * 0.24, z, size, size * 0.8, size * 0.85, random() * 6.28));
      mesh.setColorAt(count, new THREE.Color(isColdTerrain(x, z) ? '#e0e7dd' : '#aab099'));
      // Only substantial rocks block travel; tiny stones remain harmless set dressing.
      if (size > 1) colliders.push({
        id: `field-rock-${count}`, climbable: true, enabled: true,
        box: new THREE.Box3(new THREE.Vector3(x - size * 0.62, y - 0.2, z - size * 0.54), new THREE.Vector3(x + size * 0.62, y + size * 0.92, z + size * 0.54)),
      });
      count++;
    }
    mesh.count = count;
    mesh.computeBoundingSphere();
    this.root.add(mesh);
  }

  update(dt: number, state: GameState): void {
    this.wind.value += dt;
    const initial = this.bloodMoonCount === undefined;
    const bloodMoon = !initial && this.bloodMoonCount !== state.bloodMoonCount;
    this.bloodMoonCount = state.bloodMoonCount;
    for (const tree of this.trees) {
      if (bloodMoon) delete state.flags[`picked:${tree.id}`]; // Legacy whole-tree harvest flag.
      const felled = !!state.flags[`felled:${tree.id}`];
      const shaken = !!state.flags[`shaken:${tree.id}`] || !!state.flags[`apples:${tree.id}`] || !!state.flags[`picked:${tree.id}`];
      const reset = bloodMoon || (!felled && !shaken && (tree.felled || tree.shaken));
      if (initial || reset) {
        Object.assign(tree.interaction.data!, { hp: 3, chops: 0, felled, chopped: felled, applesTaken: shaken, apples: tree.pine ? 0 : 3 });
        tree.interaction.mesh!.position.copy(tree.position);
        tree.interaction.mesh!.rotation.set(0, 0, 0);
      }
      if (initial || reset || felled !== tree.felled || shaken !== tree.shaken) {
        tree.felled = felled;
        tree.shaken = shaken;
        this.paintTree(tree);
      }
      for (const apple of tree.apples) {
        const { target, pickup, radius } = apple;
        if (reset) {
          delete state.flags[`broken:${target.id}`];
          delete state.flags[`destroyed:${target.id}`];
        }
        if (initial || reset) {
          this.resetBody(target);
          target.attached = !felled && !shaken;
          // A saved shaken/felled tree restores its remaining fruit on the ground, never new loot.
          if (!target.attached) target.position.y = terrainHeight(target.position.x, target.position.z) + radius;
          target.mesh.position.copy(target.position);
        }
        const picked = !!state.flags[`picked:${target.id}`] || !!state.flags[`broken:${target.id}`] || !!state.flags[`destroyed:${target.id}`];
        if (!picked && target.attached && (felled || shaken)) {
          target.attached = false;
          target.velocity!.set((target.position.x - tree.position.x) * 0.5, 0.7, (target.position.z - tree.position.z) * 0.5);
        }
        target.solved = picked;
        target.mesh.visible = !picked;
        pickup.radius = picked ? 0 : 2.5;
        pickup.data!.disabled = picked;
        if (picked) {
          target.velocity!.set(0, 0, 0);
          target.frozen = target.charge = 0;
        }
      }
      const logId = `log:${tree.id}`;
      if (!felled) {
        // Clock clears felled flags, including while this world is unloaded; broken logs belong to that old tree.
        delete state.flags[`broken:${logId}`];
        delete state.flags[`destroyed:${logId}`];
      }
      if (felled && !tree.log) tree.log = this.addLog(tree);
      if (tree.log) {
        const { target, half, yaw } = tree.log;
        if (reset) {
          this.resetBody(target);
          target.mesh.rotation.y = yaw;
          target.collider!.box.min.copy(target.position).sub(half);
          target.collider!.box.max.copy(target.position).add(half);
        }
        const active = felled && !state.flags[`broken:${logId}`] && !state.flags[`destroyed:${logId}`];
        target.solved = !active;
        target.mesh.visible = active;
        target.collider!.enabled = active;
        if (!active) {
          target.velocity!.set(0, 0, 0);
          target.frozen = target.charge = 0;
        }
      }
    }
    this.lodClock -= dt;
    if (this.lodClock > 0) return;
    this.lodClock = 0.3;
    const [px, , pz] = state.player.position;
    const distance = state.settings.quality === 'low' ? 50 : state.settings.quality === 'medium' ? 83 : 115;
    for (const patch of this.grass) patch.mesh.visible = Math.hypot(px - patch.x, pz - patch.z) < distance;
    const shadows = state.settings.quality !== 'low';
    this.crowns.castShadow = shadows;
    this.snowCrowns.castShadow = shadows;
    // Resource visibility is gameplay state, never a quality-level decoration toggle.
    for (const tree of this.trees) for (const apple of tree.apples) apple.target.mesh.castShadow = shadows;
  }
}
