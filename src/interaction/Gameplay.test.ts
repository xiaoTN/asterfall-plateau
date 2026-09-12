import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config/game';
import { addItem, ITEMS } from '../config/items';
import { createState } from '../core/state';
import type { AbilityId, Dialogue, GameContext, Interactable, Vec3, WorldView } from '../core/types';
import { FLAGS, reconcileQuest } from '../quests/progression';
import { Gameplay } from './Gameplay';
import { cookRecipe } from './recipes';

function fixture() {
  const state = createState();
  let dialogue: Dialogue | undefined;
  const cinematics: { done?: () => void }[] = [];
  const saves: { region: string; position: Vec3 }[] = [];
  const world = (): WorldView => ({ root: new THREE.Group(), colliders: [], interactables: [], targets: [], waters: [], spawns: [], heightAt: () => 0, update: () => undefined, dispose: () => undefined });
  const ctx: GameContext = {
    state, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    input: { down: () => false, pressed: () => false, released: () => false, clear: () => undefined, mouseDX: 0, mouseDY: 0, wheel: 0 },
    world: world(), actor: { position: new THREE.Vector3(), velocity: new THREE.Vector3(), facing: new THREE.Vector3(0, 0, -1), grounded: true, model: new THREE.Group(), teleport(p) { this.position.fromArray(p); } },
    effects: { burst: vi.fn(), ring: vi.fn(), shake: vi.fn() }, elapsed: 0, realDt: 0.05, timeScale: 1, inCombat: false,
    notify: vi.fn(), sound: vi.fn(), damage: vi.fn(), addItem: (id, count, extra) => addItem(ctx.state, id, count, extra),
    save: () => saves.push({ region: ctx.state.region, position: [...ctx.state.player.position] }),
    changeRegion: (region, position) => { ctx.state.region = region; ctx.world = world(); ctx.actor.teleport(position ?? [0, 0, 9]); },
    cinematic: (_title, _text, _duration, done) => { cinematics.push({ done }); },
  };
  const gameplay = new Gameplay(ctx, value => { dialogue = value; });
  function target(kind: Interactable['kind'], extra: Partial<Interactable> = {}): Interactable {
    const result: Interactable = { id: kind, kind, name: kind, position: ctx.actor.position.clone(), radius: 3.4, ...extra };
    ctx.world.interactables.push(result);
    return result;
  }
  function finish(): void { cinematics.shift()?.done?.(); }
  function choose(index: number): void { const option = dialogue?.options[index]; if (!option) throw new Error('Missing dialogue option'); dialogue = undefined; option.action(); }
  function tick(seconds: number): void { for (let i = 0; i < Math.ceil(seconds / 0.05); i++) gameplay.update(0.05); }
  return { ctx, state, gameplay, cinematics, saves, target, finish, choose, tick, dialogue: () => dialogue };
}

afterEach(() => vi.restoreAllMocks());

describe('item insertion', () => {
  it('provides every required item and six genuinely distinct melee profiles', () => {
    for (const id of ['branch', 'axe', 'torch', 'sword', 'spear', 'club', 'bow', 'shield', 'arrows', 'shirt', 'trousers', 'warmcoat', 'apple', 'pepper', 'mushroom', 'meat', 'wood', 'monster', 'herb', 'insect', 'roastApple', 'meal', 'terminal', 'core', 'glider']) expect(ITEMS[id]).toBeDefined();
    const weapons = Object.values(ITEMS).filter(item => item.category === 'weapon');
    expect(weapons).toHaveLength(6);
    expect(new Set(weapons.map(item => `${item.attack}/${item.range}/${item.speed}`)).size).toBe(6);
  });
  it('rejects overflow atomically rather than swallowing part of the loot', () => {
    const state = createState();
    expect(addItem(state, 'branch', CONFIG.weaponSlots - 1)).toBe(true);
    const before = JSON.stringify(state.inventory);
    expect(addItem(state, 'sword', 2)).toBe(false);
    expect(JSON.stringify(state.inventory)).toBe(before);
    expect(addItem(state, 'sword')).toBe(true);
    expect(addItem(state, 'axe')).toBe(false);
    expect(addItem(state, 'bow')).toBe(true);
  });
  it('rejects invalid counts and identity overrides, retains food variants', () => {
    const state = createState();
    for (const count of [0, -1, 1.5, Infinity, NaN]) expect(addItem(state, 'apple', count)).toBe(false);
    expect(addItem(state, 'not-an-item')).toBe(false);
    expect(addItem(state, 'apple', 2, { id: 'sword', uid: 'bad', count: 100 })).toBe(true);
    expect(state.inventory[0]).toMatchObject({ id: 'apple', count: 2 });
    expect(state.inventory[0]!.uid).not.toBe('bad');
    addItem(state, 'meal', 1, { name: '暖汤', cold: 120 });
    addItem(state, 'meal', 1, { name: '草汤', energy: 40 });
    addItem(state, 'meal', 1, { name: '暖汤', cold: 120 });
    expect(state.inventory.filter(item => item.id === 'meal')).toHaveLength(2);
    expect(state.inventory.find(item => item.name === '暖汤')!.count).toBe(2);
  });
});

