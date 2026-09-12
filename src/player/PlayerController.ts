import * as THREE from 'three';
import { CONFIG } from '../config/game';
import type { ActorView, Collider, GameContext, MovementState, Region, Vec3, WaterArea } from '../core/types';
import { PlayerCollision } from './PlayerCollision';
import { PlayerRig } from './PlayerRig';
import type { PlayerPose } from './PlayerRig';

const MOTION = {
  crouchHeight: 1.24,
  acceleration: 15,
  airAcceleration: 4.5,
  terminalSpeed: 55,
  jumpCost: 5,
  climbJumpCost: 18,
  swimJumpCost: 8,
  swimOffset: 1.02,
  maxSwimCurrent: 2,
  struggleSeconds: 2.8,
  safeFallSpeed: 14,
  coyoteSeconds: 0.12,
  jumpBuffer: 0.13,
} as const;

/**
 * Feet-space actor controller. update receives the engine's SCALED dt; stamina uses
 * ctx.realDt, gated by active simulation. Owns its model and adds it to ctx.scene.
 * Combat/abilities may write attacking, guarding, bowDraw, hurt, abilityMode or
 * magnetHeld on model.userData. Swimming publishes canMelee=false for combat.
 */
export class PlayerController implements ActorView {
  private readonly rig = new PlayerRig();
  readonly model: THREE.Group = this.rig.root;
  readonly position: THREE.Vector3 = this.model.position;
  readonly velocity = new THREE.Vector3();
  readonly facing = new THREE.Vector3(0, 0, -1);
  grounded = false;
  private readonly collision: PlayerCollision;
  private readonly wish = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly wallNormal = new THREE.Vector3();
  private readonly probeNormal = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private readonly effectPoint = new THREE.Vector3();
  private readonly shore = new THREE.Vector3();
  private readonly currentDrift = new THREE.Vector3();
  private readonly cameraAnchor = new THREE.Vector3();
  private readonly cameraGoal = new THREE.Vector3();
  private readonly cameraCandidate = new THREE.Vector3();
  private readonly cameraRay = new THREE.Vector3();
  private readonly cameraLook = new THREE.Vector3();
  private readonly pose: PlayerPose = { movement: 'idle', speed: 0, yaw: 0, verticalSpeed: 0, attacking: false, guarding: false, bowDraw: 0, hurt: false, crouched: false, landing: 0 };
  private moveState: MovementState = 'idle';
  private bodyHeight: number = CONFIG.playerHeight;
  private actorYaw = 0;
  private orbitYaw = 0;
  private orbitPitch = 0.38;
  private zoom = 6.8;
  private cameraBoom = 6.8;
  private cameraSnap = true;
  private cameraFraming = false;
  private climbWall: Collider | null = null;
  private climbCooldown = 0;
  private climbRainTime = 0;
  private slipRemaining = 0;
  private jumpBuffered = 0;
  private coyote = 0;
  private jumpAge = 1;
  private regenDelay = 0;
  private lastStamina: number;
  private exhausted = false;
  private struggle = 0;
  private waterExitTime = 0;
  private fallRisk = 0;
  private landing = 0;
  private landingLock = 0;
  private footstep = 0;
  private safeTimer = 0;
  private water: WaterArea | null = null;
  private shoreRegion: Region;
  private previousRegion: Region;
  private disposed = false;

  constructor(private readonly ctx: GameContext) {
    this.collision = new PlayerCollision(() => this.ctx.world);
    this.actorYaw = Number.isFinite(ctx.state.player.yaw) ? ctx.state.player.yaw : 0;
    this.orbitYaw = this.actorYaw;
    this.lastStamina = ctx.state.player.stamina;
    this.shore.fromArray(ctx.state.safePosition);
    this.shoreRegion = ctx.state.region;
    this.previousRegion = ctx.state.region;
    this.ctx.scene.add(this.model);
    this.teleport(ctx.state.player.position);
    this.animate(0);
  }

  get movement(): MovementState { return this.moveState; }
  get crouched(): boolean { return this.bodyHeight < CONFIG.playerHeight; }
  get height(): number { return this.bodyHeight; }
  get yaw(): number { return this.actorYaw; }

