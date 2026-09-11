import * as THREE from 'three';
import { ABILITIES, CONFIG } from '../config/game';
import type { AbilityId, AbilityTarget, Collider, GameContext, Vec3, WaterArea, WorldView } from '../core/types';
import { disposeResources, mechanism, trials, type TrialRuntime } from './mechanics';
export { buildTrial } from './Trial';

interface Body {
  half: THREE.Vector3;
  offset: THREE.Vector3;
  velocity: THREE.Vector3;
  original: THREE.Vector3;
  lastCharge: number;
  lastHit: number;
}
interface IceColumn {
  mesh: THREE.Mesh;
  collider: Collider;
  active: boolean;
  born: number;
  water: WaterArea | undefined;
}
const IDS: readonly AbilityId[] = ['magnet', 'bomb', 'stasis', 'ice'];
const Y = new THREE.Vector3(0, 1, 0);
const BLAST_RADIUS = 5.2;
const ICE_SIZE = 2.8;
const ICE_HEIGHT = 2.4;

/** Reusable abilities. Call after combat so externally applied stasis charge is observed first. */
export class AbilitySystem {
  public cooldown = 0;
  public selectedTarget: AbilityTarget | undefined;
  /** Return true when an eligible living enemy was frozen. The callback owns enemy selection and duration. */
  public freezeEnemy: ((position: THREE.Vector3, range: number, seconds: number) => boolean | void) | undefined;

  private readonly ctx: GameContext;
  private readonly hitArea: (position: THREE.Vector3, radius: number, damage: number, source?: AbilityTarget) => void;
  private readonly root = new THREE.Group();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly bodies = new Map<AbilityTarget, Body>();
  private readonly highlights: THREE.Mesh[] = [];
  private readonly ice: IceColumn[] = [];
  private readonly ray = new THREE.Ray();
  private readonly collisionRay = new THREE.Ray();
  private readonly aim = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly flat = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly d = new THREE.Vector3();
  private readonly next = new THREE.Vector3();
  private readonly old = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private readonly box = new THREE.Box3();
  private readonly box2 = new THREE.Box3();
  private readonly playerBox = new THREE.Box3();
  private readonly castPoint = new THREE.Vector3();
  private readonly previewPoint = new THREE.Vector3();
  private readonly bombVelocity = new THREE.Vector3();
  private readonly bombPosition = new THREE.Vector3();
  private readonly preview: THREE.Mesh;
  private readonly previewMaterial: THREE.MeshBasicMaterial;
  private readonly bombSphere: THREE.Mesh;
  private readonly bombCube: THREE.Mesh;
  private readonly bombRing: THREE.Mesh;
  private readonly bombRingMaterial: THREE.MeshBasicMaterial;
  private readonly heldBeam: THREE.Mesh;
  private readonly chargeArrow: THREE.Group;
  private readonly chargeMaterial: THREE.MeshBasicMaterial;
  private readonly selectedMaterial: THREE.MeshBasicMaterial;
  private readonly availableMaterial: THREE.MeshBasicMaterial;
  private readonly farMaterial: THREE.MeshBasicMaterial;
  private world: WorldView;
  private moon: number;
  private held: AbilityTarget | undefined;
  private heldDistance = 5;
  private bombShape: 'sphere' | 'cube' = 'sphere';
  private activeBomb = false;
  private placedShape: 'sphere' | 'cube' = 'sphere';
  private bombPipe = false;
  private bombPipeFinished = false;
  private bombAge = 0;
  private bombLaunchCharge = 0;
  private bombLaunched = false;
  private bombFlightAge = 0;
  private bombLaunchCue = false;
  private bombTimer = 0;
  private stasisTimer = 0;
  private iceTimer = 0;
  private feedbackTimer = 0;
  private hintTimer = 0;
  private hintKey = '';
  private hazardTimer = 0;
  private attackTimer = 0;
  private clock = 0;
  private iceSerial = 0;
  private previewWater: WaterArea | undefined;
  private previewOnFall = false;
  private previewLegal = false;
  private hoveredIce: IceColumn | undefined;
  private disposed = false;

