import * as THREE from 'three';
import { ABILITIES, CONFIG, LOCATIONS, QUESTS } from '../config/game';
import { equipmentSlot, findInventoryItem, ITEMS } from '../config/items';
import type { AbilityId, AbilityTarget, Dialogue, GameContext, GameState, Interactable, InventoryItem, Vec3, WorldView } from '../core/types';
import { advanceClock } from '../core/clock';
import { FLAGS, reconcileQuest } from '../quests/progression';
import { canHoldIngredient, cookRecipe, foodEffects } from './recipes';

export { addItem } from '../config/items';

const ABILITY_IDS: readonly AbilityId[] = ['magnet', 'bomb', 'stasis', 'ice'];
const FOOD_COOLDOWN_MS = 3500;
const FIRE_RADIUS = 6;
// Only ordinary landmarks are discovered by proximity; the tower reveals shrines.
const DISCOVERY_RADII: Readonly<Record<string, number>> = { campfire: 10, camp: 16, cabin: 12, temple: 18, lake: 20 };
interface DroppedItem { target: Interactable; world: WorldView; mesh: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial>; }

function abilityId(value: unknown): AbilityId | undefined {
  return ABILITY_IDS.find(id => id === value);
}
function positiveCount(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function now(): number { return globalThis.performance?.now() ?? Date.now(); }
function manipulated(object: AbilityTarget | undefined): boolean {
  if (!object?.origin) return false;
  return object.position.y - object.origin[1] > 0.8 || Math.hypot(object.position.x - object.origin[0], object.position.z - object.origin[2]) > 1.5;
}

/** Main owns pausing/death and calls update only during active play. No DOM dependencies. */
export class Gameplay {
  private heldUids: string[] = [];
  private busy = false;
  private epoch = 0;
  private dialogueToken = 0;
  private coldClock = 0;
  private wasCold = false;
  private lastEatAt = -Infinity;
  private torchClock = 0;
  private dropSerial = 0;
  private readonly drops: DroppedItem[] = [];
  private lastState: GameState;
  private lastRegion: GameState['region'];
  private preparedWorld: WorldView | null = null;
  private movableChests: { chest: Interactable; object: AbilityTarget; offset: THREE.Vector3 }[] = [];

  constructor(private readonly ctx: GameContext, private readonly showDialogue: (dialogue: Dialogue) => void) {
    this.lastState = ctx.state;
    this.lastRegion = ctx.state.region;
    this.prepareInteractions();
  }

  /** One UID per held ingredient unit. A defensive copy prevents UI mutation. */
  get held(): string[] { this.pruneHeld(); return [...this.heldUids]; }

  clearTransient(): void {
    this.epoch++;
    this.dialogueToken++;
    this.busy = false;
    this.heldUids = [];
    this.coldClock = 0;
    this.wasCold = false;
    this.torchClock = 0;
    // Do not reset the real-time food cooldown when a menu closes or a region changes.
    for (const drop of this.drops) {
      const index = drop.world.interactables.indexOf(drop.target);
      if (index >= 0) drop.world.interactables.splice(index, 1);
      drop.mesh.removeFromParent();
      drop.mesh.geometry.dispose();
      drop.mesh.material.dispose();
    }
    this.drops.length = 0;
    this.lastState = this.ctx.state;
    this.lastRegion = this.ctx.state.region;
  }

  update(dt: number): void {
    const { ctx } = this;
    if (ctx.state !== this.lastState || ctx.state.region !== this.lastRegion) this.clearTransient();
    this.prepareInteractions();
    this.syncMovingChests();
    if (!Number.isFinite(dt) || dt <= 0 || ctx.timeScale <= 0 || ctx.state.player.hp <= 0 || ctx.state.player.movement === 'dead' || this.busy) return;
    dt = Math.min(dt, CONFIG.maxDelta);
    // A save taken during the rise must finish the cinematic before granting its rewards.
    if (ctx.state.region === 'overworld' && ctx.state.tower && ctx.state.flags[FLAGS.towerMap] === false) {
      this.activateTower();
      return;
    }
    if (ctx.state.quest === 'AWAKEN') ctx.state.flags[FLAGS.awakened] = true;
    this.reconcile();
    this.pruneHeld();
    // Crossing the chamber threshold is automatic; E also works on its exit trigger.
    if (ctx.state.region === 'overworld' && ctx.state.terminal && ctx.state.flags[FLAGS.doorOpen] && !ctx.state.flags[FLAGS.exitedChamber]) {
      const exit = ctx.world.interactables.find(target => target.kind === 'exit');
      if (exit && ctx.actor.position.distanceTo(exit.position) <= Math.max(exit.radius, 3)) {
        this.leaveChamber();
        return;
      }
    }
    if (ctx.state.region === 'overworld' && ctx.state.glider && ctx.state.player.movement === 'glide' && !ctx.state.flags[FLAGS.prologueComplete] && Math.hypot(ctx.actor.position.x, ctx.actor.position.z) > CONFIG.radius) {
      this.scene('序章完成 · 星坠原野', '台地的风终于有了去处。前方没有画好的路，只有你留下的足迹。\n你仍可返回台地，自由探索。', 4, () => {
        ctx.state.flags[FLAGS.prologueComplete] = true;
        this.reconcile();
        this.saveAtActor(false);
      });
      return;
    }
    this.discoverNearbyLocations();
    this.updateTemperature(dt);
    this.updateTorch(dt);
  }

  private discoverNearbyLocations(): void {
    const { state, actor } = this.ctx;
    if (state.region !== 'overworld') return;
    let discovered = false;
    for (const [id, location] of Object.entries(LOCATIONS)) {
      const radius = DISCOVERY_RADII[location.type];
      if (!radius || state.discovered.includes(id)) continue;
      // Map anchors have placeholder heights, so measure distance across the terrain.
      if (Math.hypot(actor.position.x - location.position[0], actor.position.z - location.position[2]) > radius) continue;
      state.discovered.push(id);
      discovered = true;
      this.ctx.notify(`发现地点 · ${location.name}`, 'success');
    }
    if (discovered) this.saveAtActor(false);
  }

  getPrompt(target: Interactable): string | null {
    const { state } = this.ctx;
    if (this.busy || state.player.hp <= 0) return null;
    switch (target.kind) {
      case 'pickup': return state.flags[FLAGS.picked(target.id)] ? null : `拾取 ${ITEMS[target.item ?? '']?.name ?? target.name}${this.lootCount(target) > 1 ? ` ×${this.lootCount(target)}` : ''}`;
      case 'chest': {
        if (state.flags[FLAGS.opened(target.id)]) return null;
        return this.chestRequirement(target) ?? `打开 ${target.name}`;
      }
      case 'tree': return this.treeEmpty(target) ? null : '摇晃果树 · 收集苹果';
      case 'terminal': return state.terminal ? null : '取得星盘';
      case 'door': return state.flags[FLAGS.doorOpen] ? null : state.terminal ? '以星盘开启石门' : '需要先取得台座上的星盘';
      case 'exit': return state.flags[FLAGS.exitedChamber] ? null : state.terminal && state.flags[FLAGS.doorOpen] ? '走向第一缕光' : '先取得星盘并开启石门';
      case 'elder': return this.isRoofElder(target) ? state.glider ? '与守望者的余光交谈' : state.upgrade ? '聆听最后的守望者' : '先在圣所祭坛兑换四枚星核' : '与白发旅人交谈';
      case 'tower': return state.tower ? '查看观星之塔' : !state.terminal ? '需要星盘' : !state.flags[FLAGS.metElder] ? '先与营火旁的旅人交谈' : '用星盘唤醒观星之塔';
      case 'shrine': return !state.terminal ? '需要星盘' : !state.tower ? '先激活中央观星之塔' : `进入${target.name}${target.ability && state.completed.includes(target.ability) ? ' · 已完成' : ''}`;
      case 'ability': {
        const ability = this.targetAbility(target);
        return !ability ? null : state.abilities.includes(ability) ? null : `接收星术 · ${this.abilityName(ability)}`;
      }
      case 'reward': {
        const ability = this.targetAbility(target);
        if (!ability) return null;
        if (state.completed.includes(ability)) return '试炼已完成 · 返回台地';
        if (!state.abilities.includes(ability)) return '先在入口台座接收星术';
        return state.trialStages[ability] >= 3 ? '领取试炼星核' : `尚有机关未解 · ${Math.min(3, state.trialStages[ability])}/3`;
      }
      case 'return': return '返回台地 · 保留试炼进度';
      case 'altar': return state.upgrade ? '星核已奉献 · 前往圣所高台' : this.allTrials() && state.cores >= 4 ? '奉献四枚星核 · 选择成长' : `需要完成四座试炼 · ${new Set(state.completed).size}/4`;
      case 'glider': return state.glider ? null : state.upgrade ? '接受逐风帆' : '先在祭坛兑换四枚星核';
      case 'pot': return !this.fireLit(target) ? '锅火已熄 · 使用木材或点燃的火把' : this.held.length ? `烹饪 · 投入 ${this.held.length}/5 份材料` : '烹饪锅 · 在背包手持材料（最多5份）';
      case 'campfire': return this.fireLit(target) ? '营火 · 休息至晨、午、夜' : '营火已熄 · 使用木材或点燃的火把';
    }
  }

  interact(target: Interactable): void {
    if (this.busy || this.ctx.state.player.hp <= 0 || this.ctx.state.player.movement === 'dead') return;
    if (this.ctx.actor.position.distanceTo(target.position) > Math.max(CONFIG.interactDistance, target.radius) + 0.6) return;
    if (this.getPrompt(target) === null) return;
    switch (target.kind) {
      case 'terminal': this.takeTerminal(); break;
      case 'door': this.openDoor(); break;
      case 'exit': this.leaveChamber(); break;
      case 'elder': this.elder(target); break;
      case 'tower': this.activateTower(); break;
      case 'shrine': this.enterShrine(target); break;
      case 'ability': this.takeAbility(target); break;
      case 'reward': this.rewardTrial(target); break;
      case 'return': this.returnFromTrial(this.targetAbility(target)); break;
      case 'altar': this.altar(); break;
      case 'glider': this.giveGlider(); break;
      case 'pickup': this.takePickup(target); break;
      case 'chest': this.openChest(target); break;
      case 'tree': this.shakeTree(target); break;
      case 'pot': if (!this.fireLit(target)) this.lightFire(target); else if (this.held.length) this.cook(); else this.ctx.notify('打开背包，选择食材并「手持」，再来锅边烹饪。'); break;
      case 'campfire': if (!this.fireLit(target)) this.lightFire(target); else this.campfire(target); break;
    }
  }

  inventoryAction(action: string, uid: string): void {
    if (this.busy || this.ctx.state.player.hp <= 0) return;
    if (action === 'sort') {
      const order = ['weapon', 'bow', 'shield', 'arrow', 'clothes', 'material', 'meal', 'key'];
      this.ctx.state.inventory.sort((a, b) => order.indexOf(ITEMS[a.id]?.category ?? 'key') - order.indexOf(ITEMS[b.id]?.category ?? 'key') || a.id.localeCompare(b.id) || (b.durability ?? 0) - (a.durability ?? 0) || a.uid.localeCompare(b.uid));
      this.ctx.sound('ui');
      return;
    }
    if (action === 'clearHeld' || action === 'clear' || action === 'cancelHold') { this.heldUids = []; return; }
    const item = findInventoryItem(this.ctx.state, uid);
    if (!item) return;
    const definition = ITEMS[item.id];
    if (!definition) return;
    if (action === 'equip' || action === 'unequip') {
      const slot = equipmentSlot(item.id);
      if (!slot) { this.ctx.notify('这件物品不能装备。'); return; }
      if (item.durability !== undefined && item.durability <= 0) { this.ctx.notify('这件装备已经损坏。', 'warning'); return; }
      const current = this.ctx.state.equipment[slot];
      this.ctx.state.equipment[slot] = action === 'unequip' || current === item.uid || current === item.id ? null : item.uid;
      this.ctx.sound('equip');
      return;
    }
    if (action === 'hold') {
      if (!canHoldIngredient(item.id)) { this.ctx.notify('只能手持可烹饪材料；木材请在火堆旁使用。', 'warning'); return; }
      if (this.heldUids.length >= 5) { this.ctx.notify('最多手持五份材料。', 'warning'); return; }
      if (this.heldUids.filter(held => held === item.uid).length >= item.count) { this.ctx.notify('这一堆材料已全部拿在手中。', 'warning'); return; }
      this.heldUids.push(item.uid);
      this.ctx.sound('ui');
      return;
    }
    if (action === 'unhold') {
      const index = this.heldUids.lastIndexOf(item.uid);
      if (index >= 0) this.heldUids.splice(index, 1);
      return;
    }
    if (action === 'drop') {
      if (definition.category === 'key') { this.ctx.notify('关键物品不能丢弃。', 'warning'); return; }
      this.dropItem(item);
      return;
    }
    if (action === 'eat') { this.eat(item); return; }
    if (action === 'use') {
      if (foodEffects(item)) this.eat(item);
      else if (item.id === 'wood' || item.id === 'torch') {
        const fire = this.nearbyFire();
        if (!fire) { this.ctx.notify('请走到营火或烹饪锅旁再使用。', 'warning'); return; }
        if (item.id === 'torch') {
          this.ctx.state.equipment.weapon = item.uid;
          if (this.fireLit(fire)) { this.ctx.state.flags.torchLit = true; this.ctx.notify('火把已点燃。雨水会熄灭它。', 'success'); }
          else this.lightFire(fire);
        } else this.lightFire(fire, item);
      } else if (equipmentSlot(item.id)) this.inventoryAction('equip', item.uid);
      else if (item.id === 'terminal') this.ctx.notify(this.ctx.state.tower ? '星盘已接入地图。按 M 查看地图，1–4 切换已获得的星术。' : '星盘感受到中央观星之塔的回声。');
      else if (item.id === 'core') this.ctx.notify('集齐四枚星核，在北方无名者圣所祭坛兑换成长。');
      else if (item.id === 'glider') this.ctx.notify('在下落时按住空格展开逐风帆，注意精力。');
      else this.ctx.notify('这种材料可以手持后投入烹饪锅。');
    }
  }

  cook(): void {
    if (this.busy || this.ctx.state.player.hp <= 0) return;
    const pot = this.ctx.world.interactables.find(target => target.kind === 'pot' && this.ctx.actor.position.distanceTo(target.position) <= Math.max(target.radius, CONFIG.interactDistance));
    if (!pot) { this.ctx.notify('需要靠近烹饪锅。', 'warning'); return; }
    if (!this.fireLit(pot)) { this.ctx.notify('锅火已熄灭；在遮雨处用木材或火把重新点火。', 'warning'); return; }
    this.pruneHeld();
    if (!this.heldUids.length) { this.ctx.notify('先从背包手持一至五份材料。', 'warning'); return; }
    const units = [...this.heldUids];
    const ingredients = units.map(uid => findInventoryItem(this.ctx.state, uid)?.id ?? '');
    const recipe = cookRecipe(ingredients);
    // Reserve by locking actions, not by removing ingredients: cancellation/load loses nothing.
    this.ctx.sound('cook', pot.position);
    this.ctx.effects.burst(pot.position.clone().add(new THREE.Vector3(0, 1, 0)), 0xeac879, 18);
    this.scene('锅中的小小星河', '食材落下，热气升起。赶路的人也值得好好吃一顿。', 2.4, () => {
      const required = new Map<string, number>();
      for (const uid of units) required.set(uid, (required.get(uid) ?? 0) + 1);
      if ([...required].some(([uid, count]) => (findInventoryItem(this.ctx.state, uid)?.count ?? 0) < count)) return;
      if (!this.ctx.addItem('meal', 1, { name: recipe.name, heal: recipe.heal, cold: recipe.cold, energy: recipe.energy })) { this.ctx.notify('料理无法收纳，材料已保留。', 'warning'); return; }
      for (const [uid, count] of required) {
        const item = findInventoryItem(this.ctx.state, uid);
        if (item) this.consume(item, count);
      }
      this.heldUids = [];
      this.ctx.sound('success');
      this.speak('野炊手记', `${recipe.name}\n${recipe.description}`, [{ label: '收进背包', action: () => undefined }]);
    });
  }

  upgrade(type: 'heart' | 'stamina'): void {
    if (this.busy || this.ctx.state.player.hp <= 0 || (type !== 'heart' && type !== 'stamina')) return;
    const { state, actor, world } = this.ctx;
    const altar = world.interactables.find(target => target.kind === 'altar' && actor.position.distanceTo(target.position) <= Math.max(target.radius, CONFIG.interactDistance) + 0.6);
    if (state.region !== 'overworld' || !altar) { this.ctx.notify('请在无名者圣所祭坛前选择成长。', 'warning'); return; }
    if (state.upgrade) { this.ctx.notify('四枚星核已经回应过你的愿望。'); return; }
    if (!this.allTrials() || state.cores < 4) { this.ctx.notify('需要完成四座试炼并携带四枚星核。', 'warning'); return; }
    state.cores -= 4;
    let remaining = 4;
    for (const item of [...state.inventory]) {
      if (item.id !== 'core') continue;
      const consumed = Math.min(item.count, remaining);
      this.consume(item, consumed);
      remaining -= consumed;
      if (remaining === 0) break;
    }
    state.upgrade = type;
    if (type === 'heart') { state.player.maxHp += 4; state.player.hp = state.player.maxHp; }
    else { state.player.maxStamina += 40; state.player.stamina = state.player.maxStamina; }
    this.reconcile();
    this.ctx.effects.ring(actor.position, type === 'heart' ? 0xf19a91 : 0x9adebc, 4);
    this.ctx.sound('upgrade');
    this.saveAtActor();
    this.scene(type === 'heart' ? '心火增长' : '长风入怀', '四点星光化作你的力量。\n高台上，旅人正等着说完最后一个故事。', 3);
  }

  private reconcile(): void {
    if (reconcileQuest(this.ctx.state)) {
      this.ctx.notify(`任务更新 · ${QUESTS[this.ctx.state.quest]?.title ?? ''}`, 'success');
      this.ctx.sound('quest');
    }
  }

  private scene(title: string, text: string, duration: number, done: () => void = () => undefined): void {
    if (this.busy) return;
    this.busy = true;
    const epoch = this.epoch;
    const state = this.ctx.state;
    let committed = false;
    this.ctx.cinematic(title, text, duration, () => {
      if (committed || epoch !== this.epoch || state !== this.ctx.state) return;
      committed = true;
      this.busy = false;
      if (state.player.hp > 0) done();
    });
  }

  private speak(speaker: string, text: string, options: Dialogue['options']): void {
    const token = ++this.dialogueToken;
    const state = this.ctx.state;
    this.showDialogue({ speaker, text, options: options.map(option => ({ label: option.label, action: () => {
      if (token !== this.dialogueToken || state !== this.ctx.state || state.player.hp <= 0) return;
      this.dialogueToken++;
      option.action();
    } })) });
  }

  private saveAtActor(safe = true): void {
    const p = this.ctx.actor.position;
    const position: Vec3 = [p.x, p.y, p.z];
    this.ctx.state.player.position = position;
    if (safe) this.ctx.state.safePosition = [...position];
    for (const drop of this.drops) delete this.ctx.state.flags[FLAGS.picked(drop.target.id)];
    this.ctx.save();
  }

  private takeTerminal(): void {
    if (this.ctx.state.terminal) return;
    this.scene('沉睡的星盘', '指尖触到微光。一道细小的回声说：\n「这一次，请替自己选择方向。」', 2.8, () => {
      if (!this.ctx.addItem('terminal')) return;
      this.ctx.state.terminal = true;
      this.ctx.effects.ring(this.ctx.actor.position, 0x79e3ec, 3);
      this.ctx.sound('terminal');
      this.reconcile();
      this.saveAtActor();
    });
  }

  private openDoor(): void {
    if (!this.ctx.state.terminal) { this.ctx.notify('台座上的星盘与门锁有相同的纹路。', 'warning'); return; }
    if (this.ctx.state.flags[FLAGS.doorOpen]) return;
    this.ctx.state.flags[FLAGS.doorOpen] = true;
    this.ctx.sound('stone');
    // Overworld reads chamberDoor, so loading restores both mesh and collision.
    for (const collider of this.ctx.world.colliders) if (collider.id === 'chamber-door' || collider.id === 'door' || collider.id === 'chamberDoor') collider.enabled = false;
    this.ctx.notify('石门已开启。空格跳跃，靠近粗糙墙面可攀爬。', 'success');
    this.saveAtActor();
  }

  private leaveChamber(): void {
    const { state } = this.ctx;
    if (state.flags[FLAGS.exitedChamber]) return;
    if (!state.terminal || !state.flags[FLAGS.doorOpen]) { this.ctx.notify('先取走星盘，再开启石门。', 'warning'); return; }
    this.scene('星坠原野 / Asterfall', '长夜留下裂痕，也留下通往晨光的路。\n远处的塔尚未苏醒，山坡下有一缕炊烟。', 5, () => {
      state.flags[FLAGS.exitedChamber] = true;
      if (!state.discovered.includes('outlook')) state.discovered.push('outlook');
      this.reconcile();
      this.saveAtActor();
    });
  }

  private elder(target: Interactable): void {
    if (this.isRoofElder(target)) { this.giveGlider(); return; }
    const { state } = this.ctx;
    if (!state.terminal || !state.flags[FLAGS.exitedChamber]) {
      this.speak('白发旅人', '门后的光，还在等你。先带上属于你的星盘，再来分这堆火。', [{ label: '回去看看', action: () => undefined }]);
      return;
    }
    if (state.glider) {
      this.speak('风里的余声', '我守了一百年的门，你替我推开就好。别把远方走成另一座牢笼。', [{ label: '我会记得', action: () => undefined }]);
      return;
    }
    if (this.allTrials()) {
      this.speak('白发旅人', state.upgrade ? '长了力气，就爬上无名者圣所的高台吧。我在那里等风，也等你。' : '四道星光都回来了。到北方无名者圣所，把它们交给那座空环祭坛。你该为自己许个愿。', [{ label: '前往圣所', action: () => this.reconcile() }]);
      return;
    }
    if (state.completed.length && !state.flags[FLAGS.elderRevisedDeal]) { this.revisedDeal(); return; }
    if (!state.flags[FLAGS.metElder]) {
      state.flags[FLAGS.metElder] = true;
      this.reconcile();
      this.saveAtActor();
    }
    let opening = state.tower ? '风帆的约定还作数。遗迹教的不是服从，是怎样自己找路。' : '醒得正好。风刚把昨夜的灰吹走，苹果也快熟了。';
    if (state.flags[FLAGS.stoleApple] && !state.flags[FLAGS.appleJoke]) {
      state.flags[FLAGS.appleJoke] = true;
      opening = '我的苹果呢？噢，已经开始旅行了。希望它至少替我付半句谢意。';
    }
    this.speak('白发旅人', opening, [
      { label: '这里是什么地方？', action: () => this.speak('白发旅人', '星坠台地。深谷把它圈成一座孤岛，风却从不肯留下。没有风帆，别拿双腿跟深谷争辩。', [{ label: '还有一件事', action: () => this.elder(target) }]) },
      { label: '你是谁？', action: () => this.speak('白发旅人', '一个记得太多路的人。名字像旧鞋，走得久了，总会磨掉几笔。你叫我旅人就好。', [{ label: '说说眼前的路', action: () => this.elder(target) }]) },
      { label: state.tower ? '风帆的交易？' : '我该去哪里？', action: () => {
        if (state.tower) this.offerDeal();
        else this.speak('白发旅人', '去中央的观星之塔，把星盘放上基座。大地会抬高你的目光。别担心下不来，塔身留着阶梯。', [{ label: '我去唤醒它', action: () => this.reconcile() }]);
      } },
      { label: '先烤会儿火', action: () => undefined },
    ]);
  }

  private offerDeal(): void {
    const { state } = this.ctx;
    const revised = state.flags[FLAGS.elderRevisedDeal];
    this.speak('白发旅人', revised ? `风帆等着你，四道星光还差 ${Math.max(0, 4 - new Set(state.completed).size)} 道。我的算术这次可不会再改了。` : '想离开台地？我这张风帆尚能托人。先替我完成一座遗迹，把里面的星核带回来，咱们谈交换。', [{ label: '一言为定', action: () => {
      if (!state.flags[FLAGS.elderDeal]) { state.flags[FLAGS.elderDeal] = true; this.saveAtActor(); }
      this.reconcile();
    } }]);
  }

  private revisedDeal(): void {
    this.ctx.state.flags[FLAGS.elderRevisedDeal] = true;
    this.reconcile();
    this.saveAtActor();
    this.speak('旅人 · 星盘传讯', '一枚？这么快！可风帆有四个角……看来是我把交易说成了算术题。再找齐另外三枚，我保证不临时给它缝第五个角。', [{ label: '你的算术最好到此为止', action: () => undefined }, { label: '四座，我都会去', action: () => undefined }]);
  }

  private activateTower(): void {
    const { state } = this.ctx;
    if (state.tower && state.flags[FLAGS.towerMap] !== false) { this.ctx.notify('区域地图已下载。按 M 查看；沿塔身阶梯可以安全下行。'); return; }
    if (!state.terminal || !state.flags[FLAGS.metElder]) { this.ctx.notify(!state.terminal ? '需要星盘才能唤醒基座。' : '先向营火旁的旅人打听这座塔。', 'warning'); return; }
    // Start world animation now; only an explicit false marks an unfinished activation.
    state.flags[FLAGS.towerMap] = false;
    state.tower = true;
    this.ctx.sound('tower');
    this.ctx.effects.shake(0.7);
    this.scene('大地的回声', '石环旋转，尘土如潮退去。沉在地底的观星之塔托起了天空。\n星盘绘出了台地，也标出四座沉默的遗迹。', 5, () => {
      if (state.flags[FLAGS.towerMap]) return;
      state.flags[FLAGS.towerMap] = true;
      for (const id of ['tower', ...ABILITY_IDS]) if (!state.discovered.includes(id)) state.discovered.push(id);
      const position: Vec3 = [0, this.ctx.world.heightAt(0, 0) + 20, 0];
      this.ctx.actor.teleport(position);
      state.player.stamina = state.player.maxStamina;
      this.reconcile();
      this.saveAtActor();
      this.offerDeal();
    });
  }

  private targetAbility(target: Interactable): AbilityId | undefined {
    return target.ability ?? abilityId(target.data?.ability) ?? abilityId(this.ctx.state.region);
  }
  private abilityName(id: AbilityId): string { return ABILITIES.find(ability => ability.id === id)?.name ?? id; }
  private allTrials(): boolean { return ABILITY_IDS.every(id => this.ctx.state.completed.includes(id)); }
  private isRoofElder(target: Interactable): boolean {
    return target.data?.roof === true || target.data?.role === 'roof' || /roof|final|king/.test(target.id) || (target.position.z < -55 && target.kind === 'elder');
  }

  private enterShrine(target: Interactable): void {
    if (!this.ctx.state.terminal || !this.ctx.state.tower) { this.ctx.notify(!this.ctx.state.terminal ? '遗迹需要星盘验证。' : '先唤醒中央观星之塔，遗迹才会回应。', 'warning'); return; }
    const ability = this.targetAbility(target);
    if (!ability) { this.ctx.notify('这座入口尚未连接星盘。', 'warning'); return; }
    this.scene(target.name, '星盘与石门共鸣。试炼中取得的能力会永远伴随你，未完成时也可从入口返回。', 1.6, () => {
      if (!this.ctx.state.discovered.includes(ability)) this.ctx.state.discovered.push(ability);
      this.clearTransient();
      this.ctx.changeRegion(ability, [0, 0, 9]);
      this.lastRegion = this.ctx.state.region;
      this.saveAtActor();
    });
  }

  private takeAbility(target: Interactable): void {
    const ability = this.targetAbility(target);
    const { state } = this.ctx;
    if (!ability || !state.terminal || !state.tower || state.region !== ability || state.abilities.includes(ability)) return;
    this.scene(`星术接收 · ${this.abilityName(ability)}`, ABILITIES.find(entry => entry.id === ability)?.description ?? '', 2.4, () => {
      if (!state.abilities.includes(ability)) state.abilities.push(ability);
      state.selectedAbility = ability;
      this.ctx.effects.ring(this.ctx.actor.position, 0x8adbe9, 3);
      this.ctx.sound('ability');
      this.saveAtActor();
      this.ctx.notify('能力已获得。完成三道机关后，再到终点领取星核。', 'success');
    });
  }

  private rewardTrial(target: Interactable): void {
    const ability = this.targetAbility(target);
    const { state } = this.ctx;
    if (!ability || state.region !== ability) return;
    if (state.completed.includes(ability)) {
      this.speak('遗迹的回声', '星光已经记住你。这枚星核只会回应一次。', [{ label: '返回台地', action: () => this.returnFromTrial(ability) }, { label: '留在遗迹', action: () => undefined }]);
      return;
    }
    if (!state.abilities.includes(ability) || state.trialStages[ability] < 3) { this.ctx.notify(!state.abilities.includes(ability) ? '先到入口台座接收星术。' : `还需要解开全部三道机关，目前 ${Math.min(3, state.trialStages[ability])}/3。`, 'warning'); return; }
    this.scene('一道星光，属于你', '勇气不是从不迷路，而是在无路处试出下一步。', 3, () => {
      if (state.completed.includes(ability)) return;
      if (!this.ctx.addItem('core')) return;
      state.completed.push(ability);
      state.cores++;
      this.reconcile();
      this.saveAtActor();
      this.speak('遗迹的回声', `获得星核 · ${new Set(state.completed).size}/4\n${this.allTrials() ? '四道星光汇向北方无名者圣所。' : '这份力量不只属于遗迹。带它去原野上试试吧。'}`, [{ label: '返回台地', action: () => this.returnFromTrial(ability) }, { label: '再探索一会儿', action: () => undefined }]);
    });
  }

  private returnFromTrial(ability?: AbilityId): void {
    const id = ability ?? abilityId(this.ctx.state.region);
    if (!id || this.ctx.state.region === 'overworld') return;
    this.scene('重返原野', '星盘保存了你的机关进度。未完成的路，下次仍可以接着走。', 1.4, () => {
      const location = LOCATIONS[id]!;
      this.clearTransient();
      // changeRegion installs the overworld height field before the final ground placement.
      this.ctx.changeRegion('overworld', [location.position[0], 0, location.position[2] + 6]);
      const x = location.position[0];
      const z = location.position[2] + 6;
      this.ctx.actor.teleport([x, this.ctx.world.heightAt(x, z), z]);
      this.lastRegion = this.ctx.state.region;
      this.heldUids = [];
      this.saveAtActor();
      if (this.ctx.state.completed.length >= 1 && !this.ctx.state.flags[FLAGS.elderRevisedDeal] && !this.allTrials()) this.revisedDeal();
    });
  }

  private altar(): void {
    const { state } = this.ctx;
    if (state.upgrade) { this.ctx.notify('星核已经化为力量。攀上圣所高台，旅人在那里等你。'); return; }
    if (!this.allTrials() || state.cores < 4) { this.speak('空环祭坛', `空环里亮起 ${new Set(state.completed).size} 道微光。\n完成四座遗迹，让四枚星核在这里汇合。`, [{ label: '继续寻找星光', action: () => undefined }]); return; }
    this.speak('空环祭坛', '星光不替你决定道路。\n四枚星核，可以化作更强的心火，也可以化作更长的呼吸。只能选择一次。', [
      { label: '心火 · 生命上限 +4', action: () => this.upgrade('heart') },
      { label: '长风 · 精力上限 +40', action: () => this.upgrade('stamina') },
      { label: '让我再想一想', action: () => undefined },
    ]);
  }

  private giveGlider(): void {
    const { state } = this.ctx;
    if (state.glider) { this.ctx.notify('风帆已经属于你。向台地边缘飞去，原野没有终点。'); return; }
    if (!state.upgrade || !this.allTrials()) { this.ctx.notify('先在圣所内的空环祭坛奉献四枚星核。', 'warning'); return; }
    this.speak('白发旅人', '故事讲到这里，总得有个真名字。\n我是烬星王国最后的王，洛岚。也是一个没能守住家园的人留下的回声。', [{ label: '一百年前发生了什么？', action: () => {
      this.scene('最后的守望者', '「一百年前，天隙吞下了王城。我们把希望锁进石室，却忘了希望也需要选择。」\n旅人的轮廓化作星尘。\n「城堡里仍有一盏灯没灭。带着这张逐风帆去看看吧——不是王的命令，是一个守门人的请求。」', 6, () => {
        if (state.glider || !this.ctx.addItem('glider')) return;
        state.glider = true;
        this.reconcile();
        this.ctx.sound('glider');
        this.ctx.effects.burst(this.ctx.actor.position.clone().add(new THREE.Vector3(0, 1.5, 0)), 0xf7d998, 30);
        this.saveAtActor();
        this.ctx.notify('获得逐风帆！下落时按住空格展开，滑翔越过半径145的台地边缘。', 'success');
      });
    } }, { label: '我还想准备一下', action: () => undefined }]);
  }

  private lootCount(target: Interactable): number { return positiveCount(target.data?.count, target.item === 'arrows' ? 10 : 1); }
  private grantLoot(id: string, count: number, extra?: Partial<InventoryItem>): boolean {
    if (!ITEMS[id]) { this.ctx.notify('这件物品暂时无法收纳。', 'warning'); return false; }
    if (!this.ctx.addItem(id, count, extra)) {
      this.ctx.notify(`${ITEMS[id].name}未拾取：装备槽已满，请在背包丢弃一件同类装备后重试。`, 'warning');
      return false;
    }
    if (ITEMS[id].category === 'weapon' && !this.ctx.state.equipment.weapon) {
      const item = [...this.ctx.state.inventory].reverse().find(entry => entry.id === id);
      if (item) this.ctx.state.equipment.weapon = item.uid;
    }
    if (ITEMS[id].category === 'weapon' && !this.ctx.state.flags[FLAGS.weaponTutorial]) {
      this.ctx.state.flags[FLAGS.weaponTutorial] = true;
      this.ctx.notify('左键攻击；长按蓄力。有效命中消耗耐久，背包可更换装备。');
    }
    this.ctx.notify(`获得 ${extra?.name ?? ITEMS[id].name} ×${count}`, 'success');
    this.ctx.sound('pickup');
    return true;
  }

  private takePickup(target: Interactable): void {
    if (!target.item || this.ctx.state.flags[FLAGS.picked(target.id)]) return;
    const extra: Partial<InventoryItem> = {};
    for (const key of ['durability', 'heal', 'cold', 'energy'] as const) if (typeof target.data?.[key] === 'number') extra[key] = target.data[key] as number;
    if (typeof target.data?.itemName === 'string') extra.name = target.data.itemName;
    if (!this.grantLoot(target.item, this.lootCount(target), extra)) return;
    this.ctx.state.flags[FLAGS.picked(target.id)] = true;
    if (target.mesh) target.mesh.visible = false;
    if (target.item === 'roastApple' && !target.id.startsWith('drop:')) this.ctx.state.flags[FLAGS.stoleApple] = true;
  }

  /** Some world chests are meshes rather than ability targets; adapt them without replacing world ownership. */
  private prepareInteractions(): void {
    const { world } = this.ctx;
    if (this.preparedWorld === world) return;
    this.preparedWorld = world;
    this.movableChests = [];
    for (const chest of world.interactables) {
      if (chest.kind !== 'chest') continue;
      const requirement = abilityId(chest.data?.requires ?? chest.data?.requireAbility);
      if (!requirement) continue;
      const explicit = chest.data?.targetId ?? chest.data?.target;
      if (requirement === 'bomb' && !explicit) {
        const barrier = world.targets.filter(object => object.kind === 'cracked' && object.position.distanceTo(chest.position) < 6)
          .sort((a, b) => a.position.distanceToSquared(chest.position) - b.position.distanceToSquared(chest.position))[0];
        if (barrier) { chest.data ??= {}; chest.data.targetId = barrier.id; }
      }
      if (requirement !== 'magnet' || !chest.mesh) continue;
      let object = world.targets.find(candidate => candidate.id === (explicit ?? chest.id) || candidate.mesh === chest.mesh);
      if (!object && !explicit) {
        chest.mesh.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(chest.mesh);
        if (box.isEmpty()) box.setFromCenterAndSize(chest.position, new THREE.Vector3(1.4, 0.9, 0.9));
        const collider = { id: `${chest.id}:body`, box, climbable: true, enabled: true, mesh: chest.mesh };
        world.colliders.push(collider);
        const position = chest.mesh.getWorldPosition(new THREE.Vector3());
        object = { id: chest.id, kind: 'metal', mesh: chest.mesh, position, origin: [position.x, position.y, position.z], velocity: new THREE.Vector3(), collider };
        world.targets.push(object);
      }
      if (object && object.mesh === chest.mesh) this.movableChests.push({ chest, object, offset: chest.position.clone().sub(object.position) });
    }
  }

  private syncMovingChests(): void {
    for (const { chest, object, offset } of this.movableChests) {
      chest.position.copy(object.position).add(offset);
      if (manipulated(object)) this.ctx.state.flags[FLAGS.solved(chest.id)] = true;
      if (this.ctx.state.flags[FLAGS.opened(chest.id)]) {
        object.solved = true;
        if (object.collider) object.collider.enabled = false;
      }
    }
  }

  private chestRequirement(target: Interactable): string | null {
    const { state, world } = this.ctx;
    const camp = typeof target.data?.lockedCamp === 'string' ? target.data.lockedCamp : target.data?.lockedCamp ? String(target.data?.camp ?? '') : '';
    if (camp) {
      const guards = world.spawns.filter(spawn => spawn.camp === camp);
      if (!guards.length || guards.some(spawn => !state.enemies[spawn.id]?.dead)) return `营地封印 · 先击败${LOCATIONS[camp]?.name ?? camp}全部守卫`;
    } else if (target.data?.lockedCamp) return '营地封印尚未解除';
    const requirement = abilityId(target.data?.requires ?? target.data?.requireAbility);
    if (requirement) {
      if (!state.abilities.includes(requirement)) return `需要星术 · ${this.abilityName(requirement)}`;
      const targetId = String(target.data?.targetId ?? target.data?.target ?? target.id);
      const object = world.targets.find(candidate => candidate.id === targetId || candidate.mesh === target.mesh);
      const physicallySolved = Boolean(state.flags[FLAGS.solved(targetId)] || state.flags[FLAGS.solved(target.id)] || state.flags[`broken:${targetId}`] || state.flags[`destroyed:${targetId}`] || target.data?.solved === true || object?.solved || object?.mesh.userData.solved === true || manipulated(object));
      if (!physicallySolved) return requirement === 'magnet' ? '用牵星移开金属阻挡或拉出宝箱' : requirement === 'bomb' ? '用鸣爆炸开封箱岩障' : '先操作附近的星术机关';
    }
    return null;
  }

  private openChest(target: Interactable): void {
    if (this.ctx.state.flags[FLAGS.opened(target.id)]) return;
    const requirement = this.chestRequirement(target);
    if (requirement) { this.ctx.notify(requirement, 'warning'); return; }
    if (!target.item || !this.grantLoot(target.item, this.lootCount(target))) return;
    this.ctx.state.flags[FLAGS.opened(target.id)] = true;
    if (target.mesh) target.mesh.userData.opened = true;
    this.ctx.effects.burst(target.position.clone().add(new THREE.Vector3(0, 0.7, 0)), 0xf4d387, 18);
    this.ctx.sound('chest');
    this.saveAtActor();
  }

  private treeEmpty(target: Interactable): boolean {
    const flags = this.ctx.state.flags;
    return Boolean(target.data?.apples === 0 || target.data?.pine === true || flags[FLAGS.apples(target.id)] || flags[`apples:${target.id}`] || flags[FLAGS.chopped(target.id)] || flags[FLAGS.picked(target.id)] || target.data?.applesTaken === true || target.data?.chopped === true);
  }

  private shakeTree(target: Interactable): void {
    if (this.treeEmpty(target)) return;
    const { state, world } = this.ctx;
    const apples = world.targets.filter(apple => apple.resource === 'apple' && apple.mesh.userData.treeId === target.id && apple.attached !== false && !apple.solved && !state.flags[FLAGS.picked(apple.id)]);
    for (const [index, apple] of apples.entries()) {
      const dx = apple.position.x - target.position.x;
      const dz = apple.position.z - target.position.z;
      const angle = Math.hypot(dx, dz) > 0.01 ? Math.atan2(dz, dx) : index / apples.length * Math.PI * 2;
      apple.attached = false;
      apple.velocity ??= new THREE.Vector3();
      apple.velocity.set(Math.cos(angle) * 1.2, 0.6, Math.sin(angle) * 1.2);
    }
    // FLAGS.apples is shaken:<treeId>; world pickup IDs persist each apple separately.
    state.flags[FLAGS.apples(target.id)] = true;
    this.ctx.effects.burst(target.position.clone().add(new THREE.Vector3(0, 3, 0)), 0xd99565, 10);
    this.ctx.sound('leaves');
  }

  private consume(item: InventoryItem, count = 1): void {
    item.count -= Math.min(item.count, Math.max(0, count));
    if (item.count <= 0) {
      const index = this.ctx.state.inventory.indexOf(item);
      if (index >= 0) this.ctx.state.inventory.splice(index, 1);
      for (const slot of Object.keys(this.ctx.state.equipment) as (keyof GameState['equipment'])[]) {
        if (this.ctx.state.equipment[slot] === item.uid || this.ctx.state.equipment[slot] === item.id) this.ctx.state.equipment[slot] = null;
      }
    }
    this.pruneHeld();
  }

  private pruneHeld(): void {
    const used = new Map<string, number>();
    this.heldUids = this.heldUids.filter(uid => {
      const item = findInventoryItem(this.ctx.state, uid);
      const count = (used.get(uid) ?? 0) + 1;
      if (!item || !canHoldIngredient(item.id) || count > item.count) return false;
      used.set(uid, count);
      return true;
    });
  }

  private eat(item: InventoryItem): void {
    const effects = foodEffects(item);
    if (!effects) { this.ctx.notify('不能直接食用；试着搭配食材烹饪。', 'warning'); return; }
    const time = now();
    if (this.ctx.inCombat && time - this.lastEatAt < FOOD_COOLDOWN_MS) { this.ctx.notify(`战斗中需要缓一口气 · ${Math.ceil((FOOD_COOLDOWN_MS - (time - this.lastEatAt)) / 1000)}秒`, 'warning'); return; }
    const player = this.ctx.state.player;
    if (!((effects.heal > 0 && player.hp < player.maxHp) || (effects.energy > 0 && player.stamina < player.maxStamina) || effects.cold > player.coldResist)) { this.ctx.notify('当前无需补充这种料理的效果。'); return; }
    player.hp = Math.min(player.maxHp, player.hp + effects.heal);
    player.stamina = Math.min(player.maxStamina, player.stamina + effects.energy);
    player.coldResist = Math.max(player.coldResist, effects.cold);
    this.lastEatAt = time;
    this.consume(item);
    this.ctx.sound('eat');
    this.ctx.notify(`食用 ${item.name ?? ITEMS[item.id]?.name ?? item.id}`, 'success');
  }

  private dropItem(item: InventoryItem): void {
    const p = this.ctx.actor.position.clone().addScaledVector(this.ctx.actor.facing, 1.3);
    p.y = Math.max(this.ctx.world.heightAt(p.x, p.z) + 0.3, this.ctx.actor.position.y + 0.3);
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.23, 0), new THREE.MeshStandardMaterial({ color: ITEMS[item.id]?.color ?? '#ded6bd', roughness: 0.8, emissive: '#322919' }));
    mesh.position.copy(p);
    mesh.castShadow = true;
    const data: NonNullable<Interactable['data']> = { count: 1 };
    for (const key of ['durability', 'heal', 'cold', 'energy'] as const) if (item[key] !== undefined) data[key] = item[key]!;
    if (item.name) data.itemName = item.name;
    const target: Interactable = { id: `drop:${item.uid}:${Date.now().toString(36)}-${++this.dropSerial}`, kind: 'pickup', name: item.name ?? ITEMS[item.id]?.name ?? item.id, item: item.id, position: p, radius: 2, mesh, data };
    this.ctx.world.root.add(mesh);
    this.ctx.world.interactables.push(target);
    this.drops.push({ target, world: this.ctx.world, mesh });
    this.consume(item);
    this.ctx.notify('已放在脚边，可再次拾取。离开区域后地面掉落物不保留。');
  }

  private fireLit(target: Interactable): boolean {
    const { state } = this.ctx;
    if (state.flags[FLAGS.extinguished(target.id)]) return false;
    if (target.data?.lit === false && !state.flags[FLAGS.lit(target.id)]) return false;
    const sheltered = target.data?.sheltered === true || target.data?.covered === true;
    return state.weather !== 'rain' || sheltered || state.region !== 'overworld';
  }

  private nearbyFire(): Interactable | undefined {
    return this.ctx.world.interactables.find(target => (target.kind === 'campfire' || target.kind === 'pot') && this.ctx.actor.position.distanceTo(target.position) <= FIRE_RADIUS);
  }

  private lightFire(target: Interactable, wood?: InventoryItem): void {
    if (this.fireLit(target)) { this.ctx.notify('火已经燃着了，不必再添木材。'); return; }
    if (this.ctx.state.weather === 'rain' && this.ctx.state.region === 'overworld' && target.data?.sheltered !== true && target.data?.covered !== true) { this.ctx.notify('雨水太大，先去有屋檐的火堆。', 'warning'); return; }
    const equipped = this.ctx.state.equipment.weapon;
    const torch = equipped && findInventoryItem(this.ctx.state, equipped)?.id === 'torch' && this.ctx.state.flags.torchLit;
    const fuel = wood ?? findInventoryItem(this.ctx.state, 'wood');
    if (!torch && !fuel) { this.ctx.notify('需要一份干木材，或装备点燃的火把。', 'warning'); return; }
    if (!torch && fuel) this.consume(fuel);
    // A pot and campfire can share a hearth even when their prompts are offset.
    const fires = [target, ...this.ctx.world.interactables.filter(fire => fire !== target && (fire.kind === 'campfire' || fire.kind === 'pot') && ((target.mesh && fire.mesh === target.mesh) || fire.position.distanceTo(target.position) <= 1.5))];
    for (const fire of fires) {
      this.ctx.state.flags[FLAGS.lit(fire.id)] = true;
      this.ctx.state.flags[FLAGS.extinguished(fire.id)] = false;
      fire.data ??= {};
      fire.data.lit = true;
    }
    this.ctx.effects.burst(target.position, 0xf4b56d, 12);
    this.ctx.sound('fire');
    this.ctx.notify('火重新燃起来了。', 'success');
  }

  private campfire(target: Interactable): void {
    if (this.ctx.inCombat) { this.ctx.notify('敌人还在附近，暂时不能休息。', 'warning'); return; }
    this.speak('营火', '让火星替你数一会儿时间。雨声会过去，路也不会走丢。', [
      { label: '等到清晨 · 06:00', action: () => this.waitAtFire(target, 6) },
      { label: '等到正午 · 12:00', action: () => this.waitAtFire(target, 12) },
      { label: '等到夜晚 · 21:00', action: () => this.waitAtFire(target, 21) },
      { label: '继续赶路', action: () => undefined },
    ]);
  }

  private waitAtFire(target: Interactable, hour: number): void {
    if (this.ctx.inCombat || !this.fireLit(target)) { this.ctx.notify('现在无法安心休息。', 'warning'); return; }
    this.scene('火星慢慢落下', hour === 6 ? '第一声鸟鸣越过山脊。' : hour === 12 ? '日光停在树梢，影子渐渐缩短。' : '暮色翻过石墙，星光重新亮起。', 2, () => {
      const state = this.ctx.state;
      const difference = (hour - state.time + 24) % 24 || 24;
      advanceClock(state, difference / 24 * CONFIG.dayDuration, false);
      state.time = hour;
      state.player.coldResist = Math.max(0, state.player.coldResist - difference / 24 * CONFIG.dayDuration);
      state.player.stamina = state.player.maxStamina;
      this.coldClock = 0;
      this.saveAtActor();
    });
  }

  private updateTemperature(dt: number): void {
    const { state, actor } = this.ctx;
    const player = state.player;
    const hadResistance = player.coldResist > 0;
    player.coldResist = Math.max(0, player.coldResist - dt);
    const cold = state.region === 'overworld' && ((actor.position.x < -38 && actor.position.z < -38) || actor.position.y > 37);
    const clothes = state.equipment.clothes ? findInventoryItem(state, state.equipment.clothes) : undefined;
    const fire = this.ctx.world.interactables.some(target => (target.kind === 'campfire' || target.kind === 'pot') && actor.position.distanceTo(target.position) < FIRE_RADIUS && this.fireLit(target));
    const weapon = state.equipment.weapon ? findInventoryItem(state, state.equipment.weapon) : undefined;
    const torch = weapon?.id === 'torch' && state.flags.torchLit && state.weather !== 'rain';
    const exposed = cold && clothes?.id !== 'warmcoat' && player.coldResist <= 0 && !fire && !torch;
    if (exposed && !this.wasCold) {
      this.ctx.notify(hadResistance ? '御寒效果结束！寻找火源或食用御寒料理。' : '寒意刺骨：每7秒损失生命。冬衣、御寒料理和火源可以保护你。', 'warning');
      state.flags[FLAGS.coldWarning] = true;
    }
    if (exposed) {
      this.coldClock += dt;
      if (this.coldClock >= CONFIG.coldInterval) {
        this.coldClock -= CONFIG.coldInterval;
        this.ctx.damage(1, '寒冷');
        this.ctx.sound('cold');
      }
    } else this.coldClock = 0;
    this.wasCold = exposed;
  }

  private updateTorch(dt: number): void {
    const { state } = this.ctx;
    const weapon = state.equipment.weapon ? findInventoryItem(state, state.equipment.weapon) : undefined;
    if (state.weather === 'rain' || state.player.movement === 'swim') {
      if (state.flags.torchLit) this.ctx.notify('水熄灭了火把。');
      state.flags.torchLit = false;
    }
    if (weapon?.id !== 'torch') { this.torchClock = 0; state.flags.torchLit = false; return; }
    const fire = this.nearbyFire();
    if (fire && this.fireLit(fire) && !state.flags.torchLit && state.weather !== 'rain' && state.player.movement !== 'swim') {
      state.flags.torchLit = true;
      this.ctx.notify('火把已点燃，可以带走一小团温暖。');
    }
    if (!state.flags.torchLit) return;
    this.torchClock += dt;
    if (this.torchClock >= 3) {
      this.torchClock -= 3;
      weapon.durability = Math.max(0, (weapon.durability ?? ITEMS.torch!.durability ?? 30) - 1);
      if (weapon.durability === 0) {
        state.flags.torchLit = false;
        this.consume(weapon);
        this.ctx.notify('火把燃尽了。', 'warning');
        this.ctx.sound('break');
      }
    }
  }
}
