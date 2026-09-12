import * as THREE from 'three';
import type { GameState, MovementState } from '../core/types';

export interface PlayerPose {
  movement: MovementState;
  speed: number;
  yaw: number;
  verticalSpeed: number;
  attacking: boolean;
  guarding: boolean;
  bowDraw: number;
  hurt: boolean;
  crouched: boolean;
  landing: number;
}

/** An original, jointed low-poly wanderer. Geometry/materials are owned by this rig. */
export class PlayerRig {
  readonly root = new THREE.Group();
  readonly visual = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly leftArm = new THREE.Group();
  private readonly rightArm = new THREE.Group();
  private readonly leftElbow = new THREE.Group();
  private readonly rightElbow = new THREE.Group();
  private readonly leftLeg = new THREE.Group();
  private readonly rightLeg = new THREE.Group();
  private readonly leftKnee = new THREE.Group();
  private readonly rightKnee = new THREE.Group();
  private readonly rightHand = new THREE.Group();
  private readonly leftHand = new THREE.Group();
  private readonly sword = new THREE.Group();
  private readonly shield = new THREE.Group();
  private readonly bow = new THREE.Group();
  private readonly arrow = new THREE.Group();
  private readonly terminal = new THREE.Group();
  private readonly scarfTail = new THREE.Group();
  private readonly glider = new THREE.Group();
  private readonly leftWing = new THREE.Group();
  private readonly rightWing = new THREE.Group();
  private readonly swordMount = new THREE.Group();
  private readonly bowMount = new THREE.Group();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.MeshStandardMaterial>();
  private readonly tunic: THREE.MeshStandardMaterial;
  private readonly trousers: THREE.MeshStandardMaterial;
  private readonly glow: THREE.MeshStandardMaterial;
  private phase = 0;
  private time = 0;
  private attackTime = 0;
  private wasAttacking = false;
  private wingAmount = 0;
  private deathAmount = 0;
  private weaponInHand = false;
  private bowInHand = false;
  private disposed = false;

