import { CONFIG } from './game';
import type { GameState, InventoryItem, ItemDefinition } from '../core/types';

/** HP is measured in quarter-hearts; cold protection is measured in seconds. */
export const ITEMS: Record<string, ItemDefinition> = {
  branch: { name: '枯枝', category: 'weapon', attack: 2, durability: 12, range: 2.1, speed: 1.3, weight: 0.6, flammable: true, color: '#99714a', description: '轻快却脆弱。可以举盾，遇火会燃烧。' },
  axe: { name: '伐木斧', category: 'weapon', attack: 7, durability: 40, range: 2.7, speed: 0.72, weight: 3.2, flammable: false, color: '#acb2ac', description: '双手挥动，擅长伐木；攻击较慢、冲击较强。' },
  torch: { name: '旅人火把', category: 'weapon', attack: 2, durability: 30, range: 2.3, speed: 1.05, weight: 0.8, flammable: true, color: '#e8a259', description: '靠近营火点燃。燃烧时可以御寒、点火，但雨水会将它熄灭。' },
  sword: { name: '巡路短剑', category: 'weapon', attack: 9, durability: 32, range: 2.5, speed: 1.2, weight: 1.4, flammable: false, color: '#b9d1d8', description: '均衡的单手剑，可同时举盾。金属剑身不怕火。' },
  spear: { name: '芦锋长矛', category: 'weapon', attack: 6, durability: 28, range: 4.1, speed: 1.55, weight: 2, flammable: true, color: '#c2a579', description: '双手突刺，出手快、距离远，但横向攻击范围很窄。' },
  club: { name: '岩节重棒', category: 'weapon', attack: 14, durability: 24, range: 3.1, speed: 0.58, weight: 4.5, flammable: true, color: '#85604d', description: '双手重击，缓慢而有力，蓄力可扫开成群敌人。' },
  bow: { name: '弦木弓', category: 'bow', attack: 6, durability: 36, range: 55, speed: 1, weight: 1, flammable: true, color: '#b79c6b', description: '按住 R 拉弓，松开射击。拉满更准；需要箭。' },
  shield: { name: '旅人圆盾', category: 'shield', defense: 4, durability: 28, weight: 1.8, flammable: true, color: '#9bb6bb', description: '单手武器或空手时可举盾。恰好迎击能弹开攻击。' },
  arrows: { name: '木羽箭', category: 'arrow', attack: 1, color: '#d4cab4', description: '弓的弹药。地面的箭束通常装有十支。' },
  shirt: { name: '旧织上衣', category: 'clothes', defense: 1, color: '#88a59c', description: '柔软的旧衣。提供少量防御，不足以抵御山寒。' },
  trousers: { name: '行旅长裤', category: 'clothes', defense: 1, color: '#998571', description: '便于攀爬的长裤，可与上衣同时装备。' },
  warmcoat: { name: '绒叶冬衣', category: 'clothes', defense: 2, cold: 1, color: '#c0a083', description: '装备后持续御寒，取代上衣。雨雪中也能保持温暖。' },
  apple: { name: '晨露苹果', category: 'material', heal: 2, color: '#e76858', description: '可直接食用恢复半颗心。摇树或攻击果树也能获得。' },
  pepper: { name: '赤穗椒', category: 'material', heal: 1, color: '#f17d4a', description: '与食材烹饪可获得御寒效果；生吃只恢复少量生命。' },
  mushroom: { name: '伞苔菇', category: 'material', heal: 2, color: '#d9b48d', description: '朴素的食材，烹饪后恢复更多生命。' },
  meat: { name: '鲜肉', category: 'material', heal: 3, color: '#c67773', description: '可以食用，烹饪更佳；与赤穗椒搭配适合雪山旅行。' },
  wood: { name: '干木材', category: 'material', flammable: true, color: '#aa8562', description: '伐木获得。可在熄灭的营火旁使用，雨中需要遮蔽。不是食材。' },
  monster: { name: '灰牙碎角', category: 'material', color: '#c2a8cd', description: '与昆虫熬制药剂。不要放进普通食物里。' },
  herb: { name: '回风草', category: 'material', heal: 1, energy: 15, color: '#80c78b', description: '恢复精力。烹饪或配制药剂可强化效果；与御寒材料效果冲突。' },
  insect: { name: '灯腹虫', category: 'material', color: '#c8d677', description: '和碎角制成回风药剂；加入赤穗椒则制成御寒药剂。不能直接食用。' },
  roastApple: { name: '营火烤苹果', category: 'meal', heal: 4, color: '#c98b54', description: '烤得微焦的苹果，恢复一颗心。似乎有人正在等它熟。' },
  meal: { name: '野炊料理', category: 'meal', heal: 4, color: '#edc878', description: '实际回复量与特殊效果取决于投入的材料。' },
  terminal: { name: '星盘', category: 'key', color: '#7ed5dc', description: '与你共鸣的古代终端。开启基座、地图与四种星术。' },
  core: { name: '星核', category: 'key', color: '#99e1d5', description: '完成试炼的证明。集齐四枚可在无名者圣所兑换一次成长。' },
  glider: { name: '逐风帆', category: 'key', color: '#ddc794', description: '下落时按住空格展开。消耗精力，带你越过台地深谷。' },
};

