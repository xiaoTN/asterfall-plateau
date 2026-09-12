import { test, expect } from '@playwright/test';

async function start(page: import('@playwright/test').Page) {
  await page.goto('/'); await page.getByRole('button', { name: /开始旅程/ }).click(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !(window as any).__asterfall.cinema);
}

test('submerged save and submerged safe point recover to a dry playable shore', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const g = (window as any).__asterfall;
    g.state.terminal = true; g.state.flags.chamberDoor = true;
    g.player.teleport([-35, 8.3, 46]); g.state.safePosition = [-35, 8.3, 46]; g.ctx.save();
    g.start(true);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__asterfall.player.position.z)).toBe(82);
  expect(await page.evaluate(() => (window as any).__asterfall.state.player.hp)).toBeGreaterThan(0);
});

test('full equipment slots keep chest loot available for a later retry', async ({ page }) => {
  await start(page);
  const first = await page.evaluate(() => {
    const g = (window as any).__asterfall;
    for (let n = 0; n < 8; n++) g.ctx.addItem('sword');
    const chest = g.ctx.world.interactables.find((t: any) => t.id === 'north-ridge-cache');
    g.player.teleport([chest.position.x + 1.7, g.ctx.world.heightAt(chest.position.x, chest.position.z), chest.position.z]);
    g.gameplay.interact(chest);
    return { opened: g.state.flags['opened:north-ridge-cache'], count: g.state.inventory.length };
  });
  expect(first.opened).not.toBe(true); expect(first.count).toBe(8);
  const second = await page.evaluate(() => {
    const g = (window as any).__asterfall;
    g.gameplay.inventoryAction('drop', g.state.inventory[0].uid);
    g.gameplay.interact(g.ctx.world.interactables.find((t: any) => t.id === 'north-ridge-cache'));
    return { opened: g.state.flags['opened:north-ridge-cache'], count: g.state.inventory.length };
  });
  expect(second.opened).toBe(true); expect(second.count).toBe(8);
});

test('pause freezes arrows, resumed large delta is bounded, load clears flight', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const g = (window as any).__asterfall; g.ctx.addItem('bow'); g.ctx.addItem('arrows', 8);
    g.gameplay.inventoryAction('equip', 'bow'); g.player.teleport([0, 60, 82]); g.ctx.save();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    for (let n = 0; n < 45; n++) { g.ctx.realDt = 1 / 60; g.player.updateCamera(1 / 60); g.combat.update(1 / 60); g.input.endFrame(); }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
    g.combat.update(1 / 60); g.input.endFrame();
    g.setPanel('pause');
  });
  const read = () => page.evaluate(() => {
    const g = (window as any).__asterfall;
    return { panel: g.panel, arrows: g.combat.projectiles.projectiles.filter((p: any) => p.active).map((p: any) => p.position.toArray()), player: g.player.position.toArray() };
  });
  await expect.poll(async () => (await read()).panel).toBe('pause');
  const before = await read(); expect(before.arrows.length).toBeGreaterThan(0);
  await page.waitForTimeout(350); expect(await read()).toEqual(before);
  await page.evaluate(() => { const g = (window as any).__asterfall; g.lastTime -= 300000; });
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  const after = await read(); expect(Math.abs(after.player[1] - before.player[1])).toBeLessThan(1);
  await page.evaluate(() => (window as any).__asterfall.start(true));
  expect((await read()).arrows).toHaveLength(0);
});

test('blood moon waits through pause and trials, clears bombs and preserves permanent rewards', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const g = (window as any).__asterfall;
    g.state.completed = ['magnet']; g.state.trialStages.magnet = 3; g.state.cores = 1; g.ctx.addItem('core');
    g.state.flags['opened:chamber-shirt'] = true; g.state.flags.bloodMoonPending = true;
    g.state.abilities = ['bomb']; g.state.selectedAbility = 'bomb'; g.changeRegion('bomb');
  });
  await page.keyboard.press('KeyF'); await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).__asterfall.abilities.activeBomb)).toBe(true);
  expect(await page.evaluate(() => (window as any).__asterfall.state.bloodMoonCount)).toBe(0);
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).__asterfall.state.bloodMoonCount)).toBe(0);
  await page.evaluate(() => { const g = (window as any).__asterfall; g.changeRegion('overworld', [0, 20.1, 82]); });
  await page.waitForFunction(() => (window as any).__asterfall.state.bloodMoonCount === 1);
  await page.keyboard.press('Enter');
  const result = await page.evaluate(() => { const g = (window as any).__asterfall; g.ctx.save(); return { cores: g.state.cores, completed: g.state.completed, chest: g.state.flags['opened:chamber-shirt'], bomb: g.abilities.activeBomb }; });
  expect(result).toEqual({ cores: 1, completed: ['magnet'], chest: true, bomb: false });
  await page.reload(); await page.getByRole('button', { name: /继续旅程/ }).click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).__asterfall.state.bloodMoonCount)).toBe(1);
});
