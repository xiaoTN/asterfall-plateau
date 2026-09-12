import type { GameState, QuestId } from '../core/types';

/** Persistent keys shared by interaction, procedural world and combat. */
export const FLAGS = {
  awakened: 'awakened', doorOpen: 'chamberDoor', exitedChamber: 'exitedChamber',
  metElder: 'metElder', elderDeal: 'elderDeal', elderRevisedDeal: 'elderRevisedDeal',
  stoleApple: 'stoleApple', appleJoke: 'appleJoke', towerMap: 'towerMap',
  prologueComplete: 'prologueComplete', coldWarning: 'coldWarning', weaponTutorial: 'weaponTutorial',
  opened: (id: string): string => `opened:${id}`,
  picked: (id: string): string => `picked:${id}`,
  apples: (id: string): string => `shaken:${id}`,
  chopped: (id: string): string => `felled:${id}`,
  solved: (id: string): string => `solved:${id}`,
  lit: (id: string): string => `lit:${id}`,
  extinguished: (id: string): string => `extinguished:${id}`,
} as const;

export const QUEST_ORDER: readonly QuestId[] = [
  'AWAKEN', 'GET_TERMINAL', 'EXIT_CHAMBER', 'MEET_ELDER', 'ACTIVATE_TOWER',
  'FIRST_TRIAL', 'COMPLETE_FOUR_TRIALS', 'VISIT_TEMPLE', 'RECEIVE_GLIDER', 'PROLOGUE_COMPLETE',
];

export function advanceQuest(state: GameState, quest: QuestId): boolean {
  if (QUEST_ORDER.indexOf(quest) <= QUEST_ORDER.indexOf(state.quest)) return false;
  state.quest = quest;
  return true;
}

/** Reconcile evidence on loading or entering content out of order; never regress progress. */
export function reconcileQuest(state: GameState): boolean {
  let next: QuestId = 'AWAKEN';
  if (state.flags[FLAGS.awakened]) next = 'GET_TERMINAL';
  if (state.terminal) next = 'EXIT_CHAMBER';
  if (state.flags[FLAGS.exitedChamber]) next = 'MEET_ELDER';
  if (state.flags[FLAGS.metElder]) next = 'ACTIVATE_TOWER';
  if (state.tower) next = 'FIRST_TRIAL';
  const completedCount = new Set(state.completed).size;
  if (completedCount >= 1) next = 'COMPLETE_FOUR_TRIALS';
  if (completedCount >= 4) next = 'VISIT_TEMPLE';
  if (state.upgrade) next = 'RECEIVE_GLIDER';
  if (state.glider || state.flags[FLAGS.prologueComplete]) next = 'PROLOGUE_COMPLETE';
  return advanceQuest(state, next);
}
