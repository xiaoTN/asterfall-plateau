import * as THREE from 'three';
import type { GameState, Interactable } from '../core/types';
import { isColdTerrain, seededRandom, terrainHeight } from './terrain';

interface Hearth { position: THREE.Vector3; flame: THREE.Object3D; interaction: Interactable; light: THREE.PointLight; }

/** Local, pooled weather and embers. The engine owns sky, sun, exposure and fog. */
export class WorldAtmosphere {
  readonly root = new THREE.Group();
  private readonly rain: THREE.LineSegments;
  private readonly snow: THREE.Points;
  private readonly embers: THREE.Points;
  private readonly hearths: Hearth[] = [];
  private readonly rainPositions = new Float32Array(360 * 6);
  private readonly snowPositions = new Float32Array(240 * 3);
  private readonly emberPositions = new Float32Array(200 * 3);
  private readonly seeds = new Float32Array(360 * 4);
  private elapsed = 0;

  constructor() {
    this.root.name = 'Local weather and fire';
    const random = seededRandom(9941);
    for (let i = 0; i < this.seeds.length; i++) this.seeds[i] = random();
    const rainGeometry = new THREE.BufferGeometry();
    rainGeometry.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(rainGeometry, new THREE.LineBasicMaterial({ color: '#b1d3e1', transparent: true, opacity: 0.4, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 3;
    this.root.add(this.rain);
    const snowGeometry = new THREE.BufferGeometry();
    snowGeometry.setAttribute('position', new THREE.BufferAttribute(this.snowPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.snow = new THREE.Points(snowGeometry, new THREE.PointsMaterial({ color: '#f5fbff', size: 0.14, transparent: true, opacity: 0.78, depthWrite: false }));
    this.snow.frustumCulled = false;
    this.root.add(this.snow);
    const emberGeometry = new THREE.BufferGeometry();
    emberGeometry.setAttribute('position', new THREE.BufferAttribute(this.emberPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.embers = new THREE.Points(emberGeometry, new THREE.PointsMaterial({ color: '#ffd084', size: 0.075, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.embers.frustumCulled = false;
    this.root.add(this.embers);
  }

  addFire(position: THREE.Vector3, flame: THREE.Object3D, interaction: Interactable): void {
    const light = new THREE.PointLight('#ffb75c', 3.5, 13, 1.6);
    light.position.copy(position).y += 1.2;
    this.root.add(light);
    this.hearths.push({ position: position.clone(), flame, interaction, light });
  }

  update(dt: number, state: GameState): void {
    this.elapsed += dt;
    const t = this.elapsed;
    const [px, py, pz] = state.player.position;
    const inCave = Math.abs(px) < 11 && pz > 94 && pz < 119 && py < 28;
    const cold = isColdTerrain(px, pz);
    const quality = state.settings.quality;
    const rainCount = quality === 'low' ? 110 : quality === 'medium' ? 230 : 360;
    const snowCount = quality === 'low' ? 75 : quality === 'medium' ? 150 : 240;
    this.rain.visible = state.weather === 'rain' && !cold && !inCave;
    this.snow.visible = cold && !inCave;
    this.rain.geometry.setDrawRange(0, rainCount * 2);
    this.snow.geometry.setDrawRange(0, snowCount);
    if (this.rain.visible) {
      for (let i = 0; i < rainCount; i++) {
        const s = i * 4, p = i * 6;
        const x = px + ((this.seeds[s] * 42 + t * 3) % 42) - 21;
        const z = pz + this.seeds[s + 1] * 42 - 21;
        const y = py + ((this.seeds[s + 2] * 22 - t * 22) % 22 + 22) % 22 - 2;
        const floor = terrainHeight(x, z) + 0.15;
        this.rainPositions[p] = x;
        this.rainPositions[p + 1] = Math.max(y, floor);
        this.rainPositions[p + 2] = z;
        this.rainPositions[p + 3] = x - 0.11;
        this.rainPositions[p + 4] = Math.max(y + 0.85, floor);
        this.rainPositions[p + 5] = z;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
    if (this.snow.visible) {
      for (let i = 0; i < snowCount; i++) {
        const s = i * 4, p = i * 3;
        this.snowPositions[p] = px + ((this.seeds[s] * 40 + t * 1.6) % 40) - 20 + Math.sin(t + i) * 0.5;
        this.snowPositions[p + 1] = py + ((this.seeds[s + 2] * 20 - t * (1.2 + this.seeds[s + 3])) % 20 + 20) % 20 - 2;
        this.snowPositions[p + 2] = pz + this.seeds[s + 1] * 40 - 20 + Math.cos(t * 0.6 + i) * 0.5;
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
    }
    let count = 0;
    for (let h = 0; h < this.hearths.length; h++) {
      const hearth = this.hearths[h];
      const dx = px - hearth.position.x, dz = pz - hearth.position.z;
      const near = dx * dx + dz * dz < 75 * 75;
      const lit = hearth.interaction.data?.lit === true;
      hearth.flame.visible = lit;
      hearth.flame.scale.set(1 + Math.sin(t * 8 + h) * 0.1, 0.9 + Math.sin(t * 12 + h * 3) * 0.16, 1);
      hearth.light.intensity = lit && dx * dx + dz * dz < 25 * 25 ? 3.7 + Math.sin(t * 13 + h) * 0.5 : 0;
      hearth.light.visible = hearth.light.intensity > 0;
      if (!near || !lit) continue;
      for (let j = 0; j < 22 && count < 200; j++, count++) {
        const s = ((h * 22 + j) % 360) * 4, p = count * 3;
        const life = (this.seeds[s] + t * 0.36) % 1;
        const angle = this.seeds[s + 1] * Math.PI * 2 + life * 1.3;
        const spread = life * 0.65;
        this.emberPositions[p] = hearth.position.x + Math.cos(angle) * spread;
        this.emberPositions[p + 1] = hearth.position.y + 0.5 + life * 3.7;
        this.emberPositions[p + 2] = hearth.position.z + Math.sin(angle) * spread;
      }
    }
    this.embers.visible = count > 0;
    this.embers.geometry.setDrawRange(0, count);
    this.embers.geometry.attributes.position.needsUpdate = true;
  }
}
