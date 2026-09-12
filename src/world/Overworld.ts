import * as THREE from 'three';
import { ABILITIES, CONFIG, LOCATIONS } from '../config/game';
import type { AbilityId, AbilityTarget, Collider, EnemySpawn, GameState, Interactable, Vec3, WaterArea, WaterfallArea, WorldView } from '../core/types';
import { FLAGS } from '../quests/progression';
import { WorldAtmosphere } from './atmosphere';
import { PlateauFoliage } from './foliage';
import { buildTerrain, CASCADE, LAKES, RIVER, outsideStructures, seededRandom, terrainHeight } from './terrain';

export { terrainHeight } from './terrain';

interface ChestVisual { id: string; lid: THREE.Group; rune: THREE.Mesh; interaction: Interactable; open: number; }
interface PickupVisual { id: string; mesh: THREE.Group; interaction: Interactable; y: number; phase: number; target?: AbilityTarget; }
interface ShrineVisual { ability: AbilityId; gem: THREE.Mesh; light: THREE.Mesh; }
interface WaterVisual { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; base: Float32Array; falling?: boolean; }
interface FireVisual { interactions: Interactable[]; sheltered: boolean; lit?: boolean; }

const NAMES: Record<string, string> = {
  branch: '枯木树枝', axe: '旅人木斧', torch: '松脂火把', sword: '旧式短剑', spear: '铁叶长矛', club: '硬木重棒',
  bow: '林地猎弓', shield: '木纹圆盾', arrows: '箭矢', shirt: '旧日上衣', trousers: '旅行长裤', warmcoat: '霜绒外衣',
  apple: '星叶苹果', pepper: '暖心椒', mushroom: '露伞菇', meat: '鲜肉', wood: '木材', monster: '影兽碎角',
  herb: '晨露草', insect: '风铃虫', roastApple: '烤苹果',
};

/** Original low-poly plateau. All public coordinates are world-space; actor positions are feet. */
export class Overworld implements WorldView {
  readonly root = new THREE.Group();
  readonly colliders: Collider[] = [];
  readonly interactables: Interactable[] = [];
  readonly targets: AbilityTarget[] = [];
  readonly waters: WaterArea[] = [];
  readonly waterfalls: WaterfallArea[] = [];
  readonly spawns: EnemySpawn[] = [];
  private readonly atmosphere = new WorldAtmosphere();
  private readonly foliage: PlateauFoliage;
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly chests: ChestVisual[] = [];
  private readonly pickups: PickupVisual[] = [];
  private readonly shrineVisuals: ShrineVisual[] = [];
  private readonly waterVisuals: WaterVisual[] = [];
  private readonly fireVisuals: FireVisual[] = [];
  private readonly cascadeFoam: THREE.Mesh[] = [];
  private readonly waterTime = { value: 0 };
  private readonly towerColliders: Collider[] = [];
  private readonly towerStructure = new THREE.Group();
  private readonly towerCore = new THREE.Group();
  private readonly towerBeacon: THREE.Mesh;
  private readonly terminalGem: THREE.Mesh;
  private readonly chamberDoor: THREE.Group;
  private readonly doorCollider: Collider;
  private readonly elder: THREE.Group;
  private readonly gliderElder: THREE.Group;
  private readonly gliderInteraction: Interactable;
  private elapsed = 0;
  private waterClock = 0;
  private doorOpen = 0;
  private towerRise = 0;
  private wasTower = false;
  private disposed = false;
  private bloodMoonCount?: number;

  constructor(state: GameState) {
    this.root.name = '星坠原野 · Asterfall';
    this.root.add(buildTerrain(), this.atmosphere.root);
    this.preparePalette();
    this.buildVista();
    this.buildWater();
    const cave = this.buildChamber();
    this.terminalGem = cave.terminal;
    this.chamberDoor = cave.door;
    this.doorCollider = cave.collider;
    this.elder = this.buildElderCamp();
    this.towerBeacon = this.buildTower();
    for (const ability of ABILITIES) this.buildShrine(ability.id, ability.color);
    const temple = this.buildTemple();
    this.gliderElder = temple.elder;
    this.gliderInteraction = temple.interaction;
    this.buildCamps();
    this.buildCabin();
    this.buildExploration();
    this.foliage = new PlateauFoliage(this.colliders, this.interactables, this.targets);
    this.root.add(this.foliage.root);
    this.wasTower = state.tower;
    this.towerRise = state.tower ? 1 : 0;
    this.doorOpen = state.flags.chamberDoor || state.flags.doorOpen ? 1 : 0;
    this.root.updateMatrixWorld(true);
    this.batchArchitecture();
    this.update(0, state);
  }

  heightAt(x: number, z: number): number { return terrainHeight(x, z); }

