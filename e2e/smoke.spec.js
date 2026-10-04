import { test, expect } from '@playwright/test';

// External CDN failures (e.g. jsdelivr blocked in CI) are environmental,
// not app bugs. We still fail on any JS error from the app's own code.
function isEnvironmental(text) {
  return /ERR_|Failed to load resource|cdn\.jsdelivr|unpkg\.com/i.test(text);
}

test('app boots with zero app-code console errors', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isEnvironmental(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (!isEnvironmental(String(err))) errors.push(String(err));
  });

  await page.goto('/');
  await expect(page).toHaveTitle(/RouteRunner/);
  await expect(page.locator('#topbar')).toBeVisible();
  await expect(page.locator('#searchInput')).toBeVisible();
  await expect(page.locator('#ocrBtn')).toBeVisible();
  await expect(page.locator('#manualBtn')).toBeVisible();
  await expect(page.locator('#originLabel')).toBeVisible();

  // let boot async work settle (SW registration, version check)
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
});

test('geolocation denial → graceful fallback, app still usable', async ({ page }) => {
  await page.addInitScript(() => {
    const denied = { code: 1, PERMISSION_DENIED: 1, message: 'User denied Geolocation' };
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition = (ok, err) => { if (err) err(denied); };
      navigator.geolocation.watchPosition = (ok, err) => { if (err) err(denied); return 0; };
    }
  });
  const errors = [];
  page.on('pageerror', (err) => {
    if (!isEnvironmental(String(err))) errors.push(String(err));
  });

  await page.goto('/');
  await expect(page.locator('#topbar')).toBeVisible();
  // origin falls back to label text instead of crashing
  await expect(page.locator('#originLabel')).toContainText('Current location');
  // manual stop entry still works without GPS
  await page.locator('#manualBtn').click();
  await expect(page.locator('#manualForm')).toBeVisible();
  expect(errors).toEqual([]);
});
