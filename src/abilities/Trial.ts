import * as THREE from 'three';
import type { AbilityId, AbilityTarget, Collider, GameState, Interactable, Vec3, WorldView } from '../core/types';
import { ABILITIES } from '../config/game';
import { disposeResources, mechanism, trials, type Mechanism, type TrialRuntime } from './mechanics';

const PALETTES = {
  magnet: { stone: 0x25283c, edge: 0x704459, light: 0xff8fb9, water: 0x462c50, title: '牵星 · 重量的回声', subtitle: 'THE WEIGHT OF A STAR' },
  bomb: { stone: 0x263c47, edge: 0x406679, light: 0x67e9ff, water: 0x153947, title: '鸣爆 · 空谷共振', subtitle: 'THE HOLLOW RESONANCE' },
  stasis: { stone: 0x3c352b, edge: 0x746342, light: 0xffd775, water: 0x494026, title: '凝时 · 未落的沙', subtitle: 'THE UNFALLEN SAND' },
  ice: { stone: 0x233e4a, edge: 0x457e8c, light: 0xa1ecff, water: 0x176f8c, title: '霜阶 · 静水天梯', subtitle: 'THE STILLWATER ASCENT' },
} as const;
const HINTS: Record<AbilityId, readonly string[]> = {
  magnet: [
    'Ⅰ 托起封板：按 1，瞄准粉色金属按 F；向上看抬高，再按 F 放手。滚轮调远近，Q 取消。',
    'Ⅱ 双星成桥：先远后近，把两块方块放进坑内光环；靠近光环会辅助对齐，沉底后 F 放手。踏上方块桥走到远岸；失足会返回近岸。',
    'Ⅲ 牵门迎敌：向自己拉出金属门，再用左侧金属块撞击门后右侧的守卫。移动鼠标挥动金属，以碰撞造成伤害；直接击败守卫也可通关。',
  ],
  bomb: [
    'Ⅰ 裂石听雷：按 2，F 在前方放炸弹。退到红圈外，再按 F 引爆裂纹墙。',
    'Ⅱ 圆行方止：V 切到球形，把球放进左侧蓝色管口。看它滚到管末，再 F 引爆。方弹不会通过。',
    'Ⅲ 空中借力：在光环弹射台放球形炸弹，半秒后自动抛射。站在红圈外，等炸弹飞近石球、与球同高时 F 遥爆；冲击推球撞墙。失手可重新放弹。',
  ],
  stasis: [
    'Ⅰ 停下回旋：按 3，瞄准金色转台按 F。六秒内穿过转台，跳跃更稳。',
    'Ⅱ 石流间隙：F 冻结横滚的石球，趁六秒空隙从旁边穿到对岸。',
    'Ⅲ 蓄势而发：F 冻结终点金球，走近用左键击打至少两次。箭头蓄满后等六秒，或再 F 释放。',
  ],
  ice: [
    'Ⅰ 水上落脚：按 4，向下瞄准水面；蓝色预览时 F 造柱。空格攀上冰柱，造两根桥柱渡到远岸。',
    'Ⅱ 托门而起：瞄准水中栅门的正下方造柱，冰会把门顶起。游过或攀柱越过后抵达远岸。',
    'Ⅲ 以水为阶：在高台前的水中造柱，空格攀上冰柱，再跳上高台。最多三根；F 瞄准旧柱可拆除。',
  ],
};

