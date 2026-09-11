import type { AbilityId, Vec3 } from '../core/types';
export const CONFIG = {
  radius: 145, walkSpeed: 6, sprintSpeed: 10.5, crouchSpeed: 2.5, swimSpeed: 3.5,
  climbSpeed: 3.4, glideSpeed: 8.5, gravity: 22, jumpSpeed: 8.2, playerRadius: 0.42,
  playerHeight: 1.8, maxDelta: 0.05, stepHeight: 0.55, staminaRegen: 25,
  sprintDrain: 13, climbDrain: 12, swimDrain: 5, glideDrain: 8,
  staminaDelay: 0.7, parryWindow: 0.17, dodgeWindow: 0.23, focusDuration: 2,
  focusScale: 0.2, coldInterval: 7, dayDuration: 1440, bloodMoonDays: 3,
  weaponSlots: 8, arrowPoolSize: 48, particlePoolSize: 180, maxIce: 3,
  bombCooldown: 3, stasisCooldown: 8, magnetRange: 19, iceRange: 18,
  interactDistance: 3.4,
} as const;
export const ABILITIES: { id: AbilityId; name: string; symbol: string; color: string; description: string }[] = [
  { id:'magnet', name:'牵星', symbol:'⌁', color:'#ea719a', description:'F 吸附金属，鼠标移动，滚轮调距；再次 F 释放。' },
  { id:'bomb', name:'鸣爆', symbol:'◇', color:'#65d8f7', description:'F 放置炸弹，再按 F 引爆；V 切换球形 / 方形。' },
  { id:'stasis', name:'凝时', symbol:'◷', color:'#f8cf65', description:'F 冻结金色机关；攻击冻结物积蓄冲量。' },
  { id:'ice', name:'霜阶', symbol:'▱', color:'#8ccff8', description:'瞄准水面按 F 造柱；再次瞄准冰柱可破坏，最多三根。' },
];
export const LOCATIONS: Record<string, { name: string; position: Vec3; type: string }> = {
  chamber: {name:'回声密室',position:[0,0,105],type:'chamber'},
  outlook: {name:'初光崖',position:[0,0,82],type:'view'},
  elder: {name:'旅人的营火',position:[9,0,64],type:'campfire'},
  tower: {name:'观星之塔',position:[0,0,0],type:'tower'},
  magnet: {name:'牵星遗迹',position:[-65,0,26],type:'shrine'},
  bomb: {name:'鸣爆遗迹',position:[64,0,32],type:'shrine'},
  stasis: {name:'凝时遗迹',position:[65,0,-60],type:'shrine'},
  ice: {name:'霜阶遗迹',position:[-66,0,-66],type:'shrine'},
  temple: {name:'无名者圣所',position:[0,0,-75],type:'temple'},
  camp1: {name:'余烬营地',position:[35,0,50],type:'camp'},
  camp2: {name:'望风营地',position:[-45,0,-18],type:'camp'},
  camp3: {name:'断壁营地',position:[42,0,-35],type:'camp'},
  lake: {name:'月镜湖',position:[-35,0,46],type:'lake'},
  cabin: {name:'落雪木屋',position:[-41,0,-46],type:'cabin'},
};
export const QUESTS: Record<string, {title: string; text: string; target: string}> = {
  AWAKEN:{title:'从长夜醒来',text:'在石台附近找到发光的星盘终端。',target:'chamber'},
  GET_TERMINAL:{title:'沉睡的星盘',text:'靠近发光台座，按 E 取得星盘。',target:'chamber'},
  EXIT_CHAMBER:{title:'第一缕光',text:'以星盘打开石门，跳跃攀上矮墙，走向洞外。',target:'outlook'},
  MEET_ELDER:{title:'篝火旁的旅人',text:'与山坡下的白发旅人交谈。',target:'elder'},
  ACTIVATE_TOWER:{title:'来自大地的回声',text:'抵达中央环形遗迹，用星盘唤醒观星之塔。',target:'tower'},
  FIRST_TRIAL:{title:'一场小小的交易',text:'进入任意一座遗迹，取得能力并完成试炼。',target:'magnet'},
  COMPLETE_FOUR_TRIALS:{title:'四道星光',text:'探索四座遗迹，收集四枚星核。顺序由你决定。',target:''},
  VISIT_TEMPLE:{title:'星光归处',text:'前往北方无名者圣所，用四枚星核兑换成长。',target:'temple'},
  RECEIVE_GLIDER:{title:'最后一位守望者',text:'攀上圣所高台，听旅人讲述往事并取得风帆。',target:'temple'},
  PROLOGUE_COMPLETE:{title:'旷野正在等待',text:'从台地边缘跃下，按住空格展开风帆，飞向远方。',target:''},
};
