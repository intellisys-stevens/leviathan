import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
if (process.env.PLAYWRIGHT_HARDWARE_GPU !== '1') {
  throw new Error('Hardware validation requires PLAYWRIGHT_HARDWARE_GPU=1');
}
const browser = await chromium.launch({
  args: [
    '--enable-gpu',
    '--use-angle=vulkan',
    '--enable-features=Vulkan',
    '--disable-vulkan-surface',
  ],
});
try {
  const page = await browser.newPage();
  const renderer = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2048;
    document.body.appendChild(canvas);
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL unavailable');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (!info) throw new Error('Unmasked WebGL renderer unavailable');
    const name = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    const vertex = gl.createShader(gl.VERTEX_SHADER);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(
      vertex,
      'attribute vec2 p; void main(){ gl_Position=vec4(p,0.,1.); }',
    );
    gl.shaderSource(
      fragment,
      'precision highp float; void main(){ vec2 p=gl_FragCoord.xy/2048.; float v=0.; for(int i=0;i<64;i++){ p=sin(p.yx*1.03+float(i)*0.01); v+=p.x; } gl_FragColor=vec4(fract(v),p,1.); }',
    );
    for (const shader of [vertex, fragment]) {
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
    }
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const location = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, canvas.width, canvas.height);
    function draw() {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      requestAnimationFrame(draw);
    }
    draw();
    return name;
  });
  if (
    !/NVIDIA/i.test(renderer) ||
    !/Vulkan/i.test(renderer) ||
    /SwiftShader|llvmpipe|software/i.test(renderer)
  ) {
    throw new Error(
      'Hardware NVIDIA Vulkan WebGL renderer required: ' + renderer,
    );
  }
  const samples = [];
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=uuid,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    );
    // This guest must have exactly the approved passed-through GPU.
    const rows = stdout.trim().split('\n');
    if (rows.length !== 1) throw new Error('Expected exactly one NVIDIA GPU');
    const [uuid, value] = rows[0].split(',').map((part) => part.trim());
    const utilization = Number(value);
    if (!Number.isFinite(utilization))
      throw new Error('GPU utilization unavailable');
    samples.push({ uuid, utilization });
  }
  await writeFile(
    'hardware-gpu.json',
    JSON.stringify({ renderer, samples }, null, 2) + '\n',
  );
  if (!samples.some(({ utilization }) => utilization > 0)) {
    throw new Error(
      'No measured NVIDIA GPU activity during the WebGL workload',
    );
  }
  console.log('Hardware WebGL verified:', renderer);
} finally {
  await browser.close();
}