/** Builds a self-contained, procedural trial. Rewards are not exposed until all three mechanisms are solved. */
export function buildTrial(id: AbilityId, state: GameState): WorldView {
  const palette = PALETTES[id];
  const root = new THREE.Group();
  root.name = `trial:${id}`;
  const colliders: Collider[] = [];
  const targets: AbilityTarget[] = [];
  const interactables: Interactable[] = [];
  const waters: WorldView['waters'] = [];
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  geometries.add(boxGeometry);
  const mat = (color: number, emissive = 0, intensity = 0): THREE.MeshStandardMaterial => {
    const result = new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: intensity, roughness: 0.72, metalness: emissive ? 0.32 : 0.12, flatShading: true });
    materials.add(result);
    return result;
  };
  const stone = mat(palette.stone);
  const edge = mat(palette.edge);
  const glow = mat(palette.light, palette.light, 1.8);
  const metal = mat(id === 'magnet' ? 0xbb789e : 0x9da9ad, id === 'magnet' ? 0x9b345f : 0x2c494e, 0.35);
  const gold = mat(0xd7ad5a, 0xd2972e, 0.45);
  const cracked = mat(0x75666a);
  const warning = mat(0xc25042, 0xf05332, 0.8);
  const addBox = (name: string, p: Vec3, size: Vec3, material: THREE.Material, collision = false, climbable = false): THREE.Mesh => {
    const mesh = new THREE.Mesh(boxGeometry, material);
    mesh.name = name;
    mesh.position.set(...p);
    mesh.scale.set(...size);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    if (collision) {
      const half = new THREE.Vector3(...size).multiplyScalar(0.5);
      colliders.push({ id: `${id}:${name}`, box: new THREE.Box3(mesh.position.clone().sub(half), mesh.position.clone().add(half)), climbable, enabled: true, mesh });
    }
    return mesh;
  };
  const addShape = (geometry: THREE.BufferGeometry, material: THREE.Material, p: Vec3): THREE.Mesh => {
    geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...p);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };
  const ring = (p: Vec3, radius: number, material = glow, horizontal = true): THREE.Mesh => {
    const mesh = addShape(new THREE.TorusGeometry(radius, 0.055, 5, 32), material, p);
    if (horizontal) mesh.rotation.x = -Math.PI / 2;
    return mesh;
  };
  const label = (text: string, p: Vec3, width = 7, height = 0.8): void => {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 1536;
    canvas.height = 192;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#101822';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = `#${palette.light.toString(16).padStart(6, '0')}`;
    context.lineWidth = 5;
    context.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
    context.fillStyle = '#e9f7fa';
    context.font = '500 48px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 70);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: false, side: THREE.DoubleSide });
    materials.add(material);
    const mesh = addShape(new THREE.PlaneGeometry(width, height), material, p);
    mesh.castShadow = false;
  };
  const targetBox = (name: string, kind: AbilityTarget['kind'], p: Vec3, size: Vec3, material: THREE.Material, stage: number, metadata: Mechanism, climbable = false): AbilityTarget => {
    const mesh = addBox(name, p, size, material, true, climbable);
    const target: AbilityTarget = { id: `${id}:${name}`, kind, position: mesh.position.clone(), mesh, collider: colliders[colliders.length - 1], stage, origin: [...p], velocity: new THREE.Vector3(), charge: 0, frozen: 0 };
    targets.push(target);
    Object.assign(mechanism(target), metadata);
    return target;
  };
  const orb = (name: string, p: Vec3, radius: number, stage: number, role: Mechanism['role']): AbilityTarget => {
    const mesh = addShape(new THREE.IcosahedronGeometry(radius, 1), gold, p);
    mesh.name = name;
    const half = new THREE.Vector3(radius, radius, radius);
    const collider: Collider = { id: `${id}:${name}`, box: new THREE.Box3(mesh.position.clone().sub(half), mesh.position.clone().add(half)), climbable: false, enabled: true, mesh };
    colliders.push(collider);
    const target: AbilityTarget = { id: `${id}:${name}`, kind: 'orb', position: mesh.position.clone(), mesh, collider, stage, origin: [...p], velocity: new THREE.Vector3(), frozen: 0, charge: 0 };
    targets.push(target);
    Object.assign(mechanism(target), { role, weight: 2 });
    ring([p[0], 0.045, p[2]], radius + 0.4, gold);
    return target;
  };
  const gateList: TrialRuntime['gates'] = [];
  const gateZ = [-17, -32, -49];
  for (let stage = 0; stage < 3; stage++) {
    const z = gateZ[stage]!;
    const gate = addBox(`seal-${stage}`, [0, 3.8, z], [23.5, 7.6, 0.5], stone, true);
    const gateCollider = colliders[colliders.length - 1]!;
    // The luminous seams are parented to each gate so opening hides the whole seal.
    for (let x = -10; x <= 10; x += 2) {
      const seam = new THREE.Mesh(boxGeometry, glow);
      seam.scale.set(0.014, 0.78, 1.07);
      seam.position.set(x / 23.5, 0, 0);
      gate.add(seam);
    }
    gateList.push({ stage, mesh: gate, collider: gateCollider });
    addBox(`lintel-${stage}`, [0, 8, z], [24, 0.5, 1.2], edge);
  }

  // Recessed geometry AND terrain: the magnet pit has no invisible floor at bank height.
  const pools: [number, number][] = id === 'ice' ? [[-15, -5], [-28, -22], [-45, -38]] : [];
  for (let z = -68; z < 14; z++) {
    const wet = pools.some(([a, b]) => z >= a && z < b);
    const pit = id === 'magnet' && z >= -29 && z < -23;
    addBox(`floor-${z}`, [0, pit ? -3.3 : wet ? -1.85 : -0.3, z + 0.5], [24, 0.6, 1], z % 4 === 0 ? edge : stone, true);
  }
  if (id === 'magnet') {
    addBox('pit-near-bank', [0, -1.8, -22.7], [24, 2.4, 0.6], edge, true);
    addBox('pit-far-bank', [0, -1.8, -29.3], [24, 2.4, 0.6], edge, true);
    for (const z of [-22.94, -29.06]) addBox(`pit-rim-${z}`, [0, 0.025, z], [24, 0.04, 0.1], glow);
  }
  addBox('west-wall', [-12.45, 4.5, -27], [0.9, 9, 84], stone, true);
  addBox('east-wall', [12.45, 4.5, -27], [0.9, 9, 84], stone, true);
  addBox('entry-wall', [0, 4.5, 14.5], [25.8, 9, 1], stone, true);
  addBox('end-wall', [0, 5, -68.5], [25.8, 10, 1], stone, true);
  for (let z = 11; z > -68; z -= 6) {
    for (const side of [-1, 1]) {
      addBox(`pilaster-${side}-${z}`, [side * 11.6, 3.3, z], [0.6, 6.6, 1], edge);
      addBox(`light-${side}-${z}`, [side * 11.24, 3.5, z], [0.075, 3.8, 0.14], glow);
      if (id !== 'magnet' || z < -31.35 || z > -20.65) addBox(`runway-${side}-${z}`, [side * 9.8, 0.025, z], [0.065, 0.04, 4.7], glow);
      const cap = addShape(new THREE.OctahedronGeometry(0.3), glow, [side * 10.7, 5.5, z]);
      cap.rotation.z = Math.PI / 4;
    }
    addBox(`roof-rib-${z}`, [0, 8.6, z], [24.8, 0.22, 0.6], edge);
  }
  root.add(new THREE.HemisphereLight(0xb0d8ec, palette.stone, 1.9));
  for (const z of [5, -21, -44, -61]) {
    const light = new THREE.PointLight(palette.light, 45, 23, 1.7);
    light.position.set(0, 6, z);
    root.add(light);
    const halo = ring([0, 7.8, z], 2.4);
    halo.rotation.z = Math.PI / 6;
  }
  label(palette.title, [0, 5.7, -0.5], 10, 1.1);
  label(palette.subtitle, [0, 4.75, -0.48], 7, 0.65);
  const ability = ABILITIES.find(entry => entry.id === id)!;
  const pedestal = addBox('download-plinth', [0, 0.55, 4], [1.5, 1.1, 1.5], edge, true, true);
  const crystal = addShape(new THREE.OctahedronGeometry(0.55), glow, [0, 1.75, 4]);
  ring([0, 0.04, 4], 2);
  interactables.push({ id: `${id}:ability`, kind: 'ability', name: `取得「${ability.name}」 · ${ability.description}`, position: new THREE.Vector3(0, 0, 4), radius: 3.4, ability: id, mesh: pedestal, data: { trial: id } });
  const returnMesh = addBox('return-plinth', [5, 0.15, 9], [2, 0.3, 2], edge);
  ring([5, 0.34, 9], 0.8);
  label('E · 返回星坠原野', [5, 1.35, 9], 3, 0.45);
  interactables.push({ id: `${id}:return`, kind: 'return', name: '返回星坠原野（试炼进度保留）', position: new THREE.Vector3(5, 0, 9), radius: 2.8, ability: id, mesh: returnMesh });
  const rewardMesh = addBox('core-altar', [0, 0.55, -60], [2.6, 1.1, 2.6], edge, true, true);
  const rewardCrystal = addShape(new THREE.IcosahedronGeometry(0.65, 0), glow, [0, 2.2, -60]);
  ring([0, 0.04, -60], 3.8);
  ring([0, 4.3, -62], 3, glow, false);
  label('三道封印 · 一枚星核', [0, 4, -65], 7, 0.8);
  const reward: Interactable = { id: `${id}:reward`, kind: 'reward', name: `领取${ability.name}星核`, position: new THREE.Vector3(0, 0, -60), radius: 3.4, ability: id, mesh: rewardMesh, data: { requiredStage: 3, trial: id } };
  const runtime: TrialRuntime = { id, gates: gateList, reward, hints: HINTS[id], bridgeSlots: [new THREE.Vector3(0, -1.5, -24.5), new THREE.Vector3(0, -1.5, -27.5)], pipeEntry: new THREE.Vector3(-4, 0.6, -22), pipeEnd: new THREE.Vector3(-4, 0.6, -28), launcher: new THREE.Vector3(0, 0, -39), stoodOnBridge: false, bridgePlaced: false, gateLifted: false, exitPillar: false, doorPulled: false, clock: 0 };
  const panelSides = (z: number, opening = 6): void => {
    const width = (24 - opening) / 2;
    for (const side of [-1, 1]) addBox(`partition-${side}-${z}`, [side * (opening / 2 + width / 2), 3.8, z], [width, 7.6, 0.7], stone, true);
    addBox(`partition-top-${z}`, [0, 6.5, z], [opening, 2.2, 0.7], edge, true);
  };
  const crackLines = (target: AbilityTarget): void => {
    for (let n = 0; n < 6; n++) {
      const slit = new THREE.Mesh(boxGeometry, warning);
      slit.position.set((n % 2 ? 0.13 : -0.1) + n * 0.015, (n - 2.5) * 0.12, 0.52);
      slit.rotation.z = n % 2 ? 0.6 : -0.6;
      slit.scale.set(0.025, 0.16, 0.05);
      target.mesh.add(slit);
    }
  };
  for (let stage = 0; stage < 3; stage++) {
    const z = [0, -19, -34][stage]!;
    addBox(`placard-${stage}`, [-6.5, 1.2, z], [4.8, 1.1, 0.25], edge);
    label(`${['Ⅰ', 'Ⅱ', 'Ⅲ'][stage]} · ${HINTS[id][stage]!.split('：')[0]!.slice(2)}`, [-6.5, 1.25, z + 0.15], 4.6, 0.75);
    // No altar-style interaction can solve a puzzle: placards are visual and proximity hints.
  }

  if (id === 'magnet') {
    panelSides(-7);
    targetBox('lifting-panel', 'metal', [0, 1, -7], [6, 2, 0.75], metal, 0, { role: 'panel', weight: 2.2, anchored: true });
    for (let slot = 0; slot < 2; slot++) {
      targetBox(`bridge-cube-${slot}`, 'metal', [slot === 0 ? -4 : 4, 1.5, -20.5], [3, 3, 3], metal, 1, { role: 'bridgeCube', bridgeSlot: slot, weight: 1.8 }, true);
      const center = runtime.bridgeSlots[slot]!;
      ring([center.x, center.y, center.z], 1.35);
      ring([center.x, -2.94, center.z], 1.35);
    }
    label('两块沉底成桥 → 踏过方块抵达远岸', [0, 2.7, -30.4], 8, 0.7);
    panelSides(-42);
    targetBox('pull-door', 'metal', [0, 2, -42], [5.9, 4, 0.65], metal, 2, { role: 'pullDoor', weight: 3, anchored: true });
    targetBox('striker-cube', 'metal', [-5, 1, -38], [2, 2, 2], metal, 2, { role: 'striker', weight: 1.3 }, true);
    ring([4, 0.05, -44.5], 1.5, warning);
    label('拉出门板 → 挥动金属撞击守卫', [0, 5, -41.6], 5.8, 0.7);
  } else if (id === 'bomb') {
    panelSides(-9);
    crackLines(targetBox('fractured-wall', 'cracked', [0, 2.5, -9], [6, 5, 0.8], cracked, 0, { role: 'crack', anchored: true }));
    const receiver = targetBox('pipe-receiver', 'cracked', [-4, 0.6, -28], [1.1, 1.2, 0.6], warning, 1, { role: 'pipeReceiver', anchored: true });
    crackLines(receiver);
    for (const side of [-1, 1]) addBox(`pipe-rail-${side}`, [-4 + side * 1.05, 0.5, -25], [0.3, 1, 7], edge, true);
    // Open-topped pipe keeps the travelling bomb visible; the narrow receiver cannot be substituted by a cube.
    for (let z = -22; z >= -28; z -= 1.5) ring([-4, 0.6, z], 0.85, glow, false);
    addBox('pipe-arrow', [-4, 0.055, -20.5], [0.55, 0.06, 1.3], glow);
    label('球形入口 ↓  等球滚到末端再引爆', [-4, 2.5, -23.5], 5.3, 0.65);
    orb('launch-orb', [0, 1.1, -42], 1.1, 2, 'launchOrb');
    ring([0, 0.2, -39], 1.7);
    addBox('launcher-pad', [0, 0.08, -39], [3.5, 0.16, 3.5], edge, true);
    runtime.launcherArm = addBox('launcher-arm', [0, 0.23, -39], [0.6, 0.12, 2.2], metal);
    for (const x of [-1.45, 1.45]) addBox(`launcher-spring-${x}`, [x, 0.3, -39], [0.18, 0.6, 1], glow);
    runtime.launcherMarker = ring([0, 0.045, -41], 0.45, gold);
    for (let z = -39; z >= -45; z -= 1.5) addBox(`launch-path-${z}`, [0, 0.05, z], [0.16, 0.04, 0.7], glow);
    panelSides(-46);
    crackLines(targetBox('remote-wall', 'cracked', [0, 2.5, -46], [6, 5, 0.65], cracked, 2, { role: 'remoteWall', anchored: true }));
    label('放弹 · 半秒抛射 · 飞近石球时 F 遥爆', [0, 5, -45.5], 7.5, 0.7);
    label('金环：预计落点（碰撞前） · 失手可重试', [5, 1.6, -39], 5, 0.55);
  } else if (id === 'stasis') {
    const rotor = targetBox('turning-platform', 'rotor', [0, 0.25, -9], [6, 0.5, 5], gold, 0, { role: 'rotor', anchored: true }, true);
    ring([0, 0.53, -9], 2.2, gold);
    // Stationary collider footprint avoids rotating AABBs trapping the player.
    for (let n = 0; n < 4; n++) {
      const vane = new THREE.Mesh(boxGeometry, glow);
      vane.scale.set(0.025, 1.1, 0.6);
      vane.rotation.y = n * Math.PI / 2;
      rotor.mesh.add(vane);
    }
    panelSides(-9, 7.5);
    orb('rolling-stone', [0, 1.2, -24], 1.2, 1, 'roller');
    for (let x = -8; x < 9; x += 2) ring([x, 0.04, -24], 0.35, gold);
    orb('charged-orb', [0, 1.15, -42], 1.15, 2, 'chargeOrb');
    panelSides(-46);
    crackLines(targetBox('impulse-seal', 'cracked', [0, 2.5, -46], [6, 5, 0.6], cracked, 2, { role: 'remoteWall', anchored: true }));
    label('冻结 · 左键 × 2 · 释放', [0, 4.5, -45.6], 5.8, 0.75);
  } else {
    const waterMaterial = new THREE.MeshStandardMaterial({ color: palette.water, emissive: 0x175271, emissiveIntensity: 0.2, transparent: true, opacity: 0.73, roughness: 0.22, metalness: 0.4, side: THREE.DoubleSide });
    materials.add(waterMaterial);
    for (const [minZ, maxZ] of pools) {
      waters.push({ minX: -11.95, maxX: 11.95, minZ, maxZ, level: 0.08, depth: 1.63 });
      const surface = addShape(new THREE.PlaneGeometry(23.9, maxZ - minZ), waterMaterial, [0, 0.08, (minZ + maxZ) / 2]);
      surface.rotation.x = -Math.PI / 2;
      surface.receiveShadow = true;
      for (let x = -8; x <= 8; x += 4) ring([x, 0.092, (minZ + maxZ) / 2], 0.6);
    }
    panelSides(-25);
    const gate = targetBox('water-lift-gate', 'gate', [0, 1.5, -25], [5.9, 3, 0.55], metal, 1, { role: 'iceGate', anchored: true });
    const bars = new THREE.Group();
    for (let x = -2.5; x <= 2.5; x += 0.5) {
      const bar = new THREE.Mesh(boxGeometry, glow);
      bar.position.set(x / 5.9, 0, 0.54);
      bar.scale.set(0.017, 0.9, 0.08);
      bars.add(bar);
    }
    gate.mesh.add(bars);
    addBox('ascent-landing', [0, 1.6, -46.5], [8, 3.2, 3], edge, true, false);
    for (let n = 0; n < 4; n++) {
      const height = 2.4 - n * 0.6;
      addBox(`descent-${n}`, [0, height / 2, -48.6 - n * 0.9], [8, height, 0.9], edge, true, true);
    }
    label('冰柱 → 空格攀爬 → 跳上高台', [0, 4.7, -47.8], 7, 0.7);
  }

  // The magnet guardian is a real combatant behind the pull door, not a puzzle prop.
  const spawns: WorldView['spawns'] = [{ id: `trial:${id}:guardian`, type: 'guardian', position: id === 'magnet' ? [4, 0, -44.5] : [5, 0, -51], camp: `trial:${id}` }];
  const guardianSave = state.enemies['trial:magnet:guardian'];
  if (id === 'magnet' && state.trialStages.magnet < 3 && !state.completed.includes(id) && guardianSave && !guardianSave.dead && (guardianSave.position?.[2] ?? 0) < -48.5) {
    // Older saves put this live enemy beyond the still-locked final seal.
    guardianSave.position = [4, 0, -44.5];
  }
  let disposed = false;
  let lastStage = -1;
  const applyProgress = (current: GameState): void => {
    let progress = Math.max(0, Math.min(3, current.trialStages[id] || 0));
    for (let stage = 0; stage < 3; stage++) if (current.flags[`trial:${id}:${stage}`]) progress = Math.max(progress, stage + 1);
    if (current.completed.includes(id)) progress = 3;
    current.trialStages[id] = progress;
    for (let stage = 0; stage < progress; stage++) current.flags[`trial:${id}:${stage}`] = true;
    if (lastStage === progress) return;
    lastStage = progress;
    for (const gate of gateList) {
      gate.collider.enabled = progress <= gate.stage;
      gate.mesh.visible = gate.collider.enabled;
    }
    for (const target of targets) {
      const data = mechanism(target);
      if (target.stage !== undefined && target.stage < progress && data.role !== 'striker') {
        target.solved = true;
        if (target.collider) target.collider.enabled = false;
        if (data.role === 'bridgeCube') {
          target.position.copy(runtime.bridgeSlots[data.bridgeSlot ?? 0]!);
          target.mesh.position.copy(target.position);
          target.velocity?.set(0, 0, 0);
          target.mesh.visible = true;
          if (target.collider) {
            target.collider.enabled = true;
            target.collider.box.min.copy(target.position).addScalar(-1.5);
            target.collider.box.max.copy(target.position).addScalar(1.5);
          }
        } else if (data.role === 'iceGate') {
          target.position.y = 5.9;
          target.mesh.position.copy(target.position);
        } else target.mesh.visible = false;
      }
    }
    if (progress >= 3 && !current.completed.includes(id) && !interactables.includes(reward)) interactables.push(reward);
    if (progress < 3 || current.completed.includes(id)) {
      const index = interactables.indexOf(reward);
      if (index >= 0) interactables.splice(index, 1);
    }
  };
  const world: WorldView = {
    root, colliders, interactables, targets, waters, spawns,
    heightAt(x, z) {
      if (Math.abs(x) > 12 || z < -68 || z > 14) return 0;
      if (id === 'magnet' && z > -29 && z < -23) return -3;
      return pools.some(([min, max]) => z > min && z < max) ? -1.55 : 0;
    },
    update(dt, current) {
      if (disposed) return;
      runtime.clock += Math.max(0, Math.min(0.05, dt));
      crystal.rotation.y = runtime.clock * 0.65;
      crystal.position.y = 1.75 + Math.sin(runtime.clock * 1.8) * 0.13;
      crystal.visible = !current.abilities.includes(id);
      rewardCrystal.rotation.y = -runtime.clock * 0.4;
      rewardCrystal.position.y = 2.2 + Math.sin(runtime.clock * 1.4) * 0.15;
      rewardCrystal.visible = current.trialStages[id] >= 3 && !current.completed.includes(id);
      applyProgress(current);
      if (current.completed.includes(id)) {
        const index = interactables.indexOf(reward);
        if (index >= 0) interactables.splice(index, 1);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      disposeResources(geometries, materials, textures);
      trials.delete(world);
    },
  };
  trials.set(world, runtime);
  applyProgress(state);
  world.update(0, state);
  // Temporary bodies are not saved. Never reload inside a vanished pillar or a locked mechanism.
  if (state.region === id) {
    const p = state.player.position;
    const stage = state.trialStages[id];
    const checkpoint: Vec3 = [0, 0, [9, -18.7, -34.5, -55][stage] ?? 9];
    const invalid = p.some(value => !Number.isFinite(value)) || Math.abs(p[0]) > 11.4 || p[2] > 13 || p[2] < -67 || p[1] < -0.2 || p[1] > 1.6;
    const inPool = waters.some(water => p[2] > water.minZ && p[2] < water.maxZ);
    const inUnbridgedPit = id === 'magnet' && p[2] > -29 && p[2] < -23 && (stage < 2 || Math.abs(p[0]) > 1.45);
    const beyondSeal = stage < 3 && p[2] < gateZ[stage]! + 0.8;
    const feet = new THREE.Vector3(p[0], p[1] + 0.85, p[2]);
    const inside = colliders.some(collider => collider.enabled && collider.box.containsPoint(feet));
    if (invalid || inPool || inUnbridgedPit || beyondSeal || inside) state.player.position = [...checkpoint];
    state.safePosition = [...checkpoint];
  }
  return world;
}
