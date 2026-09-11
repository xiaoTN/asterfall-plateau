import * as THREE from 'three';
import { CONFIG } from '../config/game';
import type { EffectPort } from './types';
export class Effects implements EffectPort {
  private geometry=new THREE.BufferGeometry();private positions=new Float32Array(CONFIG.particlePoolSize*3);private colors=new Float32Array(CONFIG.particlePoolSize*3);
  private velocities=new Float32Array(CONFIG.particlePoolSize*3);private life=new Float32Array(CONFIG.particlePoolSize);private cursor=0;
  private material=new THREE.PointsMaterial({size:0.16,vertexColors:true,transparent:true,opacity:0.88,depthWrite:false});private points:THREE.Points;
  shakeAmount=0;
  constructor(private scene:THREE.Scene){this.positions.fill(-10000);this.geometry.setAttribute('position',new THREE.BufferAttribute(this.positions,3));this.geometry.setAttribute('color',new THREE.BufferAttribute(this.colors,3));this.points=new THREE.Points(this.geometry,this.material);this.points.frustumCulled=false;scene.add(this.points);}
  burst(position:THREE.Vector3,color:number,count=18):void{const c=new THREE.Color(color);for(let i=0;i<count;i++){const n=this.cursor++%CONFIG.particlePoolSize;this.positions.set([position.x,position.y+0.6,position.z],n*3);this.velocities.set([(Math.random()-.5)*5,Math.random()*4+1,(Math.random()-.5)*5],n*3);this.colors.set([c.r,c.g,c.b],n*3);this.life[n]=0.4+Math.random()*.65;}this.geometry.attributes.color.needsUpdate=true;}
  ring(position:THREE.Vector3,color:number,radius=2):void{const c=new THREE.Color(color);for(let i=0;i<32;i++){const n=this.cursor++%CONFIG.particlePoolSize,a=i/32*Math.PI*2;this.positions.set([position.x+Math.sin(a)*radius,position.y+.2,position.z+Math.cos(a)*radius],n*3);this.velocities.set([Math.sin(a)*2,1.5,Math.cos(a)*2],n*3);this.colors.set([c.r,c.g,c.b],n*3);this.life[n]=.65;}this.geometry.attributes.color.needsUpdate=true;}
  shake(amount:number):void{this.shakeAmount=Math.max(this.shakeAmount,amount);}
  update(dt:number):void{for(let i=0;i<this.life.length;i++)if(this.life[i]>0){this.life[i]-=dt;if(this.life[i]<=0){this.positions[i*3+1]=-10000;continue;}this.velocities[i*3+1]-=dt*7;for(let a=0;a<3;a++)this.positions[i*3+a]+=this.velocities[i*3+a]*dt;}this.geometry.attributes.position.needsUpdate=true;this.shakeAmount=Math.max(0,this.shakeAmount-dt*2);}
  dispose():void{this.scene.remove(this.points);this.geometry.dispose();this.material.dispose();}
}
