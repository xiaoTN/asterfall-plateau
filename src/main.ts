import { Engine } from './app/Engine';
import './ui/styles.css';
const root=document.querySelector<HTMLElement>('#app')!;
let engine:Engine|undefined;
try {engine=new Engine(root);}catch(error){
  console.error(error);
  root.replaceChildren();
  const panel=document.createElement('main');panel.className='startup-error';
  const title=document.createElement('h1');title.textContent='星光暂时无法抵达';
  const errorMessage=error instanceof Error?error.message:String(error);
  const detail=document.createElement('p');detail.textContent=/webgl|rendering context/i.test(errorMessage)?'无法启动 WebGL。请使用支持硬件加速的 Chrome、Edge 或 Firefox，然后重新加载。':'游戏初始化失败。请重新加载；若问题持续，请保留下方错误信息。';
  const message=document.createElement('pre');message.textContent=errorMessage;
  const retry=document.createElement('button');retry.textContent='重新加载';retry.onclick=()=>location.reload();
  panel.append(title,detail,message,retry);root.append(panel);
}
document.getElementById('boot')?.remove();
if(import.meta.hot)import.meta.hot.dispose(()=>engine?.dispose());