  constructor() {
    this.root.name = 'Asterfall wanderer';
    this.root.add(this.visual);
    const skin = this.material(0xc89b79);
    const hood = this.material(0xd3c9a9);
    const dark = this.material(0x263942);
    const leather = this.material(0x674837);
    const gold = this.material(0xcfa861, 0.35);
    const steel = this.material(0xb6ced1, 0.55);
    const scarf = this.material(0xcf6849);
    this.tunic = this.material(0x365e68);
    this.trousers = this.material(0x485453);
    this.glow = this.material(0x7de6dc, 0.25, 0x4dbbad);

    this.visual.add(this.torso, this.head, this.leftLeg, this.rightLeg);
    this.torso.position.y = 0.89;
    this.mesh(this.torso, new THREE.CylinderGeometry(0.27, 0.34, 0.58, 6), this.tunic, 0, 0.24, 0, 1, 1, 0.72);
    this.mesh(this.torso, new THREE.CylinderGeometry(0.33, 0.38, 0.24, 6), this.tunic, 0, -0.075, 0, 1, 1, 0.75);
    this.mesh(this.torso, new THREE.BoxGeometry(0.61, 0.085, 0.44), leather, 0, 0.015, 0);
    this.mesh(this.torso, new THREE.BoxGeometry(0.105, 0.115, 0.035), gold, 0, 0.015, -0.235);
    const chestStrap = this.mesh(this.torso, new THREE.BoxGeometry(0.075, 0.52, 0.035), leather, -0.015, 0.25, -0.211);
    chestStrap.rotation.z = -0.48;
    this.mesh(this.torso, new THREE.OctahedronGeometry(0.07), this.glow, 0.115, 0.43, -0.21, 0.6, 1, 0.3);

    this.head.position.set(0, 1.40, 0);
    this.mesh(this.head, new THREE.IcosahedronGeometry(0.277, 1), hood, 0, 0.12, 0.025, 1, 1.12, 1);
    this.mesh(this.head, new THREE.BoxGeometry(0.30, 0.29, 0.20), skin, 0, 0.12, -0.13);
    this.mesh(this.head, new THREE.BoxGeometry(0.32, 0.06, 0.07), dark, 0, 0.25, -0.2);
    for (const side of [-1, 1]) {
      this.mesh(this.head, new THREE.BoxGeometry(0.045, 0.035, 0.018), dark, side * 0.079, 0.16, -0.239);
      this.mesh(this.head, new THREE.BoxGeometry(0.018, 0.016, 0.021), hood, side * 0.076, 0.167, -0.246);
    }
    this.mesh(this.head, new THREE.CylinderGeometry(0.28, 0.24, 0.12, 6), scarf, 0, -0.045, 0, 1, 1, 0.86);
    this.head.add(this.scarfTail);
    this.scarfTail.position.set(-0.15, -0.04, 0.16);
    this.mesh(this.scarfTail, new THREE.BoxGeometry(0.16, 0.49, 0.028), scarf, 0, -0.20, 0.03);
    this.mesh(this.scarfTail, new THREE.BoxGeometry(0.12, 0.045, 0.034), gold, 0, -0.39, 0.03);

    this.buildArm(this.leftArm, this.leftElbow, this.leftHand, -1, skin, leather);
    this.buildArm(this.rightArm, this.rightElbow, this.rightHand, 1, skin, leather);
    this.buildLeg(this.leftLeg, this.leftKnee, -1, leather);
    this.buildLeg(this.rightLeg, this.rightKnee, 1, leather);

    this.sword.name = 'Equipped blade';
    this.mesh(this.sword, new THREE.BoxGeometry(0.085, 0.24, 0.09), leather, 0, 0, 0);
    this.mesh(this.sword, new THREE.BoxGeometry(0.36, 0.055, 0.13), gold, 0, 0.14, 0);
    this.mesh(this.sword, new THREE.BoxGeometry(0.105, 0.64, 0.047), steel, 0, 0.49, 0);
    this.mesh(this.sword, new THREE.ConeGeometry(0.076, 0.22, 4), steel, 0, 0.92, 0).rotation.y = Math.PI / 4;
    this.mesh(this.sword, new THREE.OctahedronGeometry(0.065), gold, 0, -0.16, 0);
    this.torso.add(this.swordMount, this.bowMount);
    this.swordMount.position.set(0.20, 0.47, 0.30);
    this.swordMount.rotation.set(0, 0, -2.65);
    this.swordMount.add(this.sword);

    this.leftHand.add(this.shield);
    this.shield.position.set(-0.07, 0.14, -0.03);
    this.shield.rotation.y = Math.PI / 2;
    this.mesh(this.shield, new THREE.CylinderGeometry(0.30, 0.27, 0.09, 6), leather, 0, 0, 0, 1, 1, 1.15).rotation.x = Math.PI / 2;
    this.mesh(this.shield, new THREE.TorusGeometry(0.27, 0.018, 4, 6), gold, 0, 0, -0.06);
    this.mesh(this.shield, new THREE.OctahedronGeometry(0.11), steel, 0, 0, -0.07, 1, 1.2, 0.6);

    this.bow.name = 'Equipped bow';
    let prev = new THREE.Vector3(0, -0.52, 0);
    for (let i = 1; i <= 8; i++) {
      const t = i / 8;
      const next = new THREE.Vector3(-Math.sin(t * Math.PI) * 0.20, (t - 0.5) * 1.04, 0);
      this.bar(this.bow, prev, next, 0.028, leather);
      prev = next;
    }
    this.bar(this.bow, new THREE.Vector3(0, -0.52, 0), new THREE.Vector3(0, 0.52, 0), 0.008, hood);
    this.mesh(this.bow, new THREE.CylinderGeometry(0.042, 0.042, 0.16, 5), gold, -0.20, 0, 0);
    this.bowMount.position.set(-0.19, 0.22, 0.33);
    this.bowMount.rotation.z = -0.4;
    this.bowMount.add(this.bow);
    this.leftHand.add(this.arrow);
    this.mesh(this.arrow, new THREE.CylinderGeometry(0.01, 0.01, 0.72, 4), hood, 0, 0, -0.2).rotation.x = Math.PI / 2;
    this.mesh(this.arrow, new THREE.ConeGeometry(0.035, 0.09, 4), steel, 0, 0, -0.60).rotation.x = -Math.PI / 2;
    this.arrow.visible = false;

    this.torso.add(this.terminal);
    this.terminal.position.set(0.31, -0.04, -0.03);
    this.terminal.rotation.z = -0.12;
    this.mesh(this.terminal, new THREE.BoxGeometry(0.16, 0.25, 0.07), dark, 0, 0, 0);
    this.mesh(this.terminal, new THREE.BoxGeometry(0.11, 0.17, 0.013), this.glow, 0, 0.008, -0.044);
    this.mesh(this.terminal, new THREE.OctahedronGeometry(0.035), gold, 0, 0.008, -0.06, 1, 1, 0.25);
    this.buildGlider(gold, leather);
    this.root.userData.player = true;
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
  }

