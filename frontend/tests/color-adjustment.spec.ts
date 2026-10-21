import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByLabel('像素编辑画布')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '调整颜色', exact: true }).click();
});

test('HSB preserves edits through black, gray and the hue endpoint', async ({ page }) => {
  const hue = page.getByLabel('色相', { exact: true });
  const saturation = page.getByLabel('饱和度', { exact: true });
  const brightness = page.getByLabel('明度', { exact: true });
  await brightness.fill('0');
  await expect(page.locator('.color-hex')).toHaveText('#000000');
  await hue.fill('240');
  await saturation.fill('100');
  await expect(hue).toHaveValue('240');
  await expect(saturation).toHaveValue('100');
  await brightness.fill('50');
  await expect(page.locator('.color-hex')).toHaveText('#000080');

  await saturation.fill('0');
  await expect(page.locator('.color-hex')).toHaveText('#808080');
  await hue.fill('120');
  await expect(hue).toHaveValue('120');
  await saturation.fill('100');
  await expect(page.locator('.color-hex')).toHaveText('#008000');
  await brightness.fill('100');
  await hue.fill('360');
  await expect(hue).toHaveValue('360');
  await expect(page.locator('.color-hex')).toHaveText('#FF0000');
  await hue.press('ArrowLeft');
  await expect(hue).toHaveValue('359');
});

test('HSB sliders respond to real dragging and keyboard steps', async ({ page }) => {
  const canvas = page.getByLabel('像素编辑画布');
  const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  for (const label of ['色相', '饱和度', '明度']) {
    const slider = page.getByLabel(label, { exact: true });
    const bounds = (await slider.boundingBox())!;
    const maximum = Number(await slider.getAttribute('max'));
    await page.mouse.move(bounds.x + 9, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height / 2, { steps: 15 });
    await page.mouse.up();
    const value = Number(await slider.inputValue());
    expect(value).toBeGreaterThan(maximum * 0.65);
    expect(value).toBeLessThan(maximum * 0.85);
    await slider.press('ArrowLeft');
    await expect(slider).toHaveValue(String(value - 1));
  }
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(before);
});

test('RGB supports empty drafts, typing, clamping and painting the final color', async ({ page }) => {
  const canvas = page.getByLabel('像素编辑画布');
  const channels = ['红色通道', '绿色通道', '蓝色通道'];
  for (const [index, label] of channels.entries()) {
    const input = page.getByLabel(label, { exact: true });
    const previous = await page.locator('.color-hex').innerText();
    await input.fill('');
    await expect(input).toHaveValue('');
    await expect(page.locator('.color-hex')).toHaveText(previous);
    const value = String([125, 64, 231][index]);
    await input.pressSequentially(value);
    await input.press('Enter');
    await expect(input).toHaveValue(value);
  }
  await expect(page.locator('.color-hex')).toHaveText('#7D40E7');
  const red = page.getByLabel('红色通道', { exact: true });
  await red.fill('999');
  await red.press('Enter');
  await expect(red).toHaveValue('255');
  await red.fill('-1');
  await red.press('Enter');
  await expect(red).toHaveValue('0');
  await red.fill('125');
  await red.press('Enter');
  await page.getByRole('button', { name: '调整颜色', exact: true }).click();
  await page.getByRole('button', { name: '铅笔 (B)', exact: true }).click();
  await page.keyboard.press('Escape');
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.click(bounds.x + 4.5 * bounds.width / 64, bounds.y + 4.5 * bounds.height / 64);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) =>
    Array.from(element.getContext('2d')!.getImageData(4, 4, 1, 1).data)
  )).toEqual([125, 64, 231, 255]);
});
