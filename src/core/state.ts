import type { AbilityId, GameState, Settings, Vec3 } from './types';

export const SAVE_KEY = 'asterfall.save.v1';
export const SETTINGS_KEY = 'asterfall.settings.v1';
export const DEFAULT_SETTINGS: Settings = { quality:'medium', volume:0.55, music:0.3, ambient:0.45, sfx:0.7, sensitivity:1, shake:true, subtitles:true, colorblind:false };
export function createState(settings: Settings = {...DEFAULT_SETTINGS}): GameState {
  return {
    version:1, player:{position:[0,0,105],yaw:0,hp:12,maxHp:12,stamina:100,maxStamina:100,coldResist:0,movement:'idle'},
    safePosition:[0,0,82],region:'overworld',quest:'AWAKEN',inventory:[],equipment:{weapon:null,bow:null,shield:null,clothes:null,trousers:null},
    flags:{},discovered:['chamber'],abilities:[],selectedAbility:'magnet',completed:[],trialStages:{magnet:0,bomb:0,stasis:0,ice:0},cores:0,
    terminal:false,tower:false,glider:false,upgrade:null,time:7.1,day:1,weather:'clear',weatherSeed:7381,lastBloodMoon:0,bloodMoonCount:0,
    enemies:{},pins:[],settings:{...settings},playSeconds:0,
  };
}
const ABILITY_IDS: AbilityId[] = ['magnet','bomb','stasis','ice'];
const QUEST_IDS = ['AWAKEN','GET_TERMINAL','EXIT_CHAMBER','MEET_ELDER','ACTIVATE_TOWER','FIRST_TRIAL','COMPLETE_FOUR_TRIALS','VISIT_TEMPLE','RECEIVE_GLIDER','PROLOGUE_COMPLETE'];
const finite = (v:unknown):v is number => typeof v==='number' && Number.isFinite(v);
const vector = (v:unknown):v is Vec3 => Array.isArray(v) && v.length===3 && v.every(finite);
const record = (v:unknown):v is Record<string,unknown> => typeof v==='object' && v!==null && !Array.isArray(v);
function bounded(value:unknown, fallback:number, min:number, max:number):number {return finite(value)?Math.max(min,Math.min(max,value)):fallback;}
export function parseSettings(raw: unknown): Settings {
  const s=record(raw)?raw:{};
  return { quality:s.quality==='low'||s.quality==='high'?s.quality:'medium', volume:bounded(s.volume,0.55,0,1), music:bounded(s.music,0.3,0,1), ambient:bounded(s.ambient,0.45,0,1), sfx:bounded(s.sfx,0.7,0,1), sensitivity:bounded(s.sensitivity,1,0.2,3), shake:typeof s.shake==='boolean'?s.shake:true,subtitles:typeof s.subtitles==='boolean'?s.subtitles:true,colorblind:s.colorblind===true };
}
export function migrateSave(raw: unknown): GameState {
  if (!record(raw) || (raw.version!==1 && raw.version!==0)) throw new Error('不支持的存档版本');
  if (!record(raw.player) || !Array.isArray(raw.inventory) || !record(raw.flags)) throw new Error('存档结构损坏');
  const s=createState(parseSettings(raw.settings));
  const p=raw.player;
  s.player.maxHp=bounded(p.maxHp,12,4,80);s.player.hp=bounded(p.hp,s.player.maxHp,0,s.player.maxHp);
  s.player.maxStamina=bounded(p.maxStamina,100,40,300);s.player.stamina=bounded(p.stamina,s.player.maxStamina,0,s.player.maxStamina);
  s.player.coldResist=bounded(p.coldResist,0,0,3600);s.player.yaw=bounded(p.yaw,0,-100000,100000);
  if(vector(raw.safePosition) && Math.hypot(raw.safePosition[0],raw.safePosition[2])<144 && raw.safePosition[1]>=-20 && raw.safePosition[1]<200) s.safePosition=[...raw.safePosition];
  s.player.position=vector(p.position)?[...p.position]:[...s.safePosition];
  if (Math.abs(s.player.position[1])>300 || Math.hypot(s.player.position[0],s.player.position[2])>250) s.player.position=[...s.safePosition];
  s.region=raw.region==='overworld'||ABILITY_IDS.includes(raw.region as AbilityId)?raw.region as GameState['region']:'overworld';
  s.quest=QUEST_IDS.includes(raw.quest as string)?raw.quest as GameState['quest']:'GET_TERMINAL';
  s.inventory=raw.inventory.filter(record).filter(v=>typeof v.uid==='string'&&typeof v.id==='string'&&finite(v.count)&&v.count>0).slice(0,150).map(v=>({uid:String(v.uid),id:String(v.id),count:bounded(v.count,1,1,999),...(finite(v.durability)?{durability:Math.max(0,v.durability)}:{}),...(finite(v.heal)?{heal:Math.max(0,v.heal)}:{}),...(finite(v.cold)?{cold:Math.max(0,v.cold)}:{}),...(finite(v.energy)?{energy:Math.max(0,v.energy)}:{}),...(typeof v.name==='string'?{name:v.name.slice(0,80)}:{})}));
  if(record(raw.equipment)) for(const key of Object.keys(s.equipment) as (keyof GameState['equipment'])[]) {const uid=raw.equipment[key];s.equipment[key]=typeof uid==='string'&&s.inventory.some(i=>i.uid===uid)?uid:null;}
  s.flags=Object.fromEntries(Object.entries(raw.flags).filter((entry):entry is [string,boolean]=>entry[0].length<120&&typeof entry[1]==='boolean'));
  s.discovered=Array.isArray(raw.discovered)?raw.discovered.filter((v):v is string=>typeof v==='string').slice(0,200):s.discovered;
  s.abilities=ABILITY_IDS.filter(id=>Array.isArray(raw.abilities)&&raw.abilities.includes(id));
  s.completed=ABILITY_IDS.filter(id=>Array.isArray(raw.completed)&&raw.completed.includes(id));
  s.selectedAbility=ABILITY_IDS.includes(raw.selectedAbility as AbilityId)?raw.selectedAbility as AbilityId:s.abilities[0]??'magnet';
  for (const id of ABILITY_IDS) s.trialStages[id]=s.completed.includes(id)?3:Math.floor(bounded(record(raw.trialStages)?raw.trialStages[id]:0,0,0,3));
  for(const key of ['terminal','tower','glider'] as const) s[key]=raw[key]===true;
  s.upgrade=raw.upgrade==='heart'||raw.upgrade==='stamina'?raw.upgrade:null;
  s.cores=s.upgrade?0:s.completed.length;
  s.time=bounded(raw.time,7,0,23.99999);s.day=Math.floor(bounded(raw.day,1,1,100000));
  s.weather=raw.weather==='rain'||raw.weather==='cloudy'?raw.weather:'clear';
  s.weatherSeed=Math.floor(bounded(raw.weatherSeed,7381,0,0xffffffff));s.lastBloodMoon=bounded(raw.lastBloodMoon,0,0,s.day);
  s.bloodMoonCount=bounded(raw.bloodMoonCount,0,0,10000);s.playSeconds=bounded(raw.playSeconds,0,0,1e9);
  if(record(raw.enemies)) for(const [id,value] of Object.entries(raw.enemies)) {if(record(value)&&finite(value.hp)&&typeof value.dead==='boolean') s.enemies[id]={hp:Math.max(0,value.hp),dead:value.dead,...(vector(value.position)?{position:[...value.position] as Vec3}:{})};}
  s.pins=Array.isArray(raw.pins)?raw.pins.filter(record).filter(p=>finite(p.x)&&finite(p.z)&&Math.abs(p.x)<150&&Math.abs(p.z)<150).slice(0,8).map(p=>({x:p.x as number,z:p.z as number})):[];
  return s;
}
export class SaveStore {
  error='';
  private storage: Pick<Storage,'getItem'|'setItem'|'removeItem'>;
  constructor(storage?: Pick<Storage,'getItem'|'setItem'|'removeItem'>) {
    try {this.storage=storage??globalThis.localStorage;if(!this.storage)throw new Error('storage unavailable');}
    catch {this.storage={getItem:()=>null,setItem:()=>{throw new Error('storage unavailable');},removeItem:()=>{}};this.error='浏览器禁用了本地存储，本次旅程无法保存。';}
  }
  load():GameState|null {try {const raw=this.storage.getItem(SAVE_KEY);if(!raw)return null;const state=migrateSave(JSON.parse(raw));this.error='';return state;}catch{this.error='存档无法读取。你可以开始新旅程，旧存档不会导致游戏崩溃。';return null;}}
  save(state:GameState):boolean {try{this.storage.setItem(SAVE_KEY,JSON.stringify({...state,version:1}));this.error='';return true;}catch{this.error='浏览器存储已满或被禁用，存档未写入。';return false;}}
  clear():void {try{this.storage.removeItem(SAVE_KEY);this.error='';}catch{this.error='无法清除浏览器存档';}}
  settings():Settings {try{return parseSettings(JSON.parse(this.storage.getItem(SETTINGS_KEY)??'{}'));}catch{return {...DEFAULT_SETTINGS};}}
  saveSettings(settings:Settings):void {try{this.storage.setItem(SETTINGS_KEY,JSON.stringify(settings));}catch{this.error='设置无法保存';}}
}