describe('deterministic recipes', () => {
  it('combines food healing and extends same-effect protection', () => {
    const single = cookRecipe(['pepper']);
    const meal = cookRecipe(['pepper', 'pepper', 'meat']);
    expect(meal.heal).toBeGreaterThan(single.heal);
    expect(meal.cold).toBeGreaterThan(single.cold);
    expect(cookRecipe(['apple', 'meat'])).toEqual(cookRecipe(['meat', 'apple']));
  });
  it('cancels conflicting cold/stamina effects without removing food healing', () => {
    const result = cookRecipe(['pepper', 'herb', 'apple']);
    expect(result.cold).toBe(0);
    expect(result.energy).toBe(0);
    expect(result.heal).toBeGreaterThan(0);
  });
  it('has two usable elixirs and safe failed recipes', () => {
    expect(cookRecipe(['monster', 'insect'])).toMatchObject({ kind: 'elixir', name: '回风药剂', cold: 0 });
    expect(cookRecipe(['monster', 'insect']).energy).toBeGreaterThan(0);
    expect(cookRecipe(['monster', 'insect', 'pepper'])).toMatchObject({ kind: 'elixir', name: '暖星药剂', energy: 0 });
    expect(cookRecipe(['monster', 'insect', 'pepper']).cold).toBeGreaterThan(0);
    for (const ingredients of [[], ['wood'], ['monster'], ['monster', 'apple'], Array<string>(6).fill('apple')]) expect(cookRecipe(ingredients).kind).toBe('dubious');
  });
});

