import { test, expect } from '@playwright/test';

test('production bundle renders, accepts controls, opens menus and excludes debug access', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.type() === 'error')errors.push(message.text()); });
  const failed: string[] = []; page.on('requestfailed', request => failed.push(request.url()));
  await page.goto('/'); await expect(page.getByRole('button', { name: /开始旅程/ })).toBeVisible();
  expect(await page.evaluate(() => '__asterfall' in window)).toBe(false);
  await page.screenshot({ path: '.artifacts/production-title.png' });
  await page.getByRole('button', { name: /开始旅程/ }).click();
  await page.getByRole('button', { name: /跳过演出/ }).click();
  await expect(page.getByText('沉睡的星盘', { exact: true })).toBeVisible();
  await page.keyboard.down('KeyA'); await page.waitForTimeout(500); await page.keyboard.up('KeyA');
  await page.keyboard.press('Tab'); await expect(page.getByRole('heading', { name: /行囊/ })).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.getByRole('heading', { name: /行囊/ })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /继续旅程/ })).toBeVisible();
  expect(errors).toEqual([]); expect(failed).toEqual([]);
});