  teleport(position: Vec3): void {
    const valid = position.every(Number.isFinite);
    if (valid) this.position.fromArray(position);
    else this.position.set(0, this.collision.terrain(0, 105), 105);
    this.velocity.set(0, 0, 0);
    this.bodyHeight = CONFIG.playerHeight;
    this.collision.reset();
    const floor = this.collision.floor(this.position);
    if (this.position.y < floor) this.position.y = floor;
    this.grounded = Math.abs(this.position.y - floor) < 0.075;
    this.climbWall = null;
    this.climbCooldown = 0.35;
    this.jumpBuffered = 0;
    this.jumpAge = 1;
    this.coyote = 0;
    this.fallRisk = 0;
    this.struggle = 0;
    this.water = null;
    this.waterExitTime = 0;
    this.slipRemaining = 0;
    this.landing = 0;
    this.landingLock = 0;
    this.moveState = this.ctx.state.player.hp <= 0 ? 'dead' : this.grounded ? 'idle' : 'fall';
    this.actorYaw = Number.isFinite(this.ctx.state.player.yaw) ? this.ctx.state.player.yaw : this.actorYaw;
    this.orbitYaw = this.actorYaw;
    this.facing.set(-Math.sin(this.actorYaw), 0, -Math.cos(this.actorYaw));
    this.cameraSnap = true;
    this.model.visible = true;
    this.model.rotation.set(0, this.actorYaw, 0);
    this.rig.visual.visible = true;
    if (this.previousRegion !== this.ctx.state.region) {
      this.previousRegion = this.ctx.state.region;
      this.shoreRegion = this.ctx.state.region;
      this.shore.copy(this.position);
    }
    this.syncState();
  }

