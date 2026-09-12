import { test, expect } from '@playwright/test';

test('new save to four physical trials, growth, glider and prologue completion', async ({ page }) => {
  test.setTimeout(300000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await page.getByRole('button', { name: /开始旅程/ }).click();
  await page.evaluate(async () => {
    const path = '/tests/support/driver.ts';
    const { installDriver } = await import(/* @vite-ignore */ path);
    (window as any).__journey = installDriver();
  });
  await test.step('wake, terminal, door, elder, tower and safe stairs', async () => {
    await page.evaluate(() => {
      const d = (window as any).__journey;
      d.skip(); d.walk(-4.5, 107); d.interact('chamber-shirt');
      d.g.gameplay.inventoryAction('equip', 'shirt');
      d.walk(4.5, 107); d.interact('chamber-trousers'); d.g.gameplay.inventoryAction('equip', 'trousers');
      d.walk(2.4, 103); d.interact('terminal'); d.skip();
      d.walk(0, 98); d.interact('chamber-door'); d.walk(0, 93); d.walk(0, 87, true); d.walk(0, 82); d.skip();
      d.walk(11.4, 64.8); d.interact('elder'); d.choose('我该去哪里'); d.choose('我去唤醒');
      d.walk(13, 66); d.interact('elder-axe'); d.walk(7.7, 64.4); d.interact('elder-roast-apple');
      d.walk(9, 14); d.walk(0, 13); d.interact('tower'); d.skip(); d.choose('一言为定');
      d.walk(0, 8.4); d.walk(-7.6, 8.4); d.walk(-7.6, -9.1); d.walk(7.6, -9.1); d.walk(7.6, 10.7);
      d.check(d.g.player.position.y < 9, 'Tower descent failed'); d.screenshot();
    });
    await page.screenshot({ path: '.artifacts/journey-tower.png' });
  });
  await test.step('magnet panel, two-cube bridge, pulled door and guardian collision', async () => {
    await page.evaluate(() => {
      const d = (window as any).__journey;
      d.walk(-18, 12); d.walk(-54, 24); d.walk(-65, 31); d.interact('shrine-magnet'); d.skip();
      d.walk(0, 6.2); d.interact('magnet:ability'); d.skip(); d.walk(3, 3); d.walk(3, -2); d.walk(0, -2);
      d.look([0, 1, -7]); d.press('KeyF'); d.look([0, 6, -9]); d.step(150); d.stage('magnet', 1); d.press('KeyQ');
      d.walk(0, -17);
      for (const [x, z] of [[4, -27.5], [-4, -24.5]]) {
        d.walk(x, -17); d.look([x, 1.5, -20.5]); d.press('KeyF');
        d.check(d.g.player.model.userData.holdingMetal, 'Cube selection failed');
        d.walk(0, -19); d.carry([0, -1.5, z]); d.press('KeyF'); d.step(90);
      }
      d.walk(0, -30); d.stage('magnet', 2);
      d.walk(0, -37); d.look([0, 2, -42]); d.press('KeyF'); d.walk(0, -33); d.step(160);
      d.walk(-5, -35); d.look([-5, 1, -38]); d.press('KeyF');
      d.walk(0, -35); d.carry([0, 1, -40]); d.walk(0, -40); d.carry([4, 1, -44.5]);
      d.stage('magnet', 3); d.press('KeyQ'); d.screenshot();
      d.walk(-2.2, -40); d.walk(-2.2, -44); d.walk(-5, -44); d.walk(-5, -54); d.finishTrial('magnet');
      d.g.gameplay.inventoryAction('eat', 'roastApple');
    });
    await page.screenshot({ path: '.artifacts/journey-magnet.png' });
  });
  await test.step('bomb cracked wall, rolling pipe and timed catapult', async () => {
    await page.evaluate(() => {
      const d = (window as any).__journey;
      d.walk(-50, 28); d.walk(-15, 16); d.walk(18, 16); d.walk(55, 30); d.walk(64, 37); d.interact('shrine-bomb'); d.skip();
      d.walk(0, 6.2); d.interact('bomb:ability'); d.skip(); d.walk(3, 3); d.walk(3, -4); d.walk(0, -4); d.look([0, 0, -9]);
      d.press('KeyV'); d.press('KeyF'); d.walk(0, 2); d.press('KeyF'); d.stage('bomb', 1); d.step(190);
      d.walk(0, -14); d.walk(-6, -18); d.walk(-4, -19.8); d.look([-4, 0.6, -28]); d.press('KeyV'); d.press('KeyF'); d.step(150); d.walk(-4, -18); d.press('KeyF'); d.stage('bomb', 2); d.step(190);
      d.walk(0, -18); d.walk(0, -33); d.walk(0, -36.9); d.look([0, 0, -42]); d.press('KeyF');
      // Step backward while the launcher charges, then detonate on the descending arc.
      d.keys(['KeyS']); d.step(55); d.keys([]); d.step(4); d.press('KeyF'); d.step(150); d.stage('bomb', 3);
      d.walk(0, -48); d.walk(-5, -50); d.walk(-5, -55); d.finishTrial('bomb'); d.screenshot();
    });
    await page.screenshot({ path: '.artifacts/journey-bomb.png' });
  });
  await test.step('stasis moving hazards and accumulated physical hits', async () => {
    await page.evaluate(() => {
      const d = (window as any).__journey;
      d.walk(75, 26); d.walk(79, -52); d.walk(65, -55); d.interact('shrine-stasis'); d.skip();
      d.walk(0, 6.2); d.interact('stasis:ability'); d.skip(); d.walk(3, 3); d.walk(3, -5); d.walk(0, -5);
      d.look([0, 0.3, -9]); d.press('KeyF'); d.walk(0, -12, true); d.stage('stasis', 1); d.step(900);
      d.walk(0, -20); d.walk(7.8, -20); const roller = d.g.ctx.world.targets.find((t: any) => t.id.includes('rolling')); d.look(roller.position.toArray()); d.press('KeyF');
      d.check(roller.frozen > 0, 'Rolling stone did not freeze');
      d.walk(7.8, -28); d.stage('stasis', 2); d.step(900);
      d.walk(0, -39.3); d.look([0, 1.15, -42]); d.press('KeyF'); d.attack(2); d.press('KeyF'); d.step(150); d.stage('stasis', 3);
      d.walk(0, -48); d.walk(-5, -50); d.walk(-5, -55); d.finishTrial('stasis'); d.screenshot();
    });
    await page.screenshot({ path: '.artifacts/journey-stasis.png' });
  });
  await test.step('cook cold resistance, ice bridge, lifted gate and raised landing', async () => {
    await page.evaluate(() => {
      const d = (window as any).__journey;
      d.walk(77, -53); d.walk(95, -25); d.walk(95, 15); d.walk(18, 16); d.walk(0, -25); d.walk(-14, -13); d.walk(-26, -30); d.walk(-40, -41);
      d.interact('cabin-pepper-2'); d.walk(-42, -43.5); d.interact('cabin-warmcoat'); d.g.gameplay.inventoryAction('equip', 'warmcoat');
      d.g.gameplay.inventoryAction('hold', 'pepper');
      d.walk(-39.5, -44.3); d.interact('cabin-fire-pot'); d.skip();
      d.check(d.g.state.inventory.some((i: any) => i.id === 'meal' && i.cold > 0), 'Cooking did not produce cold protection');
      d.g.gameplay.inventoryAction('eat', 'meal');
      if (d.g.panel === 'dialogue') d.choose('收进背包');
      d.walk(-40, -41); d.walk(-48, -40); d.walk(-55, -53); d.walk(-66, -61); d.interact('shrine-ice'); d.skip();
      d.walk(0, 6.2); d.interact('ice:ability'); d.skip(); d.walk(3, 3); d.walk(3, -2); d.walk(0, -2);
      d.look([0, 0.08, -7.4]); d.press('KeyF'); d.walk(0, -7.4, true);
      d.look([0, 0.08, -12.3]); d.press('KeyF'); d.walk(0, -12.3, true); d.walk(0, -16, true); d.stage('ice', 1);
      d.walk(0, -20); d.look([0, 0.08, -25]); d.press('KeyF'); d.walk(0, -29, true); d.stage('ice', 2);
      d.walk(0, -36); d.look([0, 0.08, -42.8]); d.press('KeyF'); d.walk(0, -42.8, true); d.walk(0, -46.5, true); d.stage('ice', 3);
      d.walk(-5, -48); d.walk(-5, -55); d.finishTrial('ice'); d.screenshot();
    });
    await page.screenshot({ path: '.artifacts/journey-ice.png' });
  });
  await test.step('four cores, irreversible growth, rooftop reveal, gliding and reload', async () => {
    await page.evaluate(() => {
      const d = (window as any).__journey;
      d.check(d.g.state.cores === 4, 'Four cores missing');
      d.walk(-55, -60); d.walk(-28, -60); d.walk(-5, -63); d.walk(0, -65); d.interact('temple-altar'); d.choose('生命上限');
      d.check(d.g.state.player.maxHp === 16 && d.g.state.cores === 0, 'Growth transaction failed');
      d.skip();
      d.walk(5.3, -67); d.walk(5.3, -77); d.walk(0, -77); d.walk(0, -75); d.interact('glider'); d.choose('一百年前'); d.skip();
      d.check(d.g.state.glider, 'Glider missing');
      d.walk(0, -77); d.walk(5.3, -77); d.walk(5.3, -67); d.walk(16, -67); d.walk(27, -112); d.walk(29, -135);
      d.look([29, 0, -160]); d.keys(['KeyW', 'Space']);
      for(let n=0;n<1200&&!d.g.cinema;n++)d.step();
      d.check(d.g.cinema?.title.includes('序章完成'), 'Gliding did not finish prologue'); d.keys([]); d.skip();
      d.check(d.g.state.flags.prologueComplete, 'Completion not committed'); d.screenshot();
    });
    await page.screenshot({ path: '.artifacts/prologue-complete.png' });
    await page.reload(); await page.getByRole('button', { name: /继续旅程/ }).click();
    const final = await page.evaluate(() => (window as any).__asterfall.state);
    expect(final.flags.prologueComplete).toBe(true); expect(final.completed).toHaveLength(4); expect(final.glider).toBe(true); expect(final.player.maxHp).toBe(16);
  });
  expect(errors).toEqual([]);
});