  private material(color: number, metalness = 0, emissive = 0): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.83, flatShading: true, emissive, emissiveIntensity: emissive ? 0.45 : 0 });
    this.materials.add(material);
    return material;
  }

  private mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): THREE.Mesh {
    this.geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.add(mesh);
    return mesh;
  }

  private bar(parent: THREE.Object3D, start: THREE.Vector3, end: THREE.Vector3, radius: number, material: THREE.MeshStandardMaterial): void {
    const delta = new THREE.Vector3().subVectors(end, start);
    const mesh = this.mesh(parent, new THREE.CylinderGeometry(radius, radius, delta.length(), 5), material);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  }

  private buildArm(arm: THREE.Group, elbow: THREE.Group, hand: THREE.Group, side: number, skin: THREE.MeshStandardMaterial, leather: THREE.MeshStandardMaterial): void {
    this.torso.add(arm);
    arm.position.set(side * 0.34, 0.45, 0);
    this.mesh(arm, new THREE.CylinderGeometry(0.105, 0.083, 0.29, 5), this.tunic, 0, -0.11, 0);
    arm.add(elbow);
    elbow.position.y = -0.28;
    this.mesh(elbow, new THREE.CylinderGeometry(0.075, 0.065, 0.25, 5), skin, 0, -0.115, 0);
    this.mesh(elbow, new THREE.CylinderGeometry(0.077, 0.077, 0.09, 5), leather, 0, -0.20, 0);
    elbow.add(hand);
    hand.position.y = -0.27;
    this.mesh(hand, new THREE.BoxGeometry(0.12, 0.13, 0.12), skin, 0, -0.015, 0);
  }

  private buildLeg(leg: THREE.Group, knee: THREE.Group, side: number, leather: THREE.MeshStandardMaterial): void {
    leg.position.set(side * 0.155, 0.79, 0);
    this.mesh(leg, new THREE.CylinderGeometry(0.115, 0.09, 0.34, 5), this.trousers, 0, -0.16, 0);
    leg.add(knee);
    knee.position.y = -0.34;
    this.mesh(knee, new THREE.CylinderGeometry(0.088, 0.074, 0.34, 5), this.trousers, 0, -0.16, 0);
    this.mesh(knee, new THREE.CylinderGeometry(0.095, 0.095, 0.21, 5), leather, 0, -0.25, 0);
    this.mesh(knee, new THREE.BoxGeometry(0.19, 0.13, 0.30), leather, 0, -0.385, -0.055);
  }

  private buildGlider(gold: THREE.MeshStandardMaterial, leather: THREE.MeshStandardMaterial): void {
    const fabric = this.material(0xdcaa65);
    const alternate = this.material(0x427b80);
    fabric.side = THREE.DoubleSide;
    alternate.side = THREE.DoubleSide;
    this.visual.add(this.glider);
    this.glider.position.set(0, 2.45, 0.04);
    this.glider.add(this.leftWing, this.rightWing);
    for (const side of [-1, 1]) {
      const wing = side < 0 ? this.leftWing : this.rightWing;
      const points = [new THREE.Vector3(0, 0.15, -0.60), new THREE.Vector3(side * 1.12, 0.06, -0.55), new THREE.Vector3(side * 2.18, -0.18, 0.02), new THREE.Vector3(side * 1.85, -0.30, 0.70), new THREE.Vector3(side * 0.75, -0.10, 0.60), new THREE.Vector3(0, 0.05, 0.34)];
      for (let i = 1; i < points.length - 1; i++) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([...points[0].toArray(), ...points[i].toArray(), ...points[i + 1].toArray()], 3));
        geometry.computeVertexNormals();
        this.mesh(wing, geometry, i % 2 === 0 ? alternate : fabric);
        this.bar(wing, points[0], points[i + 1], 0.022, gold);
      }
      this.bar(this.glider, new THREE.Vector3(side * 0.82, 0, -0.25), new THREE.Vector3(side * 0.43, -0.61, -0.13), 0.016, leather);
      this.bar(this.glider, new THREE.Vector3(side * 0.43, -0.61, -0.13), new THREE.Vector3(side * 0.43, -0.61, 0.12), 0.025, gold);
    }
    this.glider.visible = false;
  }

  update(dt: number, state: GameState, pose: PlayerPose): void {
    this.time += dt;
    const blend = 1 - Math.exp(-dt * 14);
    this.phase += dt * (pose.movement === 'climb' ? 6 : pose.movement === 'swim' ? 5 : Math.max(2, pose.speed * 1.75));
    const stride = Math.sin(this.phase);
    const strideOther = Math.sin(this.phase + Math.PI);
    const moving = Math.min(1, pose.speed / 4);
    let la = strideOther * 0.55 * moving;
    let ra = stride * 0.55 * moving;
    let laz = -0.07;
    let raz = 0.07;
    let le = -0.12;
    let re = -0.12;
    let ll = stride * 0.70 * moving;
    let rl = strideOther * 0.70 * moving;
    let lk = Math.max(0, strideOther) * 0.7 * moving;
    let rk = Math.max(0, stride) * 0.7 * moving;
    let lean = 0;
    let bodyY = Math.sin(this.time * 2.5) * 0.012 + Math.abs(stride) * 0.045 * moving;
    const movement = pose.movement;

    if (pose.crouched) {
      bodyY -= 0.60;
      lean = -0.22;
      ll = -1.22 + stride * moving * 0.25;
      rl = -1.22 - stride * moving * 0.25;
      lk = 2.44 - stride * moving * 0.3;
      rk = 2.44 + stride * moving * 0.3;
      la = -0.4;
      ra = -0.4;
    }
    if (movement === 'jump' || movement === 'fall') {
      ll = -0.48;
      rl = 0.18;
      lk = 0.72;
      rk = 0.4;
      la = -0.45;
      ra = -0.55;
      laz = -0.38;
      raz = 0.38;
      lean = THREE.MathUtils.clamp(-pose.verticalSpeed * 0.014, -0.12, 0.18);
    } else if (movement === 'climb') {
      la = -2.6 + stride * 0.35;
      ra = -2.6 - stride * 0.35;
      le = re = -0.28;
      ll = -0.55 - stride * 0.42;
      rl = -0.55 + stride * 0.42;
      lk = 1.0 + stride * 0.45;
      rk = 1.0 - stride * 0.45;
      lean = -0.07;
    } else if (movement === 'swim') {
      lean = -0.92;
      bodyY = 0.38 + Math.sin(this.time * 3) * 0.025;
      la = -1.0 + stride * 1.5;
      ra = -1.0 - stride * 1.5;
      laz = -0.5;
      raz = 0.5;
      ll = stride * 0.22;
      rl = -ll;
      lk = rk = 0.22;
    } else if (movement === 'glide') {
      la = ra = -2.75;
      laz = -0.35;
      raz = 0.35;
      le = re = -0.14;
      ll = 0.2 + stride * 0.05;
      rl = 0.3 - stride * 0.05;
      lk = rk = 0.48;
      lean = -0.08;
    }

    const canFight = movement !== 'swim' && movement !== 'climb' && movement !== 'glide' && movement !== 'dead';
    const bow = canFight && pose.bowDraw > 0;
    const attacking = canFight && pose.attacking;
    if (attacking && !this.wasAttacking) this.attackTime = 0;
    this.wasAttacking = attacking;
    this.attackTime += dt;
    let twist = 0;
    if (attacking) {
      const swing = Math.sin(Math.min(1, this.attackTime / 0.43) * Math.PI);
      ra = -1.8 + swing * 2.3;
      raz = -0.9 + swing * 1.4;
      re = -0.3;
      twist = -0.6 + swing * 1.1;
    } else if (bow) {
      la = -Math.PI / 2;
      laz = 0.03;
      le = -0.06;
      ra = -1.40;
      raz = 1.05;
      re = -1.6 * pose.bowDraw;
      twist = -0.3;
    } else if (canFight && pose.guarding) {
      la = -1.10;
      laz = 0.5;
      le = -1.0;
      ra = -0.25;
      re = -0.5;
    }
    if (pose.hurt) {
      lean += 0.17;
      twist += Math.sin(this.time * 35) * 0.05;
    }
    bodyY -= pose.landing * 0.19;
    lk += pose.landing * 0.5;
    rk += pose.landing * 0.5;
    this.deathAmount = THREE.MathUtils.damp(this.deathAmount, movement === 'dead' ? 1 : 0, 7, dt);
    this.visual.rotation.x = THREE.MathUtils.lerp(this.visual.rotation.x, lean, blend);
    this.visual.rotation.z = -this.deathAmount * 1.48;
    this.visual.position.y = THREE.MathUtils.lerp(this.visual.position.y, bodyY + this.deathAmount * 0.22, blend);
    this.torso.rotation.y = THREE.MathUtils.lerp(this.torso.rotation.y, twist, blend);
    this.rotate(this.leftArm, la, laz, blend);
    this.rotate(this.rightArm, ra, raz, blend);
    this.rotate(this.leftElbow, le, 0, blend);
    this.rotate(this.rightElbow, re, 0, blend);
    this.rotate(this.leftLeg, ll, 0, blend);
    this.rotate(this.rightLeg, rl, 0, blend);
    this.rotate(this.leftKnee, lk, 0, blend);
    this.rotate(this.rightKnee, rk, 0, blend);
    this.head.rotation.y = -twist * 0.35;
    this.scarfTail.rotation.x = -0.2 - Math.min(1.1, pose.speed * 0.08) + Math.sin(this.time * 7) * 0.15;
    this.scarfTail.rotation.z = Math.sin(this.time * 4) * 0.13;
    this.root.rotation.y = pose.yaw;
    this.wingAmount = THREE.MathUtils.damp(this.wingAmount, movement === 'glide' ? 1 : 0, 12, dt);
    this.glider.visible = this.wingAmount > 0.025;
    this.glider.scale.set(Math.max(0.01, this.wingAmount), Math.max(0.01, this.wingAmount), Math.max(0.01, this.wingAmount));
    this.leftWing.rotation.z = (1 - this.wingAmount) * 1.4 + Math.sin(this.time * 4) * 0.025;
    this.rightWing.rotation.z = -(1 - this.wingAmount) * 1.4 - Math.sin(this.time * 4) * 0.025;
    this.glider.rotation.z = -stride * 0.012;

    const inHand = canFight && !!state.equipment.weapon && (attacking || pose.guarding);
    if (this.weaponInHand !== inHand) {
      (inHand ? this.rightHand : this.swordMount).add(this.sword);
      this.sword.rotation.set(inHand ? -0.1 : 0, 0, 0);
      this.weaponInHand = inHand;
    }
    if (this.bowInHand !== bow) {
      (bow ? this.leftHand : this.bowMount).add(this.bow);
      this.bow.rotation.set(bow ? Math.PI / 2 : 0, bow ? Math.PI / 2 : 0, 0);
      this.bowInHand = bow;
    }
    this.sword.visible = !!state.equipment.weapon && !bow;
    this.shield.visible = !!state.equipment.shield && !bow && movement !== 'glide' && movement !== 'climb' && movement !== 'swim';
    this.bow.visible = !!state.equipment.bow;
    this.arrow.visible = bow && !!state.equipment.bow;
    this.terminal.visible = state.terminal;
    this.glow.emissiveIntensity = 0.38 + Math.sin(this.time * 2) * 0.13;
    this.tunic.color.setHex(state.equipment.clothes ? 0x365e68 : 0x837760);
    this.trousers.color.setHex(state.equipment.trousers ? 0x485453 : 0x716354);
    for (const material of this.materials) {
      if (material !== this.glow) {
        material.emissive.setHex(pose.hurt ? 0x802b23 : 0);
        material.emissiveIntensity = pose.hurt ? 0.65 : 0;
      }
    }
  }

  private rotate(group: THREE.Group, x: number, z: number, blend: number): void {
    group.rotation.x = THREE.MathUtils.lerp(group.rotation.x, x, blend);
    group.rotation.z = THREE.MathUtils.lerp(group.rotation.z, z, blend);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
  }
}
