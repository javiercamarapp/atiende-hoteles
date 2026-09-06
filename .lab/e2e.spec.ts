import { test, expect } from '@playwright/test';

test('system Chrome channel drives a real page without downloading browsers', async ({ page }) => {
  await page.setContent('<title>hola</title><h1 id="t">Atiende Hoteles</h1>');
  await expect(page).toHaveTitle('hola');
  await expect(page.locator('#t')).toHaveText('Atiende Hoteles');
});