describe('progression and guarded rewards', () => {
  it('awakens on active update and never regresses an advanced quest', () => {
    const f = fixture();
    f.gameplay.update(0.05);
    expect(f.state.quest).toBe('GET_TERMINAL');
    f.state.quest = 'RECEIVE_GLIDER';
    f.state.terminal = true;
    reconcileQuest(f.state);
    expect(f.state.quest).toBe('RECEIVE_GLIDER');
  });
  it('hard-gates the door and exit, then saves after the exit cinematic', () => {
    const f = fixture();
    const door = f.target('door');
    const exit = f.target('exit');
    f.gameplay.interact(door);
    f.gameplay.interact(exit);
    expect(f.state.flags[FLAGS.doorOpen]).toBeUndefined();
    expect(f.cinematics).toHaveLength(0);
    f.gameplay.interact(f.target('terminal'));
    const callback = f.cinematics[0]!.done!;
    f.finish(); callback();
    expect(f.state.inventory.filter(item => item.id === 'terminal')).toHaveLength(1);
    expect(f.saves).toHaveLength(1);
    f.gameplay.interact(door);
    f.gameplay.interact(exit);
    expect(f.state.flags.exitedChamber).toBeUndefined();
    f.finish();
    expect(f.state.flags.exitedChamber).toBe(true);
    expect(f.state.quest).toBe('MEET_ELDER');
  });
  it('requires meeting the elder and restores the player to the safe tower top', () => {
    const f = fixture();
    f.state.terminal = true;
    f.ctx.world.heightAt = () => 7;
    const tower = f.target('tower');
    f.gameplay.interact(tower);
    expect(f.cinematics).toHaveLength(0);
    f.state.flags.metElder = true;
    f.gameplay.interact(tower);
    expect(f.state.tower).toBe(true); // Starts the physical rise before the cinematic finishes.
    expect(f.state.discovered).not.toContain('ice');
    f.finish();
    expect(f.state.tower).toBe(true);
    expect(f.ctx.actor.position.toArray()).toEqual([0, 27, 0]);
    expect(f.state.safePosition).toEqual([0, 27, 0]);
    expect(f.state.discovered).toContain('ice');
  });
  it('gates shrine entry and saves its new region, not the old region', () => {
    const f = fixture();
    const shrine = f.target('shrine', { ability: 'bomb' });
    f.gameplay.interact(shrine);
    expect(f.cinematics).toHaveLength(0);
    f.state.terminal = f.state.tower = true;
    f.gameplay.interact(shrine);
    f.finish();
    expect(f.saves.at(-1)).toEqual({ region: 'bomb', position: [0, 0, 9] });
  });
  it('does not confuse receiving an ability with completing its trial', () => {
    const f = fixture();
    f.state.region = 'magnet'; f.state.terminal = f.state.tower = true;
    const ability = f.target('ability', { ability: 'magnet' });
    const reward = f.target('reward', { ability: 'magnet' });
    f.gameplay.interact(ability); f.finish();
    expect(f.state.abilities).toEqual(['magnet']);
    expect(f.state.completed).toEqual([]);
    f.gameplay.interact(reward);
    expect(f.state.cores).toBe(0);
    f.state.trialStages.magnet = 3;
    f.gameplay.interact(reward);
    const callback = f.cinematics[0]!.done!;
    f.finish(); callback();
    expect(f.state.cores).toBe(1);
    expect(f.state.completed).toEqual(['magnet']);
    expect(f.state.inventory.find(item => item.id === 'core')!.count).toBe(1);
    f.choose(0); f.finish();
    expect(f.state.region).toBe('overworld');
    expect(f.state.flags.elderRevisedDeal).toBe(true);
  });
  it('can leave an unfinished trial without losing ability or puzzle progress', () => {
    const f = fixture();
    f.state.region = 'ice'; f.state.abilities = ['ice']; f.state.trialStages.ice = 1;
    f.gameplay.interact(f.target('return', { ability: 'ice' })); f.finish();
    expect(f.state.region).toBe('overworld');
    expect(f.state.abilities).toEqual(['ice']);
    expect(f.state.trialStages.ice).toBe(1);
    expect(f.state.cores).toBe(0);
  });
  it.each(['heart', 'stamina'] as const)('exchanges cores for %s once and grants the glider only after the final dialogue', type => {
    const f = fixture();
    f.state.completed = ['magnet', 'bomb', 'stasis', 'ice']; f.state.cores = 4; addItem(f.state, 'core', 4);
    f.target('altar');
    f.gameplay.upgrade(type); f.finish();
    f.gameplay.upgrade(type);
    expect(f.state.cores).toBe(0);
    expect(f.state.inventory.some(item => item.id === 'core')).toBe(false);
    expect(f.state.player.maxHp).toBe(type === 'heart' ? 16 : 12);
    expect(f.state.player.maxStamina).toBe(type === 'stamina' ? 140 : 100);
    f.gameplay.interact(f.target('elder', { id: 'roof-elder', data: { roof: true } }));
    expect(f.state.glider).toBe(false);
    f.choose(0); f.finish();
    expect(f.state.glider).toBe(true);
    expect(f.state.quest).toBe('PROLOGUE_COMPLETE');
    expect(f.state.flags.prologueComplete).toBeUndefined();
    f.ctx.actor.position.set(CONFIG.radius + 1, 10, 0);
    f.state.player.movement = 'fall'; f.gameplay.update(0.05);
    expect(f.cinematics).toHaveLength(0);
    f.state.player.movement = 'glide'; f.gameplay.update(0.05); f.finish();
    expect(f.state.flags.prologueComplete).toBe(true);
    const saveCount = f.saves.length;
    f.gameplay.update(0.05);
    expect(f.saves.length).toBe(saveCount);
  });
  it('invalidates cinematic callbacks and stale dialogue actions after clearing transients', () => {
    const f = fixture();
    f.gameplay.interact(f.target('terminal'));
    f.gameplay.clearTransient(); f.finish();
    expect(f.state.terminal).toBe(false);
    f.state.completed = ['magnet', 'bomb', 'stasis', 'ice']; f.state.cores = 4;
    f.gameplay.interact(f.target('altar'));
    const action = f.dialogue()!.options[0]!.action;
    f.gameplay.clearTransient(); action();
    expect(f.state.upgrade).toBeNull();
  });
});

