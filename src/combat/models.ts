import * as THREE from 'three';
import type { EnemySpawn } from '../core/types';

export interface BogModel {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  arms: [THREE.Group, THREE.Group];
  legs: [THREE.Group, THREE.Group];
  weapon: THREE.Group;
  health: THREE.Mesh;
  healthRoot: THREE.Group;
  eyes: THREE.MeshStandardMaterial;
}

/** Original reed-horned marsh creatures, built entirely from flat shaded solids. */
export function createBogModel(type: EnemySpawn['type']): BogModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const head = new THREE.Group();
  const palette = type === 'archer' ? 0x647f89 : type === 'shield' ? 0x887450 : type === 'guardian' ? 0x596f91 : 0x6d8861;
  const skin = new THREE.MeshStandardMaterial({ color: palette, roughness: 0.96, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0x303d35, roughness: 1 });
  const reed = new THREE.MeshStandardMaterial({ color: 0xc9b68a, roughness: 0.9 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x694932, roughness: 1 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x94afb2, metalness: 0.5, roughness: 0.5 });
  const eyes = new THREE.MeshStandardMaterial({ color: 0xffd78c, emissive: 0xffa64f, emissiveIntensity: 0.65 });
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const part = new THREE.Mesh(geometry, material);
    part.position.set(x, y, z);
    part.castShadow = true;
    parent.add(part);
    return part;
  };
  root.add(body);
  body.position.y = 0.94;
  mesh(new THREE.DodecahedronGeometry(0.59, 0), skin, body, 0, 0.07, 0).scale.set(0.98, 1.12, 0.72);
  mesh(new THREE.ConeGeometry(0.55, 0.46, 7), dark, body, 0, -0.25, 0);
  head.position.set(0, 0.75, -0.09);
  body.add(head);
  mesh(new THREE.IcosahedronGeometry(0.42, 0), skin, head, 0, 0, 0).scale.set(1.3, 0.86, 0.9);
  mesh(new THREE.ConeGeometry(0.24, 0.37, 5), skin, head, 0, -0.02, -0.31).rotation.x = -Math.PI / 2;
  for (const side of [-1, 1]) {
    mesh(new THREE.ConeGeometry(0.1, 0.7, 4), reed, head, side * 0.38, 0.43, 0.02).rotation.z = side * -0.4;
    mesh(new THREE.SphereGeometry(0.066, 5, 3), eyes, head, side * 0.2, 0.06, -0.32);
  }
  const arms: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  const legs: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  for (let index = 0; index < 2; index++) {
    const side = index === 0 ? -1 : 1;
    const arm = arms[index];
    arm.position.set(side * 0.5, 0.36, 0);
    body.add(arm);
    mesh(new THREE.CylinderGeometry(0.13, 0.095, 0.62, 5), skin, arm, side * 0.05, -0.27, 0);
    mesh(new THREE.DodecahedronGeometry(0.14), dark, arm, side * 0.05, -0.56, 0);
    const leg = legs[index];
    leg.position.set(side * 0.22, -0.38, 0);
    body.add(leg);
    mesh(new THREE.CylinderGeometry(0.15, 0.11, 0.46, 5), skin, leg, 0, -0.22, 0);
    mesh(new THREE.BoxGeometry(0.25, 0.15, 0.36), dark, leg, 0, -0.46, -0.07);
  }
  const weapon = new THREE.Group();
  weapon.position.set(0.06, -0.52, -0.06);
  arms[1].add(weapon);
  if (type === 'archer') {
    const bow = mesh(new THREE.TorusGeometry(0.42, 0.045, 4, 9, Math.PI), wood, weapon, 0, 0, -0.13);
    bow.rotation.z = -Math.PI / 2;
    mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.84, 3), reed, weapon, 0, 0, -0.13);
    mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.6, 6), dark, body, 0.28, 0.2, 0.38).rotation.z = -0.3;
  } else {
    mesh(new THREE.CylinderGeometry(0.065, 0.05, 0.82, 5), wood, weapon, 0, 0.1, -0.14);
    mesh(new THREE.DodecahedronGeometry(type === 'guardian' ? 0.28 : 0.21), metal, weapon, 0, 0.53, -0.14);
  }
  if (type === 'shield' || type === 'guardian') {
    const shield = mesh(new THREE.CylinderGeometry(0.4, 0.36, 0.1, 7), wood, arms[0], -0.06, -0.38, -0.14);
    shield.rotation.x = Math.PI / 2;
    mesh(new THREE.IcosahedronGeometry(0.13), metal, arms[0], -0.06, -0.38, -0.22);
  }
  const healthRoot = new THREE.Group();
  healthRoot.position.y = 2.55;
  root.add(healthRoot);
  mesh(new THREE.PlaneGeometry(1.08, 0.1), new THREE.MeshBasicMaterial({ color: 0x242e31, depthTest: false }), healthRoot, 0, 0, 0);
  const health = mesh(new THREE.PlaneGeometry(1, 0.055), new THREE.MeshBasicMaterial({ color: 0xed927b, depthTest: false }), healthRoot, 0, 0, 0.01);
  healthRoot.visible = false;
  root.name = `bog-${type}`;
  root.userData.enemyType = type;
  if (type === 'guardian') root.scale.setScalar(1.2);
  return { root, body, head, arms, legs, weapon, health, healthRoot, eyes };
}

export function disposeObject(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    geometries.add(child.geometry);
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  object.removeFromParent();
}
