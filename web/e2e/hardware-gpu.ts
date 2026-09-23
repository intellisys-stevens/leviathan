import type { Browser } from '@playwright/test';
import process from 'node:process';

const hardwareGPU = process.env.PLAYWRIGHT_HARDWARE_GPU === '1';

export const webGLLaunchArgs = hardwareGPU
  ? ['--enable-gpu', '--use-gl=angle', '--use-angle=gl']
  : [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ];

// Check the browser fixture that will run the suite, not a separate preflight launch.
export async function requireNvidiaWebGL(browser: Browser): Promise<void> {
  if (!hardwareGPU) return;

  const page = await browser.newPage();
  try {
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) throw new Error('Hardware GPU mode requires WebGL 2');
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (!info) throw new Error('Unmasked WebGL renderer unavailable');
      return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    });
    if (
      !/NVIDIA/i.test(renderer) ||
      /SwiftShader|llvmpipe|software/i.test(renderer)
    ) {
      throw new Error(`Hardware GPU mode requires NVIDIA WebGL: ${renderer}`);
    }
    console.log(`Suite WebGL renderer: ${renderer}`);
  } finally {
    await page.close();
  }
}