export type EquipmentSlot = keyof GameState['equipment'];

export function equipmentSlot(id: string): EquipmentSlot | null {
  const category = ITEMS[id]?.category;
  if (category === 'weapon' || category === 'bow' || category === 'shield') return category;
  if (category === 'clothes') return id === 'trousers' ? 'trousers' : 'clothes';
  return null;
}

/** UIDs take precedence; IDs remain usable by quick actions and integrations. */
export function findInventoryItem(state: GameState, uidOrId: string): InventoryItem | undefined {
  return state.inventory.find(item => item.uid === uidOrId)
    ?? state.inventory.find(item => item.id === uidOrId);
}

let nextUid = 0;
function uniqueUid(state: GameState, id: string): string {
  let uid: string;
  do { uid = `${id}-${Date.now().toString(36)}-${(++nextUid).toString(36)}`; }
  while (state.inventory.some(item => item.uid === uid));
  return uid;
}

function finiteStat(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

/** Atomic insertion: false leaves the entire inventory unchanged, including on slot overflow. */
export function addItem(state: GameState, id: string, count = 1, extra: Partial<InventoryItem> = {}): boolean {
  const definition = ITEMS[id];
  if (!definition || !Number.isSafeInteger(count) || count < 1) return false;
  const slot = equipmentSlot(id);
  const durable = definition.category === 'weapon' || definition.category === 'bow' || definition.category === 'shield';
  if (durable && state.inventory.filter(item => ITEMS[item.id]?.category === definition.category).length + count > CONFIG.weaponSlots) return false;
  if ((id === 'terminal' || id === 'glider') && state.inventory.some(item => item.id === id)) return true;
  const stats: Partial<InventoryItem> = {};
  for (const key of ['heal', 'cold', 'energy'] as const) {
    const value = finiteStat(extra[key]);
    if (value !== undefined) stats[key] = value;
  }
  if (extra.name) stats.name = extra.name.slice(0, 80);
  if (durable) stats.durability = Math.min(definition.durability ?? 1, finiteStat(extra.durability) ?? definition.durability ?? 1);
  if (!slot) {
    const stack = state.inventory.find(item => item.id === id && item.heal === stats.heal && item.cold === stats.cold && item.energy === stats.energy && item.name === stats.name);
    if (stack) {
      if (!Number.isSafeInteger(stack.count + count)) return false;
      stack.count += count;
    } else {
      state.inventory.push({ uid: uniqueUid(state, id), id, count: id === 'terminal' || id === 'glider' ? 1 : count, ...stats });
    }
  } else {
    // Clothes are individual equipment too, but have no artificial carrying cap.
    for (let i = 0; i < count; i++) state.inventory.push({ uid: uniqueUid(state, id), id, count: 1, ...stats });
  }
  return true;
}