describe('gathering, cooking and survival', () => {
  it('preserves a chest when full and requires every matching camp spawn to be dead', () => {
    const f = fixture();
    f.ctx.world.spawns = [{ id: 'guard1', type: 'melee', position: [0, 0, 0], camp: 'camp1' }, { id: 'guard2', type: 'archer', position: [0, 0, 0], camp: 'camp1' }];
    const chest = f.target('chest', { item: 'sword', data: { lockedCamp: 'camp1' } });
    f.state.enemies.guard1 = { hp: 0, dead: true };
    f.gameplay.interact(chest);
    expect(f.state.inventory).toHaveLength(0);
    f.state.enemies.guard2 = { hp: 0, dead: true };
    addItem(f.state, 'branch', CONFIG.weaponSlots);
    f.gameplay.interact(chest);
    expect(f.state.flags[FLAGS.opened(chest.id)]).toBeUndefined();
    f.state.inventory.pop();
    f.gameplay.interact(chest);
    expect(f.state.flags[FLAGS.opened(chest.id)]).toBe(true);
    expect(f.gameplay.getPrompt(chest)).toBeNull();
  });
  it('requires ability plus physical manipulation for an ability chest', () => {
    const f = fixture();
    const chest = f.target('chest', { item: 'arrows', data: { requires: 'magnet', targetId: 'metal-lid' } });
    f.state.abilities = ['magnet'];
    f.gameplay.interact(chest);
    expect(f.state.inventory).toHaveLength(0);
    f.state.flags['solved:metal-lid'] = true;
    f.gameplay.interact(chest);
    expect(f.state.inventory[0]).toMatchObject({ id: 'arrows', count: 10 });
  });
  it('adapts real metal chest meshes and follows lifting without accepting passive sinking', () => {
    const f = fixture();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 0.9), new THREE.MeshBasicMaterial());
    f.ctx.world.root.add(mesh);
    const chest = f.target('chest', { id: 'lake-metal', item: 'spear', mesh, data: { requires: 'magnet' } });
    const gameplay = new Gameplay(f.ctx, () => undefined);
    f.state.abilities = ['magnet'];
    const object = f.ctx.world.targets.find(target => target.id === chest.id)!;
    expect(object.kind).toBe('metal');
    object.position.y = -4;
    gameplay.update(0.05);
    expect(f.state.flags[FLAGS.solved(chest.id)]).not.toBe(true);
    expect(gameplay.getPrompt(chest)).toContain('牵星');
    object.position.set(2, 1, 0);
    gameplay.update(0.05);
    expect(chest.position.toArray()).toEqual([2, 1, 0]);
    expect(f.state.flags[FLAGS.solved(chest.id)]).toBe(true);
    gameplay.interact(chest);
    expect(f.state.inventory[0]!.id).toBe('spear');
    mesh.geometry.dispose(); mesh.material.dispose();
  });
  it('links a bomb chest to its nearest physical cracked barrier', () => {
    const f = fixture();
    const chest = f.target('chest', { item: 'bow', data: { requires: 'bomb' } });
    f.ctx.world.targets.push({ id: 'barrier', kind: 'cracked', mesh: new THREE.Group(), position: new THREE.Vector3(0, 0, 2) });
    const gameplay = new Gameplay(f.ctx, () => undefined);
    f.state.abilities = ['bomb'];
    expect(chest.data!.targetId).toBe('barrier');
    gameplay.interact(chest);
    expect(f.state.inventory).toHaveLength(0);
    f.state.flags['broken:barrier'] = true;
    gameplay.interact(chest);
    expect(f.state.inventory[0]!.id).toBe('bow');
  });
  it('shakes apple trees once, honors combat collection, and never shakes fruit from pine trees', () => {
    const f = fixture();
    const tree = f.target('tree', { id: 'apple-tree', data: { apples: 3 } });
    for (let n = 0; n < 3; n++) {
      const mesh = new THREE.Group(); mesh.userData.treeId = tree.id;
      f.ctx.world.targets.push({ id: `fruit-${n}`, kind: 'orb', resource: 'apple', attached: true, mesh, position: new THREE.Vector3(n, 3, 0) });
    }
    f.gameplay.interact(tree); f.gameplay.interact(tree);
    expect(f.state.inventory).toHaveLength(0);
    expect(f.ctx.world.targets.every(apple => apple.attached === false && apple.velocity!.y > 0)).toBe(true);
    expect(f.gameplay.getPrompt(tree)).toBeNull();
    const pine = f.target('tree', { id: 'pine', data: { apples: 0, pine: true } });
    f.gameplay.interact(pine);
    expect(f.state.inventory).toHaveLength(0);
    delete f.state.flags[FLAGS.apples(tree.id)];
    expect(f.gameplay.getPrompt(tree)).not.toBeNull();
    f.state.flags[`apples:${tree.id}`] = true;
    expect(f.gameplay.getPrompt(tree)).toBeNull();
  });
  it('limits held materials, commits cooking only after the cinematic, and consumes exact units', () => {
    const f = fixture();
    addItem(f.state, 'apple', 6);
    const uid = f.state.inventory[0]!.uid;
    for (let i = 0; i < 6; i++) f.gameplay.inventoryAction('hold', uid);
    expect(f.gameplay.held).toHaveLength(5);
    f.target('pot', { data: { lit: true } });
    f.gameplay.cook();
    expect(f.state.inventory[0]!.count).toBe(6);
    f.gameplay.inventoryAction('eat', uid);
    expect(f.state.inventory[0]!.count).toBe(6);
    f.finish();
    expect(f.state.inventory.find(item => item.id === 'apple')!.count).toBe(1);
    expect(f.state.inventory.find(item => item.id === 'meal')!.heal).toBe(15);
    expect(f.gameplay.held).toHaveLength(0);
  });
  it('returns all reserved ingredients when cooking is interrupted', () => {
    const f = fixture();
    addItem(f.state, 'pepper');
    f.gameplay.inventoryAction('hold', f.state.inventory[0]!.uid);
    f.target('pot'); f.gameplay.cook(); f.gameplay.clearTransient(); f.finish();
    expect(f.state.inventory).toHaveLength(1);
    expect(f.state.inventory[0]!.id).toBe('pepper');
  });
  it('preserves per-instance food effects across dropping and picking up', () => {
    const f = fixture();
    addItem(f.state, 'meal', 1, { name: '暖星药剂', heal: 0, cold: 150, energy: 0 });
    const uid = f.state.inventory[0]!.uid;
    f.gameplay.inventoryAction('drop', uid);
    expect(f.state.inventory).toHaveLength(0);
    const dropped = f.ctx.world.interactables[0]!;
    f.gameplay.interact(dropped);
    expect(f.state.inventory[0]).toMatchObject({ id: 'meal', name: '暖星药剂', cold: 150, heal: 0, energy: 0 });
    f.gameplay.clearTransient();
    expect(f.ctx.world.interactables).toHaveLength(0);
  });
  it('uses a real-time combat food cooldown, not simulation time', () => {
    const f = fixture();
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    f.ctx.inCombat = true; f.state.player.hp = 1; addItem(f.state, 'apple', 3);
    const uid = f.state.inventory[0]!.uid;
    f.gameplay.inventoryAction('eat', uid);
    f.ctx.elapsed += 100;
    f.gameplay.inventoryAction('eat', uid);
    expect(f.state.inventory[0]!.count).toBe(2);
    f.gameplay.clearTransient();
    f.gameplay.inventoryAction('eat', uid);
    expect(f.state.inventory[0]!.count).toBe(2);
    clock += 3501;
    f.gameplay.inventoryAction('eat', uid);
    expect(f.state.inventory[0]!.count).toBe(1);
  });
  it('damages once each seven cold seconds; warm clothes, resistance and sheltered fire protect', () => {
    const f = fixture();
    f.ctx.actor.position.set(-60, 10, -60);
    f.tick(6.9); expect(f.ctx.damage).not.toHaveBeenCalled();
    f.tick(0.2); expect(f.ctx.damage).toHaveBeenCalledTimes(1);
    addItem(f.state, 'warmcoat');
    f.gameplay.inventoryAction('equip', 'warmcoat');
    f.tick(8); expect(f.ctx.damage).toHaveBeenCalledTimes(1);
    f.gameplay.inventoryAction('unequip', 'warmcoat');
    f.state.player.coldResist = 20;
    f.tick(8); expect(f.ctx.damage).toHaveBeenCalledTimes(1);
    f.state.player.coldResist = 0;
    f.state.weather = 'rain';
    f.target('campfire', { data: { sheltered: true } });
    f.tick(8); expect(f.ctx.damage).toHaveBeenCalledTimes(1);
  });
  it('waits across midnight using hours and days', () => {
    const f = fixture();
    f.state.time = 21; f.state.day = 1;
    f.gameplay.interact(f.target('campfire'));
    f.choose(0); f.finish();
    expect(f.state.time).toBe(6);
    expect(f.state.day).toBe(2);
  });
});

// The complete quest chain can also run in any trial order; no trial writes another's stage.
describe('four-trial order independence', () => {
  it('preserves all four individual rewards and reaches the altar objective', () => {
    const f = fixture();
    f.state.terminal = f.state.tower = true;
    const order: AbilityId[] = ['ice', 'bomb', 'magnet', 'stasis'];
    for (const id of order) {
      f.state.region = id; f.gameplay.clearTransient();
      f.state.abilities.push(id); f.state.trialStages[id] = 3;
      f.gameplay.interact(f.target('reward', { id: `${id}-reward`, ability: id })); f.finish();
      f.choose(0); f.finish();
    }
    expect(f.state.completed).toEqual(order);
    expect(f.state.cores).toBe(4);
    expect(f.state.quest).toBe('VISIT_TEMPLE');
  });
});
