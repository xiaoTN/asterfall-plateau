import { ITEMS } from '../config/items';
import type { InventoryItem } from '../core/types';

export type IngredientTag = 'food' | 'cold' | 'stamina' | 'monster' | 'insect';
export interface IngredientDefinition { tags: readonly IngredientTag[]; heal: number; cold?: number; energy?: number; }
export const INGREDIENTS: Record<string, IngredientDefinition> = {
  apple: { tags: ['food'], heal: 2 },
  pepper: { tags: ['food', 'cold'], heal: 1, cold: 90 },
  mushroom: { tags: ['food'], heal: 2 },
  meat: { tags: ['food'], heal: 3 },
  herb: { tags: ['food', 'stamina'], heal: 1, energy: 30 },
  monster: { tags: ['monster'], heal: 0 },
  insect: { tags: ['insect'], heal: 0 },
};
export interface RecipeResult {
  id: 'meal'; name: string; heal: number; cold: number; energy: number;
  kind: 'food' | 'elixir' | 'dubious'; description: string;
}

export function canHoldIngredient(id: string): boolean { return Boolean(INGREDIENTS[id]); }

/** One entry per ingredient unit, not per stack. Pure and deterministic. */
export function cookRecipe(ingredientIds: readonly string[]): RecipeResult {
  const dubious = (): RecipeResult => ({ id: 'meal', name: '迷之焦糊', heal: 1, cold: 0, energy: 0, kind: 'dubious', description: '味道很勇敢，效果很谨慎。恢复 1 点生命。' });
  if (ingredientIds.length < 1 || ingredientIds.length > 5 || ingredientIds.some(id => !INGREDIENTS[id])) return dubious();
  const ingredients = ingredientIds.map(id => INGREDIENTS[id]!);
  const has = (tag: IngredientTag): boolean => ingredients.some(ingredient => ingredient.tags.includes(tag));
  const elixir = has('monster') && has('insect');
  if ((has('monster') || has('insect')) && !elixir) return dubious();
  // Apples, meat and mushrooms spoil a potion; peppers and herbs are effect reagents.
  if (elixir && ingredientIds.some(id => id === 'apple' || id === 'meat' || id === 'mushroom')) return dubious();
  const conflict = has('cold') && has('stamina');
  let cold = conflict ? 0 : ingredients.reduce((sum, ingredient) => sum + (ingredient.cold ?? 0), 0);
  let energy = conflict ? 0 : ingredients.reduce((sum, ingredient) => sum + (ingredient.energy ?? 0), 0);
  if (elixir && !has('cold') && !has('stamina')) energy = 40;
  if (cold > 0) cold += (ingredients.length - 1) * 30;
  if (energy > 0) energy = Math.min(100, energy + (ingredients.length - 1) * 5);
  const heal = elixir ? 0 : Math.min(32, Math.ceil(ingredients.reduce((sum, ingredient) => sum + ingredient.heal, 0) * 1.5));
  let name: string;
  if (elixir) name = cold > 0 ? '暖星药剂' : energy > 0 ? '回风药剂' : '无效药剂';
  else if (cold > 0) name = ingredientIds.includes('meat') ? '暖身赤椒炖肉' : '暖身野蔬煮';
  else if (energy > 0) name = '回风草鲜汤';
  else if (ingredientIds.every(id => id === 'apple')) name = '蜜烤苹果';
  else if (ingredientIds.includes('meat')) name = '山野肉串';
  else name = '田园什锦煮';
  const effects = [heal > 0 ? `恢复 ${heal} 点生命` : '', cold > 0 ? `御寒 ${cold} 秒` : '', energy > 0 ? `恢复 ${energy} 点精力` : ''].filter(Boolean);
  return { id: 'meal', name, heal, cold, energy, kind: elixir ? 'elixir' : 'food', description: `${effects.join('，') || '没有特殊效果'}${conflict ? '；御寒与精力效果互相抵消' : ''}。` };
}

export function foodEffects(item: InventoryItem): { heal: number; cold: number; energy: number } | null {
  const definition = ITEMS[item.id];
  if (!definition || (definition.category !== 'meal' && !(definition.category === 'material' && definition.heal))) return null;
  return {
    heal: Math.max(0, item.heal ?? definition.heal ?? 0),
    cold: Math.max(0, item.cold ?? definition.cold ?? 0),
    energy: Math.max(0, item.energy ?? definition.energy ?? 0),
  };
}