  update(dt: number): void {
    if (this.disposed) return;
    dt = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, CONFIG.maxDelta) : 0;
    if (dt === 0 || this.ctx.timeScale <= 0) {
      this.syncState();
      return;
    }
    const realDt = Number.isFinite(this.ctx.realDt) ? THREE.MathUtils.clamp(this.ctx.realDt, 0, 0.1) : dt;
    const state = this.ctx.state;
    const input = this.ctx.input;
    if (this.previousRegion !== state.region) {
      this.previousRegion = state.region;
      this.shoreRegion = state.region;
      this.shore.copy(this.position);
      this.climbWall = null;
      this.collision.reset();
      this.cameraSnap = true;
    }
    if (state.player.stamina < this.lastStamina - 0.001) this.regenDelay = CONFIG.staminaDelay;
    const externalDelay: unknown = this.model.userData.staminaDelay;
    if (typeof externalDelay === 'number' && externalDelay > 0) {
      this.regenDelay = Math.max(this.regenDelay, externalDelay);
      this.model.userData.staminaDelay = 0;
    }
    state.player.stamina = THREE.MathUtils.clamp(state.player.stamina, 0, state.player.maxStamina);
    if (state.player.stamina === 0) this.exhausted = true;
    if (this.exhausted && state.player.stamina >= Math.min(20, state.player.maxStamina * 0.2)) this.exhausted = false;
    this.climbCooldown = Math.max(0, this.climbCooldown - dt);
    this.waterExitTime = Math.max(0, this.waterExitTime - dt);
    this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);
    this.jumpAge += dt;
    this.landing = Math.max(0, this.landing - dt * 3.5);
    this.landingLock = Math.max(0, this.landingLock - dt);
    this.collision.carry(this.position, this.grounded);

    if (state.player.hp <= 0) {
      this.climbWall = null;
      this.moveState = 'dead';
      this.velocity.x *= Math.exp(-dt * 9);
      this.velocity.z *= Math.exp(-dt * 9);
      this.velocity.y = Math.max(-MOTION.terminalSpeed, this.velocity.y - CONFIG.gravity * dt);
      this.grounded = this.collision.move(this.position, this.velocity, dt, this.bodyHeight, this.grounded, true);
      this.animate(dt);
      this.syncState();
      return;
    }

    const oldMovement = this.moveState;
    const wasGrounded = this.grounded;
    this.readMovement();
    const moving = this.wish.lengthSq() > 0.01;
    const wantsSprint = input.down('ShiftLeft') || input.down('ShiftRight');
    const wantsCrouch = input.down('KeyC') || input.down('ControlLeft') || input.down('ControlRight');
    const aimActive = this.isAiming();
    const guardFlag: unknown = this.model.userData.guarding;
    const guarding = !aimActive && (typeof guardFlag === 'boolean' ? guardFlag : input.down('Mouse2') && !!state.equipment.shield);
    if (input.pressed('Space')) this.jumpBuffered = MOTION.jumpBuffer;
    if (this.grounded) this.coyote = MOTION.coyoteSeconds;
    else this.coyote = Math.max(0, this.coyote - dt);
    this.water = this.waterExitTime > 0 ? null : this.swimmingWater();
    let swimming = this.water !== null;

    if (swimming && oldMovement !== 'swim') {
      const impact = Math.max(-this.velocity.y, this.fallRisk);
      this.effectPoint.copy(this.position);
      this.effectPoint.y = this.water!.level;
      this.ctx.effects.burst(this.effectPoint, 0xa3dfdf, 12);
      this.ctx.effects.ring(this.effectPoint, 0xc1f0ee, 1.0);
      this.ctx.sound('swim', this.position);
      if (impact > 29) this.ctx.damage(Math.ceil((impact - 29) / 8), '坠入水面');
      this.fallRisk = 0;
      this.velocity.y = Math.max(-3, this.velocity.y);
    }

    if (!this.climbWall && moving && input.down('Space') && !input.down('KeyQ') && this.climbCooldown <= 0 && !this.exhausted && state.player.stamina > 0) {
      this.climbWall = this.collision.findClimb(this.position, this.wish, this.wallNormal);
      if (this.climbWall) {
        this.jumpBuffered = 0;
        this.coyote = 0;
        this.fallRisk = 0;
        this.climbRainTime = 0;
        this.slipRemaining = 0;
        this.velocity.set(0, 0, 0);
        this.ctx.sound('climb', this.position);
      }
    }
    if (this.climbWall && (!this.climbWall.enabled || !this.ctx.world.colliders.includes(this.climbWall) || input.down('KeyQ') || state.player.stamina <= 0 || this.exhausted)) this.dropClimb();
    if (this.climbWall && input.pressed('KeyX')) {
      if (state.player.stamina > 0) {
        this.spend(MOTION.climbJumpCost);
        this.velocity.copy(this.wallNormal).multiplyScalar(5.5);
        this.velocity.y = CONFIG.jumpSpeed * 0.95;
        this.facing.copy(this.wallNormal);
        this.actorYaw = Math.atan2(-this.facing.x, -this.facing.z);
        this.climbWall = null;
        this.climbCooldown = 0.65;
        this.grounded = false;
        this.jumpAge = 0;
        this.waterExitTime = 0.45;
        swimming = false;
        this.ctx.sound('jump', this.position);
      }
    }

    let drain = 0;
    let sprinting = false;
    let gliding = false;
    let climbMovement = false;
    let motionResolved = false;
    if (this.climbWall) {
      this.bodyHeight = CONFIG.playerHeight;
      climbMovement = true;
      const up = (input.down('KeyW') || input.down('ArrowUp') ? 1 : 0) - (input.down('KeyS') || input.down('ArrowDown') ? 1 : 0);
      const sideways = (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0) - (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0);
      const magnitude = Math.max(1, Math.hypot(up, sideways));
      this.climbRainTime += dt;
      this.slipRemaining = Math.max(0, this.slipRemaining - dt);
      if (state.region === 'overworld' && state.weather === 'rain' && this.climbRainTime > 2.45) {
        this.climbRainTime = 0;
        this.slipRemaining = 0.42;
        this.ctx.sound('climb', this.position);
        this.effectPoint.copy(this.position).addScaledVector(this.wallNormal, -CONFIG.playerRadius);
        this.effectPoint.y += 1.3;
        this.ctx.effects.burst(this.effectPoint, 0xaecdd6, 5);
      }
      this.velocity.set(this.wallNormal.z * sideways * CONFIG.climbSpeed / magnitude - this.wallNormal.x * 1.5, this.slipRemaining > 0 ? -3.8 : up * CONFIG.climbSpeed / magnitude, -this.wallNormal.x * sideways * CONFIG.climbSpeed / magnitude - this.wallNormal.z * 1.5);
      drain = CONFIG.climbDrain * (up || sideways ? 1 : 0.35) + (this.slipRemaining > 0 ? 4 : 0);
      this.spend(drain * realDt);
      this.grounded = false;
      if (state.player.stamina <= 0) {
        this.dropClimb();
        climbMovement = false;
      } else if (up > 0 && this.slipRemaining <= 0 && this.tryMantle()) {
        climbMovement = false;
        motionResolved = true;
      } else {
        this.grounded = this.collision.move(this.position, this.velocity, dt, this.bodyHeight, false, false);
        motionResolved = true;
        const wall = this.collision.findClimb(this.position, this.wish, this.probeNormal, this.climbWall);
        if (wall) {
          this.climbWall = wall;
          this.wallNormal.copy(this.probeNormal);
        } else {
          this.dropClimb();
          climbMovement = false;
        }
        if (this.grounded && up <= 0) {
          this.dropClimb();
          climbMovement = false;
        }
      }
      swimming = false;
    }

    if (!climbMovement) {
      // Never integrate twice when climbing ends at a wall corner or a clear ledge.
      if (!motionResolved) {
        drain = 0;
        if (wantsCrouch && !swimming && this.grounded) this.bodyHeight = MOTION.crouchHeight;
        else if (this.collision.canOccupy(this.position, CONFIG.playerHeight)) this.bodyHeight = CONFIG.playerHeight;
        if (swimming && this.tryLeaveWater(moving)) {
          swimming = false;
          this.water = null;
        }
        if (swimming && this.jumpBuffered > 0 && !this.exhausted && state.player.stamina >= MOTION.swimJumpCost) {
          this.spend(MOTION.swimJumpCost);
          this.velocity.y = CONFIG.jumpSpeed * 0.78;
          this.jumpBuffered = 0;
          this.jumpAge = 0;
          this.waterExitTime = 0.42;
          swimming = false;
          this.water = null;
          this.grounded = false;
          this.ctx.sound('jump', this.position);
        } else if (!swimming && this.jumpBuffered > 0 && this.coyote > 0 && this.landingLock <= 0 && !this.crouched) {
          this.velocity.y = CONFIG.jumpSpeed;
          this.grounded = false;
          this.coyote = 0;
          this.jumpBuffered = 0;
          this.jumpAge = 0;
          this.spend(MOTION.jumpCost);
          this.ctx.sound('jump', this.position);
        }

        gliding = !swimming && !this.grounded && this.jumpAge > 0.16 && this.velocity.y <= 0.5 && state.glider && input.down('Space') && !input.down('KeyQ') && !this.exhausted && state.player.stamina > 0 && !aimActive && this.position.y - this.collision.floor(this.position) > 0.75;
        sprinting = !swimming && !gliding && this.grounded && moving && wantsSprint && !this.crouched && !guarding && !aimActive && !this.exhausted && state.player.stamina > 0;
        if (swimming) drain = CONFIG.swimDrain * (wantsSprint && moving && !this.exhausted ? 2.5 : 1);
        else if (gliding) drain = CONFIG.glideDrain;
        else if (sprinting) drain = CONFIG.sprintDrain;
        if (drain > 0) this.spend(drain * realDt);
        if (state.player.stamina <= 0) {
          sprinting = false;
          gliding = false;
        }
        const swimMultiplier = this.exhausted ? 0.32 : wantsSprint ? 1.5 : 1;
        let speed = swimming ? CONFIG.swimSpeed * swimMultiplier : gliding ? CONFIG.glideSpeed : this.crouched ? CONFIG.crouchSpeed : sprinting ? CONFIG.sprintSpeed : CONFIG.walkSpeed;
        if (guarding || aimActive) speed *= 0.56;
        if (this.landingLock > 0) speed *= 0.25;
        if (this.model.userData.attacking && this.grounded) speed *= 0.55;
        if (gliding && !moving) this.wish.copy(this.facing);
        const acceleration = swimming ? 5 : gliding ? 3.4 : this.grounded ? MOTION.acceleration : MOTION.airAcceleration;
        const blend = 1 - Math.exp(-dt * acceleration);
        this.currentDrift.set(0, 0, 0);
        const current = swimming ? this.water?.current : undefined;
        if (current && current.every(Number.isFinite)) this.currentDrift.fromArray(current).clampLength(0, MOTION.maxSwimCurrent);
        // A bounded velocity contribution, not accumulating acceleration or a collision-bypassing position offset.
        this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, this.wish.x * speed + this.currentDrift.x, blend);
        this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, this.wish.z * speed + this.currentDrift.z, blend);
        if (swimming) {
          this.velocity.y = THREE.MathUtils.clamp((this.water!.level - MOTION.swimOffset - this.position.y) * 7 + this.currentDrift.y, -3, 5);
          this.fallRisk = 0;
        } else if (gliding) {
          if (oldMovement !== 'glide') {
            this.fallRisk = Math.max(this.fallRisk, -this.velocity.y);
            this.velocity.y = Math.max(-9, this.velocity.y);
            this.ctx.sound('glide', this.position);
          }
          let updraft = 0;
          for (const object of this.ctx.world.interactables) {
            if (object.kind !== 'campfire') continue;
            const dx = object.position.x - this.position.x;
            const dz = object.position.z - this.position.z;
            const altitude = this.position.y - object.position.y;
            if (dx * dx + dz * dz < 9 && altitude > 0 && altitude < 12 && object.data?.lit !== false) updraft = 2.4;
          }
          this.velocity.y = THREE.MathUtils.damp(this.velocity.y, updraft || -2.0, 3.8, dt);
          this.fallRisk = Math.max(0, this.fallRisk - dt * 12);
        } else {
          this.velocity.y = Math.max(-MOTION.terminalSpeed, this.velocity.y - CONFIG.gravity * dt);
        }
        this.grounded = this.collision.move(this.position, this.velocity, dt, this.bodyHeight, this.grounded || swimming, !gliding && !swimming && this.jumpAge > 0.12);
        if (this.grounded) {
          gliding = false;
          if (!wasGrounded && !swimming) this.land(Math.max(this.collision.impactSpeed, this.fallRisk));
          this.fallRisk = 0;
        }
      }
    }

    this.moveState = climbMovement && this.climbWall ? 'climb' : swimming ? 'swim' : gliding ? 'glide' : this.grounded ? this.crouched ? 'crouch' : moving ? sprinting ? 'sprint' : 'run' : 'idle' : this.velocity.y > 0.1 ? 'jump' : 'fall';
    const lockTarget = this.getLockTarget();
    if (this.moveState === 'climb') {
      this.aim.copy(this.wallNormal).negate();
      this.turnTo(this.aim, dt, 16);
    } else if (lockTarget) {
      // Keep camera-relative movement, but face the opponent while strafing or guarding.
      this.aim.subVectors(lockTarget, this.position).setY(0);
      this.turnTo(this.aim, dt, 18);
    } else if (aimActive || guarding) {
      this.ctx.camera.getWorldDirection(this.aim);
      this.aim.y = 0;
      if (this.aim.lengthSq() > 0.0001) this.turnTo(this.aim.normalize(), dt, 18);
    } else if (moving || gliding) this.turnTo(this.wish, dt, this.grounded ? 15 : 7);

    if (this.moveState === 'swim') {
      if (state.player.stamina <= 0) {
        this.struggle += realDt;
        if (this.struggle >= MOTION.struggleSeconds) this.rescueFromWater();
      } else this.struggle = 0;
    } else this.struggle = 0;
    const underwater = this.water !== null && this.position.y + this.bodyHeight < this.water.level;
    if (drain === 0 && this.moveState !== 'climb' && this.moveState !== 'swim' && this.moveState !== 'glide' && !underwater) {
      this.regenDelay = Math.max(0, this.regenDelay - realDt);
      if (this.regenDelay === 0) state.player.stamina = Math.min(state.player.maxStamina, state.player.stamina + CONFIG.staminaRegen * realDt);
    }
    this.lastStamina = state.player.stamina;
    this.updateSafePosition(realDt);
    this.updateFootsteps(dt, moving);
    if (state.player.hp <= 0) this.moveState = 'dead';
    this.animate(dt);
    this.syncState();
  }

  private readMovement(): void {
    const input = this.ctx.input;
    const x = (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0) - (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0);
    const z = (input.down('KeyW') || input.down('ArrowUp') ? 1 : 0) - (input.down('KeyS') || input.down('ArrowDown') ? 1 : 0);
    this.forward.set(-Math.sin(this.orbitYaw), 0, -Math.cos(this.orbitYaw));
    this.right.set(Math.cos(this.orbitYaw), 0, -Math.sin(this.orbitYaw));
    this.wish.copy(this.forward).multiplyScalar(z).addScaledVector(this.right, x);
    if (this.wish.lengthSq() > 1) this.wish.normalize();
  }

  private isAiming(): boolean {
    const data = this.model.userData;
    if (data.cameraMode === 'aim') return true;
    if (typeof data.aiming === 'boolean') return data.aiming;
    return !!this.ctx.state.equipment.bow && (this.ctx.input.down('KeyR') || !!data.bowDraw);
  }

  private getLockTarget(): THREE.Vector3 | null {
    const data = this.model.userData;
    if (this.isAiming() || data.cameraMode === 'explore' || this.moveState === 'climb' || this.moveState === 'swim' || this.moveState === 'dead') return null;
    const target: unknown = data.lockTarget;
    return target instanceof THREE.Vector3 && Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z) ? target : null;
  }

  private turnTo(direction: THREE.Vector3, dt: number, speed: number): void {
    if (direction.lengthSq() < 0.001) return;
    const yaw = Math.atan2(-direction.x, -direction.z);
    const difference = Math.atan2(Math.sin(yaw - this.actorYaw), Math.cos(yaw - this.actorYaw));
    this.actorYaw += difference * (1 - Math.exp(-dt * speed));
    this.actorYaw = Math.atan2(Math.sin(this.actorYaw), Math.cos(this.actorYaw));
    this.facing.set(-Math.sin(this.actorYaw), 0, -Math.cos(this.actorYaw));
  }

  private spend(amount: number): void {
    if (amount <= 0) return;
    const player = this.ctx.state.player;
    player.stamina = Math.max(0, player.stamina - amount);
    this.regenDelay = CONFIG.staminaDelay;
    if (player.stamina === 0 && !this.exhausted) {
      this.exhausted = true;
      this.ctx.notify('精力耗尽，先歇一会儿。', 'warning');
    }
  }

  private dropClimb(): void {
    if (!this.climbWall) return;
    this.velocity.copy(this.wallNormal).multiplyScalar(1.8);
    this.velocity.y = -1.4;
    this.climbWall = null;
    this.climbCooldown = 0.55;
    this.grounded = false;
    this.coyote = 0;
    this.jumpBuffered = 0;
  }

  private tryMantle(): boolean {
    if (!this.climbWall || this.position.y + CONFIG.playerHeight * 0.72 < this.climbWall.box.max.y) return false;
    this.probe.copy(this.position).addScaledVector(this.wallNormal, -(CONFIG.playerRadius * 2 + 0.18));
    this.probe.y = this.climbWall.box.max.y + 0.003;
    if (!this.collision.canOccupy(this.probe, CONFIG.playerHeight, this.climbWall)) return false;
    this.position.copy(this.probe);
    this.velocity.set(0, 0, 0);
    this.climbWall = null;
    this.climbCooldown = 0.3;
    this.grounded = true;
    this.jumpBuffered = 0;
    this.landing = 0.55;
    this.ctx.sound('land', this.position);
    return true;
  }

  private swimmingWater(): WaterArea | null {
    const floor = this.collision.floor(this.position, this.position.y + CONFIG.stepHeight);
    const threshold = this.moveState === 'swim' ? 0.78 : 0.94;
    for (const water of this.ctx.world.waters) {
      if (this.position.x < water.minX || this.position.x > water.maxX || this.position.z < water.minZ || this.position.z > water.maxZ) continue;
      if (water.depth > threshold && water.level - floor > threshold && this.position.y < water.level - 0.45) return water;
    }
    return null;
  }

  private tryLeaveWater(moving: boolean): boolean {
    if (!moving || !this.water) return false;
    this.probe.copy(this.position).addScaledVector(this.wish, 0.62);
    const floor = this.collision.floor(this.probe, this.water.level + 0.35);
    if (floor < this.water.level - 0.72 || floor > this.water.level + 0.35 || floor < this.position.y + 0.3) return false;
    this.probe.y = floor + 0.003;
    if (!this.collision.canOccupy(this.probe, this.bodyHeight)) return false;
    this.position.copy(this.probe);
    this.velocity.y = 0;
    this.grounded = true;
    this.waterExitTime = 0.3;
    this.struggle = 0;
    return true;
  }

  private land(impact: number): void {
    if (impact < 3.5) return;
    this.landing = Math.min(1, impact / 17);
    this.ctx.sound('land', this.position);
    if (impact > 8) {
      this.effectPoint.copy(this.position);
      this.effectPoint.y += 0.08;
      this.ctx.effects.burst(this.effectPoint, 0xc4b69d, Math.min(14, Math.ceil(impact / 2)));
    }
    if (impact > MOTION.safeFallSpeed) {
      const damage = Math.max(1, Math.ceil((impact - MOTION.safeFallSpeed) / 3.7));
      this.landingLock = Math.min(0.65, (impact - MOTION.safeFallSpeed) * 0.035);
      this.ctx.damage(damage, '坠落');
      this.ctx.effects.shake(Math.min(0.5, impact * 0.013));
    }
  }

  private rescueFromWater(): void {
    this.ctx.damage(2, '溺水');
    this.ctx.effects.burst(this.position, 0x8dcdd8, 16);
    this.ctx.sound('swim', this.position);
    if (this.ctx.state.player.hp <= 0) {
      this.moveState = 'dead';
      this.struggle = 0;
      return;
    }
    this.effectPoint.copy(this.shore);
    if (this.shoreRegion !== this.ctx.state.region) this.effectPoint.fromArray(this.ctx.state.safePosition);
    // Validate a remembered shore in case a puzzle object moved away after recording it.
    this.effectPoint.y = this.collision.floor(this.effectPoint, this.effectPoint.y + 1);
    this.teleport([this.effectPoint.x, this.effectPoint.y, this.effectPoint.z]);
    this.ctx.state.player.stamina = Math.max(this.ctx.state.player.stamina, this.ctx.state.player.maxStamina * 0.25);
    this.exhausted = false;
    this.regenDelay = CONFIG.staminaDelay;
    this.ctx.notify('你挣扎着回到了岸边。', 'warning');
  }

  private updateSafePosition(dt: number): void {
    this.safeTimer += dt;
    if (!this.grounded || this.climbWall || this.moveState === 'swim' || this.safeTimer < 0.65) return;
    for (const water of this.ctx.world.waters) {
      if (this.position.x > water.minX - 0.75 && this.position.x < water.maxX + 0.75 && this.position.z > water.minZ - 0.75 && this.position.z < water.maxZ + 0.75 && this.position.y < water.level + 0.12) return;
    }
    if (this.collision.support && this.collision.support.box.max.y - this.collision.terrain(this.position.x, this.position.z) > CONFIG.stepHeight) return;
    this.collision.groundNormal(this.position, this.probeNormal);
    if (this.probeNormal.y < 0.72 || !this.collision.canOccupy(this.position, CONFIG.playerHeight)) return;
    this.safeTimer = 0;
    this.shore.copy(this.position);
    this.shoreRegion = this.ctx.state.region;
    const inChamber = Math.abs(this.position.x) < 19 && this.position.z > 90;
    if (this.ctx.state.region === 'overworld' && !inChamber && Math.hypot(this.position.x, this.position.z) < CONFIG.radius - 4) {
      const safe = this.ctx.state.safePosition;
      safe[0] = this.position.x;
      safe[1] = this.position.y;
      safe[2] = this.position.z;
    }
  }

  private updateFootsteps(dt: number, moving: boolean): void {
    if (!moving) { this.footstep = 0.2; return; }
    const movingOnSurface = this.grounded || this.moveState === 'climb' || this.moveState === 'swim';
    if (!movingOnSurface) return;
    this.footstep -= dt;
    if (this.footstep > 0) return;
    const sound = this.moveState === 'swim' ? 'swim' : this.moveState === 'climb' ? 'climb' : 'step';
    this.ctx.sound(sound, this.position);
    this.footstep = this.moveState === 'sprint' ? 0.27 : this.moveState === 'crouch' ? 0.65 : this.moveState === 'swim' ? 0.8 : 0.40;
    if (this.moveState === 'swim' && this.water) {
      this.effectPoint.copy(this.position);
      this.effectPoint.y = this.water.level + 0.025;
      this.ctx.effects.ring(this.effectPoint, 0xb0dddc, 0.55);
    }
  }

  private animate(dt: number): void {
    const data = this.model.userData;
    const bowValue: unknown = data.bowDraw;
    this.pose.movement = this.moveState;
    this.pose.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.pose.yaw = this.actorYaw;
    this.pose.verticalSpeed = this.velocity.y;
    this.pose.attacking = typeof data.attacking === 'boolean' ? data.attacking : this.ctx.input.down('Mouse0') && !this.isAiming();
    this.pose.guarding = typeof data.guarding === 'boolean' ? data.guarding : this.ctx.input.down('Mouse2');
    this.pose.bowDraw = typeof bowValue === 'number' ? THREE.MathUtils.clamp(bowValue, 0, 1) : this.isAiming() ? 0.8 : 0;
    this.pose.hurt = !!data.hurt;
    this.pose.crouched = this.crouched;
    this.pose.landing = this.landing;
    this.rig.update(dt, this.ctx.state, this.pose);
    if (typeof data.hurt === 'number') data.hurt = Math.max(0, data.hurt - dt);
  }

  private syncState(): void {
    const player = this.ctx.state.player;
    player.position[0] = this.position.x;
    player.position[1] = this.position.y;
    player.position[2] = this.position.z;
    player.yaw = this.actorYaw;
    player.movement = this.moveState;
    this.model.userData.canMelee = this.moveState !== 'swim' && this.moveState !== 'climb' && this.moveState !== 'glide' && this.moveState !== 'dead';
    this.model.userData.crouched = this.crouched;
    this.model.userData.noiseRadius = this.moveState === 'sprint' ? 16 : this.crouched ? 2.5 : this.moveState === 'run' ? 8 : 1;
  }

  updateCamera(dt: number): void {
    if (this.disposed) return;
    dt = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, CONFIG.maxDelta) : 0;
    const input = this.ctx.input;
    const aiming = this.isAiming() && this.moveState !== 'swim' && this.moveState !== 'climb';
    const lockTarget = this.getLockTarget();
    const sensitivity = THREE.MathUtils.clamp(this.ctx.state.settings.sensitivity || 1, 0.1, 4);
    if (dt > 0) {
      if (lockTarget) {
        this.aim.subVectors(lockTarget, this.position).setY(0);
        if (this.aim.lengthSq() > 0.001) {
          const yaw = Math.atan2(-this.aim.x, -this.aim.z);
          const difference = Math.atan2(Math.sin(yaw - this.orbitYaw), Math.cos(yaw - this.orbitYaw));
          this.orbitYaw += difference * (this.cameraSnap ? 1 : 1 - Math.exp(-dt * 6));
        }
        this.orbitPitch = THREE.MathUtils.damp(this.orbitPitch, 0.38, 6, dt);
      } else {
        // Lock owns mouse rotation entirely; release/aim resumes orbit from the tracked heading.
        this.orbitYaw -= THREE.MathUtils.clamp(input.mouseDX, -600, 600) * 0.0023 * sensitivity;
        this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + THREE.MathUtils.clamp(input.mouseDY, -600, 600) * 0.0019 * sensitivity, -0.24, 1.18);
      }
      this.orbitYaw = Math.atan2(Math.sin(this.orbitYaw), Math.cos(this.orbitYaw));
      const data = this.model.userData;
      const abilityOwnsWheel = data.abilityMode || data.abilityActive || data.magnetHeld || data.abilityTarget || input.down('KeyF');
      // Combat uses the wheel to cycle locked opponents, not to change exploration zoom.
      if (!lockTarget && !abilityOwnsWheel && input.wheel) {
        const scroll = Math.abs(input.wheel) <= 10 ? input.wheel * 0.6 : THREE.MathUtils.clamp(input.wheel, -200, 200) * 0.008;
        this.zoom = THREE.MathUtils.clamp(this.zoom + scroll, 3, 11);
      }
    }
    this.forward.set(-Math.sin(this.orbitYaw), 0, -Math.cos(this.orbitYaw));
    this.right.set(Math.cos(this.orbitYaw), 0, -Math.sin(this.orbitYaw));
    this.cameraGoal.copy(this.position);
    if (lockTarget) {
      this.cameraGoal.lerp(lockTarget, 0.5);
      this.cameraGoal.y += 1.32;
    } else {
      this.cameraGoal.y += this.crouched ? 0.88 : this.moveState === 'swim' ? 1.15 : 1.32;
      this.cameraGoal.addScaledVector(this.forward, aiming ? 0.15 : 0.62);
      if (aiming) this.cameraGoal.addScaledVector(this.right, 0.55);
    }
    if (this.cameraSnap) this.cameraAnchor.copy(this.cameraGoal);
    else this.cameraAnchor.lerp(this.cameraGoal, 1 - Math.exp(-dt * 12));
    // Keep the focal point reachable from the actor, even on the inside of a corner.
    this.cameraLook.copy(this.position);
    this.cameraLook.y += this.crouched ? 0.88 : 1.32;
    this.cameraRay.subVectors(this.cameraAnchor, this.cameraLook);
    const anchorLength = this.cameraRay.length();
    if (anchorLength > 0.001) {
      const safe = this.collision.cameraDistance(this.cameraLook, this.cameraAnchor);
      if (safe < anchorLength) this.cameraAnchor.copy(this.cameraLook).addScaledVector(this.cameraRay, safe / anchorLength);
    }
    let distance = aiming ? 3.1 : this.moveState === 'glide' ? Math.max(this.zoom, 7.7) : this.zoom;
    const cosPitch = Math.cos(this.orbitPitch);
    const sinPitch = Math.sin(this.orbitPitch);
    this.cameraRay.set(Math.sin(this.orbitYaw) * cosPitch, sinPitch, Math.cos(this.orbitYaw) * cosPitch);
    if (lockTarget) {
      // Fit both bodies to the actual viewport, with a margin; obstacles still take priority.
      const tanVertical = Math.tan(THREE.MathUtils.degToRad(this.ctx.camera.getEffectiveFOV()) * 0.5) * 0.85;
      const tanHorizontal = tanVertical * this.ctx.camera.aspect;
      for (let i = 0; i < 2; i++) {
        this.cameraGoal.copy(i === 0 ? this.position : lockTarget);
        this.cameraGoal.y += 1.32;
        this.cameraGoal.sub(this.cameraAnchor);
        const horizontal = Math.abs(this.cameraGoal.dot(this.right));
        const vertical = Math.abs(this.cameraGoal.y * cosPitch + this.cameraGoal.dot(this.forward) * sinPitch);
        const depth = this.cameraGoal.dot(this.cameraRay);
        distance = Math.max(distance, depth + Math.max((horizontal + 1.4) / tanHorizontal, (vertical + 1.4) / tanVertical));
      }
    }
    this.cameraGoal.copy(this.cameraAnchor).addScaledVector(this.cameraRay, distance);
    let allowed = this.collision.cameraDistance(this.cameraAnchor, this.cameraGoal);
    const crowded = allowed < (this.cameraFraming && !this.cameraSnap ? 1.65 : 1.4);
    this.cameraFraming = false;
    if (crowded && !aiming && !lockTarget && this.orbitPitch > 0) {
      // Keep input pitch intact: try at most three flatter rays on the same yaw.
      // Only trade pitch for usable framing, never for passage through an obstacle.
      // Hysteresis avoids toggling at the crowding threshold; the usual smoothing
      // and final collision clamp also apply to the fallback and its restoration.
      for (let i = 1; i <= 3; i++) {
        const pitch = this.orbitPitch * (1 - i / 3);
        const cos = Math.cos(pitch);
        this.cameraCandidate.set(Math.sin(this.orbitYaw) * cos, Math.sin(pitch), Math.cos(this.orbitYaw) * cos);
        this.cameraGoal.copy(this.cameraAnchor).addScaledVector(this.cameraCandidate, distance);
        const clearance = this.collision.cameraDistance(this.cameraAnchor, this.cameraGoal);
        if (clearance < 1.8) continue;
        this.cameraRay.copy(this.cameraCandidate);
        allowed = clearance;
        this.cameraFraming = true;
        break;
      }
    }
    if (this.cameraSnap || allowed < this.cameraBoom) this.cameraBoom = allowed;
    else this.cameraBoom = THREE.MathUtils.damp(this.cameraBoom, allowed, 5, dt);
    this.cameraGoal.copy(this.cameraAnchor).addScaledVector(this.cameraRay, this.cameraBoom);
    if (this.cameraSnap) this.cameraCandidate.copy(this.cameraGoal);
    else this.cameraCandidate.copy(this.ctx.camera.position).lerp(this.cameraGoal, 1 - Math.exp(-dt * (aiming ? 20 : 14)));
    this.cameraRay.subVectors(this.cameraCandidate, this.cameraAnchor);
    const candidateDistance = this.cameraRay.length();
    const safeDistance = this.collision.cameraDistance(this.cameraAnchor, this.cameraCandidate);
    if (candidateDistance > 0.001 && safeDistance < candidateDistance) this.cameraCandidate.copy(this.cameraAnchor).addScaledVector(this.cameraRay, safeDistance / candidateDistance);
    this.ctx.camera.position.copy(this.cameraCandidate);
    this.ctx.camera.lookAt(this.cameraAnchor);
    this.ctx.camera.updateMatrixWorld();
    this.rig.visual.visible = this.ctx.camera.position.distanceToSquared(this.cameraLook) > 0.64;
    this.cameraSnap = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rig.dispose();
    this.collision.reset();
  }
}
