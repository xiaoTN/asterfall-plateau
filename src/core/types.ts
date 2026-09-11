import type * as THREE from 'three';

export type Vec3 = [number, number, number];
export type AbilityId = 'magnet' | 'bomb' | 'stasis' | 'ice';
export type Region = 'overworld' | AbilityId;
export type QuestId = 'AWAKEN' | 'GET_TERMINAL' | 'EXIT_CHAMBER' | 'MEET_ELDER' | 'ACTIVATE_TOWER' | 'FIRST_TRIAL' | 'COMPLETE_FOUR_TRIALS' | 'VISIT_TEMPLE' | 'RECEIVE_GLIDER' | 'PROLOGUE_COMPLETE';
export type Weather = 'clear' | 'cloudy' | 'rain';
export type MovementState = 'idle' | 'run' | 'sprint' | 'crouch' | 'jump' | 'fall' | 'climb' | 'swim' | 'glide' | 'dead';
export interface InventoryItem { uid: string; id: string; count: number; durability?: number; heal?: number; cold?: number; energy?: number; name?: string; }
export interface ItemDefinition { name: string; category: 'weapon'|'bow'|'shield'|'arrow'|'clothes'|'material'|'meal'|'key'; attack?: number; durability?: number; range?: number; speed?: number; weight?: number; flammable?: boolean; heal?: number; cold?: number; energy?: number; defense?: number; description: string; color: string; }
export interface Settings { quality: 'low'|'medium'|'high'; volume: number; music: number; ambient: number; sfx: number; sensitivity: number; shake: boolean; subtitles: boolean; colorblind: boolean; }
export interface EnemySave { hp: number; dead: boolean; position?: Vec3; }
export interface GameState {
  version: number;
  player: { position: Vec3; yaw: number; hp: number; maxHp: number; stamina: number; maxStamina: number; coldResist: number; movement: MovementState; };
  safePosition: Vec3; region: Region; quest: QuestId;
  inventory: InventoryItem[]; equipment: { weapon: string|null; bow: string|null; shield: string|null; clothes: string|null; trousers: string|null; };
  flags: Record<string, boolean>; discovered: string[]; abilities: AbilityId[]; selectedAbility: AbilityId;
  completed: AbilityId[]; trialStages: Record<AbilityId, number>; cores: number; terminal: boolean; tower: boolean; glider: boolean; upgrade: 'heart'|'stamina'|null;
  time: number; day: number; weather: Weather; weatherSeed: number; lastBloodMoon: number; bloodMoonCount: number;
  enemies: Record<string, EnemySave>; pins: { x: number; z: number }[]; settings: Settings; playSeconds: number;
}
export interface Collider { id: string; box: THREE.Box3; climbable: boolean; enabled: boolean; mesh?: THREE.Object3D; }
export interface Interactable { id: string; kind: 'terminal'|'door'|'exit'|'elder'|'tower'|'shrine'|'altar'|'glider'|'chest'|'pickup'|'tree'|'pot'|'campfire'|'ability'|'reward'|'return'; name: string; position: THREE.Vector3; radius: number; item?: string; ability?: AbilityId; mesh?: THREE.Object3D; data?: Record<string, string|number|boolean>; }
export interface AbilityTarget { id: string; kind: 'metal'|'cracked'|'orb'|'rotor'|'water'|'gate'|'barrel'; position: THREE.Vector3; mesh: THREE.Object3D; collider?: Collider; stage?: number; solved?: boolean; frozen?: number; charge?: number; velocity?: THREE.Vector3; origin?: Vec3; resource?: 'log'|'apple'; attached?: boolean; }
export interface WaterArea { minX: number; maxX: number; minZ: number; maxZ: number; level: number; depth: number; current?: Vec3; }
export interface WaterfallArea { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number; axis: 'x'|'z'; }
export interface EnemySpawn { id: string; type: 'melee'|'shield'|'archer'|'guardian'; position: Vec3; camp: string; }
export interface WorldView {
  root: THREE.Group; colliders: Collider[]; interactables: Interactable[]; targets: AbilityTarget[]; waters: WaterArea[]; waterfalls?: WaterfallArea[]; spawns: EnemySpawn[];
  heightAt(x: number, z: number): number;
  update(dt: number, state: GameState): void;
  dispose(): void;
}
export interface InputLike { down(code: string): boolean; pressed(code: string): boolean; released(code: string): boolean; mouseDX: number; mouseDY: number; wheel: number; clear(): void; }
export interface ActorView { position: THREE.Vector3; velocity: THREE.Vector3; facing: THREE.Vector3; grounded: boolean; model: THREE.Group; teleport(position: Vec3): void; }
export interface EffectPort { burst(position: THREE.Vector3, color: number, count?: number): void; ring(position: THREE.Vector3, color: number, radius?: number): void; shake(amount: number): void; }
export interface GameContext {
  state: GameState; scene: THREE.Scene; camera: THREE.PerspectiveCamera; input: InputLike; world: WorldView; actor: ActorView; effects: EffectPort;
  elapsed: number; realDt: number; timeScale: number; inCombat: boolean;
  notify(text: string, kind?: 'info'|'success'|'warning'): void;
  sound(name: string, position?: THREE.Vector3): void;
  damage(amount: number, source: string): void;
  addItem(id: string, count?: number, extra?: Partial<InventoryItem>): boolean;
  save(): void;
  changeRegion(region: Region, position?: Vec3): void;
  cinematic(title: string, text: string, duration: number, done?: ()=>void): void;
}
export interface Dialogue { speaker: string; text: string; options: { label: string; action: ()=>void }[]; }
export type Panel = 'none'|'title'|'inventory'|'map'|'quests'|'settings'|'pause'|'death'|'dialogue'|'cooking';
export interface UIActions { start(continuing: boolean): void; panel(panel: Panel): void; save(): void; inventory(action: string, uid: string): void; cook(): void; upgrade(type: 'heart'|'stamina'): void; settings(settings: Partial<Settings>): void; pin(x: number, z: number): void; debug(action: string, value?: string): void; }