  private preparePalette(): void {
    const colors: Record<string, string> = {
      stone: '#a6ae9d', darkstone: '#505f62', pale: '#c6c7b1', trim: '#6d817b',
      cave: '#677e83', caveDark: '#40565e', wood: '#786044', woodDark: '#4d493b',
      copper: '#c69e65', metal: '#718994', cloth: '#ac7453', snow: '#dce7e9',
      green: '#63784c', skin: '#b89876', beard: '#e1ddc8', charcoal: '#323d41',
    };
    for (const [key, color] of Object.entries(colors)) this.materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: key === 'metal' ? 0.42 : 0.94, metalness: key === 'metal' ? 0.55 : 0, flatShading: true }));
    this.materials.set('glow', new THREE.MeshStandardMaterial({ color: '#a7f5e3', emissive: '#44cdb5', emissiveIntensity: 1.5, roughness: 0.45 }));
    this.materials.set('amber', new THREE.MeshStandardMaterial({ color: '#ffe1a0', emissive: '#e4a548', emissiveIntensity: 1.2, roughness: 0.5 }));
    this.materials.set('fire', new THREE.MeshStandardMaterial({ color: '#ffd28a', emissive: '#ff842b', emissiveIntensity: 2.3, transparent: true, opacity: 0.92, flatShading: true, depthWrite: false }));
  }

  private material(key: string): THREE.MeshStandardMaterial { return this.materials.get(key)!; }
  private geometry(key: string): THREE.BufferGeometry {
    let geometry = this.geometries.get(key);
    if (geometry) return geometry;
    if (key === 'box') geometry = new THREE.BoxGeometry(1, 1, 1);
    else if (key === 'cylinder') geometry = new THREE.CylinderGeometry(1, 1, 1, 8);
    else if (key === 'cone') geometry = new THREE.ConeGeometry(1, 1, 6);
    else if (key === 'rock') geometry = new THREE.DodecahedronGeometry(1, 0);
    else if (key === 'gem') geometry = new THREE.OctahedronGeometry(1, 0);
    else if (key === 'sphere') geometry = new THREE.IcosahedronGeometry(1, 1);
    else if (key === 'ring') geometry = new THREE.TorusGeometry(1, 0.055, 4, 32);
    else throw new Error(`Unknown world primitive ${key}`);
    this.geometries.set(key, geometry);
    return geometry;
  }
  private mesh(shape: string, material: string, position: Vec3, scale: Vec3, parent: THREE.Object3D = this.root): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geometry(shape), this.material(material));
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.castShadow = material !== 'glow' && material !== 'fire';
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  private box(position: Vec3, size: Vec3, material: string, parent: THREE.Object3D = this.root): THREE.Mesh {
    return this.mesh('box', material, position, size, parent);
  }
  private solid(id: string, position: Vec3, size: Vec3, material = 'stone', climbable = true, parent: THREE.Object3D = this.root): THREE.Mesh {
    const mesh = this.box(position, size, material, parent);
    mesh.name = id;
    const center = new THREE.Vector3(...position), half = new THREE.Vector3(...size).multiplyScalar(0.5);
    this.colliders.push({ id, mesh, climbable, enabled: true, box: new THREE.Box3(center.clone().sub(half), center.clone().add(half)) });
    return mesh;
  }
  private interact(id: string, kind: Interactable['kind'], name: string, position: Vec3, mesh?: THREE.Object3D, data?: Interactable['data']): Interactable {
    const entry: Interactable = { id, kind, name, position: new THREE.Vector3(...position), radius: CONFIG.interactDistance, mesh, data };
    this.interactables.push(entry);
    return entry;
  }
  private ring(x: number, y: number, z: number, radius: number, material: string, parent: THREE.Object3D = this.root): THREE.Mesh {
    const mesh = this.mesh('ring', material, [x, y, z], [radius, radius, radius], parent);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }
  private beam(a: Vec3, b: Vec3, radius: number, material: string, parent: THREE.Object3D = this.root): THREE.Mesh {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const delta = end.clone().sub(start);
    const mesh = this.mesh('cylinder', material, start.add(end).multiplyScalar(0.5).toArray() as Vec3, [radius, delta.length(), radius], parent);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    return mesh;
  }

  private buildChamber(): { terminal: THREE.Mesh; door: THREE.Group; collider: Collider } {
    const y = this.heightAt(0, 105);
    // Generous 18 m room, then a straight 8 m corridor. Every opaque wall has a camera collider.
    this.solid('chamber-west', [-10, y + 3.5, 107], [2, 7, 22], 'cave');
    this.solid('chamber-east', [10, y + 3.5, 107], [2, 7, 22], 'cave');
    this.solid('chamber-back', [0, y + 3.5, 117], [20, 7, 2], 'cave');
    this.solid('chamber-ceiling', [0, y + 6.7, 107], [22, 1.4, 24], 'caveDark', false);
    this.solid('chamber-shoulder-west', [-7, y + 2.8, 96], [6, 5.6, 2], 'cave');
    this.solid('chamber-shoulder-east', [7, y + 2.8, 96], [6, 5.6, 2], 'cave');
    this.solid('exit-passage-west', [-5, y + 2.8, 92.5], [2, 5.6, 5], 'cave');
    this.solid('exit-passage-east', [5, y + 2.8, 92.5], [2, 5.6, 5], 'cave');
    this.solid('exit-passage-roof', [0, y + 5.5, 93], [12, 1, 6], 'cave', false);
    this.solid('chamber-climb-ledge', [0, y + 0.7, 91], [8, 1.4, 1.2], 'stone', true);
    // Thin inlaid paths sit flush with the terrain rather than creating a raised spawn collider.
    this.box([0, y + 0.012, 107], [6, 0.02, 13], 'darkstone');
    for (const x of [-2.8, 2.8]) this.box([x, y + 0.026, 105], [0.055, 0.025, 14], 'glow');
    for (let i = 0; i < 7; i++) {
      this.box([-8.94, y + 0.7 + i * 0.68, 109], [0.05, 0.055, 5 - i * 0.42], 'glow');
      this.box([8.94, y + 0.7 + i * 0.68, 109], [0.05, 0.055, 5 - i * 0.42], 'glow');
    }
    for (const x of [-6.5, 6.5]) {
      const waterMaterial = new THREE.MeshStandardMaterial({ color: '#418994', transparent: true, opacity: 0.65, roughness: 0.16, metalness: 0.3 });
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 5), waterMaterial);
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(x, y + 0.035, 113);
      this.root.add(pool);
    }
    this.solid('terminal-plinth', [0, y + 0.56, 102.5], [1.4, 1.12, 1.2], 'darkstone');
    this.ring(0, y + 1.18, 102.5, 0.58, 'glow');
    const terminal = this.mesh('gem', 'glow', [0, y + 1.7, 102.5], [0.28, 0.52, 0.19]);
    this.interact('terminal', 'terminal', '取得星盘终端', [0, y + 0.4, 103], terminal);
    this.addChest('chamber-shirt', -5.7, 106.5, 'shirt');
    this.addChest('chamber-trousers', 5.7, 106.5, 'trousers');
    const door = new THREE.Group();
    door.position.set(0, y, 96);
    this.root.add(door);
    const doorSlab = this.box([0, 2.6, 0], [8, 5.2, 1.1], 'caveDark', door);
    for (const side of [-1, 1]) {
      this.box([side * 2, 2.6, -0.58], [0.08, 4.6, 0.04], 'glow', door);
      this.box([side * 2, 2.6, 0.58], [0.08, 4.6, 0.04], 'glow', door);
    }
    const seal = this.mesh('ring', 'glow', [0, 2.6, 0.58], [1.15, 1.15, 1.15], door);
    seal.rotation.z = Math.PI / 4;
    const collider: Collider = { id: 'chamber-door', enabled: true, climbable: false, mesh: doorSlab,
      box: new THREE.Box3(new THREE.Vector3(-4, y, 95.45), new THREE.Vector3(4, y + 5.2, 96.55)) };
    this.colliders.push(collider);
    this.interact('chamber-door', 'door', '开启密室石门', [0, y + 0.8, 96], door);
    this.interact('chamber-exit', 'exit', '走向第一缕光', [0, this.heightAt(0, 82), 82], undefined, { automatic: true });
    const lamp = new THREE.PointLight('#8ddcde', 10, 26, 1.4);
    lamp.position.set(0, y + 4.5, 108);
    this.root.add(lamp);
    const random = seededRandom(441);
    for (let i = 0; i < 18; i++) {
      const x = (random() - 0.5) * 24;
      const z = 96 + random() * 22;
      const rock = this.mesh('rock', 'stone', [x, y + 7.2, z], [3 + random() * 2.5, 1.4 + random() * 2, 3.3]);
      rock.rotation.y = random() * 6.28;
    }
    // Two flanking stones frame the first reveal without walling off the view north.
    for (const x of [-7.5, 7.5]) this.mesh('rock', 'stone', [x, this.heightAt(x, 85) + 1.6, 85], [2.4, 2.8, 2]);
    return { terminal, door, collider };
  }

  private createElder(x: number, y: number, z: number, ghost = false): THREE.Group {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.name = ghost ? 'The last star-keeper' : 'Wandering star-keeper';
    this.root.add(group);
    this.mesh('cone', ghost ? 'trim' : 'woodDark', [0, 0.72, 0], [0.56, 1.5, 0.48], group);
    this.mesh('sphere', 'skin', [0, 1.62, 0], [0.29, 0.34, 0.28], group);
    this.mesh('cone', 'beard', [0, 1.33, 0.22], [0.23, 0.63, 0.14], group).rotation.z = Math.PI;
    this.mesh('sphere', 'beard', [0, 1.79, -0.04], [0.32, 0.25, 0.26], group);
    this.box([-0.115, 1.66, 0.258], [0.04, 0.035, 0.025], 'charcoal', group);
    this.box([0.115, 1.66, 0.258], [0.04, 0.035, 0.025], 'charcoal', group);
    this.beam([0.55, 0, 0.18], [0.64, 2.3, 0.18], 0.045, 'wood', group);
    this.mesh('gem', ghost ? 'glow' : 'copper', [0.64, 2.34, 0.18], [0.11, 0.21, 0.11], group);
    this.box([-0.2, 0.1, 0.13], [0.22, 0.2, 0.4], 'woodDark', group);
    this.box([0.2, 0.1, 0.13], [0.22, 0.2, 0.4], 'woodDark', group);
    return group;
  }

  private fire(id: string, x: number, z: number, pot: boolean, sheltered = false): void {
    const y = this.heightAt(x, z);
    const root = new THREE.Group();
    root.position.set(x, y, z);
    this.root.add(root);
    for (let i = 0; i < 9; i++) {
      const angle = i * Math.PI * 2 / 9;
      this.mesh('rock', 'darkstone', [Math.cos(angle) * 0.92, 0.15, Math.sin(angle) * 0.92], [0.28, 0.22, 0.27], root);
    }
    for (let i = 0; i < 3; i++) this.beam([-0.62, 0.19, (i - 1) * 0.22], [0.62, 0.26, (1 - i) * 0.22], 0.13, 'woodDark', root);
    const flame = new THREE.Group();
    root.add(flame);
    this.mesh('cone', 'fire', [-0.2, 0.71, 0], [0.4, 1.15, 0.36], flame);
    this.mesh('cone', 'amber', [0.18, 0.58, 0.15], [0.25, 0.85, 0.24], flame);
    const interaction = this.interact(id, 'campfire', '营火 · 休息与取暖', [x, y, z - (pot ? 1.1 : 0)], root, { lit: true, sheltered, fireId: id });
    const hearth: FireVisual = { interactions: [interaction], sheltered };
    this.fireVisuals.push(hearth);
    this.atmosphere.addFire(new THREE.Vector3(x, y, z), flame, interaction);
    if (pot) {
      for (const side of [-1, 1]) this.beam([side * 0.9, 0.1, 0], [side * 0.7, 1.4, 0], 0.06, 'metal', root);
      this.beam([-0.8, 1.3, 0], [0.8, 1.3, 0], 0.055, 'metal', root);
      this.mesh('sphere', 'charcoal', [0, 0.94, 0], [0.62, 0.35, 0.62], root);
      this.ring(0, 1.12, 0, 0.56, 'metal', root);
      hearth.interactions.push(this.interact(`${id}-pot`, 'pot', '星旅炊锅 · 烹饪', [x, y + 0.5, z + 0.75], root, { lit: true, sheltered, fireId: id }));
    }
  }

  private buildElderCamp(): THREE.Group {
    const [x, , z] = LOCATIONS.elder.position;
    const y = this.heightAt(x, z);
    this.fire('elder-fire', x, z, true, true);
    const elder = this.createElder(x + 2.4, y, z - 0.3);
    elder.rotation.y = -Math.PI / 2;
    this.interact('elder', 'elder', '白发旅人', [x + 2.4, y, z - 0.3], elder);
    this.beam([x - 2, y + 0.26, z + 2.5], [x + 1.5, y + 0.26, z + 2.5], 0.3, 'wood');
    this.addPickup('elder-roast-apple', 'roastApple', x - 1.35, z + 0.4);
    this.addPickup('elder-axe', 'axe', x + 4, z + 3);
    this.addPickup('elder-branch', 'branch', x - 5, z + 4);
    this.addPickup('elder-torch', 'torch', x + 3, z + 4);
    for (let i = 0; i < 4; i++) this.addPickup(`elder-pepper-${i}`, 'pepper', x - 5 + i * 1.25, z - 4.5);
    this.addPickup('elder-mushroom', 'mushroom', x + 5, z - 4);
    this.addPickup('elder-meat', 'meat', x + 4.4, z + 0.9);
    return elder;
  }

  private buildTower(): THREE.Mesh {
    const y = this.heightAt(0, 0);
    this.root.add(this.towerStructure, this.towerCore);
    this.towerStructure.name = 'Tower decks and safe switchback stair';
    this.towerCore.name = 'Rising observatory core';
    this.ring(0, y + 0.09, 0, 11.8, 'trim');
    this.ring(0, y + 0.11, 0, 4.4, 'copper');
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI * 2 / 12;
      if (i === 3 || i === 9) continue;
      this.mesh('rock', 'pale', [Math.cos(a) * 12, y + 0.45, Math.sin(a) * 12], [0.95, 0.85 + i % 3 * 0.35, 0.8]);
    }
    this.solid('tower-console', [0, y + 0.65, 10.8], [1.3, 1.3, 1.1], 'darkstone');
    this.mesh('gem', 'glow', [0, y + 1.55, 10.8], [0.22, 0.33, 0.22]);
    this.interact('tower', 'tower', '唤醒观星之塔', [0, y + 0.5, 10.8]);
    const start = this.colliders.length;
    this.solid('tower-core', [0, y + 9.3, 0], [4.8, 18.6, 4.8], 'darkstone', true, this.towerCore);
    for (const x of [-2.5, 2.5]) for (const z of [-2.5, 2.5]) {
      this.box([x, y + 10, z], [0.38, 20, 0.38], 'copper', this.towerCore);
      this.box([x * 1.03, y + 10, z * 1.03], [0.11, 19, 0.11], 'glow', this.towerCore);
    }
    for (let level = 0; level < 5; level++) this.box([0, y + level * 4 + 1, 0], [6.1, 0.4, 6.1], 'trim', this.towerCore);
    // Exactly 0.4 m steps, below CONFIG.stepHeight; each flight is 3 m wide.
    for (let i = 0; i < 25; i++) {
      this.solid(`tower-stair-east-${i}`, [7.6, y + (i + 1) * 0.4 - 0.2, 8.4 - i * 0.7], [3, 0.4, 0.75], 'pale', true, this.towerStructure);
      this.solid(`tower-stair-west-${i}`, [-7.6, y + 10 + (i + 1) * 0.4 - 0.2, -8.4 + i * 0.7], [3, 0.4, 0.75], 'pale', true, this.towerStructure);
    }
    this.solid('tower-mid-landing', [0, y + 9.8, -9.1], [18.7, 0.4, 2.1], 'trim', true, this.towerStructure);
    this.solid('tower-top-landing', [0, y + 19.8, 9.4], [18.7, 0.4, 2], 'trim', true, this.towerStructure);
    this.solid('tower-top-bridge', [0, y + 19.8, 7.5], [11.6, 0.4, 3], 'trim', true, this.towerStructure);
    this.solid('tower-top-deck', [0, y + 19.7, 0], [13, 0.6, 13], 'stone', true, this.towerStructure);
    // Safe exterior edges; the south deck remains open onto the staircase landing.
    this.solid('tower-top-rail-north', [0, y + 20.65, -6.35], [12.8, 1.3, 0.25], 'trim', true, this.towerStructure);
    for (const x of [-6.35, 6.35]) this.solid(`tower-top-rail-${x}`, [x, y + 20.65, 0], [0.25, 1.3, 12.8], 'trim', true, this.towerStructure);
    for (const side of [-1, 1]) {
      this.beam([side * 9.1, y + (side === 1 ? 1.1 : 21.1), 8.4], [side * 9.1, y + (side === 1 ? 10.7 : 11.1), -8.4], 0.055, 'copper', this.towerStructure);
      for (let i = 0; i < 6; i++) {
        const z = -8.4 + i * 3.36;
        const top = side === 1 ? y + 10 - i * 1.92 : y + 10.4 + i * 1.92;
        this.beam([side * 9.1, top, z], [side * 9.1, top + 1, z], 0.045, 'copper', this.towerStructure);
      }
    }
    this.towerColliders.push(...this.colliders.slice(start));
    this.ring(0, y + 20.035, 0, 4.9, 'glow', this.towerStructure);
    this.ring(0, y + 20.04, 0, 3.5, 'copper', this.towerStructure);
    const beaconMaterial = new THREE.MeshStandardMaterial({ color: '#8ee8d4', emissive: '#4bc6b9', emissiveIntensity: 1.3, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide });
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 1.1, 38, 12, 1, true), beaconMaterial);
    beacon.position.set(0, y + 40, 0);
    this.towerStructure.add(beacon);
    return beacon;
  }

  private buildShrine(ability: AbilityId, color: string): void {
    const [x, , z] = LOCATIONS[ability].position;
    const y = this.heightAt(x, z);
    const entry = new THREE.Group();
    entry.position.set(x, y, z);
    entry.name = LOCATIONS[ability].name;
    this.root.add(entry);
    this.box([0, 0.025, 0], [10, 0.05, 10], 'trim', entry);
    this.solid(`${ability}-shrine-west`, [x - 3.6, y + 2.8, z - 1], [1.5, 5.6, 4.5], 'darkstone');
    this.solid(`${ability}-shrine-east`, [x + 3.6, y + 2.8, z - 1], [1.5, 5.6, 4.5], 'darkstone');
    this.solid(`${ability}-shrine-back`, [x, y + 2.5, z - 3], [8.6, 5, 1.2], 'stone');
    this.solid(`${ability}-shrine-cap`, [x, y + 5.8, z - 0.7], [9, 1.2, 5.8], 'stone', false);
    for (const side of [-1, 1]) {
      this.box([side * 2.78, 2.6, 1.3], [0.1, 4.6, 0.08], 'glow', entry);
      this.mesh('gem', 'copper', [side * 3.6, 6.75, -0.7], [0.55, 1.1, 0.55], entry);
    }
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1, flatShading: true, roughness: 0.3 });
    const gem = new THREE.Mesh(this.geometry('gem'), mat);
    gem.position.set(0, 6.95, -0.7);
    gem.scale.set(0.8, 1.35, 0.8);
    entry.add(gem);
    const light = new THREE.Mesh(new THREE.PlaneGeometry(4.7, 4.6), new THREE.MeshStandardMaterial({ color: '#95d8d1', emissive: '#34776f', emissiveIntensity: 0.8, transparent: true, opacity: 0.23, depthWrite: false, side: THREE.DoubleSide }));
    light.position.set(0, 2.5, -1.4);
    entry.add(light);
    this.ring(0, 0.09, 1.7, 2.1, 'glow', entry);
    const interaction = this.interact(`shrine-${ability}`, 'shrine', `进入${LOCATIONS[ability].name}`, [x, y, z + 2.3], entry);
    interaction.ability = ability;
    this.shrineVisuals.push({ ability, gem, light });
    for (let i = 0; i < 4; i++) {
      const px = x + (i % 2 === 0 ? -5.9 : 5.9), pz = z + 4.5 - Math.floor(i / 2) * 8;
      const py = this.heightAt(px, pz);
      this.mesh('rock', 'pale', [px, py + 0.6, pz], [0.8, 1.3 + i * 0.15, 0.75]);
    }
  }

  private buildTemple(): { elder: THREE.Group; interaction: Interactable } {
    const [x, , z] = LOCATIONS.temple.position;
    const y = this.heightAt(x, z);
    this.box([x, y + 0.025, z], [25, 0.05, 27], 'pale');
    this.solid('temple-pedestal', [x, y + 3.5, z], [7, 7, 7], 'stone');
    this.solid('temple-pedestal-cap', [x, y + 6.8, z], [8, 0.4, 8], 'pale');
    // Pedestal collision top is precisely base + 7, including the visible cap.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 14; i++) this.solid(`temple-stair-${side}-${i}`, [x + side * 5.3, y + (i + 1) * 0.5 - 0.25, z + 7 - i * 0.65], [2.6, 0.5, 0.7], 'pale');
      this.solid(`temple-stair-landing-${side}`, [x + side * 4.2, y + 6.8, z - 2.1], [3.8, 0.4, 2.2], 'pale');
      for (let i = 0; i < 4; i++) {
        const pz = z - 10 + i * 6.5;
        const height = i === 1 && side === -1 ? 4.2 : 9.8;
        this.solid(`temple-column-${side}-${i}`, [x + side * 10.3, y + height / 2, pz], [1.4, height, 1.5], 'stone');
        this.box([x + side * 10.3, y + 0.3, pz], [2.1, 0.6, 2.1], 'trim');
        this.box([x + side * 10.3, y + height, pz], [2.2, 0.45, 2.2], 'pale');
      }
      this.solid(`temple-side-lintel-${side}`, [x + side * 10.3, y + 10.3, z + 3], [1.8, 0.8, 15], 'pale', false);
    }
    this.solid('temple-back-wall-left', [x - 7, y + 3.6, z - 11], [7, 7.2, 1.3], 'stone');
    this.solid('temple-back-wall-right', [x + 7, y + 2.7, z - 11], [7, 5.4, 1.3], 'stone');
    this.solid('temple-front-crown', [x, y + 10.4, z + 9.5], [22, 1.1, 1.8], 'pale', false);
    // An original open celestial instrument, not a borrowed statue or emblem.
    const sculpture = this.mesh('ring', 'copper', [x, y + 11.6, z - 10.9], [3, 3, 3]);
    sculpture.rotation.z = Math.PI / 6;
    this.mesh('gem', 'glow', [x, y + 11.6, z - 10.9], [0.62, 1.2, 0.62]);
    this.solid('temple-altar-plinth', [x, y + 0.55, z + 7.6], [2.4, 1.1, 1.6], 'trim');
    this.ring(x, y + 1.16, z + 7.6, 0.78, 'glow');
    this.interact('temple-altar', 'altar', '星核祭坛 · 交还星光', [x, y + 0.4, z + 8.2]);
    this.ring(x, y + 7.025, z, 2.5, 'copper');
    const elder = this.createElder(x, y + 7, z, true);
    const interaction = this.interact('glider', 'glider', '高台上的守望者', [x, y + 7, z], elder);
    return { elder, interaction };
  }

  private buildCamps(): void {
    const types: EnemySpawn['type'][] = ['melee', 'shield', 'archer'];
    for (let n = 1; n <= 3; n++) {
      const camp = `camp${n}`;
      const [x, , z] = LOCATIONS[camp].position;
      const y = this.heightAt(x, z);
      this.fire(`${camp}-fire`, x, z, false);
      for (let i = 0; i < 3; i++) {
        const sx = x + [-3.8, 3.8, 0][i], sz = z + [1.5, 1.5, -4.5][i];
        this.spawns.push({ id: `${camp}-${i + 1}`, type: types[i], camp, position: [sx, this.heightAt(sx, sz), sz] });
      }
      if (n === 1) {
        this.beam([x - 7, y, z - 6], [x - 7, y + 3.7, z - 6], 0.13, 'wood');
        this.beam([x - 3, y, z - 6], [x - 3, y + 3.7, z - 6], 0.13, 'wood');
        const tent = this.mesh('cone', 'cloth', [x - 5, y + 1.5, z - 6], [3.1, 3, 2.2]);
        tent.rotation.y = Math.PI / 4;
      } else if (n === 2) {
        for (const dx of [-1.8, 1.8]) for (const dz of [-1.8, 1.8]) this.solid(`camp2-watch-post-${dx}-${dz}`, [x + 6 + dx, y + 2.4, z - 5 + dz], [0.3, 4.8, 0.3], 'wood');
        this.solid('camp2-watch-deck', [x + 6, y + 4.7, z - 5], [4.3, 0.35, 4.3], 'wood');
        for (let i = 0; i < 10; i++) this.solid(`camp2-watch-stair-${i}`, [x + 6, y + (i + 1) * 0.48 - 0.16, z + 3.5 - i * 0.65], [1.8, 0.32, 0.7], 'wood');
      } else {
        this.solid('camp3-ruin-wall', [x, y + 2.4, z - 7.7], [16, 4.8, 1.1], 'stone');
        this.solid('camp3-ruin-side', [x + 7.6, y + 1.8, z - 3], [1.2, 3.6, 8], 'stone');
        this.mesh('rock', 'pale', [x - 6.4, y + 1.1, z - 6], [2.5, 1.7, 1.7]);
      }
      for (let i = 0; i < 5; i++) {
        const px = x - 5 + i * 2.5;
        this.solid(`${camp}-palisade-${i}`, [px, y + 0.65, z + 7.8], [0.45, 1.3, 0.45], 'wood');
      }
      this.addChest(`${camp}-chest`, x + 5, z + 4.5, n === 1 ? 'sword' : n === 2 ? 'bow' : 'shield', { lockedCamp: camp });
      this.addTarget(`${camp}-barrel`, 'barrel', x - 2.5, z - 2.5, 1.25);
      this.addTarget(`${camp}-metal`, 'metal', x + 5.7, z - 1.6, 1.6);
      this.addTarget(`${camp}-orb`, 'orb', x - 5.7, z + 2.8, 1.2);
      this.addPickup(`${camp}-arrows`, 'arrows', x - 5.5, z + 5, 6);
      this.addPickup(`${camp}-meat`, 'meat', x + 1.5, z + 4.5);
    }
  }

  private buildCabin(): void {
    const [x, , z] = LOCATIONS.cabin.position;
    const y = this.heightAt(x, z);
    this.solid('cabin-back', [x, y + 1.8, z - 3.8], [8, 3.6, 0.5], 'wood');
    this.solid('cabin-west', [x - 3.8, y + 1.8, z], [0.5, 3.6, 8], 'wood');
    this.solid('cabin-east', [x + 3.8, y + 1.8, z], [0.5, 3.6, 8], 'wood');
    this.solid('cabin-roof', [x, y + 3.85, z], [8.8, 0.45, 8.8], 'woodDark', false);
    this.box([x, y + 4.12, z], [8.9, 0.14, 8.9], 'snow');
    this.box([x - 2.7, y + 0.55, z - 2.3], [1.6, 1.1, 1.4], 'woodDark');
    this.fire('cabin-fire', x + 1.5, z - 0.6, true, true);
    this.addChest('cabin-warmcoat', x - 2, z + 0.8, 'warmcoat');
    for (let i = 0; i < 4; i++) this.addPickup(`cabin-pepper-${i}`, 'pepper', x - 3 + i * 1.7, z + 5.7);
    this.addPickup('cabin-wood', 'wood', x - 5.4, z + 2, 3);
  }

  private addTarget(id: string, kind: AbilityTarget['kind'], x: number, z: number, size: number): AbilityTarget {
    const y = this.heightAt(x, z) + size / 2;
    const root = new THREE.Group();
    root.position.set(x, y, z);
    root.name = id;
    this.root.add(root);
    const material = kind === 'metal' ? 'metal' : kind === 'orb' ? 'copper' : kind === 'barrel' ? 'wood' : 'stone';
    const shape = kind === 'orb' ? 'sphere' : kind === 'cracked' ? 'rock' : kind === 'barrel' ? 'cylinder' : 'box';
    const scale: Vec3 = kind === 'metal' ? [size, size, size]
      : kind === 'barrel' ? [size * 0.5, size, size * 0.5] : [size * 0.5, size * 0.5, size * 0.5];
    this.mesh(shape, material, [0, 0, 0], scale, root);
    if (kind === 'metal') {
      for (const side of [-1, 1]) {
        this.box([0, 0, side * (size / 2 + 0.015)], [size * 0.77, 0.09, 0.03], 'copper', root).rotation.z = Math.PI / 4;
        this.box([0, 0, side * (size / 2 + 0.015)], [size * 0.77, 0.09, 0.03], 'copper', root).rotation.z = -Math.PI / 4;
      }
    } else if (kind === 'barrel') {
      for (const dy of [-0.35, 0.35]) this.mesh('cylinder', 'metal', [0, size * dy, 0], [size * 0.52, 0.09, size * 0.52], root);
      this.mesh('gem', 'amber', [0, size * 0.54, 0], [0.08, 0.16, 0.08], root);
    } else if (kind === 'cracked') {
      for (let i = 0; i < 3; i++) this.box([(i - 1) * size * 0.15, (i - 1) * size * 0.22, size * 0.45], [0.08, size * 0.4, 0.035], 'charcoal', root).rotation.z = (i % 2 ? -1 : 1) * 0.4;
    } else this.ring(0, 0, 0, size * 0.52, 'amber', root);
    const half = kind === 'metal' ? size / 2 : size * 0.47;
    const collider: Collider = { id, mesh: root, climbable: kind !== 'barrel', enabled: true,
      box: new THREE.Box3(new THREE.Vector3(x - half, y - size / 2, z - half), new THREE.Vector3(x + half, y + size / 2, z + half)) };
    this.colliders.push(collider);
    const target: AbilityTarget = { id, kind, position: root.position.clone(), mesh: root, collider, origin: [x, y, z], velocity: new THREE.Vector3() };
    root.userData.abilityTarget = id;
    this.targets.push(target);
    return target;
  }

  private addChest(id: string, x: number, z: number, item: string, data: Interactable['data'] = {}, elevation?: number): void {
    const y = elevation ?? this.heightAt(x, z);
    const root = new THREE.Group();
    root.position.set(x, y, z);
    root.name = id;
    this.root.add(root);
    this.box([0, 0.35, 0], [1.4, 0.7, 0.9], data.requires === 'magnet' ? 'metal' : 'woodDark', root);
    for (const side of [-1, 1]) this.box([side * 0.49, 0.37, 0], [0.12, 0.77, 0.96], 'copper', root);
    const lid = new THREE.Group();
    lid.position.set(0, 0.68, -0.44);
    root.add(lid);
    this.box([0, 0.08, 0.44], [1.46, 0.22, 0.97], 'trim', lid);
    const rune = this.mesh('gem', 'amber', [0, 0.55, 0.485], [0.12, 0.17, 0.04], root);
    const interaction = this.interact(id, 'chest', `宝箱 · ${NAMES[item] ?? item}`, [x, y + 0.35, z], root, { ...data, item, count: item === 'arrows' ? 12 : 1 });
    interaction.item = item;
    this.chests.push({ id, lid, rune, interaction, open: 0 });
    if (data.requires === 'magnet') {
      const collider: Collider = { id: `${id}-body`, mesh: root, enabled: true, climbable: true,
        box: new THREE.Box3(new THREE.Vector3(x - 0.73, y, z - 0.49), new THREE.Vector3(x + 0.73, y + 0.95, z + 0.49)) };
      this.colliders.push(collider);
      this.targets.push({ id, kind: 'metal', mesh: root, position: root.position.clone(), collider,
        origin: [x, y, z], velocity: new THREE.Vector3() });
      interaction.data!.targetId = id;
      root.userData.abilityTarget = id;
    }
  }

  private addPickup(id: string, item: string, x: number, z: number, count = 1, elevation?: number): void {
    const y = elevation ?? this.heightAt(x, z);
    const root = new THREE.Group();
    root.position.set(x, y + 0.08, z);
    root.name = id;
    this.root.add(root);
    if (item === 'apple') {
      const radius = 0.22;
      root.position.y = y + radius;
      root.userData = { abilityTarget: id, resource: 'apple', item, mass: 0.2, shape: 'sphere', radius };
      // Center the physical body on its pivot; decoration must not inflate AbilitySystem's bounds.
      this.mesh('sphere', 'cloth', [0, 0, 0], [radius, radius, radius], root);
      const target: AbilityTarget = { id, kind: 'orb', resource: 'apple', attached: false,
        mesh: root, position: root.position.clone(), origin: root.position.toArray() as Vec3, velocity: new THREE.Vector3() };
      const interaction = this.interact(id, 'pickup', NAMES[item] ?? item, target.origin!, root, { count, targetId: id });
      interaction.position = target.position;
      interaction.item = item;
      interaction.radius = 2.5;
      this.targets.push(target);
      this.pickups.push({ id, mesh: root, interaction, target, y: root.position.y, phase: this.pickups.length * 1.71 });
      return;
    }
    const weapon = ['branch', 'axe', 'torch', 'sword', 'spear', 'club', 'bow'].includes(item);
    if (weapon) {
      const length = item === 'spear' ? 2 : 1.2;
      const shaft = this.box([0, 0.13, 0], [0.12, 0.12, length], 'wood', root);
      shaft.rotation.y = 0.35;
      if (item === 'axe') this.box([0.2, 0.14, -0.42], [0.48, 0.15, 0.3], 'metal', root);
      if (item === 'sword' || item === 'spear') this.mesh('gem', 'metal', [0.1, 0.16, -length * 0.35], [0.13, 0.07, length * 0.3], root);
      if (item === 'torch') this.box([0.1, 0.15, -0.45], [0.24, 0.24, 0.28], 'cloth', root);
      if (item === 'bow') this.mesh('ring', 'wood', [0, 0.1, 0], [0.38, 0.65, 0.4], root).rotation.x = Math.PI / 2;
    } else if (item === 'mushroom') {
      this.mesh('cylinder', 'pale', [0, 0.18, 0], [0.07, 0.36, 0.07], root);
      this.mesh('sphere', 'cloth', [0, 0.39, 0], [0.32, 0.14, 0.3], root);
    } else if (item === 'pepper' || item === 'herb') {
      this.mesh('cone', 'green', [0, 0.27, 0], [0.22, 0.5, 0.2], root);
      this.mesh('gem', item === 'pepper' ? 'cloth' : 'glow', [0.14, 0.37, 0.05], [0.09, 0.21, 0.09], root).rotation.z = 0.4;
    } else if (item === 'wood') {
      for (let i = 0; i < 3; i++) this.beam([-0.45, 0.15 + i * 0.07, (i - 1) * 0.16], [0.45, 0.15 + i * 0.07, (i - 1) * 0.16], 0.11, 'wood', root);
    } else if (item === 'arrows') {
      for (let i = 0; i < 3; i++) this.box([(i - 1) * 0.12, 0.12, 0], [0.035, 0.035, 0.8], 'copper', root);
    } else this.mesh('sphere', item === 'apple' || item === 'roastApple' || item === 'meat' ? 'cloth' : 'copper', [0, 0.2, 0], [0.24, 0.2, 0.22], root);
    const sparkle = this.mesh('gem', 'amber', [0, 0.65, 0], [0.045, 0.095, 0.045], root);
    sparkle.castShadow = false;
    const interaction = this.interact(id, 'pickup', NAMES[item] ?? item, [x, y + 0.25, z], root, { count });
    interaction.item = item;
    interaction.radius = 2.5;
    this.pickups.push({ id, mesh: root, interaction, y: y + 0.08, phase: this.pickups.length * 1.71 });
  }

  private buildExploration(): void {
    this.addChest('lake-metal-chest', -35, 46, 'spear', { requires: 'magnet' });
    this.addChest('cracked-hollow-chest', 79, 43, 'bow', { requires: 'bomb', targetId: 'cracked-hollow-wall' });
    this.addTarget('cracked-hollow-wall', 'cracked', 79, 45.2, 3);
    this.addChest('outlook-cache', 21, 96, 'shield');
    this.addChest('old-road-cache', -22, -70, 'arrows');
    this.addChest('north-ridge-cache', 77, -86, 'sword');
    this.addChest('snow-pine-cache', -89, -54, 'warmcoat');
    this.addChest('eastern-pond-cache', 94, -7, 'arrows', { requires: 'magnet' });
    this.addTarget('magnet-practice-box', 'metal', -59, 36, 1.6);
    this.addTarget('bomb-practice-rock', 'cracked', 56, 45, 2.2);
    this.addTarget('stasis-practice-orb', 'orb', 73, -48, 1.8);
    const random = seededRandom(181923);
    const items = ['apple', 'mushroom', 'herb', 'pepper', 'wood', 'insect'];
    let placed = 0;
    for (let attempt = 0; attempt < 1400 && placed < 62; attempt++) {
      const x = (random() - 0.5) * 244, z = (random() - 0.5) * 240;
      if (!outsideStructures(x, z, 1)) continue;
      this.addPickup(`wild-${String(placed + 1).padStart(3, '0')}`, items[placed % items.length], x, z);
      placed++;
    }
    // Trail-side food is deliberately plentiful before the cold region.
    for (let i = 0; i < 5; i++) this.addPickup(`snow-route-pepper-${i}`, 'pepper', -28 - i * 2.1, -30 + (i % 2) * 2.5);
    this.addPickup('outlook-branch', 'branch', -4, 80);
    this.addPickup('orchard-apple-a', 'apple', 20.8, 70.3);
    this.addPickup('orchard-apple-b', 'apple', 24.6, 75.1);
    this.addPickup('trail-club', 'club', 23, 42);
    this.addPickup('trail-shield', 'shield', -7, 44);
    // Modest road ruins provide cover without obstructing the navigation corridor.
    for (let i = 0; i < 10; i++) {
      const x = i % 2 ? 7 : -7, z = 34 - i * 7;
      const y = this.heightAt(x, z);
      if (Math.abs(z) < 19) continue;
      this.solid(`road-marker-${i}`, [x, y + 0.55, z], [0.8, 1.1, 0.8], 'stone');
      this.mesh('gem', 'copper', [x, y + 1.2, z], [0.23, 0.35, 0.23]);
    }
  }

  private flowingWater(falling = false): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color: falling ? '#8cd5db' : '#4bafb7', transparent: true,
      opacity: falling ? 0.88 : 0.78, roughness: 0.24, metalness: 0.18, emissive: '#163f4d', emissiveIntensity: 0.13,
      side: THREE.DoubleSide, depthWrite: false });
    material.onBeforeCompile = shader => {
      shader.uniforms.flowTime = this.waterTime;
      shader.vertexShader = `varying vec3 vFlowPosition;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vFlowPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = `uniform float flowTime;\nvarying vec3 vFlowPosition;\n${shader.fragmentShader}`;
      const travel = falling ? '-vFlowPosition.y * 2.8 - flowTime * 5.5' : 'vFlowPosition.z * 1.4 - flowTime * 2.4';
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float ribbon = pow(max(0.0, sin(${travel} + sin(vFlowPosition.x * 3.7) * 0.7)), 12.0);
        float lanes = 0.35 + 0.65 * pow(sin(vFlowPosition.x * 4.1) * 0.5 + 0.5, 2.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.94, 0.91), ribbon * lanes * ${falling ? '0.7' : '0.38'});`);
    };
    material.customProgramCacheKey = () => `rillstep-flow-${falling ? 'vertical' : 'surface'}-v1`;
    return material;
  }

  private buildWater(): void {
    // Priority over the overlapping source basin: this reach carries the stronger downstream current.
    this.waters.push({ ...RIVER, current: [...RIVER.current!] });
    this.waterfalls.push({ ...CASCADE });
    for (let index = 0; index < LAKES.length; index++) {
      const lake = LAKES[index];
      const positions: number[] = [], indices: number[] = [];
      const rings = 8, segments = 48;
      positions.push(lake.x, lake.level, lake.z);
      for (let ring = 1; ring <= rings; ring++) {
        for (let i = 0; i < segments; i++) {
          const a = i * Math.PI * 2 / segments;
          positions.push(lake.x + Math.cos(a) * lake.rx * ring / rings, lake.level, lake.z + Math.sin(a) * lake.rz * ring / rings);
        }
      }
      for (let i = 0; i < segments; i++) indices.push(0, 1 + (i + 1) % segments, 1 + i);
      for (let ring = 1; ring < rings; ring++) for (let i = 0; i < segments; i++) {
        const a = 1 + (ring - 1) * segments + i, b = 1 + (ring - 1) * segments + (i + 1) % segments;
        const c = a + segments, d = b + segments;
        indices.push(a, b, c, b, d, c);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const material = this.flowingWater();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `lake-${index}-surface`;
      mesh.renderOrder = 1;
      this.root.add(mesh);
      this.waterVisuals.push({ mesh, base: new Float32Array(positions) });
      // Overlapping inscribed rectangles admit a whole ice pillar, not just its center point.
      for (const [rx, rz] of [[0.78, 0.6], [0.95, 0.3], [0.45, 0.88]]) {
        this.waters.push({ minX: lake.x - lake.rx * rx, maxX: lake.x + lake.rx * rx,
          minZ: lake.z - lake.rz * rz, maxZ: lake.z + lake.rz * rz, level: lake.level, depth: lake.depth, current: lake.current });
      }
      // Narrow outer strips match the shore for swimming without filling the ellipse's corners.
      const strips = 16;
      for (let i = 0; i < strips; i++) {
        const z0 = -1 + i * 2 / strips, z1 = -1 + (i + 1) * 2 / strips;
        const width = lake.rx * Math.sqrt(Math.max(0, 1 - ((z0 + z1) / 2) ** 2));
        this.waters.push({ minX: lake.x - width, maxX: lake.x + width, minZ: lake.z + z0 * lake.rz, maxZ: lake.z + z1 * lake.rz, level: lake.level, depth: lake.depth, current: lake.current });
      }
      this.targets.push({ id: `lake-${index}-water`, kind: 'water', mesh, position: new THREE.Vector3(lake.x, lake.level, lake.z), origin: [lake.x, lake.level, lake.z] });
      const shoreMaterial = new THREE.LineBasicMaterial({ color: '#b8e3d5', transparent: true, opacity: 0.48 });
      for (const fraction of [0.94, 0.975]) {
        const points: THREE.Vector3[] = [];
        for (let i = 0; i < 64; i++) {
          const a = i * Math.PI * 2 / 64;
          points.push(new THREE.Vector3(lake.x + Math.cos(a) * lake.rx * fraction, lake.level + 0.045, lake.z + Math.sin(a) * lake.rz * fraction));
        }
        this.root.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), shoreMaterial));
      }
      // Reed tufts are instanced along the wet shoreline.
      const reedGeometry = new THREE.ConeGeometry(0.065, 1.2, 3);
      const reeds = new THREE.InstancedMesh(reedGeometry, this.materials.get('green') ?? new THREE.MeshStandardMaterial({ color: '#7f965e' }), 52);
      const dummy = new THREE.Object3D();
      let reedCount = 0;
      for (let i = 0; i < 52; i++) {
        const a = i * 2.39996;
        const x = lake.x + Math.cos(a) * lake.rx * 1.045, z = lake.z + Math.sin(a) * lake.rz * 1.045;
        if (x > RIVER.minX - 0.4 && x < RIVER.maxX + 0.4 && z > RIVER.minZ && z < RIVER.maxZ + 1) continue;
        dummy.position.set(x, this.heightAt(x, z) + 0.45, z);
        dummy.rotation.set(0.09, a, 0.1 * Math.sin(i));
        dummy.scale.setScalar(0.7 + (i % 5) * 0.13);
        dummy.updateMatrix();
        reeds.setMatrixAt(reedCount++, dummy.matrix);
      }
      reeds.count = reedCount;
      reeds.computeBoundingSphere();
      this.root.add(reeds);
    }
    const width = RIVER.maxX - RIVER.minX, x = (RIVER.minX + RIVER.maxX) / 2;
    // Start inside the source shoreline, avoiding most of the coplanar overlap with its basin surface.
    const startZ = RIVER.minZ + 6, length = RIVER.maxZ - startZ;
    const reachGeometry = new THREE.PlaneGeometry(width, length, 4, 18).rotateX(-Math.PI / 2)
      .translate(x, RIVER.level, (startZ + RIVER.maxZ) / 2);
    (reachGeometry.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const reach = new THREE.Mesh(reachGeometry, this.flowingWater());
    reach.name = 'Rillstep narrow river';
    reach.renderOrder = 1;
    this.root.add(reach);
    this.waterVisuals.push({ mesh: reach, base: new Float32Array(reachGeometry.attributes.position.array) });
    this.targets.push({ id: 'rillstep-river', kind: 'water', mesh: reach,
      position: new THREE.Vector3(x, RIVER.level, (startZ + RIVER.maxZ) / 2) });

    // A short rock lip fills the final sloping heightfield cell; its top is the submerged river bed.
    const bed = RIVER.level - RIVER.depth, foot = CASCADE.minY - 1.2;
    this.solid('rillstep-waterfall-lip', [x, (bed + foot) / 2, CASCADE.minZ - 1], [width, bed - foot, 1.94], 'darkstone');
    const height = CASCADE.maxY - CASCADE.minY;
    const curtainGeometry = new THREE.PlaneGeometry(width, height, 8, 16)
      .translate(x, (CASCADE.minY + CASCADE.maxY) / 2, CASCADE.minZ);
    const curtain = new THREE.Mesh(curtainGeometry, this.flowingWater(true));
    curtain.name = 'Rillstep waterfall · exact vertical ice surface';
    curtain.renderOrder = 2;
    this.root.add(curtain);
    this.waterVisuals.push({ mesh: curtain, base: new Float32Array(curtainGeometry.attributes.position.array), falling: true });
    this.targets.push({ id: 'rillstep-waterfall', kind: 'water', mesh: curtain,
      position: new THREE.Vector3(x, (CASCADE.minY + CASCADE.maxY) / 2, CASCADE.minZ) });
    for (let i = 0; i < 3; i++) {
      const foam = new THREE.Mesh(this.geometry('ring'), new THREE.MeshStandardMaterial({ color: '#d8f2eb',
        emissive: '#77b6bc', emissiveIntensity: 0.2, transparent: true, opacity: 0.5, depthWrite: false }));
      foam.position.set(x, CASCADE.minY + 0.07 + i * 0.005, CASCADE.minZ + 1.2);
      foam.rotation.x = -Math.PI / 2;
      foam.renderOrder = 3;
      this.root.add(foam);
      this.cascadeFoam.push(foam);
    }
  }

  private buildVista(): void {
    const random = seededRandom(47729);
    const distant = new THREE.Group();
    distant.name = 'Far valley and the Crownless Citadel';
    this.root.add(distant);
    const mountain = new THREE.MeshStandardMaterial({ color: '#809b9d', roughness: 1, flatShading: true });
    const farMountain = new THREE.MeshStandardMaterial({ color: '#9aafb0', roughness: 1, flatShading: true });
    const cone = new THREE.ConeGeometry(1, 1, 5);
    for (let i = 0; i < 48; i++) {
      const angle = i * Math.PI * 2 / 48;
      const distance = 255 + random() * 95;
      const height = 42 + random() * 76;
      const peak = new THREE.Mesh(cone, i % 3 === 0 ? farMountain : mountain);
      peak.position.set(Math.cos(angle) * distance, -50 + height / 2, Math.sin(angle) * distance);
      peak.scale.set(25 + random() * 25, height, 26 + random() * 24);
      peak.rotation.y = random() * 6;
      distant.add(peak);
      if (height > 87) {
        const cap = new THREE.Mesh(cone, this.material('snow'));
        cap.position.set(peak.position.x, -50 + height * 0.89, peak.position.z);
        cap.scale.set(peak.scale.x * 0.225, height * 0.225, peak.scale.z * 0.225);
        cap.rotation.copy(peak.rotation);
        distant.add(cap);
      }
    }
    // A broken crown of five asymmetrical observatory spires, intentionally original.
    const castle = new THREE.Group();
    castle.position.set(10, -23, -245);
    distant.add(castle);
    this.box([0, 13, 0], [35, 26, 21], 'darkstone', castle);
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 9, h = [31, 42, 62, 37, 29][i];
      this.mesh('cylinder', 'darkstone', [x, h / 2 + 10, i % 2 * 4], [4 - Math.abs(i - 2) * 0.4, h, 4], castle);
      this.mesh('gem', 'trim', [x, h + 14, i % 2 * 4], [4.5, 8 + i, 4.5], castle);
    }
    const crown = this.mesh('ring', 'copper', [0, 74, 0], [11, 11, 11], castle);
    crown.rotation.set(0.25, 0.1, -0.3);
    // A low valley floor below the heightfield gives the ravine a readable depth.
    const floor = new THREE.Mesh(new THREE.CircleGeometry(500, 64), new THREE.MeshStandardMaterial({ color: '#6b8683', roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -58;
    distant.add(floor);
  }

  private batchArchitecture(): void {
    const protectedRoots = new Set<THREE.Object3D>([this.terminalGem, this.towerCore, this.towerStructure, this.atmosphere.root]);
    for (const target of this.targets) protectedRoots.add(target.mesh);
    for (const item of this.interactables) {
      if (item.mesh && ['door', 'chest', 'pickup', 'elder', 'glider'].includes(item.kind)) protectedRoots.add(item.mesh);
    }
    const primitives = new Set(this.geometries.values());
    const batch = (parent: THREE.Group, exclusions: Set<THREE.Object3D>): void => {
      const groups = new Map<string, THREE.Mesh[]>();
      const inverse = parent.matrixWorld.clone().invert();
      const visit = (object: THREE.Object3D): void => {
        if (object !== parent && exclusions.has(object)) return;
        if (object instanceof THREE.Mesh && !(object instanceof THREE.InstancedMesh)
          && primitives.has(object.geometry) && !Array.isArray(object.material)
          && object.material !== this.material('fire') && object.material !== this.material('amber')) {
          const key = `${object.geometry.uuid}:${object.material.uuid}:${object.castShadow}`;
          const list = groups.get(key) ?? [];
          list.push(object);
          groups.set(key, list);
        }
        for (const child of object.children) visit(child);
      };
      visit(parent);
      for (const meshes of groups.values()) {
        if (meshes.length < 3) continue;
        const first = meshes[0];
        const instances = new THREE.InstancedMesh(first.geometry, first.material, meshes.length);
        instances.name = 'Batched fixed architecture';
        instances.castShadow = first.castShadow;
        instances.receiveShadow = true;
        meshes.forEach((mesh, i) => {
          instances.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
          // Collider AABBs are immutable world-space data; their original mesh handles remain valid.
          mesh.removeFromParent();
        });
        instances.computeBoundingSphere();
        parent.add(instances);
      }
    };
    batch(this.root, protectedRoots);
    batch(this.towerCore, new Set());
    batch(this.towerStructure, new Set([this.towerBeacon]));
  }

  update(dt: number, state: GameState): void {
    if (this.disposed) return;
    const delta = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    const initial = this.bloodMoonCount === undefined;
    const bloodMoon = !initial && this.bloodMoonCount !== state.bloodMoonCount;
    this.bloodMoonCount = state.bloodMoonCount;
    this.elapsed += delta;
    const t = this.elapsed;
    const opening = !!(state.flags.chamberDoor || state.flags.doorOpen);
    this.doorOpen = THREE.MathUtils.damp(this.doorOpen, opening ? 1 : 0, 3.8, delta);
    this.chamberDoor.position.y = this.heightAt(0, 105) + this.doorOpen * 5.8;
    this.chamberDoor.visible = this.doorOpen < 0.995;
    this.doorCollider.enabled = !opening;
    this.setInteractionAvailable('chamber-door', !opening);
    this.terminalGem.visible = !state.terminal;
    this.terminalGem.rotation.y = t * 0.7;
    this.setInteractionAvailable('terminal', !state.terminal);
    this.setInteractionAvailable('chamber-exit', !state.flags.exitedChamber && state.quest === 'EXIT_CHAMBER');
    if (state.tower && !this.wasTower) this.towerRise = 0;
    this.wasTower = state.tower;
    this.towerRise = state.tower ? Math.min(1, this.towerRise + delta / 2.4) : 0;
    this.towerStructure.visible = state.tower;
    this.towerCore.visible = state.tower;
    // The decks become safe immediately (including the engine's top teleport), while the massive core rises.
    this.towerCore.position.y = -20 * (1 - this.towerRise) ** 2;
    for (const collider of this.towerColliders) collider.enabled = state.tower;
    this.towerBeacon.rotation.y = t * 0.12;
    (this.towerBeacon.material as THREE.MeshStandardMaterial).opacity = 0.07 + Math.sin(t * 1.4) * 0.02;
    this.setInteractionAvailable('tower', !state.tower);
    const atTemple = state.completed.length === 4 || state.upgrade !== null || state.glider;
    this.gliderElder.visible = atTemple;
    this.gliderInteraction.radius = atTemple && !state.glider ? CONFIG.interactDistance : 0;
    this.gliderInteraction.data = { disabled: !atTemple || state.glider };
    this.gliderElder.rotation.y = Math.sin(t * 0.3) * 0.12;
    this.elder.rotation.z = Math.sin(t * 0.65) * 0.018;
    for (const chest of this.chests) {
      const opened = !!state.flags[`opened:${chest.id}`];
      chest.open = THREE.MathUtils.damp(chest.open, opened ? 1 : 0, 8, delta);
      if (delta === 0) chest.open = opened ? 1 : 0;
      chest.lid.rotation.x = -chest.open * 1.8;
      chest.rune.visible = !opened;
      chest.interaction.radius = opened ? 0 : CONFIG.interactDistance;
      chest.interaction.data!.disabled = opened;
      if (chest.interaction.data!.requires === 'magnet' && chest.interaction.mesh) {
        chest.interaction.position.copy(chest.interaction.mesh.position).y += 0.35;
      }
    }
    const [px, , pz] = state.player.position;
    for (const pickup of this.pickups) {
      const target = pickup.target;
      if (target && bloodMoon) {
        delete state.flags[`picked:${pickup.id}`];
        delete state.flags[`broken:${pickup.id}`];
        delete state.flags[`destroyed:${pickup.id}`];
      }
      const picked = !!state.flags[`picked:${pickup.id}`]
        || !!(target && (state.flags[`broken:${pickup.id}`] || state.flags[`destroyed:${pickup.id}`]));
      if (target) {
        const reset = initial || bloodMoon || (target.solved && !picked);
        if (reset) {
          // Only lifecycle restoration may move the body here; abilities own all regular movement.
          target.position.set(...target.origin!);
          pickup.mesh.position.copy(target.position);
          pickup.mesh.rotation.set(0, 0, 0);
          target.attached = false;
        }
        if (reset || picked) {
          target.velocity!.set(0, 0, 0);
          target.frozen = target.charge = 0;
        }
        target.solved = picked;
      }
      pickup.mesh.visible = !picked;
      pickup.interaction.radius = picked ? 0 : 2.5;
      pickup.interaction.data!.disabled = picked;
      if (!target && !picked && Math.hypot(px - pickup.mesh.position.x, pz - pickup.mesh.position.z) < 30) {
        pickup.mesh.position.y = pickup.y + Math.sin(t * 2 + pickup.phase) * 0.035;
      }
    }
    for (const shrine of this.shrineVisuals) {
      const complete = state.completed.includes(shrine.ability);
      const material = shrine.gem.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = complete ? 0.45 : 1.15 + Math.sin(t * 1.7) * 0.15;
      shrine.gem.rotation.y = t * 0.18;
      shrine.light.visible = !complete;
    }
    // Abilities own movement and collision synchronization for dynamic targets; never overwrite their positions.
    for (const target of this.targets) {
      if (target.kind === 'water') continue;
      if (state.flags[`destroyed:${target.id}`] || state.flags[`broken:${target.id}`]) {
        target.mesh.visible = false;
        target.solved = true;
        if (target.collider) target.collider.enabled = false;
      }
    }
    for (const hearth of this.fireVisuals) {
      const extinguished = hearth.interactions.some(item => state.flags[FLAGS.extinguished(item.id)] === true || state.flags[FLAGS.lit(item.id)] === false);
      const ignited = hearth.interactions.some(item => state.flags[FLAGS.lit(item.id)] === true && state.flags[FLAGS.extinguished(item.id)] !== true);
      // A changed endpoint wins over the previously mirrored sibling. Rain always vetoes exposed ignition.
      const lit = state.weather === 'rain' && !hearth.sheltered ? false
        : hearth.lit === undefined ? !extinguished
        : hearth.lit ? !extinguished : ignited;
      hearth.lit = lit;
      for (const item of hearth.interactions) {
        state.flags[FLAGS.lit(item.id)] = lit;
        state.flags[FLAGS.extinguished(item.id)] = !lit;
        item.data!.lit = lit;
      }
    }
    this.waterTime.value = t;
    for (let i = 0; i < this.cascadeFoam.length; i++) {
      const foam = this.cascadeFoam[i], phase = (t * 0.55 + i / 3) % 1;
      foam.scale.set(0.7 + phase * 2.8, 0.4 + phase * 1.8, 1);
      (foam.material as THREE.MeshStandardMaterial).opacity = (1 - phase) * 0.6;
    }
    this.waterClock += delta;
    if (this.waterClock >= (state.settings.quality === 'low' ? 0.1 : 0.05)) {
      this.waterClock = 0;
      for (const water of this.waterVisuals) {
        // Vertical ice-placement bounds are exact; animate the curtain's shader, not its plane.
        if (!water.falling) {
          const positions = water.mesh.geometry.attributes.position.array as Float32Array;
          for (let i = 0; i < positions.length; i += 3) positions[i + 1] = water.base[i + 1] + Math.sin(water.base[i] * 0.5 + t * 1.5) * Math.cos(water.base[i + 2] * 0.4 - t * 0.8) * 0.032;
          water.mesh.geometry.attributes.position.needsUpdate = true;
        }
        water.mesh.material.roughness = state.weather === 'rain' ? 0.43 : 0.22;
      }
    }
    this.foliage.update(delta, state);
    this.atmosphere.update(delta, state);
  }

  private setInteractionAvailable(id: string, available: boolean): void {
    const interaction = this.interactables.find(entry => entry.id === id);
    if (!interaction) return;
    interaction.radius = available ? CONFIG.interactDistance : 0;
    interaction.data ??= {};
    interaction.data.disabled = !available;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.root.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) {
          materials.add(material);
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
        }
        if (object instanceof THREE.InstancedMesh) object.dispose();
      }
      if (object instanceof THREE.Light && object.shadow) object.shadow.dispose();
    });
    for (const geometry of this.geometries.values()) geometries.add(geometry);
    for (const material of this.materials.values()) materials.add(material);
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    textures.forEach(texture => texture.dispose());
    this.root.clear();
    this.root.removeFromParent();
    this.colliders.length = this.interactables.length = this.targets.length = this.waters.length = this.waterfalls.length = this.spawns.length = 0;
    this.waterVisuals.length = this.fireVisuals.length = this.cascadeFoam.length = 0;
  }
}
