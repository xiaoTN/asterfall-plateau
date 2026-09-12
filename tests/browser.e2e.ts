import { test, expect, type Page } from '@playwright/test';

type TestWindow = Window & { __asterfall: any };
const game = (page:Page) => page.evaluate(()=>{const g=(window as unknown as TestWindow).__asterfall;return {state:g.state,panel:g.panel,position:g.player.position.toArray()};});
// Playwright creates an isolated browser context for every test.
async function fresh(page:Page){await page.goto('/');await page.waitForFunction(()=>Boolean((window as unknown as TestWindow).__asterfall));await page.getByRole('button',{name:/开始游戏|开始旅程|踏上旅程|新的旅程|开始探索/}).first().click();await page.keyboard.press('Enter');await expect.poll(async()=>(await game(page)).panel).toBe('none');await page.waitForFunction(()=>!(window as unknown as TestWindow).__asterfall.cinema);}

test('title, playable chamber, menus, resize and error-free rendering',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await fresh(page);await expect(page.locator('#game-canvas')).toBeVisible();
  const start=(await game(page)).position;await page.keyboard.down('KeyA');
  try { await expect.poll(async()=>Math.abs((await game(page)).position[0]-start[0])).toBeGreaterThan(.1); }
  finally { await page.keyboard.up('KeyA'); }
  await page.keyboard.press('Tab');await expect.poll(async()=>(await game(page)).panel).toBe('inventory');
  const stopped=(await game(page)).position;await page.keyboard.down('KeyW');await page.waitForTimeout(250);await page.keyboard.up('KeyW');expect((await game(page)).position).toEqual(stopped);
  await page.keyboard.press('Escape');await expect.poll(async()=>(await game(page)).panel).toBe('none');await page.keyboard.press('KeyM');await expect.poll(async()=>(await game(page)).panel).toBe('map');await page.keyboard.press('Escape');await expect.poll(async()=>(await game(page)).panel).toBe('none');
  await page.setViewportSize({width:1280,height:720});await page.screenshot({path:'.artifacts/chamber-1280.png'});await page.setViewportSize({width:1024,height:768});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.keyboard.press('Escape');await expect.poll(async()=>(await game(page)).panel).toBe('pause');
  expect(errors).toEqual([]);
});

test('corrupt browser storage recovers to a usable title',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await page.evaluate(()=>localStorage.setItem('asterfall.save.v1','{not-json'));await page.reload();await page.waitForFunction(()=>Boolean((window as unknown as TestWindow).__asterfall));await expect(page.locator('#game-canvas')).toBeVisible();await expect(page.getByRole('button',{name:/开始游戏|开始旅程|踏上旅程|新的旅程|开始探索/}).first()).toBeVisible();expect(errors).toEqual([]);
});

test('death cannot be dismissed into a zero-health softlock',async({page})=>{
  await fresh(page);await page.waitForFunction(()=>!(window as unknown as TestWindow).__asterfall.cinema);
  await page.evaluate(()=>{const g=(window as unknown as TestWindow).__asterfall;g.ctx.save();g.ctx.damage(100,'测试坠落');});
  await expect.poll(async()=>(await game(page)).panel).toBe('death');
  for(const key of ['Escape','Tab','KeyM','KeyJ']){await page.keyboard.press(key);await expect.poll(async()=>(await game(page)).panel).toBe('death');}
  await page.getByRole('button',{name:/最近.*存档|继续旅程|从.*继续|读取.*存档/}).first().click();
  await expect.poll(async()=>(await game(page)).state.player.hp).toBeGreaterThan(0);
});

test('restricted localStorage does not prevent WebGL startup',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get:()=>{throw new DOMException('Storage disabled','SecurityError');},configurable:true}));await page.goto('/');await page.waitForFunction(()=>Boolean((window as unknown as TestWindow).__asterfall));expect((await game(page)).panel).toBe('title');expect(errors).toEqual([]);
});
