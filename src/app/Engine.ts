import * as THREE from 'three';
import { CONFIG, LOCATIONS, ABILITIES } from '../config/game';
import { ITEMS } from '../config/items';
import { createState, SaveStore } from '../core/state';
import { recoverSavedPosition } from '../core/recovery';
import { advanceClock, applyBloodMoon } from '../core/clock';
import { Input } from '../core/input';
import { Effects } from '../core/effects';
import type { AbilityId, ActorView, Dialogue, GameContext, GameState, Interactable, Panel, Region, Settings, Vec3, WorldView } from '../core/types';
import { Overworld } from '../world/Overworld';
import { PlayerController } from '../player/PlayerController';
import { Gameplay, addItem } from '../interaction/Gameplay';
import { CombatSystem } from '../combat/CombatSystem';
import { AbilitySystem, buildTrial } from '../abilities/AbilitySystem';
import { GameUI } from '../ui/GameUI';
import { AudioSystem } from '../audio/AudioSystem';

interface Cinema {title:string;text:string;duration:number;remaining:number;done?:()=>void;}
export class Engine {
  readonly renderer:THREE.WebGLRenderer;
  readonly scene=new THREE.Scene();
  readonly camera=new THREE.PerspectiveCamera(57,1,.1,650);
  readonly store=new SaveStore();
  readonly input:Input;
  readonly effects:Effects;
  readonly audio=new AudioSystem();
  readonly ctx:GameContext;
  readonly ui:GameUI;
  player!:PlayerController;combat!:CombatSystem;abilities!:AbilitySystem;gameplay!:Gameplay;
  panel:Panel='title';started=false;
  private abilityWheel:{selected:AbilityId|null;x:number;y:number}|undefined;
  private readonly cameraBounds=new THREE.Box3();
  private readonly cameraSight=new THREE.Ray();
  private readonly cameraContact=new THREE.Vector3();
  private readonly cameraOccluders:THREE.Object3D[]=[];
  private dialogue:Dialogue|null=null;private cinema:Cinema|null=null;private notices:{id:number;text:string;kind:string;end:number}[]=[];private noticeId=0;
  private sun=new THREE.DirectionalLight(0xffefd4,2.2);private hemi=new THREE.HemisphereLight(0xcceef3,0x405b41,2.5);
  private lastTime=0;private frame=0;private fps=60;private hurtUntil=0;private rendering=true;private hasSave=false;private pendingMoon=false;private uiTick=0;private presentationTime=0;private uiRoot!:HTMLElement;private abort=new AbortController();
  constructor(root:HTMLElement){
    this.renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
    this.renderer.domElement.id='game-canvas';this.renderer.domElement.setAttribute('aria-label','星坠原野三维游戏世界');root.append(this.renderer.domElement);
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.15;
    this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;this.scene.background=new THREE.Color(0xabcdd3);this.scene.fog=new THREE.FogExp2(0xabcdd3,.004);
    this.sun.position.set(40,90,30);this.sun.castShadow=true;this.sun.shadow.camera.left=-65;this.sun.shadow.camera.right=65;this.sun.shadow.camera.top=65;this.sun.shadow.camera.bottom=-65;this.sun.shadow.camera.near=1;this.sun.shadow.camera.far=220;this.sun.shadow.bias=-.001;this.sun.shadow.normalBias=.15;
    this.scene.add(this.sun,this.sun.target,this.hemi);
    this.input=new Input(this.renderer.domElement);this.effects=new Effects(this.scene);
    const state=createState(this.store.settings());
    this.ctx={state,scene:this.scene,camera:this.camera,input:this.input,world:null as unknown as WorldView,actor:null as unknown as ActorView,effects:this.effects,elapsed:0,realDt:0,timeScale:1,inCombat:false,
      notify:(text,kind='info')=>this.notify(text,kind),sound:(name,p)=>this.audio.play(name,p),damage:(amount,source)=>this.damage(amount,source),addItem:(id,count,extra)=>addItem(this.ctx.state,id,count,extra),save:()=>this.save(false),changeRegion:(region,p)=>this.changeRegion(region,p),cinematic:(title,text,duration,done)=>this.showCinema(title,text,duration,done)};
    const uiRoot=document.createElement('div');uiRoot.id='interface';root.append(uiRoot);this.uiRoot=uiRoot;
    this.ui=new GameUI(uiRoot,{start:continuing=>this.start(continuing),panel:p=>this.setPanel(p),save:()=>this.save(true),inventory:(action,uid)=>{this.gameplay.inventoryAction(action,uid);this.input.clear();},cook:()=>this.gameplay.cook(),upgrade:type=>this.gameplay.upgrade(type),settings:s=>this.settings(s),pin:(x,z)=>{const pins=this.ctx.state.pins;const index=pins.findIndex(p=>Math.hypot(p.x-x,p.z-z)<7);if(index>=0)pins.splice(index,1);else if(pins.length<8)pins.push({x,z});else this.notify('最多放置 8 枚图钉。','warning');this.save(false);},debug:(a,v)=>this.debug(a,v)});
    this.hasSave=this.store.load()!==null;this.rebuild(state);this.settings(state.settings);
    window.addEventListener('resize',()=>this.resize(),{signal:this.abort.signal});
    window.addEventListener('mousemove',event=>{
      const wheel=this.abilityWheel;if(!wheel)return;
      if(document.pointerLockElement===this.renderer.domElement){wheel.x+=event.movementX;wheel.y+=event.movementY;}
      else{wheel.x=event.clientX-window.innerWidth/2;wheel.y=event.clientY-window.innerHeight/2;}
      const length=Math.hypot(wheel.x,wheel.y);
      if(length>130){wheel.x*=130/length;wheel.y*=130/length;}
      wheel.selected=length<30?null:Math.abs(wheel.x)>Math.abs(wheel.y)?wheel.x>0?'bomb':'ice':wheel.y>0?'stasis':'magnet';
    },{signal:this.abort.signal});
    document.addEventListener('visibilitychange',()=>{this.input.clear();this.lastTime=performance.now();if(document.hidden&&this.started&&this.panel==='none'&&!this.cinema)this.setPanel('pause');},{signal:this.abort.signal});
    window.addEventListener('blur',()=>{if(this.started&&this.panel==='none'&&!this.cinema)this.setPanel('pause');},{signal:this.abort.signal});
    this.resize();this.renderUI();requestAnimationFrame(t=>this.tick(t));
    if(import.meta.env.DEV){Object.defineProperty(window,'__asterfall',{value:this,configurable:true});}
  }
  get state():GameState{return this.ctx.state;}
  private rebuild(state:GameState):void{
    this.combat?.dispose();this.abilities?.dispose();this.player?.dispose();if(this.ctx.world){this.scene.remove(this.ctx.world.root);this.ctx.world.dispose();}
    this.ctx.state=state;this.ctx.inCombat=false;this.ctx.timeScale=1;
    this.ctx.world=state.region==='overworld'?new Overworld(state):buildTrial(state.region,state);this.scene.add(this.ctx.world.root);
    recoverSavedPosition(state,this.ctx.world);
    this.player=new PlayerController(this.ctx);this.ctx.actor=this.player;
    this.combat=new CombatSystem(this.ctx);this.abilities=new AbilitySystem(this.ctx,(p,r,d,source)=>this.combat.hitArea(p,r,d,!source,source));this.abilities.freezeEnemy=(p,r,t)=>Boolean(this.combat.freezeNearest(p,r,t));
    this.gameplay=new Gameplay(this.ctx,d=>this.showDialogue(d));
    this.input.clear();
  }
  start(continuing:boolean):void{
    void this.audio.start();const loaded=continuing?this.store.load():null;
    if(continuing&&!loaded){this.notify(this.store.error||'还没有存档，开始一段新旅程。','warning');}
    const state=loaded??createState(this.ctx.state.settings);state.settings={...this.ctx.state.settings};this.cinema=null;this.dialogue=null;this.hurtUntil=0;this.pendingMoon=state.flags.bloodMoonPending===true;
    if(state.player.hp<=0){state.player.hp=state.player.maxHp;state.player.stamina=state.player.maxStamina;state.player.position=state.region==='overworld'?[...state.safePosition]:[0,0,9];}
    this.rebuild(state);this.settings(state.settings);this.started=true;this.setPanel('none');
    if(!loaded){this.showCinema('第一束光','长夜沉入石缝。远方，有一颗星仍在等你。',4,()=>{this.ctx.state.quest='GET_TERMINAL';this.notify('WASD 移动 · 鼠标转动视角 · E 与发光物体交互');});}
    else this.notify('旅程已继续。星光记得你的足迹。','success');
  }
  changeRegion(region:Region,position?:Vec3):void{
    this.abilities.dispose();this.combat.dispose();this.scene.remove(this.ctx.world.root);this.ctx.world.dispose();
    this.ctx.state.region=region;this.ctx.world=region==='overworld'?new Overworld(this.ctx.state):buildTrial(region,this.ctx.state);this.scene.add(this.ctx.world.root);
    const p:Vec3=position?[...position]:[0,0,9];p[1]=Math.max(p[1],this.ctx.world.heightAt(p[0],p[2]));this.player.teleport(p);this.player.velocity.set(0,0,0);this.ctx.inCombat=false;
    this.combat=new CombatSystem(this.ctx);this.abilities=new AbilitySystem(this.ctx,(p,r,d,source)=>this.combat.hitArea(p,r,d,!source,source));this.abilities.freezeEnemy=(p,r,t)=>Boolean(this.combat.freezeNearest(p,r,t));this.input.clear();this.ctx.timeScale=1;this.hurtUntil=this.ctx.elapsed+1;this.dialogue=null;this.setPanel('none');
    this.notify(region==='overworld'?'回到星坠台地':`${ABILITIES.find(a=>a.id===region)?.name}遗迹 · 靠近星盘基座下载能力`);
  }
  private showDialogue(dialogue:Dialogue):void{
    this.dialogue={...dialogue,options:dialogue.options.map(option=>({label:option.label,action:()=>{this.dialogue=null;this.setPanel('none');option.action();this.input.clear();}}))};this.setPanel('dialogue');
  }
  private showCinema(title:string,text:string,duration:number,done?:()=>void):void{
    this.abilityWheel=undefined;
    if(this.cinema)this.finishCinema();this.dialogue=null;this.panel='none';this.input.unlock();this.input.enabled=false;this.cinema={title,text,duration:Math.max(.2,duration),remaining:Math.max(.2,duration),done};this.audio.play('quest');
  }
  private finishCinema():void{const c=this.cinema;if(!c)return;this.cinema=null;this.input.clear();c.done?.();this.input.enabled=this.started&&this.panel==='none'&&!this.cinema;}
  setPanel(panel:Panel):void{
    if(this.started&&this.state.player.hp<=0&&panel!=='title'&&panel!=='death')return;
    this.abilityWheel=undefined;
    if(panel==='title'){this.started=false;this.cinema=null;this.dialogue=null;this.hasSave=this.store.load()!==null;}
    if(panel==='none'&&!this.started)panel='title';
    if(this.cinema&&panel==='none'){this.finishCinema();return;}
    this.panel=panel;this.input.enabled=this.started&&panel==='none'&&!this.cinema;
    if(panel!=='none')this.input.unlock();else this.input.clear();
    this.renderUI();
  }
  private save(manual:boolean):void{
    if(manual&&this.ctx.inCombat){this.notify('战斗中无法手动存档。脱离敌人视线后再试。','warning');return;}
    if(!this.started||this.ctx.state.player.hp<=0)return;
    this.ctx.state.player.position=this.player.position.toArray() as Vec3;
    if(this.store.save(this.ctx.state)){this.hasSave=true;if(manual)this.notify('旅程已保存。','success');else this.notify('星盘记录了此刻。','success');}else this.notify(this.store.error,'warning');
  }
  private damage(amount:number,source:string):void{
    if(this.ctx.state.player.hp<=0||this.ctx.elapsed<this.hurtUntil||this.cinema)return;
    const s=this.ctx.state;let defense=0;
    if(!['寒冷','溺水','坠落','深谷'].some(v=>source.includes(v))){for(const slot of [s.equipment.clothes,s.equipment.trousers]){const item=s.inventory.find(i=>i.uid===slot);if(item)defense+=ITEMS[item.id]?.defense??0;}}
    const hit=Math.max(.25,amount-defense*.25);s.player.hp=Math.max(0,s.player.hp-hit);this.hurtUntil=this.ctx.elapsed+.7;this.player.model.userData.hurt=.4;this.effects.shake(.24);this.audio.play('hurt');
    document.body.classList.remove('is-hurt');void document.body.offsetWidth;document.body.classList.add('is-hurt');
    if(s.player.hp<=0){s.player.movement='dead';this.player.model.rotation.z=-Math.PI/2;this.audio.play('death');this.setPanel('death');}
    else if(source)this.notify(`${source} · −${Math.round(hit*10)/10} 生命`,'warning');
  }
  private notify(text:string,kind='info'):void{if(this.notices.some(n=>n.text===text&&n.end>this.presentationTime))return;this.notices.push({id:++this.noticeId,text,kind,end:this.presentationTime+5});if(this.notices.length>5)this.notices.shift();}
  private settings(settings:Partial<Settings>):void{
    Object.assign(this.ctx.state.settings,settings);const s=this.ctx.state.settings;this.store.saveSettings(s);this.audio.setSettings(s);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,s.quality==='low'?1:s.quality==='medium'?1.5:2));this.renderer.shadowMap.enabled=s.quality!=='low';const size=s.quality==='high'?2048:1024;
    if(this.sun.shadow.mapSize.x!==size){this.sun.shadow.mapSize.set(size,size);this.sun.shadow.map?.dispose();this.sun.shadow.map=null;}
    document.documentElement.classList.toggle('colorblind',s.colorblind);this.resize();
  }
  private resize():void{const w=window.innerWidth,h=window.innerHeight;this.renderer.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}
  private nearest():Interactable|undefined{
    let nearest:Interactable|undefined;let distance=Infinity;
    for(const item of this.ctx.world.interactables){if(!this.gameplay.getPrompt(item))continue;const d=this.player.position.distanceTo(item.position);if(d<=item.radius&&d<distance){nearest=item;distance=d;}}
    return nearest;
  }
  private controls():void{
    const i=this.input;
    if(this.cinema){if(i.pressed('Space')||i.pressed('Enter')||i.pressed('Escape')||i.pressed('KeyE'))this.finishCinema();return;}
    if(!this.started||this.state.player.hp<=0)return;
    if(this.abilityWheel){
      if(i.pressed('Escape')||!i.down('KeyB')){
        const selected=this.abilityWheel.selected;
        if(!i.pressed('Escape')&&selected)this.abilities.select(selected);
        this.abilityWheel=undefined;i.clear();i.enabled=true;this.renderUI();
      }
      return;
    }
    if(i.pressed('Escape')){this.setPanel(this.panel==='none'?'pause':'none');return;}
    if(i.pressed('Tab')){this.setPanel(this.panel==='inventory'?'none':'inventory');return;}
    if(i.pressed('KeyM')){this.setPanel(this.panel==='map'?'none':'map');return;}
    if(i.pressed('KeyJ')){this.setPanel(this.panel==='quests'?'none':'quests');return;}
    if(this.panel==='none'&&i.pressed('KeyB')){
      if(!this.state.terminal){this.notify('取得星盘后才能选择能力。','warning');return;}
      this.abilityWheel={selected:null,x:0,y:0};i.enabled=false;this.renderUI();return;
    }
    if(this.panel==='none'&&i.pressed('KeyE')){const target=this.nearest();if(target)this.gameplay.interact(target);}
  }
  private canSimulate():boolean{return this.started&&this.panel==='none'&&!this.cinema&&!this.abilityWheel&&this.state.player.hp>0;}
  private tick(now:number):void{
    if(!this.rendering)return;requestAnimationFrame(t=>this.tick(t));const dt=Math.min(CONFIG.maxDelta,Math.max(0,(now-(this.lastTime||now))/1000));this.lastTime=now;
    if(document.hidden){this.input.endFrame();return;}
    this.ctx.realDt=dt;this.presentationTime+=dt;this.fps+=((dt>0?1/dt:60)-this.fps)*.04;
    this.controls();
    if(this.cinema){this.cinema.remaining-=dt;if(this.cinema.remaining<=0)this.finishCinema();}
    let simulationDt=0;
    if(this.canSimulate()){
      const scaled=dt*this.ctx.timeScale;simulationDt=scaled;this.ctx.timeScale=1;this.ctx.elapsed+=scaled;
      this.player.update(scaled);
      if(this.canSimulate())this.combat.update(scaled);
      if(this.canSimulate())this.abilities.update(scaled);
      if(this.canSimulate())this.gameplay.update(scaled);
      if(this.canSimulate()){
        if(advanceClock(this.state,scaled))this.pendingMoon=true;
        if(this.pendingMoon&&this.state.region==='overworld'&&!this.ctx.inCombat){this.pendingMoon=false;this.bloodMoon();}
        if(this.frame%90===0)this.resolveDeferredSpawns();
        if(this.player.position.y< -36)this.damage(100,'深谷');
      }
    }
    if(this.started){if(!this.abilityWheel)this.player.updateCamera(dt);}
    else {const t=this.presentationTime*.018;this.camera.position.set(Math.sin(t)*12+79,67,112);this.camera.lookAt(-7,5,4);}
    if(this.cinema&&this.state.region==='overworld')this.cinematicCamera();
    this.updateLighting(dt);this.ctx.world.update(!this.started||this.cinema&&this.state.region==='overworld'?dt:simulationDt,this.state);this.effects.update(this.started?simulationDt:dt);this.audio.update(this.started?simulationDt:dt,this.state,this.player.position);
    if(this.state.settings.shake&&this.effects.shakeAmount>0&&!this.cinema&&!this.abilityWheel){this.camera.position.x+=(Math.random()-.5)*this.effects.shakeAmount;this.camera.position.y+=(Math.random()-.5)*this.effects.shakeAmount;}
    const presentation=!!this.cinema||this.panel==='dialogue';
    this.cameraContact.copy(this.player.position).y+=1;
    this.cameraSight.origin.copy(this.camera.position);
    this.cameraSight.direction.copy(this.cameraContact).sub(this.camera.position);
    const subjectDistance=this.cameraSight.direction.length();
    this.cameraSight.direction.normalize();
    for(const enemy of this.combat.enemies){
      const model=enemy.model.root;
      if(!model.visible||enemy.position.distanceToSquared(this.camera.position)>(presentation?144:36))continue;
      this.cameraBounds.setFromObject(model).expandByScalar(.3);
      const blocksSubject=presentation&&this.cameraSight.intersectBox(this.cameraBounds,this.cameraContact)!==null&&this.cameraContact.distanceTo(this.camera.position)<subjectDistance;
      if(this.cameraBounds.containsPoint(this.camera.position)||blocksSubject){model.visible=false;this.cameraOccluders.push(model);}
    }
    this.renderer.render(this.scene,this.camera);
    for(const model of this.cameraOccluders)model.visible=true;
    this.cameraOccluders.length=0;
    this.uiTick+=dt;if(this.uiTick>.08){this.uiTick=0;this.renderUI();}
    this.input.endFrame();this.frame++;
  }
  private cinematicCamera():void{
    const c=this.cinema!;const progress=THREE.MathUtils.smoothstep(1-c.remaining/c.duration,0,1);const p=this.player.position;
    if(/第一束光|苏醒|醒来/.test(c.title)){this.camera.position.set(p.x+1.5-progress,p.y+2+progress,p.z+2+progress*3);this.camera.lookAt(p.x,p.y+1,p.z);}
    else if(/塔|脉冲|大地的回声/.test(c.title)){const angle=progress*.7;this.camera.position.set(Math.sin(angle)*36+14,24+progress*16,Math.cos(angle)*36);this.camera.lookAt(0,12,0);}
    else if(/初光|旷野|台地|第一缕|全景|星坠原野/.test(c.title)){this.camera.position.set(p.x+progress*10,p.y+5+progress*16,p.z-3-progress*10);this.camera.lookAt(0,4,-20);}
  }
  private updateLighting(dt:number):void{
    const interior=this.state.region!=='overworld';const daylight=Math.max(.08,Math.sin((this.state.time-6)/24*Math.PI*2));const red=(this.state.day+1)%CONFIG.bloodMoonDays===0&&this.state.time>23||this.cinema?.title==='绯月归来';
    const color=new THREE.Color(interior?0x121e29:red?0x753a46:0xadcdd1).lerp(new THREE.Color(0x101d35),interior?0:1-daylight);
    (this.scene.background as THREE.Color).lerp(color,Math.min(1,dt*2));if(this.scene.fog instanceof THREE.FogExp2){this.scene.fog.color.copy(this.scene.background as THREE.Color);this.scene.fog.density=interior?.013:this.state.weather==='rain'?.009:.004;}
    this.hemi.intensity=interior?1.9:.7+daylight*1.8;this.sun.intensity=interior?.5:(this.state.weather==='rain'?.8:2)*daylight;this.sun.color.set(red?0xff5365:0xffecd0);
    const p=this.started?this.player.position:new THREE.Vector3();this.sun.position.set(p.x+45,95,p.z+30);this.sun.target.position.set(p.x,0,p.z);this.sun.target.updateMatrixWorld();
  }
  private bloodMoon():void{
    const s=this.state;applyBloodMoon(s,this.ctx.world.spawns,s.player.position);this.abilities.reset();this.combat.reset();
    this.showCinema('绯月归来','红色的光爬过石缝。远处熄灭的营火，再一次亮起。你的星核与记忆安然无恙。',4,()=>this.save(false));
  }
  private resolveDeferredSpawns():void{let changed=false;for(const spawn of this.ctx.world.spawns){const key='blood-pending:'+spawn.id;if(this.state.flags[key]&&Math.hypot(spawn.position[0]-this.player.position.x,spawn.position[2]-this.player.position.z)>30){delete this.state.flags[key];delete this.state.enemies[spawn.id];changed=true;}}if(changed)this.combat.reset();}
  private renderUI():void{
    this.notices=this.notices.filter(n=>n.end>this.presentationTime);
    const target=this.started&&this.panel==='none'&&!this.cinema?this.nearest():undefined;
    this.ui.render({state:this.state,panel:this.panel,hasSave:this.hasSave,prompt:target?this.gameplay.getPrompt(target)??undefined:undefined,dialogue:this.dialogue,cinematic:this.cinema?{title:this.cinema.title,text:this.cinema.text,progress:1-this.cinema.remaining/this.cinema.duration}:null,notices:this.notices,held:this.gameplay?.held??[],cooldown:this.abilities?.cooldown??0,inCombat:this.ctx.inCombat,aiming:this.combat?.aiming??false,bowDraw:Number(this.player.model.userData.bowDraw??0),abilityWheel:this.abilityWheel,fps:Math.round(this.fps),error:this.store.error});
  }
  debug(action:string,value?:string):void{
    if(!import.meta.env.DEV)return;
    const s=this.state;
    if(action==='teleport'){const location=LOCATIONS[value??'outlook'];if(location){if(s.region!=='overworld')this.changeRegion('overworld');const p=[...location.position] as Vec3;p[1]=this.ctx.world.heightAt(p[0],p[2])+0.1;this.player.teleport(p);this.setPanel('none');}}
    if(action==='heal'){s.player.hp=s.player.maxHp;s.player.stamina=s.player.maxStamina;s.player.coldResist=600;}
    if(action==='items'||action==='addItems'){for(const id of ['axe','sword','spear','club','bow','shield','warmcoat','apple','pepper','mushroom','herb','monster','insect'])addItem(s,id,ITEMS[id]?.category==='material'?5:1);addItem(s,'arrows',40);}
    if(action==='clearItems'){s.inventory=[];for(const k of Object.keys(s.equipment) as (keyof GameState['equipment'])[])s.equipment[k]=null;}
    if(action==='repair'){for(const item of s.inventory)if(ITEMS[item.id]?.durability)item.durability=ITEMS[item.id].durability;}
    if(action==='unlock'){s.abilities=['magnet','bomb','stasis','ice'];s.glider=true;}
    if(action==='lock'){s.abilities=[];s.glider=false;this.abilities.reset();}
    if(action==='weather'&&['clear','rain','cloudy'].includes(value??''))s.weather=value as GameState['weather'];
    if(action==='time')s.time=Math.max(0,Math.min(23.9,Number(value)||7));
    if(action==='bloodmoon'){s.day+=3-s.day%3;s.time=0;this.bloodMoon();}
    if(action==='save')this.save(true);if(action==='load')this.start(true);if(action==='clear'){this.store.clear();this.hasSave=false;this.setPanel('title');}
    this.input.clear();
  }
  dispose():void{this.rendering=false;this.abort.abort();this.ui.dispose();this.player.dispose();this.combat.dispose();this.abilities.dispose();this.ctx.world.dispose();this.effects.dispose();this.audio.dispose();this.input.dispose();this.renderer.dispose();this.renderer.domElement.remove();this.uiRoot.remove();if(import.meta.env.DEV&&Reflect.get(window,'__asterfall')===this)Reflect.deleteProperty(window,'__asterfall');}
}
