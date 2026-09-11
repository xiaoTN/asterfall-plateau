import type { InputLike } from './types';
export class Input implements InputLike {
  private keys=new Set<string>(); private presses=new Set<string>(); private releases=new Set<string>();
  mouseDX=0; mouseDY=0; wheel=0; enabled=false;
  private abort=new AbortController();
  constructor(private canvas:HTMLCanvasElement) {
    const opt={signal:this.abort.signal};
    window.addEventListener('keydown',e=>{if(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement)return;if(['Space','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();if(!this.keys.has(e.code))this.presses.add(e.code);this.keys.add(e.code);},opt);
    window.addEventListener('keyup',e=>{this.keys.delete(e.code);this.releases.add(e.code);},opt);
    canvas.addEventListener('mousedown',e=>{if(!this.enabled)return;const code=`Mouse${e.button}`;if(!this.keys.has(code))this.presses.add(code);this.keys.add(code);if(document.pointerLockElement!==canvas)this.lock();},opt);
    window.addEventListener('mouseup',e=>{const code=`Mouse${e.button}`;this.keys.delete(code);this.releases.add(code);},opt);
    window.addEventListener('mousemove',e=>{if(this.enabled&&(document.pointerLockElement===canvas||this.keys.has('Mouse2'))){this.mouseDX+=e.movementX;this.mouseDY+=e.movementY;}},opt);
    canvas.addEventListener('wheel',e=>{if(this.enabled){this.wheel+=Math.sign(e.deltaY);e.preventDefault();}},{passive:false,...opt});
    canvas.addEventListener('contextmenu',e=>e.preventDefault(),opt);
    window.addEventListener('blur',()=>this.clear(),opt);
  }
  lock():void {try{const result=this.canvas.requestPointerLock();if(result&&typeof result.catch==='function')void result.catch(()=>{});}catch{}}
  unlock():void {if(document.pointerLockElement===this.canvas)document.exitPointerLock();this.clear();}
  down(code:string):boolean{return this.keys.has(code);}
  pressed(code:string):boolean{return this.presses.has(code);}
  released(code:string):boolean{return this.releases.has(code);}
  endFrame():void{this.presses.clear();this.releases.clear();this.mouseDX=0;this.mouseDY=0;this.wheel=0;}
  clear():void{this.keys.clear();this.endFrame();}
  dispose():void{this.abort.abort();this.unlock();}
}
