import type { AbilityId, Dialogue, GameState, InventoryItem, ItemDefinition, Panel, Settings, UIActions } from '../core/types';
import { ABILITIES, CONFIG, LOCATIONS, QUESTS } from '../config/game';
import { ITEMS } from '../config/items';

export interface UIData {
  state: GameState;
  panel: Panel;
  hasSave: boolean;
  prompt?: string;
  dialogue?: Dialogue | null;
  cinematic?: { title: string; text: string; progress: number } | null;
  notices?: { id: number; text: string; kind: string }[];
  held?: string[];
  cooldown?: number;
  inCombat?: boolean;
  aiming?: boolean;
  bowDraw?: number;
  abilityWheel?: { selected: AbilityId | null; x: number; y: number };
  fps?: number;
  error?: string;
}

type Category = ItemDefinition['category'] | 'all';
// The final quest starts on receiving the glider; completion requires leaving the plateau.
const questPresentation = (s: GameState, id: string = s.quest) => s.flags.prologueComplete === true && id === 'PROLOGUE_COMPLETE'
  ? { title: '序章完成 · 自由探索', text: '你已乘风离开台地。现在可以返回台地，自由探索。', target: '' }
  : QUESTS[id];
const CATEGORIES: [Category, string][] = [['all', '全部'], ['weapon', '兵器'], ['bow', '弓'], ['shield', '盾'], ['arrow', '箭矢'], ['clothes', '衣装'], ['material', '素材'], ['meal', '料理'], ['key', '珍藏']];
const WEATHER = { clear: '晴', cloudy: '阴', rain: '雨' };
const MOVEMENT: Record<string, string> = { idle: '驻足', run: '行走', sprint: '疾跑', crouch: '潜行', jump: '跃起', fall: '下落', climb: '攀爬', swim: '游泳', glide: '滑翔', dead: '倒下' };
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clamp = (n: number, min = 0, max = 1): number => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
const button = (label: string, action: string, extra = '', cls = ''): string => `<button type="button" class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
const icon = (category: string): string => {
  const paths: Record<string, string> = {
    weapon: '<path d="M17 45 43 13l7-3-2 8-27 31M14 38l13 11M15 47l-5 7M11 50l5 4"/>',
    bow: '<path d="M19 9Q55 32 19 55l12-23Z M13 32h36m-6-5 6 5-6 5"/>',
    shield: '<path d="m32 9 19 8-3 24-16 14-16-14-3-24Z M32 16v31M22 24l10-4 10 4"/>',
    arrow: '<path d="m14 50 33-37m-9 2 11-4-2 11M13 43l8 1 3 8M9 48l8 1 3 8"/>',
    clothes: '<path d="m24 13-13 9 7 12 7-5-3 24h21l-3-24 7 5 7-12-14-9q-8 12-16 0Z"/>',
    material: '<path d="M16 49C5 17 32 8 49 13c1 24-5 40-28 33M13 54l29-34M24 42l-2-14m8 7 12-1"/>',
    meal: '<path d="M12 32h40c-1 15-9 20-20 20S14 47 12 32ZM8 32h48M22 24c-7-7 7-8 0-16m11 16c-7-7 7-8 0-16m10 16c-7-7 7-8 0-16"/>',
    key: '<path d="m32 7 22 25-22 25L10 32ZM32 18l11 14-11 14-11-14ZM5 32h8m38 0h8"/>',
  };
  return `<svg viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[category] ?? paths.key}</svg>`;
};

/** Persistent, delegated DOM overlay. All game mutations go through UIActions. */
export class GameUI {
  private readonly el: HTMLDivElement;
  private readonly refs = new Map<string, HTMLElement>();
  private readonly panels = new Map<Panel, HTMLElement>();
  private readonly cards = new Map<string, HTMLButtonElement>();
  private readonly toastNodes = new Map<number, { el: HTMLElement; time: number }>();
  private definitions: Record<string, ItemDefinition> = ITEMS;
  private data: UIData | null = null;
  private category: Category = 'all';
  private sort: 'category' | 'name' | 'power' = 'category';
  private selected = '';
  private inventorySignature = '';
  private detailSignature = '';
  private mapSignature = '';
  private questSignature = '';
  private lastPanel: Panel | null = null;
  private settingsReturn: Panel = 'pause';
  private dialogueSignature = '';
  private dialogueObject: Dialogue | null = null;
  private dialogueStart = 0;
  private dialogueSkipped = false;
  private dialogueUsed = false;
  private helpOpen = false;
  private debugOpen = false;
  private lastHp = Infinity;
  private hitUntil = 0;
  private disposed = false;

  constructor(root: HTMLElement, private readonly actions: UIActions) {
    this.el = document.createElement('div');
    this.el.className = 'asterfall-ui';
    this.el.innerHTML = this.template();
    root.append(this.el);
    this.el.querySelectorAll<HTMLElement>('[data-ref]').forEach(node => this.refs.set(node.dataset.ref!, node));
    this.el.querySelectorAll<HTMLElement>('[data-panel]').forEach(node => this.panels.set(node.dataset.panel as Panel, node));
    this.el.addEventListener('click', this.onClick);
    this.el.addEventListener('input', this.onInput);
    this.el.addEventListener('change', this.onChange);
    window.addEventListener('keydown', this.onKey, true);
  }

  /** Supply the gameplay item catalog so descriptions and statistics share one source. */
  public setItemDefinitions(definitions: Record<string, ItemDefinition>): void {
    this.definitions = definitions;
    this.inventorySignature = '';
    this.detailSignature = '';
  }

  public setPanel(panel: Panel): void { this.actions.panel(panel); }

  public render(data: UIData): void {
    if (this.disposed) return;
    this.data = data;
    const { state, panel } = data;
    this.el.classList.toggle('colorblind', state.settings.colorblind);
    this.el.classList.toggle('reduce-motion', !state.settings.shake);
    this.el.classList.toggle('is-title', panel === 'title');
    this.el.classList.toggle('has-panel', panel !== 'none');
    if (this.lastPanel !== panel) {
      if (panel === 'settings') this.settingsReturn = this.lastPanel === 'title' ? 'title' : 'pause';
      this.panels.forEach((node, key) => { node.hidden = key !== panel; });
      this.lastPanel = panel;
      this.el.dataset.currentPanel = panel;
      const heading = this.panels.get(panel)?.querySelector<HTMLElement>('[data-heading]');
      if (heading && document.pointerLockElement === null) heading.focus({ preventScroll: true });
    }
    this.show('hud', panel === 'none' && !data.cinematic);
    this.show('menu-shade', panel !== 'none' && panel !== 'title' && panel !== 'dialogue');
    this.show('help', this.helpOpen && panel !== 'title');
    this.show('debug', import.meta.env.DEV && this.debugOpen);
    this.show('error', !!data.error);
    this.text('error-text', data.error ?? '');
    this.disabled('continue', !data.hasSave);
    this.disabled('death-continue', !data.hasSave);
    this.disabled('save', !!data.inCombat);
    this.text('save-hint', data.inCombat ? '战斗中无法保存' : '旅途中会自动记录重要进展');
    this.renderHud(data);
    this.renderAbilityWheel(data);
    if (panel === 'inventory' || panel === 'cooking') this.renderInventory(data);
    if (panel === 'map') this.renderMap(state);
    if (panel === 'quests') this.renderQuests(state);
    if (panel === 'settings') this.renderSettings(state.settings);
    if (panel === 'dialogue') this.renderDialogue(data.dialogue ?? null);
    else { this.dialogueSignature = ''; this.dialogueObject = null; }
    this.renderCinematic(data);
    this.renderNotices(data.notices ?? []);
    this.show('notices', panel !== 'title');
    if (this.debugOpen && import.meta.env.DEV) {
      this.text('debug-state', `${Math.round(data.fps ?? 0)} FPS · ${state.region}\n${state.player.position.map(v => v.toFixed(1)).join(', ')}\n${state.quest} · ${state.player.movement}\n生命 ${state.player.hp}/${state.player.maxHp} · 精力 ${Math.round(state.player.stamina)}\n天数 ${state.day} · 星核 ${state.cores} · 试炼 ${state.completed.length}/4`);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.el.removeEventListener('click', this.onClick);
    this.el.removeEventListener('input', this.onInput);
    this.el.removeEventListener('change', this.onChange);
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
    this.cards.clear(); this.refs.clear(); this.panels.clear(); this.toastNodes.clear();
  }

  private get(ref: string): HTMLElement { return this.refs.get(ref)!; }
  private text(ref: string, value: string): void { const el = this.get(ref); if (el.textContent !== value) el.textContent = value; }
  private show(ref: string, show: boolean): void { this.get(ref).hidden = !show; }
  private disabled(ref: string, value: boolean): void { (this.get(ref) as HTMLButtonElement).disabled = value; }

  private renderHud(data: UIData): void {
    const s = data.state;
    const aiming = data.aiming === true && data.panel === 'none' && !data.cinematic && !data.abilityWheel;
    this.show('aim-reticle', aiming);
    if (aiming) {
      const draw = clamp(data.bowDraw ?? 0);
      const percent = Math.floor(draw * 100);
      const label = draw === 1 ? '满弓' : `拉弓 ${percent}%`;
      this.get('aim-reticle').classList.toggle('fully-drawn', draw === 1);
      this.get('bow-draw-fill').style.transform = `scaleX(${draw})`;
      this.get('bow-draw').setAttribute('aria-valuenow', String(percent));
      this.get('bow-draw').setAttribute('aria-valuetext', `${label}，松开 R 射箭`);
      this.text('bow-draw-label', label);
    }
    const now = performance.now();
    if (s.player.hp < this.lastHp && data.panel === 'none') this.hitUntil = now + 450;
    this.lastHp = s.player.hp;
    this.show('damage', now < this.hitUntil && !data.cinematic && data.panel === 'none');
    const heartUnit = 4;
    const count = Math.ceil(s.player.maxHp / heartUnit);
    const hearts = this.get('hearts');
    while (hearts.children.length > count) hearts.lastElementChild?.remove();
    while (hearts.children.length < count) { const heart = document.createElement('span'); heart.className = 'heart'; heart.innerHTML = '<i></i>'; hearts.append(heart); }
    [...hearts.children].forEach((heart, i) => (heart as HTMLElement).style.setProperty('--fill', `${clamp((s.player.hp - i * heartUnit) / heartUnit) * 100}%`));
    hearts.setAttribute('aria-label', `生命 ${s.player.hp} / ${s.player.maxHp}`);
    hearts.setAttribute('aria-valuemin', '0');
    hearts.setAttribute('aria-valuemax', String(s.player.maxHp));
    hearts.setAttribute('aria-valuenow', String(s.player.hp));
    hearts.classList.toggle('low', s.player.hp <= heartUnit);
    const stamina = clamp(s.player.stamina / s.player.maxStamina);
    this.get('stamina').setAttribute('aria-valuemin', '0');
    this.get('stamina').setAttribute('aria-valuemax', String(s.player.maxStamina));
    this.get('stamina').setAttribute('aria-valuenow', String(Math.round(s.player.stamina)));
    this.get('stamina').style.setProperty('--stamina', `${stamina * 100}%`);
    this.get('stamina').classList.toggle('exhausted', stamina < .18);
    this.show('stamina', stamina < .995 || ['climb', 'swim', 'glide', 'sprint'].includes(s.player.movement));
    this.text('stamina-label', `${Math.round(stamina * 100)}`);
    const quest = questPresentation(s);
    this.text('quest-title', quest?.title ?? '自由探索');
    this.text('quest-text', quest?.text ?? '沿着风，寻找属于你的方向。');
    this.text('quest-counter', s.flags.prologueComplete === true ? '主线 · 序章已完成' : s.quest === 'COMPLETE_FOUR_TRIALS' ? `${s.completed.length} / 4 道星光` : '主线 · 序章');
    const degrees = ((-s.player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    this.text('bearing', `${String(Math.round(degrees) % 360).padStart(3, '0')}°`);
    this.get('compass-needle').style.transform = `rotate(${degrees}deg)`;
    const target = quest?.target && LOCATIONS[quest.target];
    this.show('compass-target', !!target && s.region === 'overworld');
    if (target) {
      const x = target.position[0] - s.player.position[0];
      const z = target.position[2] - s.player.position[2];
      const angle = Math.atan2(-x, -z) - s.player.yaw;
      this.get('compass-target').style.transform = `translateX(${-Math.sin(angle) * 96}px)`;
      this.text('target-distance', `${Math.round(Math.hypot(x, z))} m`);
    }
    let nearest = '星坠台地'; let distance = 24;
    if (s.region !== 'overworld') nearest = `${ABILITIES.find(a => a.id === s.region)?.name ?? ''} · 试炼之间`;
    else Object.values(LOCATIONS).forEach(location => {
      const d = Math.hypot(location.position[0] - s.player.position[0], location.position[2] - s.player.position[2]);
      if (d < distance) { nearest = location.name; distance = d; }
    });
    this.text('location', nearest);
    const hour = ((s.time % 24) + 24) % 24;
    this.text('time', `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`);
    this.text('weather', WEATHER[s.weather]);
    const cold = s.region === 'overworld' && (s.player.position[1] > 37 || (s.player.position[0] < -38 && s.player.position[2] < -38));
    this.text('temperature', cold ? '寒冷' : '温和');
    this.get('temperature').classList.toggle('cold', cold);
    this.show('cold-resist', s.player.coldResist > 0);
    this.text('cold-resist', `御寒 ${Math.ceil(s.player.coldResist / 60)}′`);
    ABILITIES.forEach((ability, i) => {
      const slot = this.get(`ability-${ability.id}`);
      const unlocked = s.abilities.includes(ability.id);
      slot.classList.toggle('locked', !unlocked);
      slot.classList.toggle('selected', s.selectedAbility === ability.id && unlocked);
      slot.setAttribute('aria-label', `${i + 1} ${ability.name}${unlocked ? '' : ' 尚未获得'}`);
    });
    const selected = ABILITIES.find(a => a.id === s.selectedAbility);
    this.text('ability-name', s.abilities.includes(s.selectedAbility) ? selected?.name ?? '' : '星盘能力');
    const abilityHint = !s.terminal ? '寻找沉睡的星盘' : !s.abilities.length ? '探索遗迹 · 唤醒能力' : `${(data.cooldown ?? 0) > 0 ? `冷却 ${data.cooldown!.toFixed(1)} 秒` : 'F 使用'} · 1 — 4 切换\n按住 B · 鼠标定向 · 松开 B 确认已解锁能力`;
    this.text('ability-hint', abilityHint);
    this.get('ability-cooldown').style.setProperty('--cooldown', `${clamp((data.cooldown ?? 0) / (s.selectedAbility === 'bomb' ? CONFIG.bombCooldown : CONFIG.stasisCooldown)) * 100}%`);
    const weapon = s.inventory.find(item => item.uid === s.equipment.weapon);
    const bow = s.inventory.find(item => item.uid === s.equipment.bow);
    const shield = s.inventory.find(item => item.uid === s.equipment.shield);
    this.text('weapon-name', weapon ? this.definition(weapon).name : '空手');
    this.text('weapon-detail', weapon ? `攻击 ${this.definition(weapon).attack ?? '—'} · 耐久 ${Math.ceil(weapon.durability ?? this.definition(weapon).durability ?? 0)}` : '寻找一件趁手的兵器');
    this.get('weapon-detail').classList.toggle('warning', weapon?.durability !== undefined && weapon.durability < 5);
    const arrows = s.inventory.filter(item => this.definition(item).category === 'arrow').reduce((n, item) => n + item.count, 0);
    this.text('equipment-detail', `${shield ? this.definition(shield).name : '无盾'}  /  ${bow ? `箭 ${arrows}` : '无弓'}`);
    this.show('prompt', !!data.prompt && data.panel === 'none' && !data.cinematic && !data.abilityWheel);
    this.text('prompt-text', (data.prompt ?? '').replace(/^\s*(?:\[?E\]?|按\s*E)\s*[:：·]?\s*/i, ''));
    this.show('onboarding', !this.helpOpen && !data.abilityWheel && ['AWAKEN', 'GET_TERMINAL', 'EXIT_CHAMBER', 'MEET_ELDER'].includes(s.quest));
    this.text('movement', MOVEMENT[s.player.movement] ?? '探索');
    this.show('combat', !!data.inCombat);
  }

  /** Render engine-supplied direction only; selection and confirmation belong to gameplay. */
  private renderAbilityWheel(data: UIData): void {
    const wheel = data.abilityWheel;
    this.show('ability-wheel', !!wheel && data.panel === 'none' && !data.cinematic);
    if (!wheel || data.panel !== 'none' || data.cinematic) return;
    ABILITIES.forEach(ability => {
      const slot = this.get(`wheel-${ability.id}`);
      const unlocked = data.state.abilities.includes(ability.id);
      const selected = wheel.selected === ability.id;
      slot.classList.toggle('locked', !unlocked);
      slot.classList.toggle('selected', selected);
      slot.setAttribute('aria-disabled', String(!unlocked));
      slot.setAttribute('aria-current', String(selected));
      this.text(`wheel-${ability.id}-state`, !unlocked ? '未解锁 · 不可选择' : selected ? '当前方向 · 待确认' : '已解锁');
    });
    const selected = ABILITIES.find(ability => ability.id === wheel.selected);
    const unlocked = !!selected && data.state.abilities.includes(selected.id);
    this.text('wheel-state', !selected ? '中心死区 · 松开 B 取消' : unlocked ? '松开 B 确认选择' : '未解锁 · 松开 B 不切换');
    this.text('wheel-name', selected?.name ?? '保持当前能力');
    this.text('wheel-description', selected ? `${unlocked ? '' : '解锁后：'}${selected.description}` : '按住 B，移动鼠标指向能力。回到中心后松开，不作切换。');
    // Keep pixel offsets independent of responsive wheel dimensions; never infer a selection here.
    const x = Number.isFinite(wheel.x) ? wheel.x : 0;
    const y = Number.isFinite(wheel.y) ? wheel.y : 0;
    const scale = 130 / Math.max(130, Math.hypot(x, y));
    this.get('wheel-cursor').style.transform = `translate(${x * scale}px, ${y * scale}px)`;
  }

  private definition(item: InventoryItem): ItemDefinition {
    if (this.definitions[item.id]) return { ...this.definitions[item.id], name: item.name ?? this.definitions[item.id]!.name };
    const id = item.id.toLowerCase();
    const category: ItemDefinition['category'] = /arrow/.test(id) ? 'arrow' : /bow/.test(id) ? 'bow' : /shield/.test(id) ? 'shield' : /shirt|tunic|pants|trousers|coat|clothes|robe/.test(id) ? 'clothes' : /sword|spear|axe|club|branch|torch|hammer/.test(id) ? 'weapon' : /meal|dish|stew|cooked|roast|elixir/.test(id) ? 'meal' : /core|terminal|glider|key/.test(id) ? 'key' : 'material';
    return { name: item.name ?? item.id.replace(/[_-]/g, ' '), category, description: '在星坠原野旅途中收集的物品。', color: '#a9c8ae', heal: item.heal, cold: item.cold, energy: item.energy };
  }

  private renderInventory(data: UIData): void {
    const cooking = data.panel === 'cooking';
    // Cooking uses the same persistent inventory surface; move it, never rebuild it.
    const host = this.get(cooking ? 'cooking-host' : 'inventory-host');
    const surface = this.get('inventory-surface');
    if (surface.parentElement !== host) host.append(surface);
    this.get('category-tabs').querySelectorAll<HTMLElement>('[data-category]').forEach(tab => {
      const selected = cooking ? tab.dataset.category === 'material' : tab.dataset.category === this.category;
      tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected));
      (tab as HTMLButtonElement).disabled = cooking && tab.dataset.category !== 'material';
    });
    const category = cooking ? 'material' : this.category;
    const items = data.state.inventory.filter(item => category === 'all' || this.definition(item).category === category).slice();
    items.sort((a, b) => this.sort === 'power' ? (this.definition(b).attack ?? this.definition(b).heal ?? b.heal ?? 0) - (this.definition(a).attack ?? this.definition(a).heal ?? a.heal ?? 0) || a.uid.localeCompare(b.uid) : this.sort === 'name' ? this.definition(a).name.localeCompare(this.definition(b).name, 'zh-CN') : CATEGORIES.findIndex(c => c[0] === this.definition(a).category) - CATEGORIES.findIndex(c => c[0] === this.definition(b).category) || this.definition(a).name.localeCompare(this.definition(b).name, 'zh-CN'));
    if (!items.some(item => item.uid === this.selected)) this.selected = items[0]?.uid ?? '';
    const signature = JSON.stringify([items, data.state.equipment, data.held, this.selected, this.sort, category]);
    if (signature !== this.inventorySignature) {
      this.inventorySignature = signature;
      const grid = this.get('item-grid');
      const equipped = Object.values(data.state.equipment);
      const live = new Set(items.map(item => item.uid));
      this.cards.forEach((card, uid) => { if (!live.has(uid)) { card.remove(); this.cards.delete(uid); } });
      items.forEach((item, index) => {
        let card = this.cards.get(item.uid);
        if (!card) { card = document.createElement('button'); card.type = 'button'; card.className = 'item-card'; card.dataset.action = 'select-item'; card.dataset.uid = item.uid; this.cards.set(item.uid, card); }
        const def = this.definition(item);
        const isEquipped = equipped.includes(item.uid);
        const content = `${isEquipped ? '<span class="equipped-tag">已装备</span>' : ''}<span class="item-art" style="color:${/^#[a-f\d]{3,8}$/i.test(def.color) ? def.color : '#a9c8ae'}">${icon(def.category)}</span><span class="item-name">${esc(def.name)}</span><span class="item-meta">${def.attack !== undefined ? `攻击 ${def.attack}` : esc(CATEGORIES.find(c => c[0] === def.category)?.[1] ?? '')}<b>×${item.count}</b></span>${item.durability !== undefined ? `<span class="durability"><i style="width:${clamp(item.durability / (def.durability ?? Math.max(1, item.durability))) * 100}%"></i></span>` : ''}`;
        if (card.innerHTML !== content) card.innerHTML = content;
        card.classList.toggle('selected', item.uid === this.selected);
        card.setAttribute('aria-pressed', String(item.uid === this.selected));
        card.setAttribute('aria-label', `${def.name}，数量 ${item.count}${isEquipped ? '，已装备' : ''}`);
        const at = grid.children[index];
        if (at !== card) grid.insertBefore(card, at ?? null);
      });
      this.show('empty-inventory', items.length === 0);
      this.text('inventory-count', `${data.state.inventory.length} 件珍藏 · 兵器 ${data.state.inventory.filter(item => this.definition(item).category === 'weapon').length}/${CONFIG.weaponSlots}`);
    }
    const item = items.find(entry => entry.uid === this.selected);
    const detailSignature = JSON.stringify([item, data.state.equipment, data.inCombat, data.held, cooking]);
    if (detailSignature !== this.detailSignature) {
      this.detailSignature = detailSignature;
      const detail = this.get('item-detail');
      const focused = document.activeElement instanceof HTMLElement && detail.contains(document.activeElement) ? document.activeElement.dataset.action : undefined;
      if (!item) detail.innerHTML = `<div class="empty-detail">${icon('key')}<p>每段旅途，都从空空的行囊开始。</p><small>探索原野，按 E 收集物品。</small></div>`;
      else {
        const def = this.definition(item);
        const uid = `data-uid="${esc(item.uid)}"`;
        const equipped = Object.values(data.state.equipment).includes(item.uid);
        const heal = item.heal ?? def.heal ?? 0;
        const cold = item.cold ?? def.cold ?? 0;
        const energy = item.energy ?? def.energy ?? 0;
        const stats = [def.attack !== undefined ? ['攻击', def.attack] : null, item.durability !== undefined ? ['耐久', `${Math.ceil(item.durability)} / ${def.durability ?? '—'}`] : null, def.defense !== undefined ? ['防御', def.defense] : null, heal > 0 ? ['恢复生命', `+${heal}`] : null, cold > 0 ? ['御寒', def.category === 'clothes' ? '持续生效' : `${Math.ceil(cold / 60)} 分钟`] : null, energy > 0 ? ['恢复精力', `+${energy}`] : null].filter(Boolean);
        detail.innerHTML = `<div class="detail-art">${icon(def.category)}</div><span class="eyebrow">${esc(CATEGORIES.find(c => c[0] === def.category)?.[1])} / ${String(items.indexOf(item) + 1).padStart(2, '0')}</span><h3>${esc(def.name)}</h3><p class="detail-description">${esc(def.description)}</p><dl class="item-stats">${stats.map(pair => `<div><dt>${esc(pair![0])}</dt><dd>${esc(pair![1])}</dd></div>`).join('')}</dl><div class="item-actions">${['weapon', 'bow', 'shield', 'clothes'].includes(def.category) ? button(equipped ? '卸下装备' : '装备', equipped ? 'unequip' : 'equip', uid, equipped ? '' : 'primary') : ''}${(def.category === 'meal' || def.category === 'material') && (heal > 0 || energy > 0 || cold > 0) ? button('食用', 'eat', uid, 'primary') : ''}${def.category === 'material' && item.id !== 'wood' ? button('手持一份', 'hold', `${uid} ${(data.held?.length ?? 0) >= 5 || (data.held?.filter(held => held === item.uid).length ?? 0) >= item.count ? 'disabled' : ''}`) : ''}${item.id === 'wood' || item.id === 'torch' ? button('在营火旁使用', 'use', uid) : ''}${def.category !== 'key' ? button('丢弃一件', 'drop', uid, 'subtle') : ''}</div>${data.inCombat ? '<p class="warning detail-footnote">战斗中食用受恢复间隔限制。</p>' : ''}`;
        if (focused) {
          const nextAction = focused === 'equip' && equipped ? 'unequip' : focused === 'unequip' && !equipped ? 'equip' : focused;
          (detail.querySelector<HTMLElement>(`[data-action="${nextAction}"]`) ?? detail.querySelector<HTMLElement>('button:not(:disabled)'))?.focus({ preventScroll: true });
        }
      }
    }
    const held = data.held ?? [];
    this.text('held-count', `${held.length} / 5`);
    const tray = this.get('held-items');
    const heldContent = Array.from({ length: 5 }, (_, i) => {
      const uid = held[i]; const ingredient = data.state.inventory.find(entry => entry.uid === uid || entry.id === uid);
      return ingredient ? button(`<span>${icon(this.definition(ingredient).category)}</span><small>${esc(this.definition(ingredient).name)}</small>`, 'unhold', `data-uid="${esc(ingredient.uid)}" title="放回一份"`, 'held-item filled') : '<span class="held-item empty">＋</span>';
    }).join('');
    if (tray.innerHTML !== heldContent) {
      const focusIndex = Array.from(tray.children).findIndex(node => node === document.activeElement);
      tray.innerHTML = heldContent;
      if (focusIndex >= 0) {
        const next = tray.children[Math.min(focusIndex, held.length - 1)];
        if (next instanceof HTMLButtonElement) next.focus({ preventScroll: true });
        else this.get('category-tabs').querySelector<HTMLElement>('.active')?.focus({ preventScroll: true });
      }
    }
    this.disabled('cook', held.length === 0);
    this.text('cook-hint', cooking ? '选择素材手持，投入锅中。点击手持素材可放回。' : '需靠近点燃的锅。也可返回原野后按 E 烹饪。');
  }

  private renderMap(s: GameState): void {
    this.show('map-locked', !s.terminal);
    this.show('map-content', s.terminal);
    if (!s.terminal) return;
    this.show('map-fog', !s.tower);
    this.get('map-svg').classList.toggle('charted', s.tower);
    this.text('map-status', s.tower ? '区域地形已同步' : '信号微弱 · 激活观星之塔以下载地形');
    this.text('map-coordinates', `X ${Math.round(s.player.position[0])}  Z ${Math.round(s.player.position[2])}  /  海拔 ${Math.round(s.player.position[1])} m`);
    const quest = questPresentation(s);
    this.text('map-quest-status', s.flags.prologueComplete === true ? '自由探索' : '正在追寻');
    this.text('map-quest-title', quest?.title ?? '自由探索');
    this.text('map-quest-text', quest?.text ?? '');
    this.text('map-cores', `${s.completed.length} / 4`);
    this.get('map-player').setAttribute('transform', `translate(${clamp(s.player.position[0], -CONFIG.radius, CONFIG.radius)} ${clamp(s.player.position[2], -CONFIG.radius, CONFIG.radius)}) rotate(${-s.player.yaw * 180 / Math.PI})`);
    this.get('map-player').style.opacity = s.region === 'overworld' ? '1' : '.4';
    const signature = JSON.stringify([s.tower, s.discovered, s.completed, s.trialStages, s.pins, s.quest, s.region]);
    if (this.mapSignature === signature) return;
    this.mapSignature = signature;
    const visible = Object.entries(LOCATIONS).filter(([id, loc]) => s.discovered.includes(id) || (s.tower && (loc.type === 'shrine' || id === 'tower')));
    this.get('map-pois').innerHTML = visible.map(([id, loc]) => {
      const done = s.completed.some(ability => ability === id);
      const target = QUESTS[s.quest]?.target === id;
      return `<g class="map-poi ${done ? 'complete' : ''} ${target ? 'objective' : ''}" transform="translate(${loc.position[0]} ${loc.position[2]})"><title>${esc(loc.name)}${done ? ' · 已完成' : ''}</title>${loc.type === 'shrine' ? '<path d="M0-5 5 0 0 5-5 0Z"/>' : id === 'tower' ? '<path d="M-3 5 0-7 3 5ZM-5-1H5"/>' : '<circle r="2.6"/>'}${done ? '<path class="check" d="m-2 0 1.5 1.5 3-3"/>' : ''}<text y="11">${esc(loc.name)}</text></g>`;
    }).join('');
    this.get('map-pins').innerHTML = s.pins.map((pin, index) => `<g class="map-pin" transform="translate(${clamp(pin.x, -CONFIG.radius, CONFIG.radius)} ${clamp(pin.z, -CONFIG.radius, CONFIG.radius)})"><path d="M0 0V-11l7 2-7 3"/><text x="9" y="-6">${index + 1}</text></g>`).join('');
    this.get('trial-list').innerHTML = ABILITIES.map(ability => {
      const known = s.tower || s.discovered.includes(ability.id);
      const completed = s.completed.includes(ability.id);
      return `<li class="${completed ? 'complete' : ''}"><span class="trial-diamond">${completed ? '✓' : '◇'}</span><span>${known ? `${ability.name}遗迹` : '未记录的星光'}<small>${completed ? '试炼完成' : s.region === ability.id ? `正在探索 · 阶段 ${s.trialStages[ability.id] + 1}` : known ? '等待探索' : '尚未发现'}</small></span></li>`;
    }).join('');
  }

  private renderQuests(s: GameState): void {
    const signature = `${s.quest}:${s.completed.join(',')}:${s.terminal}:${s.flags.prologueComplete}`;
    if (this.questSignature === signature) return;
    this.questSignature = signature;
    const entries = Object.entries(QUESTS);
    const current = entries.findIndex(([id]) => id === s.quest);
    this.get('quest-log').innerHTML = !s.terminal ? '<div class="locked-message"><h3>星盘尚未唤醒</h3><p>靠近石台上的发光终端，按 E 取得星盘。</p></div>' : entries.slice(0, current + 1).reverse().map(([id]) => {
      const quest = questPresentation(s, id);
      const active = id === s.quest && s.flags.prologueComplete !== true;
      return `<article class="journal-entry ${active ? 'current' : ''}"><span class="eyebrow">${active ? '正在追寻' : '已留下的足迹'}</span><h3>${esc(quest.title)}</h3><p>${esc(quest.text)}</p>${active ? button('查看地图', 'panel', 'data-value="map"', 'subtle') : '<span class="journal-done">已完成</span>'}</article>`;
    }).join('');
  }

  private renderSettings(settings: Settings): void {
    this.get('settings-form').querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]').forEach(input => {
      const key = input.dataset.setting as keyof Settings;
      const value = settings[key];
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
      else if (document.activeElement !== input) input.value = String(value);
      if (input instanceof HTMLInputElement && input.type === 'range') {
        const output = input.parentElement?.querySelector('output');
        if (output) output.textContent = key === 'sensitivity' ? `${Number(value).toFixed(2)}×` : `${Math.round(Number(value) * 100)}%`;
        input.style.setProperty('--range', `${clamp((Number(value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
      }
    });
  }

  private renderDialogue(dialogue: Dialogue | null): void {
    if (!dialogue) { this.text('dialogue-text', ''); this.get('dialogue-options').replaceChildren(); return; }
    const signature = `${dialogue.speaker}\n${dialogue.text}\n${dialogue.options.map(option => option.label).join('|')}`;
    if (signature !== this.dialogueSignature || this.dialogueObject !== dialogue) {
      this.dialogueSignature = signature; this.dialogueObject = dialogue;
      this.dialogueStart = performance.now(); this.dialogueSkipped = false; this.dialogueUsed = false;
      this.text('dialogue-speaker', dialogue.speaker);
      this.get('dialogue-options').innerHTML = dialogue.options.map((option, i) => button(`${esc(option.label)}<span>↗</span>`, 'dialogue-option', `data-index="${i}" disabled`)).join('');
    }
    const characters = Array.from(dialogue.text);
    const length = this.dialogueSkipped ? characters.length : Math.floor((performance.now() - this.dialogueStart) / 28);
    this.text('dialogue-text', characters.slice(0, length).join(''));
    const complete = length >= characters.length;
    this.get('dialogue-options').querySelectorAll<HTMLButtonElement>('button').forEach(option => { option.disabled = !complete || this.dialogueUsed; });
    this.show('dialogue-skip', !complete);
  }

  private renderCinematic(data: UIData): void {
    const cinema = data.cinematic;
    this.show('cinematic', !!cinema);
    if (!cinema) return;
    this.text('cinematic-title', cinema.title);
    this.text('cinematic-text', data.state.settings.subtitles ? cinema.text : '');
    this.get('cinematic-progress').style.transform = `scaleX(${clamp(cinema.progress)})`;
  }

  private renderNotices(notices: NonNullable<UIData['notices']>): void {
    const now = performance.now();
    const live = new Set(notices.map(notice => notice.id));
    this.toastNodes.forEach((record, id) => {
      if (!live.has(id)) { record.el.remove(); this.toastNodes.delete(id); }
      else record.el.hidden = now - record.time > 6500;
    });
    notices.slice(-5).forEach(notice => {
      const existing = this.toastNodes.get(notice.id);
      if (existing) return;
      const toast = document.createElement('div');
      toast.className = `toast ${['success', 'warning', 'info'].includes(notice.kind) ? notice.kind : 'info'}`;
      toast.innerHTML = '<span class="toast-mark"></span><span></span>';
      toast.lastElementChild!.textContent = notice.text;
      this.get('notices').append(toast);
      this.toastNodes.set(notice.id, { el: toast, time: now });
    });
  }

  private onClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !this.data) return;
    const map = target.closest('[data-map]');
    if (map && this.data.state.terminal) {
      const svg = map as SVGSVGElement;
      const matrix = svg.getScreenCTM();
      if (matrix) {
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        if (Math.hypot(point.x, point.y) <= CONFIG.radius) this.actions.pin(Math.round(point.x), Math.round(point.y));
      }
      return;
    }
    const el = target.closest<HTMLElement>('[data-action]');
    if (!el || !this.el.contains(el) || (el instanceof HTMLButtonElement && el.disabled)) return;
    const action = el.dataset.action;
    const uid = el.dataset.uid ?? '';
    switch (action) {
      case 'start': this.actions.start(false); break;
      case 'continue': if (this.data.hasSave) this.actions.start(true); break;
      case 'panel': this.actions.panel(el.dataset.value as Panel); break;
      case 'settings-back': this.actions.panel(this.settingsReturn); break;
      case 'save': if (!this.data.inCombat) this.actions.save(); break;
      case 'category': this.category = el.dataset.category as Category; this.inventorySignature = ''; this.renderInventory(this.data); break;
      case 'select-item': this.selected = uid; this.renderInventory(this.data); break;
      case 'equip': case 'unequip': case 'drop': case 'eat': case 'hold': case 'unhold': case 'use':
        if (uid && this.data.state.inventory.some(item => item.uid === uid) && !(action === 'hold' && (this.data.held?.length ?? 0) >= 5)) this.actions.inventory(action, uid);
        break;
      case 'cook': if (this.data.held?.length) this.actions.cook(); break;
      case 'help': this.helpOpen = !this.helpOpen; this.show('help', this.helpOpen); break;
      case 'dialogue-skip': this.dialogueSkipped = true; this.renderDialogue(this.data.dialogue ?? null); break;
      case 'dialogue-option': {
        const option = this.data.dialogue?.options[Number(el.dataset.index)];
        if (option && !this.dialogueUsed && (this.dialogueSkipped || performance.now() - this.dialogueStart >= Array.from(this.data.dialogue!.text).length * 28)) { this.dialogueUsed = true; option.action(); }
        break;
      }
      case 'cinematic-skip': this.actions.panel('none'); break;
      case 'debug': if (import.meta.env.DEV) this.actions.debug(el.dataset.value ?? ''); break;
      case 'debug-teleport': if (import.meta.env.DEV) this.actions.debug('teleport', (this.get('debug-location') as HTMLSelectElement).value); break;
      case 'debug-clear': if (import.meta.env.DEV && window.confirm('清除本地测试存档？此操作无法撤销。')) this.actions.debug('clear'); break;
    }
  };

  private onInput = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.setting) return;
    const key = input.dataset.setting as keyof Settings;
    this.actions.settings({ [key]: input.type === 'checkbox' ? input.checked : Number(input.value) });
    const output = input.parentElement?.querySelector('output');
    if (output) output.textContent = key === 'sensitivity' ? `${Number(input.value).toFixed(2)}×` : `${Math.round(Number(input.value) * 100)}%`;
  };

  private onChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLSelectElement)) return;
    if (input.dataset.setting === 'quality') this.actions.settings({ quality: input.value as Settings['quality'] });
    if (input.dataset.sort !== undefined) { this.sort = input.value as typeof this.sort; if (this.data) this.renderInventory(this.data); }
    if (import.meta.env.DEV && input.dataset.debug) this.actions.debug(input.dataset.debug, input.value);
  };

  private onKey = (event: KeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (event.code === 'KeyH' && this.data?.panel !== 'title') {
      event.preventDefault(); this.helpOpen = !this.helpOpen; this.show('help', this.helpOpen);
    }
    if (event.code === 'Backquote' && import.meta.env.DEV) {
      event.preventDefault(); this.debugOpen = !this.debugOpen; this.show('debug', this.debugOpen);
      if (this.debugOpen && document.pointerLockElement) void document.exitPointerLock();
    }
    if (this.data?.panel === 'dialogue' && (event.code === 'Space' || event.code === 'KeyE') && !(target instanceof HTMLButtonElement)) {
      event.preventDefault(); this.dialogueSkipped = true; this.renderDialogue(this.data.dialogue ?? null);
    }
  };

  private template(): string {
    const close = button('<kbd>Esc</kbd> 返回原野', 'panel', 'data-value="none"', 'close-button');
    const heading = (small: string, title: string) => `<div class="panel-heading"><div><span class="eyebrow">${small}</span><h2 tabindex="-1" data-heading>${title}</h2></div>${close}</div>`;
    const range = (key: string, label: string, min = 0, max = 1, step = .01) => `<label class="setting-row"><span>${label}</span><span class="range-wrap"><input aria-label="${label}" type="range" min="${min}" max="${max}" step="${step}" data-setting="${key}"><output></output></span></label>`;
    const toggle = (key: string, label: string, note: string) => `<label class="setting-row"><span>${label}<small>${note}</small></span><input class="toggle" type="checkbox" data-setting="${key}"></label>`;
    const wheelDirections: Record<AbilityId, string> = { magnet: '上', bomb: '右', stasis: '下', ice: '左' };
    const keyGuide = `<div class="control-guide"><div class="key-guide">
      <div><kbd>W A S D</kbd><span>移动（亦可用方向键）</span></div>
      <div><kbd>鼠标</kbd><span>环顾四周</span></div>
      <div><kbd>Shift</kbd><span>按住疾跑</span></div>
      <div><kbd>C / Ctrl</kbd><span>按住蹲伏</span></div>
      <div><kbd>Space</kbd><span>跳跃；贴墙按住攀爬</span></div>
      <div><kbd>Space</kbd><span>获得风帆后，空中按住滑翔</span></div>
      <div><kbd>X</kbd><span>攀爬时蹬墙跳离</span></div>
      <div><kbd>E</kbd><span>交互 / 拾取</span></div>
      <div><kbd>左键</kbd><span>松开攻击 · 按住蓄力</span></div>
      <div><kbd>右键</kbd><span>按住锁定 / 举盾</span></div>
      <div><kbd>G</kbd><span>举盾时盾反</span></div>
      <div><kbd>A / D / S + Space</kbd><span>按住右键时侧跳 / 后撤</span></div>
      <div><kbd>R</kbd><span>按住拉弓 · 松开 R 射箭</span></div>
      <div><kbd>Q</kbd><span>投掷武器 / 放下磁吸物</span></div>
      <div><kbd>滚轮</kbd><span>缩放 / 磁吸距离 / 切换锁定目标</span></div>
      <div><kbd>F</kbd><span>使用所选能力</span></div>
      <div><kbd>1 — 4</kbd><span>选择已解锁能力</span></div>
      <div><kbd>B</kbd><span>按住打开轮盘 · 鼠标定向 · 松开 B 确认已解锁能力；中心松开取消</span></div>
      <div><kbd>V</kbd><span>切换下一颗炸弹形态</span></div>
      <div><kbd>Tab / M</kbd><span>背包 / 地图</span></div>
      <div><kbd>J</kbd><span>任务纪事</span></div>
      <div><kbd>Esc</kbd><span>暂停 / 返回原野</span></div>
      <div><kbd>H</kbd><span>显示 / 隐藏帮助</span></div>
    </div><p class="control-notes">举盾需装备盾牌、留有精力，并使用单手武器或空手。<br>Q 在攀爬时松手、滑翔时收帆；拉弓需装备弓且有箭矢。</p></div>`;
    return `
      <div class="damage-vignette" data-ref="damage" hidden></div>
      <div class="menu-shade" data-ref="menu-shade" hidden></div>
      <section class="title-screen" data-panel="title" hidden aria-label="星坠原野 主菜单">
        <div class="title-topline"><span class="wordmark-mini">A / F</span><span>AN ORIGINAL OPEN-WORLD ADVENTURE</span><span class="edition">序章 · 001</span></div>
        <div class="title-content"><div class="title-kicker"><i></i> 风起之处，星光未眠</div><h1 tabindex="-1" data-heading>星坠原野</h1><div class="title-latin">ASTERFALL <span>/</span> THE FIRST LIGHT</div><p class="title-description">从长夜中醒来。<br>走过遗落的文明，寻回属于旷野的第一缕光。</p>
        <nav class="title-nav" aria-label="主菜单">${button('<span>开始旅程</span><small>NEW JOURNEY</small><i>↗</i>', 'start', '', 'title-primary')}${button('<span>继续旅程</span><small>CONTINUE</small><i>→</i>', 'continue', 'data-ref="continue"')}${button('<span>设置</span><small>SETTINGS</small><i>＋</i>', 'panel', 'data-value="settings"')}</nav>
        <div class="title-controls"><kbd>W A S D</kbd> 移动 <b>·</b> <kbd>鼠标</kbd> 探索视野 <b>·</b> <kbd>E</kbd> 交互</div></div>
        <div class="title-coordinate"><span>THE ASTER PLATEAU</span><i></i><span>遗落之地 / 初光将至</span></div>
        <footer class="title-footer"><span>一段关于苏醒、远行与微光的故事</span><span>低多边形世界 · 原创程序化冒险</span><span>戴上耳机，听见旷野</span></footer>
      </section>
      <section class="hud" data-ref="hud" hidden aria-label="游戏状态">
        <div class="aim-reticle" data-ref="aim-reticle" hidden>
          <svg viewBox="0 0 44 44" aria-hidden="true" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path class="aim-outline" d="M12 9 5 16v12l7 7m20-26 7 7v12l-7 7M22 4v3m0 30v3m0-21 3 3-3 3-3-3Z"/>
            <path d="M12 9 5 16v12l7 7m20-26 7 7v12l-7 7M22 4v3m0 30v3m0-21 3 3-3 3-3-3Z"/>
          </svg>
          <div class="bow-draw" data-ref="bow-draw" role="meter" aria-label="弓弦蓄力" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-live="off">
            <div class="bow-draw-track" aria-hidden="true"><i data-ref="bow-draw-fill"></i></div>
            <span data-ref="bow-draw-label"></span>
          </div>
        </div>
        <div class="hud-upper-left"><div class="hearts" data-ref="hearts" role="meter" aria-label="生命"></div><div class="quest-card"><div class="quest-card-line"><span class="tiny-diamond"></span><span data-ref="quest-counter"></span></div><h3 data-ref="quest-title"></h3><p data-ref="quest-text"></p></div><span class="combat-label" data-ref="combat" hidden>交战中</span></div>
        <div class="compass"><div class="compass-scale"><span>W</span><span>·</span><b>N</b><span>·</span><span>E</span></div><i class="compass-needle" data-ref="compass-needle"></i><span class="compass-target" data-ref="compass-target"><i></i><small data-ref="target-distance"></small></span><small data-ref="bearing"></small></div>
        <div class="location-pill"><span class="location-mark">⌖</span><div><strong data-ref="location"></strong><div class="location-meta"><time data-ref="time"></time><span data-ref="weather"></span><span data-ref="temperature"></span><span data-ref="cold-resist" hidden></span></div></div></div>
        <div class="stamina-ring" data-ref="stamina" hidden role="meter" aria-label="精力"><span data-ref="stamina-label"></span></div>
        <div class="ability-hud"><div class="ability-slots">${ABILITIES.map((a, i) => `<div class="ability-slot locked" data-ref="ability-${a.id}" style="--ability:${a.color}"><span class="ability-diamond"><b>${esc(a.symbol)}</b></span><kbd>${i + 1}</kbd></div>`).join('')}</div><div class="ability-caption"><strong data-ref="ability-name"></strong><span data-ref="ability-hint"></span></div><div class="ability-cooldown" data-ref="ability-cooldown"></div></div>
        <div class="weapon-hud"><div class="weapon-icon">${icon('weapon')}</div><div><strong data-ref="weapon-name"></strong><small data-ref="weapon-detail"></small><small data-ref="equipment-detail"></small></div></div>
        <div class="interaction-prompt" data-ref="prompt" hidden><kbd>E</kbd><span data-ref="prompt-text"></span></div>
        <div class="onboarding" data-ref="onboarding"><span><kbd>W A S D</kbd> 移动</span><span><kbd>鼠标</kbd> 环顾</span><span><kbd>Space</kbd> 跳跃 / 攀爬</span><span><kbd>E</kbd> 交互</span></div>
        <div class="hud-footer"><span><i class="status-dot"></i> <span data-ref="movement"></span></span><div>${button('<kbd>Tab</kbd> 行囊', 'panel', 'data-value="inventory"')}${button('<kbd>M</kbd> 地图', 'panel', 'data-value="map"')}${button('<kbd>H</kbd> 操作', 'help')}</div></div>
      </section>
      <section class="ability-wheel" data-ref="ability-wheel" hidden aria-label="星盘能力轮盘" aria-describedby="ability-wheel-guide">
        <div class="wheel-stage">
          <header class="wheel-header"><span class="eyebrow">ASTRAL INTERFACE / 星盘</span><h2>选择能力</h2></header>
          <div class="wheel-orbit" aria-hidden="true"></div>
          <ul class="wheel-slots" role="list" aria-label="鼠标方向对应能力">
            ${ABILITIES.map(a => `<li class="wheel-slot wheel-slot--${a.id} locked" data-ref="wheel-${a.id}" aria-disabled="true" aria-current="false"><span class="wheel-direction">${wheelDirections[a.id]}</span><span class="wheel-symbol" aria-hidden="true">${esc(a.symbol)}</span><strong>${esc(a.name)}</strong><small data-ref="wheel-${a.id}-state">未解锁 · 不可选择</small></li>`).join('')}
          </ul>
          <div class="wheel-center" role="status" aria-live="polite" aria-atomic="true"><span class="wheel-state" data-ref="wheel-state"></span><h3 data-ref="wheel-name"></h3><p data-ref="wheel-description"></p></div>
          <span class="wheel-origin" aria-hidden="true"></span>
          <span class="wheel-cursor" data-ref="wheel-cursor" aria-hidden="true"></span>
          <p class="wheel-guide" id="ability-wheel-guide"><span>按住 <kbd>B</kbd> · 鼠标定向 · 松开 <kbd>B</kbd> 确认</span><small>中心松开取消 · 仅可选择已解锁能力</small></p>
        </div>
      </section>
      <section class="game-panel inventory-panel" data-panel="inventory" hidden>${heading('THE THINGS WE CARRY', '旅人的行囊')}<div data-ref="inventory-host"><div class="inventory-surface" data-ref="inventory-surface"><div class="inventory-toolbar"><div class="category-tabs" data-ref="category-tabs" role="tablist" aria-label="物品分类">${CATEGORIES.map(([id, label]) => button(label, 'category', `role="tab" data-category="${id}"`)).join('')}</div><select data-sort aria-label="物品排序"><option value="category">按种类</option><option value="name">按名称</option><option value="power">按强度</option></select></div><div class="inventory-columns"><div class="inventory-list"><div class="inventory-count" data-ref="inventory-count"></div><div class="item-grid" data-ref="item-grid"></div><p class="empty-inventory" data-ref="empty-inventory">这里还没有物品。<br><small>原野总会给细心的旅人一点馈赠。</small></p></div><aside class="item-detail" data-ref="item-detail"></aside></div><div class="held-tray"><div class="held-label"><strong>手持素材</strong><small data-ref="held-count"></small></div><div class="held-items" data-ref="held-items"></div><div class="cook-control">${button('投入烹饪 <span>→</span>', 'cook', 'data-ref="cook"', 'primary')}<small data-ref="cook-hint"></small></div></div></div></div></section>
      <section class="game-panel inventory-panel" data-panel="cooking" hidden>${heading('A LITTLE WARMTH', '营火料理')}<div data-ref="cooking-host"></div></section>
      <section class="game-panel map-panel" data-panel="map" hidden>${heading('ATLAS / THE ASTER PLATEAU', '星盘舆图')}<div class="locked-message" data-ref="map-locked">${icon('key')}<span class="eyebrow">NO SIGNAL</span><h3>星盘尚未唤醒</h3><p>在回声密室中取得星盘，方可记录这片大地。</p></div><div class="map-content" data-ref="map-content"><div class="map-sheet"><div class="map-paper-heading"><span>星坠台地</span><small data-ref="map-status"></small></div>${this.mapSvg()}<div class="map-fog-label" data-ref="map-fog">未知的原野<small>等待来自观星之塔的回声</small></div><div class="map-paper-footer"><small data-ref="map-coordinates"></small><small>点击台地放置标记</small></div></div><aside class="map-sidebar"><span class="eyebrow" data-ref="map-quest-status">正在追寻</span><h3 data-ref="map-quest-title"></h3><p data-ref="map-quest-text"></p><div class="map-core-count"><strong data-ref="map-cores"></strong><span>道星光</span></div><ul class="trial-list" data-ref="trial-list"></ul><div class="map-legend"><span><i class="legend-player"></i> 当前位置</span><span>◇ 试炼遗迹</span><span>⚑ 旅人标记</span></div><p class="map-footnote">尚未发现的地点不会留下痕迹。<br>每一次探索，都让世界更清晰。</p></aside></div></section>
      <section class="game-panel journal-panel" data-panel="quests" hidden>${heading('TRACES OF FIRST LIGHT', '星光纪事')}<div class="quest-log" data-ref="quest-log"></div></section>
      <section class="game-panel settings-panel" data-panel="settings" hidden><div class="panel-heading"><div><span class="eyebrow">MAKE THE JOURNEY YOURS</span><h2 tabindex="-1" data-heading>旅途设置</h2></div>${button('返回 <span>↗</span>', 'settings-back', '', 'close-button')}</div><div class="settings-form" data-ref="settings-form"><div class="settings-column"><h3>画面与操控</h3><label class="setting-row"><span>画面质量<small>低配设备可选择「流畅」</small></span><select data-setting="quality" aria-label="画面质量"><option value="low">流畅</option><option value="medium">均衡</option><option value="high">精致</option></select></label>${range('sensitivity', '视角灵敏度', .25, 2, .05)}${toggle('shake', '镜头震动', '关闭以获得更平稳的镜头')}${toggle('subtitles', '演出字幕', '对话选项始终显示')}${toggle('colorblind', '高辨识配色', '以颜色及形状共同区分状态')}</div><div class="settings-column"><h3>旷野之声</h3>${range('volume', '主音量')}${range('music', '音乐')}${range('ambient', '环境')}${range('sfx', '音效')}<p class="settings-note">声音由实时合成生成。第一次交互后启用音频。<br>设置将随旅途保存。</p></div></div><div class="settings-bottom"><span>键鼠游玩 · 建议佩戴耳机</span>${button('查看完整操作', 'help', '', 'subtle')}</div></section>
      <section class="pause-panel" data-panel="pause" hidden><div class="pause-main"><span class="eyebrow">A MOMENT BETWEEN ADVENTURES</span><h2 tabindex="-1" data-heading>风，稍作停留。</h2><p>路途很长。不必急于抵达。</p><nav>${button('继续旅程 <span>→</span>', 'panel', 'data-value="none"', 'primary')}${button('旅人的行囊', 'panel', 'data-value="inventory"')}${button('星盘舆图', 'panel', 'data-value="map"')}${button('星光纪事', 'panel', 'data-value="quests"')}${button('旅途设置', 'panel', 'data-value="settings"')}${button('记录旅途', 'save', 'data-ref="save"')}${button('返回标题', 'panel', 'data-value="title"', 'subtle')}</nav><small data-ref="save-hint"></small></div><div class="pause-guide"><span class="eyebrow">FIELD NOTES / 操作指南</span>${keyGuide}</div></section>
      <section class="death-panel" data-panel="death" hidden><div class="death-sigil">${icon('key')}</div><span class="eyebrow">EVEN STARS FALL</span><h2 tabindex="-1" data-heading>你倒下了</h2><p>微光尚未熄灭。再一次，回应旷野的呼唤。</p><nav>${button('从最近存档继续', 'continue', 'data-ref="death-continue"', 'primary')}${button('返回标题', 'panel', 'data-value="title"', 'subtle')}</nav></section>
      <section class="dialogue-panel" data-panel="dialogue" hidden><div class="dialogue-box"><span class="dialogue-speaker" data-ref="dialogue-speaker"></span><p data-ref="dialogue-text" aria-live="off"></p>${button('显示全文 <kbd>E</kbd>', 'dialogue-skip', 'data-ref="dialogue-skip"', 'dialogue-skip')}<div class="dialogue-options" data-ref="dialogue-options"></div></div></section>
      <div class="cinematic" data-ref="cinematic" hidden><div class="letterbox-top"><span>ASTERFALL / THE FIRST LIGHT</span>${button('跳过演出 <span>→</span>', 'cinematic-skip')}</div><div class="cinematic-caption"><span class="eyebrow">A STORY WRITTEN IN STARLIGHT</span><h2 data-ref="cinematic-title"></h2><p data-ref="cinematic-text"></p></div><div class="letterbox-bottom"><div data-ref="cinematic-progress"></div></div></div>
      <div class="notices" data-ref="notices" role="status" aria-live="polite" aria-atomic="false"></div>
      <aside class="quick-help" data-ref="help" hidden><header><span class="eyebrow">FIELD NOTES / 旅人指南</span>${button('关闭 <kbd>H</kbd>', 'help')}</header><h3>让好奇心带路。</h3>${keyGuide}<p>攀爬和滑翔都会消耗精力；雨中的岩壁格外湿滑。<br>寒冷时寻找火光，或用辛辣素材烹饪。</p></aside>
      <div class="error-banner" data-ref="error" role="alert" hidden><strong>旅途遇到了一点阻碍</strong><p data-ref="error-text"></p>${button('返回标题', 'panel', 'data-value="title"')}</div>
      ${import.meta.env.DEV ? this.debugTemplate() : '<div data-ref="debug" hidden></div>'}
    `;
  }

  private mapSvg(): string {
    const contours = Array.from({ length: 7 }, (_, i) => {
      const scale = 1 - i * .085;
      return `<path transform="scale(${scale})" d="M-24-141 23-136 62-125 76-103 112-86 134-48 130-19 142 8 123 41 120 76 92 91 76 121 36 130 9 142-26 128-61 131-77 109-111 87-118 50-138 21-131-10-140-43-114-68-102-101-62-110Z"/>`;
    }).join('');
    return `<svg class="map-svg" data-map data-ref="map-svg" viewBox="-165 -165 330 330" role="img" aria-label="星坠台地地图，北方位于上方；点击放置标记"><defs><pattern id="aster-map-grid" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M22 0H0V22" fill="none" stroke="#304d4c" stroke-width=".3" opacity=".22"/></pattern><radialGradient id="aster-map-halo"><stop stop-color="#456a61" stop-opacity=".15"/><stop offset="1" stop-color="#456a61" stop-opacity="0"/></radialGradient></defs><rect x="-165" y="-165" width="330" height="330" fill="url(#aster-map-grid)"/><circle r="148" fill="url(#aster-map-halo)"/><g class="map-contours" fill="none" stroke="#667266" stroke-width=".65">${contours}</g><g class="map-terrain" fill="none" stroke="#627f74" stroke-width=".7"><path d="M-104-68q13-30 42-20t13 28q-4 21-21 11t-31-7Z M-91-68q14-26 35-10t-13 23Z M-79-66q5-14 16-6t-10 10Z"/><path d="M35-103q33-8 38 25t-8 32q-19 7-25-10t-5-47ZM44-86q17-21 19 7t-15 15Z"/><path d="M-17 116Q-8 77 6 61T0 0Q21-38 3-72 M0 0Q-37 10-63 27M0 0Q42 11 64 32M0-11Q-44-23-66-66M0-8Q40-23 65-60" stroke-dasharray="2 2" opacity=".7"/><path d="M-52 26q-18 8-9 24t28 20q22-4 18-21t-18-17Z" fill="#729797" fill-opacity=".35"/><path d="M-34 68q15 11 7 28t-7 23" stroke="#779b9d" stroke-width="2"/><circle r="13"/><circle r="17" stroke-dasharray="1 2"/><path d="M-13-85h26v18h-26ZM-9-80h18v10H-9Z"/></g><g class="map-boundary" fill="none" stroke="#a29c80" stroke-width=".8"><circle r="149" stroke-dasharray="1 4"/><path d="M-154 0h7m294 0h7M0-154v7M0 147v7"/></g><g transform="translate(136 -135)" fill="none" stroke="#767e68" stroke-width=".9"><path d="M0-10 3 5 0 2-3 5Z"/><text y="-15" text-anchor="middle" fill="#767e68" stroke="none" font-size="6">N</text></g><g data-ref="map-pois"></g><g data-ref="map-pins"></g><g class="map-player" data-ref="map-player"><circle r="8"/><path d="M0-6 4 4 0 2-4 4Z"/></g></svg>`;
  }

  private debugTemplate(): string {
    return `<aside class="debug-panel" data-ref="debug" hidden><header>DEVELOPMENT <kbd>&#96;</kbd></header><pre data-ref="debug-state"></pre><label>传送<select data-ref="debug-location">${Object.entries(LOCATIONS).map(([id, location]) => `<option value="${id}">${esc(location.name)}</option>`).join('')}${ABILITIES.map(a => `<option value="trial:${a.id}">${a.name}试炼内部</option>`).join('')}</select></label>${button('传送', 'debug-teleport')}<div class="debug-buttons">${[['heal', '生命 / 精力'], ['items', '补给物品'], ['clearItems', '清空物品'], ['repair', '修复装备'], ['unlock', '解锁能力 / 风帆'], ['lock', '锁定能力 / 风帆'], ['bloodmoon', '触发血月'], ['save', '强制保存'], ['load', '读取存档']].map(([value, label]) => button(label!, 'debug', `data-value="${value}"`)).join('')}${button('清除存档', 'debug-clear')}</div><label>天气<select data-debug="weather"><option value="clear">晴</option><option value="cloudy">阴</option><option value="rain">雨</option></select></label><label>时间<select data-debug="time"><option value="6">清晨 06:00</option><option value="12">正午 12:00</option><option value="18">黄昏 18:00</option><option value="0">午夜 00:00</option></select></label></aside>`;
  }
}
