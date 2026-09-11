import { CONFIG } from '../config/game';
import type { GameState, Vec3 } from './types';
export function advanceClock(state:GameState,dt:number):boolean {
  state.playSeconds+=dt;
  state.time+=dt*24/CONFIG.dayDuration;
  while(state.time>=24){state.time-=24;state.day++;if(state.day%2===0){state.weatherSeed=(Math.imul(state.weatherSeed,1664525)+1013904223)>>>0;state.weather=['clear','cloudy','rain'][state.weatherSeed%3] as GameState['weather'];}}
  if(state.day%CONFIG.bloodMoonDays===0 && state.time<1 && state.lastBloodMoon!==state.day) state.flags.bloodMoonPending=true;
  return state.flags.bloodMoonPending===true;
}
export function applyBloodMoon(state:GameState,spawns:{id:string;position:Vec3}[],player:Vec3):number {
  delete state.flags.bloodMoonPending;
  state.lastBloodMoon=state.day;state.bloodMoonCount++;
  let reset=0;
  for(const spawn of spawns){if(Math.hypot(spawn.position[0]-player[0],spawn.position[2]-player[2])<28){state.flags['blood-pending:'+spawn.id]=true;}else{delete state.enemies[spawn.id];reset++;}}
  for(const key of Object.keys(state.flags)){if(key.startsWith('picked:resource-')||key.startsWith('felled:')||key.startsWith('shaken:')||key.startsWith('apples:')) delete state.flags[key];}
  return reset;
}