  public constructor(ctx: GameContext, hitArea: (position: THREE.Vector3, radius: number, damage: number, source?: AbilityTarget) => void) {
    this.ctx = ctx;
    this.hitArea = hitArea;
    this.world = ctx.world;
    this.moon = ctx.state.bloodMoonCount;
    this.root.name = 'ability-effects';
    const geometry = <T extends THREE.BufferGeometry>(value: T): T => { this.geometries.add(value); return value; };
    const material = <T extends THREE.Material>(value: T): T => { this.materials.add(value); return value; };
    const box = geometry(new THREE.BoxGeometry(1, 1, 1));
    this.selectedMaterial = material(new THREE.MeshBasicMaterial({ color: 0xffe5f4, wireframe: true, transparent: true, opacity: 0.95, depthWrite: false }));
    this.availableMaterial = material(new THREE.MeshBasicMaterial({ color: 0xff69bc, wireframe: true, transparent: true, opacity: 0.65, depthWrite: false }));
    this.farMaterial = material(new THREE.MeshBasicMaterial({ color: 0x766c91, wireframe: true, transparent: true, opacity: 0.25, depthWrite: false }));
    for (let i = 0; i < 24; i++) {
      const outline = new THREE.Mesh(box, this.availableMaterial);
      outline.visible = false;
      outline.renderOrder = 4;
      this.highlights.push(outline);
      this.root.add(outline);
    }
    this.previewMaterial = material(new THREE.MeshBasicMaterial({ color: 0x73e4ff, transparent: true, opacity: 0.28, depthWrite: false }));
    this.preview = new THREE.Mesh(box, this.previewMaterial);
    this.preview.scale.set(ICE_SIZE, ICE_HEIGHT, ICE_SIZE);
    this.preview.visible = false;
    this.root.add(this.preview);
    const iceMaterial = material(new THREE.MeshStandardMaterial({ color: 0x8bd9ed, emissive: 0x205d91, emissiveIntensity: 0.6, transparent: true, opacity: 0.84, roughness: 0.18, metalness: 0.15, flatShading: true }));
    const iceEdge = material(new THREE.MeshBasicMaterial({ color: 0xc8f6ff, wireframe: true, transparent: true, opacity: 0.64 }));
    for (let i = 0; i < CONFIG.maxIce; i++) {
      const mesh = new THREE.Mesh(box, iceMaterial);
      mesh.scale.set(ICE_SIZE, ICE_HEIGHT, ICE_SIZE);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      const rim = new THREE.Mesh(box, iceEdge);
      rim.scale.setScalar(1.006);
      mesh.add(rim);
      this.root.add(mesh);
      this.ice.push({ mesh, collider: { id: `ability:ice:${i}`, box: new THREE.Box3(), climbable: true, enabled: false, mesh }, active: false, born: 0, water: undefined });
    }
    const bombMaterial = material(new THREE.MeshStandardMaterial({ color: 0x9dedff, emissive: 0x2289bc, emissiveIntensity: 1.7, roughness: 0.27, metalness: 0.45, flatShading: true }));
    this.bombSphere = new THREE.Mesh(geometry(new THREE.IcosahedronGeometry(0.38, 1)), bombMaterial);
    this.bombCube = new THREE.Mesh(box, bombMaterial);
    this.bombCube.scale.setScalar(0.73);
    this.bombSphere.visible = this.bombCube.visible = false;
    this.root.add(this.bombSphere, this.bombCube);
    this.bombRingMaterial = material(new THREE.MeshBasicMaterial({ color: 0xff706a, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
    this.bombRing = new THREE.Mesh(geometry(new THREE.RingGeometry(BLAST_RADIUS - 0.1, BLAST_RADIUS, 56)), this.bombRingMaterial);
    this.bombRing.rotation.x = -Math.PI / 2;
    this.bombRing.visible = false;
    this.root.add(this.bombRing);
    this.heldBeam = new THREE.Mesh(geometry(new THREE.CylinderGeometry(0.025, 0.05, 1, 6)), material(new THREE.MeshBasicMaterial({ color: 0xff87d0, transparent: true, opacity: 0.65, depthWrite: false })));
    this.heldBeam.visible = false;
    this.root.add(this.heldBeam);
    this.chargeArrow = new THREE.Group();
    this.chargeMaterial = material(new THREE.MeshBasicMaterial({ color: 0xffd86a }));
    const shaft = new THREE.Mesh(geometry(new THREE.CylinderGeometry(0.07, 0.07, 1, 6)), this.chargeMaterial);
    shaft.position.y = 0.5;
    this.chargeArrow.add(shaft);
    const cone = geometry(new THREE.ConeGeometry(0.24, 0.45, 5));
    for (let n = 0; n < 4; n++) {
      const tip = new THREE.Mesh(cone, this.chargeMaterial);
      tip.position.y = 1 + n * 0.36;
      this.chargeArrow.add(tip);
    }
    this.chargeArrow.visible = false;
    this.root.add(this.chargeArrow);
    ctx.scene.add(this.root);
  }

  public update(dt: number): void {
    if (this.disposed) return;
    if (this.ctx.world !== this.world || this.ctx.state.bloodMoonCount !== this.moon) this.reset();
    if (this.root.parent !== this.ctx.scene) this.ctx.scene.add(this.root);
    dt = Number.isFinite(dt) ? Math.min(CONFIG.maxDelta, Math.max(0, dt)) : 0;
    if (dt === 0) return;
    this.clock += dt;
    this.bombTimer = Math.max(0, this.bombTimer - dt);
    const previousStasisTimer = this.stasisTimer;
    this.stasisTimer = Math.max(0, this.stasisTimer - dt);
    if (previousStasisTimer > 0 && this.stasisTimer === 0) {
      this.ctx.sound('ability');
      this.ctx.notify('凝时已经恢复。', 'info');
    }
    this.iceTimer = Math.max(0, this.iceTimer - dt);
    this.feedbackTimer = Math.max(0, this.feedbackTimer - dt);
    this.hintTimer = Math.max(0, this.hintTimer - dt);
    this.hazardTimer = Math.max(0, this.hazardTimer - dt);
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.ctx.camera.getWorldDirection(this.aim).normalize();
    this.ctx.camera.getWorldPosition(this.ray.origin);
    this.ray.direction.copy(this.aim);
    this.eye.copy(this.ctx.actor.position).y += 1.25;
    this.flat.set(this.aim.x, 0, this.aim.z);
    if (this.flat.lengthSq() < 0.01) this.flat.copy(this.ctx.actor.facing).setY(0);
    if (this.flat.lengthSq() < 0.01) this.flat.set(0, 0, -1);
    this.flat.normalize();
    this.updatePlayerBox();
    this.restorePuzzleTargets();
    if (this.ctx.state.player.hp <= 0) {
      if (this.held) this.releaseHeld();
      this.preview.visible = this.heldBeam.visible = this.chargeArrow.visible = false;
      for (const outline of this.highlights) outline.visible = false;
      this.selectedTarget = undefined;
      return;
    }
    for (let i = 0; i < IDS.length; i++) {
      if (this.ctx.input.pressed(`Digit${i + 1}`)) this.select(IDS[i]!);
    }
    const selected = this.ctx.state.selectedAbility;
    const unlocked = this.ctx.state.abilities.includes(selected);
    if (this.held && (selected !== 'magnet' || this.ctx.input.pressed('KeyQ'))) this.releaseHeld();
    if (selected === 'bomb' && unlocked && this.ctx.input.pressed('KeyV')) {
      this.bombShape = this.bombShape === 'sphere' ? 'cube' : 'sphere';
      this.ctx.notify(`鸣爆 · ${this.bombShape === 'sphere' ? '球形：会滚动，可通过管道' : '方形：固定在落点'}${this.activeBomb ? '（下一颗生效）' : ''}`);
      this.ctx.sound('ability');
    }
    this.selectedTarget = unlocked ? this.selectTarget(selected) : undefined;
    if (this.held) this.moveHeld(dt);
    this.updateIcePreview(unlocked && selected === 'ice');
    if (unlocked && this.ctx.input.pressed('KeyF')) {
      if (selected === 'magnet') this.activateMagnet();
      else if (selected === 'bomb') this.activateBomb();
      else if (selected === 'stasis') this.activateStasis();
      else this.activateIce();
    }
    this.updateBodies(dt);
    this.updateBomb(dt);
    this.updatePuzzles();
    this.updateHighlights(unlocked ? selected : undefined);
    this.cooldown = selected === 'bomb' ? this.bombTimer : selected === 'stasis' ? this.stasisTimer : selected === 'ice' ? this.iceTimer : 0;
  }

  public select(id: AbilityId): void {
    if (!this.ctx.state.abilities.includes(id)) {
      this.say('先在对应遗迹的入口台座下载这项能力。');
      return;
    }
    if (this.ctx.state.selectedAbility === id) return;
    this.releaseHeld();
    this.ctx.state.selectedAbility = id;
    this.cooldown = id === 'bomb' ? this.bombTimer : id === 'stasis' ? this.stasisTimer : id === 'ice' ? this.iceTimer : 0;
    const ability = ABILITIES.find(a => a.id === id)!;
    this.ctx.sound('ability');
    this.ctx.notify(`${ability.name} · ${ability.description}`);
  }

  private say(text: string): void {
    if (this.feedbackTimer > 0) return;
    this.feedbackTimer = 1.1;
    this.ctx.notify(text, 'warning');
  }
  private restorePuzzleTargets(): void {
    const trial = trials.get(this.world);
    if (!trial) return;
    const stage = this.ctx.state.trialStages[trial.id];
    for (const target of this.world.targets) {
      if (target.stage === undefined || target.stage < stage || (target.kind !== 'cracked' && target.kind !== 'barrel')) continue;
      if (!target.solved || mechanism(target).brokenByAbility) continue;
      target.solved = false;
      target.mesh.visible = true;
      if (target.collider) target.collider.enabled = true;
    }
  }
  private damageArea(position: THREE.Vector3, radius: number, damage: number, source?: AbilityTarget): void {
    this.hitArea(position, radius, damage, source);
    // Combat owns enemy/prop damage, but only this system validates trial-specific solutions.
    this.restorePuzzleTargets();
  }
  private updatePlayerBox(): void {
    const p = this.ctx.actor.position;
    this.playerBox.min.set(p.x - CONFIG.playerRadius - 0.08, p.y + 0.045, p.z - CONFIG.playerRadius - 0.08);
    this.playerBox.max.set(p.x + CONFIG.playerRadius + 0.08, p.y + CONFIG.playerHeight, p.z + CONFIG.playerRadius + 0.08);
  }
  private body(target: AbilityTarget): Body {
    let body = this.bodies.get(target);
    if (body) return body;
    const half = new THREE.Vector3(0.65, 0.65, 0.65);
    const offset = new THREE.Vector3();
    if (target.collider) {
      target.collider.box.getSize(half).multiplyScalar(0.5);
      target.collider.box.getCenter(offset).sub(target.position);
    } else {
      this.box.setFromObject(target.mesh);
      if (!this.box.isEmpty()) {
        this.box.getSize(half).multiplyScalar(0.5);
        this.box.getCenter(offset).sub(target.position);
      }
    }
    body = { half, offset, velocity: target.velocity ?? new THREE.Vector3(), original: target.origin ? new THREE.Vector3(...target.origin) : target.position.clone(), lastCharge: target.charge ?? 0, lastHit: -10 };
    target.velocity = body.velocity;
    this.bodies.set(target, body);
    return body;
  }
  private targetAllowed(target: AbilityTarget): boolean {
    if (target.solved || !target.mesh.visible) return false;
    const trial = trials.get(this.world);
    return !trial || target.stage === undefined || target.stage <= this.ctx.state.trialStages[trial.id];
  }
  private selectTarget(id: AbilityId): AbilityTarget | undefined {
    if (id === 'bomb' || id === 'ice') return undefined;
    if (this.held && id === 'magnet') return this.held;
    let best: AbilityTarget | undefined;
    let bestScore = Infinity;
    const range = id === 'magnet' ? CONFIG.magnetRange : 19;
    for (const target of this.world.targets) {
      if (!this.targetAllowed(target)) continue;
      if (id === 'magnet' ? target.kind !== 'metal' : target.kind !== 'orb' && target.kind !== 'rotor' && target.kind !== 'metal') continue;
      this.a.copy(target.position).sub(this.eye);
      const distance = this.a.length();
      if (distance > range || distance < 0.1) continue;
      this.b.copy(this.a).setY(0).normalize();
      const forward = this.flat.dot(this.b);
      if (forward < 0.25 && distance > 2.5) continue;
      const body = this.body(target);
      this.box.min.copy(target.position).add(body.offset).sub(body.half).addScalar(-0.65);
      this.box.max.copy(target.position).add(body.offset).add(body.half).addScalar(0.65);
      const hit = this.ray.intersectBox(this.box, this.castPoint);
      const angular = this.a.dot(this.aim) / distance;
      if (!hit && angular < 0.45 && forward < 0.88) continue;
      if (!this.visibleTarget(target, distance)) continue;
      // A real ray hit takes precedence; otherwise a generous forward cone assists keyboard/mouse play.
      const score = hit ? this.ray.origin.distanceTo(this.castPoint) * 0.03 : 4 + (1 - forward) * 8 + distance * 0.06;
      if (score < bestScore) { best = target; bestScore = score; }
    }
    return best;
  }
  private visibleTarget(target: AbilityTarget, distance: number): boolean {
    this.c.copy(target.position).sub(this.eye).normalize();
    this.collisionRay.set(this.eye, this.c);
    for (const collider of this.world.colliders) {
      if (!collider.enabled || collider === target.collider || collider.box.containsPoint(this.eye)) continue;
      if (!this.collisionRay.intersectBox(collider.box, this.d)) continue;
      if (this.d.distanceTo(this.eye) < distance - Math.max(0.8, this.body(target).half.length() * 0.5)) return false;
    }
    return true;
  }
  private setPosition(target: AbilityTarget, position: THREE.Vector3): void {
    const body = this.body(target);
    this.delta.copy(position).sub(target.position);
    target.position.copy(position);
    if (target.mesh.position !== target.position) target.mesh.position.add(this.delta);
    if (target.collider) {
      target.collider.box.min.copy(position).add(body.offset).sub(body.half);
      target.collider.box.max.copy(position).add(body.offset).add(body.half);
    }
  }
  private floorFor(target: AbilityTarget, position: THREE.Vector3): number {
    const body = this.body(target);
    let floor = this.world.heightAt(position.x, position.z);
    if (target.resource === 'log') {
      for (let n = 0; n <= 4; n++) floor = Math.max(floor, this.world.heightAt(position.x + body.half.x * (n / 2 - 1), position.z));
    }
    return floor + body.half.y - body.offset.y;
  }
  private blocked(target: AbilityTarget, p: THREE.Vector3, protectPlayer = true): boolean {
    const body = this.body(target);
    this.box.min.copy(p).add(body.offset).sub(body.half).addScalar(0.035);
    this.box.max.copy(p).add(body.offset).add(body.half).addScalar(-0.035);
    if (protectPlayer && this.box.intersectsBox(this.playerBox)) return true;
    if (trials.has(this.world) && (Math.abs(p.x) + body.half.x > 12 || p.z - body.half.z < -67 || p.z + body.half.z > 13)) return true;
    for (const collider of this.world.colliders) {
      if (collider.enabled && collider !== target.collider && this.box.intersectsBox(collider.box)) return true;
    }
    return false;
  }
  /** Axis-separated substeps prevent a heavy body from tunnelling through a thin gate or the player. */
  private moveBody(target: AbilityTarget, movement: THREE.Vector3, protectPlayer = true): void {
    const body = this.body(target);
    const steps = Math.max(1, Math.ceil(movement.length() / 0.18));
    const dx = movement.x / steps;
    const dy = movement.y / steps;
    const dz = movement.z / steps;
    for (let n = 0; n < steps; n++) {
      this.next.copy(target.position);
      this.next.x += dx;
      if (!this.blocked(target, this.next, protectPlayer)) this.setPosition(target, this.next);
      else body.velocity.x *= -0.12;
      this.next.copy(target.position);
      this.next.z += dz;
      if (!this.blocked(target, this.next, protectPlayer)) this.setPosition(target, this.next);
      else body.velocity.z *= -0.12;
      this.next.copy(target.position);
      this.next.y += dy;
      const floor = this.floorFor(target, this.next);
      if (this.next.y < floor) { this.next.y = floor; body.velocity.y = 0; }
      if (!this.blocked(target, this.next, protectPlayer)) this.setPosition(target, this.next);
      else body.velocity.y = 0;
    }
  }
  private activateMagnet(): void {
    if (this.held) { this.releaseHeld(); return; }
    if (!this.selectedTarget) { this.say('瞄准前方发粉光的金属，再按 F。'); return; }
    this.held = this.selectedTarget;
    const pose = this.ctx.actor.model.userData;
    pose.magnetHeld = pose.holdingMetal = true;
    pose.magnetTarget = this.held.id;
    this.heldDistance = THREE.MathUtils.clamp(this.held.position.distanceTo(this.eye), 3, CONFIG.magnetRange - 2);
    this.body(this.held).velocity.set(0, 0, 0);
    this.ctx.sound('ability', this.held.position);
    this.ctx.notify('牵星连接 · 移动鼠标搬运，滚轮调距，F 放手，Q 取消。');
  }
  private releaseHeld(): void {
    if (!this.held) return;
    this.body(this.held).velocity.multiplyScalar(0.15);
    this.ctx.sound('ability', this.held.position);
    this.held = undefined;
    this.heldBeam.visible = false;
    const pose = this.ctx.actor.model.userData;
    pose.magnetHeld = pose.holdingMetal = false;
    pose.magnetTarget = undefined;
  }
  private moveHeld(dt: number): void {
    const target = this.held!;
    if (target.solved || !this.world.targets.includes(target)) { this.releaseHeld(); return; }
    const body = this.body(target);
    const wheel = this.ctx.input.wheel;
    if (wheel) this.heldDistance = THREE.MathUtils.clamp(this.heldDistance + THREE.MathUtils.clamp(wheel, -4, 4) * 0.6, 3, CONFIG.magnetRange - 1);
    this.a.copy(this.eye).addScaledVector(this.aim, this.heldDistance);
    // Anchored panels are constrained to lift/pull axes rather than clipping through their guides.
    const data = mechanism(target);
    if (data.role === 'panel') {
      this.a.x = body.original.x;
      this.a.z = body.original.z;
      this.a.y = Math.max(this.a.y, body.original.y + Math.max(0, this.aim.y + 0.05) * 10);
    }
    if (data.role === 'pullDoor') { this.a.x = body.original.x; this.a.y = body.original.y; }
    if (data.role === 'bridgeCube' && this.a.y < 2) {
      const guide = trials.get(this.world)?.bridgeSlots.find(slot => Math.hypot(this.a.x - slot.x, this.a.z - slot.z) < 0.7);
      // Small aiming assistance, still using collision-checked motion: exact tiling should not demand pixel-perfect aim.
      if (guide) { this.a.x = guide.x; this.a.z = guide.z; }
    }
    this.a.y = Math.max(this.a.y, this.world.heightAt(this.a.x, this.a.z) + body.half.y - body.offset.y);
    this.a.sub(target.position);
    const speed = 8 / Math.sqrt(data.weight ?? Math.max(1, body.half.length() * 0.6));
    this.a.clampLength(0, speed * dt);
    this.old.copy(target.position);
    this.moveBody(target, this.a);
    body.velocity.copy(target.position).sub(this.old).divideScalar(Math.max(dt, 0.001)).clampLength(0, speed);
    if (body.velocity.length() > 1.3) {
      this.tryMetalImpact(target, body);
      if (this.clock - body.lastHit > 0.45) {
        body.lastHit = this.clock;
        this.damageArea(target.position, Math.max(1, body.half.x + 0.65), Math.min(24, 5 + body.velocity.length() * (data.weight ?? 1.5)), target);
      }
    }
    this.b.copy(target.position).sub(this.eye);
    this.heldBeam.visible = true;
    this.heldBeam.position.copy(this.eye).addScaledVector(this.b, 0.5);
    this.heldBeam.scale.y = this.b.length();
    this.heldBeam.quaternion.setFromUnitVectors(Y, this.b.normalize());
  }
  private tryMetalImpact(target: AbilityTarget, body: Body): void {
    for (const other of this.world.targets) {
      if (other === target || other.solved || (other.kind !== 'barrel' && other.kind !== 'cracked')) continue;
      const distance = target.position.distanceTo(other.position);
      const reach = body.half.length() + this.body(other).half.length() * 0.55 + 0.45;
      if (distance > reach) continue;
      const data = mechanism(other);
      if (data.role === 'lantern') {
        const trial = trials.get(this.world);
        if (trial?.doorPulled) this.breakTarget(other, 0xff8573);
      } else if (!trials.has(this.world)) this.breakTarget(other, 0xffa977);
    }
  }

  private activateBomb(): void {
    if (this.activeBomb) { this.detonate(); return; }
    if (this.bombTimer > 0) { this.say(`鸣爆恢复中 · ${this.bombTimer.toFixed(1)} 秒`); return; }
    this.bombPosition.copy(this.ctx.actor.position).addScaledVector(this.flat, 2.1);
    this.bombPosition.y = this.world.heightAt(this.bombPosition.x, this.bombPosition.z) + 0.4;
    // Place on an accessible platform when looking over its top, rather than inside it.
    for (const collider of this.world.colliders) {
      if (!collider.enabled || this.bombPosition.x < collider.box.min.x - 0.35 || this.bombPosition.x > collider.box.max.x + 0.35 || this.bombPosition.z < collider.box.min.z - 0.35 || this.bombPosition.z > collider.box.max.z + 0.35) continue;
      if (collider.box.max.y <= this.ctx.actor.position.y + CONFIG.stepHeight + 0.6) this.bombPosition.y = Math.max(this.bombPosition.y, collider.box.max.y + 0.4);
    }
    this.box.min.copy(this.bombPosition).addScalar(-0.36);
    this.box.max.copy(this.bombPosition).addScalar(0.36);
    if (this.world.colliders.some(collider => collider.enabled && this.box.intersectsBox(collider.box))) {
      this.say('落点被挡住了。稍微后退或移向空地再放置。'); return;
    }
    this.activeBomb = true;
    this.placedShape = this.bombShape;
    this.bombAge = this.bombLaunchCharge = this.bombFlightAge = 0;
    this.bombPipe = this.bombPipeFinished = this.bombLaunched = this.bombLaunchCue = false;
    this.bombVelocity.copy(this.flat).multiplyScalar(this.placedShape === 'sphere' ? 1.8 : 0);
    this.bombSphere.visible = this.placedShape === 'sphere';
    this.bombCube.visible = this.placedShape === 'cube';
    this.bombRing.visible = true;
    this.ctx.sound('ability', this.bombPosition);
    this.ctx.notify(`${this.placedShape === 'sphere' ? '球形' : '方形'}鸣爆已放置 · 退到红圈外，再 F 引爆。`, 'warning');
  }
  private updateCatapult(trial: TrialRuntime, dt: number): void {
    if (this.bombLaunched) {
      this.bombFlightAge += dt;
      if (trial.launcherArm) trial.launcherArm.rotation.x = -0.95 * Math.max(0, 1 - this.bombFlightAge / 0.5);
      if (!this.bombLaunchCue && this.bombFlightAge >= 0.22) {
        this.bombLaunchCue = true;
        this.ctx.notify('炸弹已飞起 · 靠近石球、同高时按 F 遥爆！', 'success');
      }
      return;
    }
    const onPad = Math.hypot(this.bombPosition.x - trial.launcher.x, this.bombPosition.z - trial.launcher.z) < 1.35
      && this.bombPosition.y >= 0.35 && this.bombPosition.y < 0.85;
    if (!onPad) { this.bombLaunchCharge = 0; return; }
    if (this.bombLaunchCharge === 0) {
      this.ctx.notify('弹射台已装填 · 半秒后抛射！准备 F 遥爆，避开红圈。');
      this.ctx.sound('ability', this.bombPosition);
    }
    // The cradle holds either shape in place, then supplies velocity, never a position jump.
    this.bombVelocity.set(0, 0, 0);
    this.bombLaunchCharge += dt;
    const vx = -this.bombPosition.x / 0.65;
    const vz = -2.8;
    const vy = 7.6;
    if (trial.launcherMarker) {
      const flight = (vy + Math.sqrt(vy * vy + 2 * CONFIG.gravity * (this.bombPosition.y - 0.39))) / CONFIG.gravity;
      trial.launcherMarker.position.set(this.bombPosition.x + vx * flight, 0.045, this.bombPosition.z + vz * flight);
    }
    if (this.bombLaunchCharge < 0.5) return;
    this.bombLaunched = true;
    this.bombFlightAge = 0;
    this.bombVelocity.set(vx, vy, vz);
    if (trial.launcherArm) trial.launcherArm.rotation.x = -0.95;
    this.ctx.effects.burst(this.bombPosition, 0x8ceaff, 10);
    this.ctx.sound('ability', this.bombPosition);
    this.ctx.notify('抛射！看准空中炸弹与石球之间的距离。');
  }
  private updateBomb(dt: number): void {
    if (!this.activeBomb) return;
    this.bombAge += dt;
    const trial = trials.get(this.world);
    if (trial?.id === 'bomb' && this.ctx.state.trialStages.bomb === 2) this.updateCatapult(trial, dt);
    if (trial?.id === 'bomb' && this.ctx.state.trialStages.bomb === 1 && this.placedShape === 'sphere') {
      if (!this.bombPipe && this.bombPosition.distanceTo(trial.pipeEntry) < 1.75) {
        this.bombPipe = true;
        this.bombVelocity.set(0, 0, 0);
        this.ctx.notify('球形炸弹正在管道中滚动……等它抵达末端。');
      }
      if (this.bombPipe) {
        this.a.copy(this.bombPipeFinished ? trial.pipeEnd : trial.pipeEntry);
        this.bombPosition.x = THREE.MathUtils.damp(this.bombPosition.x, trial.pipeEntry.x, 12, dt);
        this.bombPosition.y = 0.43;
        this.bombPosition.z = Math.max(trial.pipeEnd.z + 0.7, this.bombPosition.z - dt * 2.9);
        if (!this.bombPipeFinished && this.bombPosition.z <= trial.pipeEnd.z + 0.75) {
          this.bombPipeFinished = true;
          this.ctx.notify('管末共鸣灯亮起 · 现在按 F 引爆！', 'success');
          this.ctx.sound('ability', this.bombPosition);
        }
      }
    }
    if (!this.bombPipe) {
      if (this.placedShape === 'sphere' || this.bombLaunched) {
        const floor = this.world.heightAt(this.bombPosition.x, this.bombPosition.z);
        // Only grounded spheres roll downhill; launched bombs of either shape follow gravity.
        if (this.placedShape === 'sphere' && this.bombPosition.y <= floor + 0.42) {
          this.bombVelocity.x += (this.world.heightAt(this.bombPosition.x - 0.3, this.bombPosition.z) - this.world.heightAt(this.bombPosition.x + 0.3, this.bombPosition.z)) * dt * 4;
          this.bombVelocity.z += (this.world.heightAt(this.bombPosition.x, this.bombPosition.z - 0.3) - this.world.heightAt(this.bombPosition.x, this.bombPosition.z + 0.3)) * dt * 4;
        }
        this.bombVelocity.y -= CONFIG.gravity * dt;
        this.bombVelocity.clampLength(0, 10);
        const steps = Math.max(1, Math.ceil(this.bombVelocity.length() * dt / 0.18));
        for (let n = 0; n < steps; n++) {
          this.next.copy(this.bombPosition).addScaledVector(this.bombVelocity, dt / steps);
          this.box.min.copy(this.next).addScalar(-0.35);
          this.box.max.copy(this.next).addScalar(0.35);
          let collision: Collider | undefined;
          for (const collider of this.world.colliders) if (collider.enabled && this.box.intersectsBox(collider.box)) { collision = collider; break; }
          if (!collision) this.bombPosition.copy(this.next);
          else if (collision.box.max.y < this.bombPosition.y + 0.1) {
            this.bombPosition.y = collision.box.max.y + 0.38;
            this.bombPosition.x = this.next.x;
            this.bombPosition.z = this.next.z;
            this.bombVelocity.y = this.placedShape === 'sphere' && Math.abs(this.bombVelocity.y) > 2 ? Math.abs(this.bombVelocity.y) * 0.25 : 0;
            if (this.placedShape === 'cube') this.bombVelocity.set(0, 0, 0);
          } else {
            this.bombVelocity.x *= -0.35;
            this.bombVelocity.z *= -0.35;
          }
        }
        if (this.bombPosition.y <= floor + 0.39) {
          this.bombPosition.y = floor + 0.39;
          this.bombVelocity.y = Math.max(0, this.bombVelocity.y);
          const friction = this.placedShape === 'cube' ? 0 : Math.exp(-dt * 0.8);
          this.bombVelocity.x *= friction;
          this.bombVelocity.z *= friction;
        }
        if (this.placedShape === 'sphere') {
          this.bombSphere.rotation.x += this.bombVelocity.z * dt / 0.38;
          this.bombSphere.rotation.z -= this.bombVelocity.x * dt / 0.38;
        }
      }
    }
    this.bombSphere.position.copy(this.bombPosition);
    this.bombCube.position.copy(this.bombPosition);
    this.bombRing.position.copy(this.bombPosition);
    this.bombRing.position.y = Math.max(this.world.heightAt(this.bombPosition.x, this.bombPosition.z) + 0.04, this.bombPosition.y - 0.35);
    this.bombRingMaterial.opacity = 0.35 + Math.sin(this.bombAge * 5) * 0.14;
    if (!Number.isFinite(this.bombPosition.y) || this.bombPosition.y < -90) {
      this.clearBomb();
      this.ctx.notify('炸弹失去信号，已安全解除。');
    }
  }
  private detonate(): void {
    this.activeBomb = false;
    this.bombTimer = CONFIG.bombCooldown;
    this.ctx.effects.burst(this.bombPosition, 0x7cddff, 36);
    this.ctx.effects.ring(this.bombPosition, 0xffb47a, BLAST_RADIUS);
    this.ctx.effects.shake(0.35);
    this.ctx.sound('explosion', this.bombPosition);
    this.damageArea(this.bombPosition, BLAST_RADIUS, 28);
    if (this.ctx.actor.position.distanceTo(this.bombPosition) < BLAST_RADIUS) {
      this.ctx.damage(4, '鸣爆冲击');
      this.a.copy(this.ctx.actor.position).sub(this.bombPosition).setY(0).normalize();
      this.ctx.actor.velocity.addScaledVector(this.a, 4);
      this.ctx.actor.velocity.y = Math.max(this.ctx.actor.velocity.y, 3);
    }
    const trial = trials.get(this.world);
    let launchedImpulse = false;
    for (const target of this.world.targets) {
      if (target.solved || !target.mesh.visible) continue;
      const distance = target.position.distanceTo(this.bombPosition);
      if (distance > BLAST_RADIUS + 0.2) continue;
      const data = mechanism(target);
      if (target.kind === 'cracked' || target.kind === 'barrel') {
        if (!trial) this.breakTarget(target, 0xffb273);
        else if (trial.id === 'bomb' && data.role === 'crack' && this.ctx.state.trialStages.bomb === 0) {
          this.breakTarget(target, 0xffb273); this.solve(trial, 0);
        } else if (trial.id === 'bomb' && data.role === 'pipeReceiver' && this.ctx.state.trialStages.bomb === 1 && this.placedShape === 'sphere' && this.bombPipeFinished) {
          this.breakTarget(target, 0xffb273); this.solve(trial, 1);
        }
      }
      if (target.kind === 'orb' || target.kind === 'metal') {
        const body = this.body(target);
        this.a.copy(target.position).sub(this.bombPosition).normalize();
        if (data.role === 'launchOrb' && trial?.id === 'bomb') {
          // A pad-level explosion is not a launch. Require a real flight and a near-side, ball-height blast.
          if (this.ctx.state.trialStages.bomb !== 2 || !this.bombLaunched || this.bombFlightAge < 0.18
            || distance > 3.2 || this.bombPosition.y < 0.65 || this.bombPosition.y > target.position.y + 1.8
            || this.bombPosition.z >= trial.launcher.z - 0.6 || this.bombPosition.z <= target.position.z + 0.4) continue;
          data.releasedCharge = 2;
          data.launchedBlast = launchedImpulse = true;
          this.ctx.notify('空中爆风推动石球！等它实际撞上裂墙。');
        }
        if ((target.frozen ?? 0) > 0) {
          target.charge = Math.min(6, (target.charge ?? 0) + 2);
          data.impulse ??= new THREE.Vector3();
          data.impulse.addScaledVector(this.a, 9);
        } else body.velocity.addScaledVector(this.a, Math.max(6, 15 - distance));
      }
    }
    if (trial?.id === 'bomb' && this.ctx.state.trialStages.bomb === 2 && !launchedImpulse) {
      this.ctx.notify('未形成有效空中冲击 · 冷却后重新放弹，飞近石球、与球同高时再引爆。', 'warning');
    }
    this.clearBomb();
  }
  private clearBomb(): void {
    this.activeBomb = this.bombPipe = this.bombPipeFinished = this.bombLaunched = this.bombLaunchCue = false;
    this.bombLaunchCharge = this.bombFlightAge = 0;
    this.bombSphere.visible = this.bombCube.visible = this.bombRing.visible = false;
    this.bombVelocity.set(0, 0, 0);
    const arm = trials.get(this.world)?.launcherArm;
    if (arm) arm.rotation.x = 0;
  }

  private activateStasis(): void {
    const target = this.selectedTarget;
    if (target && (target.frozen ?? 0) > 0) {
      this.releaseStasis(target);
      return;
    }
    if (this.stasisTimer > 0) { this.say(`凝时恢复中 · ${this.stasisTimer.toFixed(1)} 秒`); return; }
    if (!target) {
      this.a.copy(this.eye).addScaledVector(this.flat, 7);
      if (this.freezeEnemy?.(this.a, 9, 2)) {
        this.stasisTimer = CONFIG.stasisCooldown + 2;
        this.ctx.effects.ring(this.a, 0xffd879, 2);
        this.ctx.sound('ability', this.a);
        this.ctx.notify('敌人的时间凝住了 · 2 秒');
      } else this.say('瞄准金色转台、石球或附近敌人，再按 F。');
      return;
    }
    target.frozen = 6;
    target.charge = 0;
    const body = this.body(target);
    body.lastCharge = 0;
    const data = mechanism(target);
    data.impulse ??= new THREE.Vector3();
    data.impulse.set(0, 0, 0);
    data.releasedCharge = 0;
    data.frozenFromZ = this.ctx.actor.position.z;
    this.stasisTimer = CONFIG.stasisCooldown + 6;
    this.ctx.effects.ring(target.position, 0xffdc76, body.half.length() + 0.5);
    this.ctx.sound('ability', target.position);
    this.ctx.notify('凝时 · 6 秒。左键击打冻结物蓄力；再按 F 可提前释放。');
  }
  private releaseStasis(target: AbilityTarget): void {
    const data = mechanism(target);
    const body = this.body(target);
    const observed = target.charge ?? 0;
    const charge = Math.min(6, observed > body.lastCharge ? body.lastCharge + 1 : observed);
    target.frozen = 0;
    data.releasedCharge = charge;
    if (charge > 0) {
      if (!data.impulse || data.impulse.lengthSq() < 0.01) {
        data.impulse ??= new THREE.Vector3();
        data.impulse.copy(this.flat);
      }
      body.velocity.copy(data.impulse).normalize().multiplyScalar(4 + charge * 4);
      body.velocity.y = Math.max(body.velocity.y, 1.5);
      if (data.role === 'chargeOrb') {
        // The etched runway guides the release; hitting from the far side still needs real charge.
        body.velocity.set(0, 1.2, -(4 + charge * 4));
      }
      this.ctx.effects.burst(target.position, 0xffc759, 12 + charge * 2);
      this.ctx.notify(`凝时释放 · ${charge} 段冲量`);
    }
    target.charge = 0;
    body.lastCharge = 0;
    this.stasisTimer = CONFIG.stasisCooldown;
    this.ctx.sound('ability', target.position);
  }
  private updateBodies(dt: number): void {
    this.chargeArrow.visible = false;
    let nearestFrozen: AbilityTarget | undefined;
    let nearestDistance = Infinity;
    for (const target of this.world.targets) {
      if (target.solved || !target.mesh.visible || (target.attached && (target.frozen ?? 0) <= 0)) continue;
      const data = mechanism(target);
      const body = this.body(target);
      if ((target.frozen ?? 0) > 0) {
        const externallyCharged = (target.charge ?? 0) > body.lastCharge;
        // Combat supplies damage-weighted charge. Count distinct impacts, not weapon damage,
        // so a single powerful blow cannot satisfy the two-hit tutorial.
        if (externallyCharged) target.charge = Math.min(6, body.lastCharge + 1);
        const distance = target.position.distanceTo(this.eye);
        this.a.copy(target.position).sub(this.eye).setY(0).normalize();
        const standaloneCombat = !('attackProgress' in this.ctx.actor.model.userData);
        if (standaloneCombat && !externallyCharged && this.attackTimer <= 0 && this.ctx.input.pressed('Mouse0') && distance < 3.4 && this.flat.dot(this.a) > 0.15) {
          target.charge = Math.min(6, (target.charge ?? 0) + 1);
          this.attackTimer = 0.34;
        }
        if ((target.charge ?? 0) > body.lastCharge) {
          data.impulse ??= new THREE.Vector3();
          data.impulse.add(this.flat);
          this.ctx.effects.burst(target.position, 0xffd975, 7);
          this.ctx.sound('hit', target.position);
          this.ctx.notify(`凝时蓄力 ${target.charge}/6${(target.charge ?? 0) >= 2 ? ' · 可释放' : ' · 再击打一次'}`);
        }
        body.lastCharge = target.charge ?? 0;
        target.frozen = Math.max(0, (target.frozen ?? 0) - dt);
        if (target.frozen === 0) this.releaseStasis(target);
        else if (distance < nearestDistance) { nearestFrozen = target; nearestDistance = distance; }
        continue;
      }
      if (target === this.held || target.attached) continue;
      if (target.resource) {
        this.updateResource(target, body, dt);
        continue;
      }
      if (data.role === 'rotor') {
        target.mesh.rotation.y += dt * 1.6;
        continue;
      }
      if (data.role === 'roller' && (data.releasedCharge ?? 0) === 0) {
        this.next.copy(body.original);
        this.next.x = Math.sin(this.clock * 1.1) * 7;
        this.setPosition(target, this.next);
        target.mesh.rotation.z -= dt * 4;
        continue;
      }
      if (data.anchored || target.kind === 'rotor' || target.kind === 'water' || target.kind === 'gate' || target.kind === 'cracked' || target.kind === 'barrel') continue;
      if (body.velocity.lengthSq() < 0.002 && target.position.y <= this.world.heightAt(target.position.x, target.position.z) + body.half.y - body.offset.y + 0.06) continue;
      body.velocity.y -= CONFIG.gravity * dt;
      body.velocity.clampLength(0, 24);
      this.a.copy(body.velocity).multiplyScalar(dt);
      this.old.copy(target.position);
      const speed = body.velocity.length();
      // Swept proximity triggers the remote seal before solid-body collision arrests the orb.
      if ((data.role === 'launchOrb' || data.role === 'chargeOrb') && (data.releasedCharge ?? 0) >= 2) this.orbImpact(target, this.a);
      this.moveBody(target, this.a);
      const ground = this.world.heightAt(target.position.x, target.position.z) + body.half.y - body.offset.y;
      const damping = Math.exp(-dt * (target.position.y <= ground + 0.1 ? 1.25 : 0.22));
      body.velocity.x *= damping;
      body.velocity.z *= damping;
      if (speed > 3) {
        this.tryMetalImpact(target, body);
        if (this.clock - body.lastHit > 0.55) {
          body.lastHit = this.clock;
          this.damageArea(target.position, Math.max(0.9, body.half.x + 0.5), Math.min(25, speed * 2), target);
          if (target.position.distanceTo(this.eye) < body.half.length() + 0.6) this.ctx.damage(Math.min(8, speed), '机关碰撞');
        }
      }
      if (target.kind === 'orb') target.mesh.rotation.x += (target.position.z - this.old.z) / Math.max(0.5, body.half.y);
      if (target.position.y < -30 || (trials.has(this.world) && (Math.abs(target.position.x) > 11 || target.position.z < -65 || target.position.z > 12))) {
        this.setPosition(target, body.original);
        body.velocity.set(0, 0, 0);
        data.releasedCharge = 0;
        data.launchedBlast = false;
      }
      if ((data.role === 'chargeOrb' || data.role === 'launchOrb') && body.velocity.lengthSq() < 0.12 && target.position.distanceTo(body.original) > (data.role === 'launchOrb' ? 0.1 : 1) && !target.solved) {
        // A weak/blocked attempt returns to its marked cradle, never permanently losing the puzzle object.
        this.setPosition(target, body.original);
        body.velocity.set(0, 0, 0);
        data.releasedCharge = 0;
        data.launchedBlast = false;
        if (data.role === 'launchOrb' && this.ctx.state.trialStages.bomb === 2) this.ctx.notify('石球已回到起点 · 可以重新弹射。');
      }
    }
    if (nearestFrozen) {
      const data = mechanism(nearestFrozen);
      const charge = nearestFrozen.charge ?? 0;
      this.chargeArrow.visible = true;
      this.chargeArrow.position.copy(nearestFrozen.position).y += this.body(nearestFrozen).half.y + 0.45;
      this.a.copy(data.impulse ?? this.flat).setY(0);
      if (this.a.lengthSq() < 0.001) this.a.copy(this.flat);
      this.chargeArrow.quaternion.setFromUnitVectors(Y, this.a.normalize());
      this.chargeArrow.scale.setScalar(0.65 + charge * 0.1);
      this.chargeMaterial.color.setHex(charge >= 2 ? 0xff8859 : 0xffde79);
      for (let n = 1; n < this.chargeArrow.children.length; n++) this.chargeArrow.children[n]!.visible = n <= Math.max(1, charge);
    }
  }
  private updateResource(target: AbilityTarget, body: Body, dt: number): void {
    const p = target.position;
    const floor = this.floorFor(target, p);
    const water = this.world.waters.find(area => this.inWater(p, area) && area.level > floor - body.half.y + 0.15 && p.y < area.level + body.half.y + 0.3);
    const grounded = p.y <= floor + 0.08;
    if (water) {
      const surface = water.level + body.half.y * 0.35 - body.offset.y;
      body.velocity.y += THREE.MathUtils.clamp((surface - p.y) * 24 - body.velocity.y * 6, -CONFIG.gravity, CONFIG.gravity) * dt;
      body.velocity.x = THREE.MathUtils.damp(body.velocity.x, water.current?.[0] ?? 0, 1.8, dt);
      body.velocity.z = THREE.MathUtils.damp(body.velocity.z, water.current?.[2] ?? 0, 1.8, dt);
    } else {
      body.velocity.y -= CONFIG.gravity * dt;
      if (grounded) {
        const slopeX = (this.world.heightAt(p.x - 0.3, p.z) - this.world.heightAt(p.x + 0.3, p.z)) / 0.6;
        const slopeZ = (this.world.heightAt(p.x, p.z - 0.3) - this.world.heightAt(p.x, p.z + 0.3)) / 0.6;
        if (Math.hypot(slopeX, slopeZ) > 0.08) {
          body.velocity.x += THREE.MathUtils.clamp(slopeX, -1, 1) * 8 * dt;
          body.velocity.z += THREE.MathUtils.clamp(slopeZ, -1, 1) * 8 * dt;
        }
        const friction = Math.exp(-dt * 1.7);
        body.velocity.x *= friction;
        body.velocity.z *= friction;
      }
    }
    body.velocity.clampLength(0, 18);
    const impactSpeed = body.velocity.length();
    this.old.copy(p);
    this.a.copy(body.velocity).multiplyScalar(dt);
    this.moveBody(target, this.a, target.resource === 'log');
    if (target.resource === 'log' && impactSpeed > 3 && this.clock - body.lastHit > 0.55) {
      body.lastHit = this.clock;
      // Include the log ends, but cap the area so a long trunk never becomes a room-wide blast.
      const reach = THREE.MathUtils.clamp(Math.hypot(body.half.x, body.half.z) + 0.35, 0.9, 3.2);
      this.damageArea(p, reach, Math.min(24, impactSpeed * 1.8), target);
    }
    const travelX = p.x - this.old.x, travelZ = p.z - this.old.z;
    target.mesh.rotation.x += travelZ / Math.max(0.15, body.half.y);
    if (target.resource === 'apple') target.mesh.rotation.z -= travelX / Math.max(0.15, body.half.y);
    if (p.y < -30 || Math.hypot(p.x, p.z) > CONFIG.radius + 12) {
      this.next.copy(body.original);
      this.next.y = this.floorFor(target, this.next);
      this.setPosition(target, this.next);
      body.velocity.set(0, 0, 0);
    }
  }
  private orbImpact(target: AbilityTarget, movement: THREE.Vector3): void {
    const trial = trials.get(this.world);
    if (!trial || this.ctx.state.trialStages[trial.id] !== 2) return;
    const data = mechanism(target);
    if (data.role === 'launchOrb' && (!data.launchedBlast || this.body(target).velocity.length() < 3)) return;
    for (const wall of this.world.targets) {
      if (mechanism(wall).role !== 'remoteWall' || wall.solved) continue;
      const body = this.body(target);
      this.box2.copy(wall.collider!.box).expandByVector(body.half);
      this.collisionRay.set(target.position, this.c.copy(movement).normalize());
      if (this.box2.containsPoint(target.position) || (this.collisionRay.intersectBox(this.box2, this.d) && this.d.distanceTo(target.position) <= movement.length() + 0.2)) {
        this.breakTarget(wall, 0xffd47a);
        this.solve(trial, 2);
      }
    }
  }

  private updateIcePreview(enabled: boolean): void {
    this.preview.visible = enabled;
    this.previewLegal = false;
    this.previewWater = undefined;
    this.previewOnFall = false;
    this.hoveredIce = undefined;
    if (!enabled) return;
    let nearest = Infinity;
    for (const column of this.ice) {
      if (!column.active || column.mesh.position.distanceTo(this.eye) > CONFIG.iceRange) continue;
      if (this.ray.intersectBox(column.collider.box, this.castPoint)) {
        const distance = this.ray.origin.distanceTo(this.castPoint);
        if (distance < nearest) { nearest = distance; this.hoveredIce = column; }
      }
    }
    if (this.hoveredIce) {
      this.preview.position.copy(this.hoveredIce.mesh.position);
      this.preview.scale.set(ICE_SIZE + 0.08, ICE_HEIGHT + 0.08, ICE_SIZE + 0.08);
      this.previewMaterial.color.setHex(0xffc073);
      return;
    }
    this.preview.scale.set(ICE_SIZE, ICE_HEIGHT, ICE_SIZE);
    // First use the actual camera ray. If it misses, use an eye ray for generous third-person aiming.
    let distance = Infinity;
    for (const water of this.world.waters) {
      if (this.aim.y >= -0.015) continue;
      const t = (water.level - this.ray.origin.y) / this.aim.y;
      if (t < 0) continue;
      this.ray.at(t, this.a);
      if (this.a.distanceTo(this.ctx.actor.position) > CONFIG.iceRange || !this.inWater(this.a, water, ICE_SIZE / 2 + 0.04)) continue;
      if (t < distance) { distance = t; this.previewPoint.copy(this.a); this.previewWater = water; }
    }
    for (const fall of this.world.waterfalls ?? []) {
      const axis = fall.axis;
      const plane = axis === 'x' ? (fall.minX + fall.maxX) / 2 : (fall.minZ + fall.maxZ) / 2;
      if (Math.abs(this.aim[axis]) < 0.01) continue;
      const t = (plane - this.ray.origin[axis]) / this.aim[axis];
      if (t <= 0 || t >= distance) continue;
      this.ray.at(t, this.a);
      if (this.a.distanceTo(this.eye) > CONFIG.iceRange || this.a.y < fall.minY + ICE_HEIGHT / 2 || this.a.y > fall.maxY - 0.1) continue;
      const lateral = axis === 'x' ? this.a.z : this.a.x;
      const min = axis === 'x' ? fall.minZ : fall.minX;
      const max = axis === 'x' ? fall.maxZ : fall.maxX;
      if (lateral < min + ICE_SIZE / 2 || lateral > max - ICE_SIZE / 2) continue;
      distance = t;
      this.previewPoint.copy(this.a);
      this.previewPoint[axis] = plane + Math.sign(this.ray.origin[axis] - plane) * (ICE_SIZE / 2 + 0.08);
      this.previewPoint.y -= ICE_HEIGHT / 2;
      this.previewWater = this.world.waters.find(water => this.inWater(this.previewPoint, water));
      this.previewOnFall = true;
    }
    if (!this.previewWater && !this.previewOnFall) {
      const ground = this.world.heightAt(this.eye.x + this.flat.x * 6, this.eye.z + this.flat.z * 6);
      const ahead = THREE.MathUtils.clamp((this.eye.y - ground) / Math.max(0.13, -this.aim.y), 2.6, CONFIG.iceRange - 1);
      this.previewPoint.copy(this.ctx.actor.position).addScaledVector(this.flat, ahead);
      this.previewPoint.y = this.world.heightAt(this.previewPoint.x, this.previewPoint.z);
      for (const water of this.world.waters) if (this.inWater(this.previewPoint, water, ICE_SIZE / 2 + 0.04)) { this.previewWater = water; this.previewPoint.y = water.level; break; }
    }
    this.preview.position.copy(this.previewPoint).y += ICE_HEIGHT / 2;
    if (this.previewWater || this.previewOnFall) {
      this.box.min.set(this.previewPoint.x - ICE_SIZE / 2 + 0.035, this.previewPoint.y + 0.04, this.previewPoint.z - ICE_SIZE / 2 + 0.035);
      this.box.max.set(this.previewPoint.x + ICE_SIZE / 2 - 0.035, this.previewPoint.y + ICE_HEIGHT, this.previewPoint.z + ICE_SIZE / 2 - 0.035);
      this.previewLegal = true;
      if (this.previewOnFall) {
        for (const x of [this.box.min.x, this.box.max.x]) for (const z of [this.box.min.z, this.box.max.z]) {
          if (this.world.heightAt(x, z) > this.previewPoint.y + 0.1) this.previewLegal = false;
        }
      }
      for (const collider of this.world.colliders) {
        if (!collider.enabled || !this.box.intersectsBox(collider.box)) continue;
        const target = this.world.targets.find(value => value.collider === collider);
        if (target && (target.kind === 'gate' || mechanism(target).role === 'iceGate')) continue;
        this.previewLegal = false;
        break;
      }
      if (this.previewLegal) {
        this.c.copy(this.previewPoint).sub(this.eye).normalize();
        this.collisionRay.set(this.eye, this.c);
        const length = this.previewPoint.distanceTo(this.eye);
        for (const collider of this.world.colliders) {
          if (!collider.enabled || collider.box.containsPoint(this.eye)) continue;
          const target = this.world.targets.find(value => value.collider === collider);
          if (target?.kind === 'gate') continue;
          if (this.collisionRay.intersectBox(collider.box, this.d) && this.d.distanceTo(this.eye) < length - 0.2) { this.previewLegal = false; break; }
        }
      }
    }
    this.previewMaterial.color.setHex(this.previewLegal ? 0x79e4ff : 0xff646e);
  }
  private inWater(p: THREE.Vector3, water: WaterArea, margin = 0): boolean {
    return p.x >= water.minX + margin && p.x <= water.maxX - margin && p.z >= water.minZ + margin && p.z <= water.maxZ - margin;
  }
  private activateIce(): void {
    if (this.iceTimer > 0) return;
    if (this.hoveredIce) { this.removeIce(this.hoveredIce, true); this.iceTimer = 0.35; return; }
    if (!this.previewLegal || (!this.previewWater && !this.previewOnFall)) { this.say('红色：此处不能造冰。瞄准开阔水面或瀑布，蓝色才可放置。'); return; }
    let column = this.ice.find(value => !value.active);
    if (!column) {
      column = this.ice.reduce((oldest, value) => value.born < oldest.born ? value : oldest);
      this.removeIce(column, true);
    }
    column.mesh.position.copy(this.preview.position);
    column.collider.box.min.set(this.previewPoint.x - ICE_SIZE / 2, this.previewPoint.y - 0.05, this.previewPoint.z - ICE_SIZE / 2);
    column.collider.box.max.set(this.previewPoint.x + ICE_SIZE / 2, this.previewPoint.y + ICE_HEIGHT, this.previewPoint.z + ICE_SIZE / 2);
    // Raise a player caught in the forming volume onto the new top; never entomb them.
    if (column.collider.box.intersectsBox(this.playerBox)) {
      this.ctx.actor.position.y = column.collider.box.max.y + 0.06;
      this.ctx.actor.velocity.y = 0;
      this.updatePlayerBox();
    }
    column.active = column.collider.enabled = column.mesh.visible = true;
    column.water = this.previewWater;
    column.born = ++this.iceSerial;
    if (!this.world.colliders.includes(column.collider)) this.world.colliders.push(column.collider);
    this.iceTimer = 0.35;
    this.ctx.effects.burst(this.previewPoint, 0x9beeff, 18);
    this.ctx.sound('ability', this.previewPoint);
    this.ctx.notify(`霜阶 ${this.ice.filter(value => value.active).length}/${CONFIG.maxIce} · 空格攀爬，瞄准旧柱 F 拆除。`);
    const trial = trials.get(this.world);
    if (trial?.id === 'ice') {
      const stage = this.ctx.state.trialStages.ice;
      if (stage === 0 && this.previewPoint.z >= -15 && this.previewPoint.z <= -5) trial.bridgePlaced = true;
      if (stage === 2 && this.previewPoint.z >= -45 && this.previewPoint.z <= -38) trial.exitPillar = true;
    }
    for (const target of this.world.targets) {
      if (target.kind !== 'gate' || target.solved || Math.abs(target.position.x - this.previewPoint.x) > 2.8 || Math.abs(target.position.z - this.previewPoint.z) > 1.6) continue;
      const body = this.body(target);
      this.a.copy(target.position);
      this.a.y = this.previewPoint.y + ICE_HEIGHT + CONFIG.playerHeight + body.half.y + 0.15;
      this.setPosition(target, this.a);
      mechanism(target).lifted = true;
      if (target.collider) target.collider.enabled = false;
      if (trial?.id === 'ice' && this.ctx.state.trialStages.ice === 1) trial.gateLifted = true;
      this.ctx.notify('水门已被冰柱托起 · 穿过它抵达远岸。', 'success');
    }
  }
  private removeIce(column: IceColumn, safely: boolean): void {
    if (!column.active) return;
    const p = this.ctx.actor.position;
    const box = column.collider.box;
    const standing = p.x > box.min.x - CONFIG.playerRadius && p.x < box.max.x + CONFIG.playerRadius && p.z > box.min.z - CONFIG.playerRadius && p.z < box.max.z + CONFIG.playerRadius && p.y >= box.min.y && p.y < box.max.y + 0.7;
    if (standing && safely) this.recoverToBank(column.water);
    this.ctx.effects.burst(column.mesh.position, 0xc7f5ff, 12);
    column.active = column.collider.enabled = column.mesh.visible = false;
  }
  private recoverToBank(water?: WaterArea): void {
    const actor = this.ctx.actor;
    if (!water) {
      actor.teleport(this.ctx.state.safePosition);
      this.updatePlayerBox();
      this.ctx.notify('脚下冰台消融 · 已返回安全落脚点。');
      return;
    }
    const x = THREE.MathUtils.clamp(actor.position.x, water.minX + 2, water.maxX - 2);
    const front = water.maxZ + 1.3;
    const back = water.minZ - 1.3;
    const preferred = Math.abs(actor.position.z - front) < Math.abs(actor.position.z - back) ? front : back;
    const other = preferred === front ? back : front;
    for (const z of [preferred, other]) if (this.tryBank(x, z)) return;
    const trial = trials.get(this.world);
    if (trial) actor.teleport([0, 0.05, [9, -18.7, -34.5, -55][this.ctx.state.trialStages[trial.id]] ?? 9]);
    else {
      // Overworld lakes may consist of overlapping water rectangles. Their internal
      // rectangle edges are not shores, so search the union for a genuinely dry bank.
      const limit = Math.max(water.maxX - water.minX, water.maxZ - water.minZ) + 8;
      for (let radius = 3; radius <= limit; radius += 3) {
        for (let n = 0; n < 12; n++) {
          const angle = n * Math.PI / 6;
          if (this.tryBank(actor.position.x + Math.cos(angle) * radius, actor.position.z + Math.sin(angle) * radius)) return;
        }
      }
      actor.teleport(this.ctx.state.safePosition);
    }
  }
  private tryBank(x: number, z: number): boolean {
    if (!trials.has(this.world) && Math.hypot(x, z) > CONFIG.radius - 2) return false;
    const height = this.world.heightAt(x, z);
    if (!Number.isFinite(height)) return false;
    this.a.set(x, height + 0.08, z);
    if (this.world.waters.some(water => this.inWater(this.a, water) && water.level - height > 0.7)) return false;
    this.box.min.set(x - CONFIG.playerRadius, this.a.y + 0.05, z - CONFIG.playerRadius);
    this.box.max.set(x + CONFIG.playerRadius, this.a.y + CONFIG.playerHeight, z + CONFIG.playerRadius);
    if (this.world.colliders.some(collider => collider.enabled && this.box.intersectsBox(collider.box))) return false;
    this.ctx.actor.teleport([x, this.a.y, z]);
    this.updatePlayerBox();
    this.ctx.notify('脚下冰柱消融 · 已安全落到岸边。');
    return true;
  }

  private breakTarget(target: AbilityTarget, color: number): void {
    if (target.solved) return;
    mechanism(target).brokenByAbility = true;
    target.solved = true;
    target.mesh.visible = false;
    if (target.collider) target.collider.enabled = false;
    this.ctx.effects.burst(target.position, color, 20);
    this.ctx.sound('explosion', target.position);
    if (!trials.has(this.world)) {
      this.ctx.state.flags[`broken:${target.id}`] = true;
      // The surrounding world decides which of its renewable targets return at blood moon.
    }
  }
  private solve(trial: TrialRuntime, stage: number): void {
    if (this.ctx.state.trialStages[trial.id] !== stage) return;
    this.ctx.state.flags[`trial:${trial.id}:${stage}`] = true;
    this.ctx.state.trialStages[trial.id] = stage + 1;
    for (const gate of trial.gates) if (gate.stage <= stage) { gate.collider.enabled = false; gate.mesh.visible = false; }
    const checkpoint: Vec3 = [0, 0, [-18.7, -34.5, -55][stage] ?? 9];
    this.ctx.state.safePosition = checkpoint;
    if (this.held?.stage === stage) this.releaseHeld();
    this.ctx.effects.ring(this.ctx.actor.position, 0x98ffe0, 3);
    this.ctx.sound('quest');
    this.ctx.notify(stage === 2 ? '三道封印全部解除 · 前往尽头祭坛领取星核。' : `第 ${stage + 1} 道封印解除 · 前方通路已开启。`, 'success');
    this.world.update(0, this.ctx.state);
    this.ctx.save();
    this.hintTimer = 3;
  }
  private updateMagnetBridge(trial: TrialRuntime, stage: number): void {
    const actor = this.ctx.actor;
    const p = actor.position;
    if (p.z > -29 && p.z < -23 && p.y < -1.15) {
      trial.stoodOnBridge = false;
      if (this.held) this.releaseHeld();
      // Choose an unoccupied near-bank landing, even if a cube was left in the middle.
      for (const z of [-20.5, -18.7]) {
        for (const x of [0, 8, -8, 4, -4]) {
          this.box.min.set(x - CONFIG.playerRadius, 0.08, z - CONFIG.playerRadius);
          this.box.max.set(x + CONFIG.playerRadius, CONFIG.playerHeight + 0.08, z + CONFIG.playerRadius);
          if (this.world.colliders.some(collider => collider.enabled && this.box.intersectsBox(collider.box))) continue;
          actor.teleport([x, 0.08, z]);
          this.updatePlayerBox();
          this.ctx.notify('失足落坑 · 已返回近岸。把两块方块沉到光环内，放手后再过桥。', 'warning');
          return;
        }
      }
    }
    if (stage !== 1) return;
    const cubes = this.world.targets.filter(target => mechanism(target).role === 'bridgeCube');
    const aligned = trial.bridgeSlots.every(slot => cubes.some(target => target !== this.held && target.collider?.enabled
      && Math.abs(target.position.x - slot.x) < 0.35 && Math.abs(target.position.z - slot.z) < 0.3
      && Math.abs(target.position.y - slot.y) < 0.15 && this.body(target).velocity.lengthSq() < 0.16));
    if (!aligned) { trial.stoodOnBridge = false; trial.bridgePlaced = false; return; }
    if (!trial.bridgePlaced) {
      trial.bridgePlaced = true;
      this.ctx.notify('双星桥已就位 · 亲自踏上方块，走到远岸解除封印。', 'success');
    }
    if (actor.grounded && p.z < -23.5 && p.z > -28.8 && cubes.some(target => {
      const box = target.collider!.box;
      return p.x > box.min.x + 0.1 && p.x < box.max.x - 0.1 && p.z > box.min.z && p.z < box.max.z && Math.abs(p.y - box.max.y) < 0.15;
    })) trial.stoodOnBridge = true;
    if (trial.stoodOnBridge && actor.grounded && p.z < -29.25 && p.z > -32 && p.y > -0.2) this.solve(trial, 1);
  }
  private updatePuzzles(): void {
    const trial = trials.get(this.world);
    if (!trial) return;
    const stage = this.ctx.state.trialStages[trial.id];
    const p = this.ctx.actor.position;
    if (trial.id === 'magnet') this.updateMagnetBridge(trial, stage);
    const hintZone = stage === 0 ? p.z < 4 : stage === 1 ? p.z < -17 : p.z < -32;
    const key = `${trial.id}:${stage}`;
    if (stage < 3 && hintZone && this.ctx.state.abilities.includes(trial.id) && this.hintTimer <= 0 && (this.hintKey !== key || this.clock % 24 < 0.1)) {
      this.ctx.notify(trial.hints[stage]!);
      this.hintKey = key;
      this.hintTimer = 9;
    }
    if (stage >= 3) return;
    for (const target of this.world.targets) {
      if (target.stage !== stage) continue;
      const data = mechanism(target);
      if (trial.id === 'magnet') {
        if (data.role === 'panel' && target.position.y >= 3.2) this.solve(trial, 0);
        if (data.role === 'pullDoor' && target.position.z > -38.7) {
          if (!trial.doorPulled) {
            trial.doorPulled = true;
            target.solved = true;
            if (target.collider) target.collider.enabled = false;
            target.mesh.visible = false;
            if (this.held === target) this.releaseHeld();
            this.ctx.notify('门板已移开 · 搬起左侧金属块，挥动撞击门后右侧守卫！也可直接击败它。');
          }
        }
        if (stage === 2 && trial.doorPulled && (this.ctx.state.flags['metal-hit:trial:magnet:guardian'] || this.ctx.state.enemies['trial:magnet:guardian']?.dead)) this.solve(trial, 2);
      } else if (trial.id === 'stasis') {
        if (data.role === 'rotor' && (target.frozen ?? 0) > 0 && (data.frozenFromZ ?? -99) > -9 && p.z < -11.4 && p.z > -17) this.solve(trial, 0);
        if (data.role === 'roller' && (target.frozen ?? 0) > 0 && (data.frozenFromZ ?? -99) > -24 && p.z < -26.8 && p.z > -32) this.solve(trial, 1);
        if ((data.role === 'rotor' || data.role === 'roller') && !target.solved && (target.frozen ?? 0) <= 0 && this.hazardTimer <= 0) {
          const close = data.role === 'rotor' ? Math.abs(p.x) < 3.3 && Math.abs(p.z + 9) < 2.8 && p.y < 0.85 : p.distanceTo(target.position) < 1.9;
          if (close) {
            this.hazardTimer = 2;
            this.ctx.damage(3, data.role === 'rotor' ? '回旋平台' : '滚落石球');
            this.ctx.actor.teleport([data.role === 'rotor' ? 0 : -4, 0.15, data.role === 'rotor' ? -5.4 : -21]);
            this.ctx.notify('金色机关可以凝时。冻结后再穿过！', 'warning');
          }
        }
      }
    }
    if (trial.id === 'ice') {
      let onColumn = false;
      let bridgeCount = 0;
      for (const column of this.ice) {
        if (!column.active) continue;
        if (column.mesh.position.z < -5 && column.mesh.position.z > -15) bridgeCount++;
        const box = column.collider.box;
        if (p.x > box.min.x - 0.3 && p.x < box.max.x + 0.3 && p.z > box.min.z - 0.3 && p.z < box.max.z + 0.3 && p.y >= box.max.y - 0.25) onColumn = true;
      }
      if (stage === 0) {
        if (trial.bridgePlaced && onColumn && p.z < -9.8 && bridgeCount >= 2) trial.stoodOnBridge = true;
        if (trial.stoodOnBridge && p.z < -15.25 && p.z > -17 && p.y > -0.2) this.solve(trial, 0);
      } else if (stage === 1 && trial.gateLifted && p.z < -28.2 && p.z > -32 && p.y > -0.2) this.solve(trial, 1);
      else if (stage === 2 && trial.exitPillar && p.z < -44.8 && p.z > -49 && Math.abs(p.x) < 4.2 && p.y >= 3.05) this.solve(trial, 2);
    }
  }
  private updateHighlights(selected?: AbilityId): void {
    let n = 0;
    for (const target of this.world.targets) {
      if (n >= this.highlights.length || target.solved || !target.mesh.visible) continue;
      const frozen = (target.frozen ?? 0) > 0;
      if (!frozen && (selected === 'magnet' ? target.kind !== 'metal' : selected === 'stasis' ? target.kind !== 'orb' && target.kind !== 'rotor' && target.kind !== 'metal' : true)) continue;
      const distance = target.position.distanceTo(this.ctx.actor.position);
      if (distance > 35) continue;
      const mesh = this.highlights[n++]!;
      const body = this.body(target);
      mesh.visible = true;
      mesh.position.copy(target.position).add(body.offset);
      mesh.scale.copy(body.half).multiplyScalar(2).addScalar(0.12);
      mesh.material = target === this.selectedTarget || frozen ? this.selectedMaterial : distance <= CONFIG.magnetRange && this.targetAllowed(target) ? this.availableMaterial : this.farMaterial;
    }
    for (; n < this.highlights.length; n++) this.highlights[n]!.visible = false;
  }

  /** Clears transient objects across travel, load/death, and blood moon; never erases persistent puzzle progress. */
  public reset(): void {
    this.releaseHeld();
    this.clearBomb();
    for (const column of this.ice) {
      if (this.ctx.world === this.world && this.ctx.state.player.hp > 0) this.removeIce(column, true);
      column.active = column.collider.enabled = column.mesh.visible = false;
      const index = this.world.colliders.indexOf(column.collider);
      if (index >= 0) this.world.colliders.splice(index, 1);
    }
    for (const [target, body] of this.bodies) {
      target.frozen = 0;
      target.charge = 0;
      body.velocity.set(0, 0, 0);
    }
    this.bodies.clear();
    this.world = this.ctx.world;
    this.moon = this.ctx.state.bloodMoonCount;
    this.selectedTarget = undefined;
    this.preview.visible = this.chargeArrow.visible = this.heldBeam.visible = false;
    for (const outline of this.highlights) outline.visible = false;
    this.cooldown = this.bombTimer = this.stasisTimer = this.iceTimer = 0;
    this.hintKey = '';
    this.hintTimer = this.feedbackTimer = this.hazardTimer = this.attackTimer = 0;
  }
  public dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.root.removeFromParent();
    disposeResources(this.geometries, this.materials);
  }
}
