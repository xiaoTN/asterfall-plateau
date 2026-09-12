import { test, expect, type Page } from '@playwright/test';
type TestWindow=Window&{__asterfall:any};
async function status(page:Page){return page.evaluate(()=>{const g=(window as unknown as TestWindow).__asterfall;return {position:g.player.position.toArray() as number[],yaw:g.player.orbitYaw as number,state:g.state,panel:g.panel,cinema:Boolean(g.cinema)};});}
async function skip(page:Page){await page.waitForFunction(()=>Boolean((window as unknown as TestWindow).__asterfall.cinema));await page.keyboard.press('Enter');await page.waitForFunction(()=>!(window as unknown as TestWindow).__asterfall.cinema);}
async function walk(page:Page,x:number,z:number,climb=false){
  const held=new Set<string>();if(climb){await page.keyboard.down('Space');held.add('Space');}
  try{for(let n=0;n<400;n++){const s=await status(page);if(s.cinema)return;if(s.panel!=='none')throw new Error(`Walking interrupted: ${s.panel} ${s.state.quest}`);const dx=x-s.position[0]!,dz=z-s.position[2]!;if(Math.hypot(dx,dz)<.7)return;
    const right=dx*Math.cos(s.yaw)-dz*Math.sin(s.yaw),forward=-dx*Math.sin(s.yaw)-dz*Math.cos(s.yaw);const next=new Set<string>();if(Math.abs(right)>.3)next.add(right>0?'KeyD':'KeyA');if(Math.abs(forward)>.3)next.add(forward>0?'KeyW':'KeyS');if(climb)next.add('Space');
    for(const key of held)if(!next.has(key)){await page.keyboard.up(key);held.delete(key);}for(const key of next)if(!held.has(key)){await page.keyboard.down(key);held.add(key);}await page.waitForTimeout(100);
  }throw new Error(`Could not walk to ${x},${z}: ${JSON.stringify(await status(page))}`);}finally{for(const key of held)await page.keyboard.up(key);}
}

test('keyboard-only awakening, sealed door, panorama, elder, tower and reload',async({page})=>{
  test.setTimeout(240000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.waitForFunction(()=>Boolean((window as unknown as TestWindow).__asterfall));await page.getByRole('button',{name:/开始旅程/}).click();await skip(page);
  await walk(page,2.8,105);await walk(page,2.8,98);await walk(page,0,98);await page.keyboard.press('KeyE');expect((await status(page)).state.terminal).toBe(false);expect((await status(page)).state.flags.chamberDoor).not.toBe(true);
  await walk(page,2.4,103);await page.keyboard.press('KeyE');await skip(page);await expect.poll(async()=>(await status(page)).state.terminal).toBe(true);
  await walk(page,0,98);await page.keyboard.press('KeyE');await expect.poll(async()=>(await status(page)).state.flags.chamberDoor).toBe(true);
  await walk(page,0,93);await walk(page,0,87,true);await walk(page,0,82);await skip(page);await expect.poll(async()=>(await status(page)).state.quest).toBe('MEET_ELDER');
  await walk(page,11.4,64.8);
  for(let n=0;n<4&&(await status(page)).panel==='none';n++){await page.keyboard.press('KeyE');await page.waitForTimeout(200);}
  await expect.poll(async()=>(await status(page)).panel).toBe('dialogue');await page.getByRole('button',{name:'我该去哪里？'}).click();await page.getByRole('button',{name:'我去唤醒它'}).click();
  await walk(page,9,14);await walk(page,0,13);await page.keyboard.press('KeyE');await skip(page);await expect.poll(async()=>(await status(page)).state.tower).toBe(true);await page.getByRole('button',{name:'一言为定'}).click();
  expect((await status(page)).position[1]).toBeGreaterThan(19);await page.keyboard.press('KeyM');await page.screenshot({path:'.artifacts/tower-map.png'});await page.keyboard.press('Escape');
  await page.reload();await page.waitForFunction(()=>Boolean((window as unknown as TestWindow).__asterfall));await page.getByRole('button',{name:/继续旅程/}).click();await expect.poll(async()=>(await status(page)).state.tower).toBe(true);expect((await status(page)).state.terminal).toBe(true);expect(errors).toEqual([]);
});
