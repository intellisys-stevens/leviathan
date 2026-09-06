import * as THREE from 'three';
import { GPU_CHIP_COLORS, type GPUChipAppearance } from './gpu-chip-appearance';

/** Logical chip compartments. Geometry does not represent physical MIG slice placement. */
export type BoardRegion = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const CHIP_WIDTH = 3.08;
const CHIP_DEPTH = 2.34;
const CHIP_TOP = 0.335;
const HIGHLIGHT_MS = 180;

type RegionHighlight = {
  id: string;
  material: THREE.MeshStandardMaterial;
  edge: THREE.LineBasicMaterial;
  current: number;
  from: number;
  target: number;
  appearance: GPUChipAppearance;
  appearanceElapsed: number;
  fromColor: THREE.Color;
  targetColor: THREE.Color;
  fromEmissive: THREE.Color;
  targetEmissive: THREE.Color;
  fromIntensity: number;
  targetIntensity: number;
  particles: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  bounds: { x: number; z: number; width: number; depth: number };
  phase: number;
  seed: number;
};

/** A locally constructed, fanless accelerator PCB. Each instance owns its resources. */
export function createGPUBoard(
  regions: readonly BoardRegion[],
  theme: 'dark' | 'light',
) {
  const group = new THREE.Group();
  group.name = 'Fanless accelerator board';
  const pickables: THREE.Object3D[] = [];
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const instances = new Set<THREE.InstancedMesh>();
  const highlights: RegionHighlight[] = [];
  let disposed = false;
  let highlighted: string | null = null;
  let elapsed = HIGHLIGHT_MS;
  let motionEnabled = true;

  function geometry<T extends THREE.BufferGeometry>(value: T): T {
    geometries.add(value);
    return value;
  }
  function material<T extends THREE.Material>(value: T): T {
    materials.add(value);
    return value;
  }
  const standard = (
    color: THREE.ColorRepresentation,
    roughness = 0.55,
    metalness = 0.15,
  ) =>
    material(new THREE.MeshStandardMaterial({ color, roughness, metalness }));
  const pcb = standard(theme === 'dark' ? '#14231e' : '#21352b', 0.83, 0.08);
  const boardEdge = standard('#243f2d', 0.72, 0.15);
  const packageBlack = standard('#171b1d', 0.74, 0.07);
  const memoryTop = standard('#24282a', 0.7, 0.12);
  const silver = standard('#b7bec0', 0.3, 0.86);
  const darkMetal = standard('#535d5c', 0.44, 0.72);
  const gold = standard('#caaa58', 0.28, 0.8);
  const solder = standard('#9eaaa4', 0.38, 0.74);
  const resistor = standard('#3c433e', 0.72, 0.12);
  const coil = standard('#363b3d', 0.57, 0.38);
  const green = standard('#528c19', 0.55, 0.2);
  const neutralDie = new THREE.Color(theme === 'dark' ? '#252b2d' : '#30383a');

  function mesh(
    geom: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    name: string,
  ) {
    const object = new THREE.Mesh(geom, mat);
    object.position.set(x, y, z);
    object.name = name;
    group.add(object);
    return object;
  }
  function box(
    width: number,
    height: number,
    depth: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    name: string,
  ) {
    return mesh(
      geometry(new THREE.BoxGeometry(width, height, depth)),
      mat,
      x,
      y,
      z,
      name,
    );
  }
  function cylinders(
    radius: number,
    height: number,
    mat: THREE.Material,
    positions: readonly [number, number, number][],
    name: string,
  ) {
    const object = new THREE.InstancedMesh(
      geometry(new THREE.CylinderGeometry(radius, radius, height, 16)),
      mat,
      positions.length,
    );
    const matrix = new THREE.Matrix4();
    positions.forEach(([x, y, z], index) => {
      matrix.makeTranslation(x, y, z);
      object.setMatrixAt(index, matrix);
    });
    object.name = name;
    group.add(object);
    instances.add(object);
    return object;
  }
  function boxes(
    width: number,
    height: number,
    depth: number,
    mat: THREE.Material,
    positions: readonly [number, number, number][],
    name: string,
  ) {
    const object = new THREE.InstancedMesh(
      geometry(new THREE.BoxGeometry(width, height, depth)),
      mat,
      positions.length,
    );
    const matrix = new THREE.Matrix4();
    positions.forEach(([x, y, z], index) => {
      matrix.makeTranslation(x, y, z);
      object.setMatrixAt(index, matrix);
    });
    object.name = name;
    group.add(object);
    instances.add(object);
    return object;
  }

  const outline = new THREE.Shape();
  const perimeter = [
    [-5.35, -2.12],
    [4.98, -2.12],
    [5.35, -1.76],
    [5.35, 1.84],
    [5.08, 2.12],
    [1.15, 2.12],
    [1.15, 2.3],
    [-3.9, 2.3],
    [-3.9, 2.12],
    [-5.35, 2.12],
  ];
  perimeter.forEach(([x, z], index) => {
    if (index === 0) outline.moveTo(x, -z);
    else outline.lineTo(x, -z);
  });
  outline.closePath();
  const pcbGeometry = geometry(
    new THREE.ExtrudeGeometry(outline, {
      depth: 0.14,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 1,
    }),
  );
  pcbGeometry.rotateX(-Math.PI / 2);
  pcbGeometry.translate(0, -0.07, 0);
  mesh(pcbGeometry, pcb, 0, 0, 0, 'Multilayer dark PCB');

  // A static hardware accent follows the laminate edge, independently of MIG state.
  const edgePath = new THREE.CurvePath<THREE.Vector3>();
  perimeter.forEach(([x, z], index) => {
    const [nextX, nextZ] = perimeter[(index + 1) % perimeter.length];
    edgePath.add(
      new THREE.LineCurve3(
        new THREE.Vector3(x, 0.07, z),
        new THREE.Vector3(nextX, 0.07, nextZ),
      ),
    );
  });
  for (const [name, radius, opacity] of [
    ['PCB edge halo', 0.055, theme === 'dark' ? 0.075 : 0.045],
    ['PCB edge rim', 0.016, theme === 'dark' ? 0.32 : 0.2],
  ] as const) {
    const edge = mesh(
      geometry(new THREE.TubeGeometry(edgePath, 128, radius, 6, true)),
      material(
        new THREE.MeshBasicMaterial({
          color: '#76b900',
          transparent: true,
          opacity,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
      0,
      0,
      0,
      name,
    );
    edge.renderOrder = name === 'PCB edge halo' ? 1 : 2;
  }

  // Mounting rail and connector housings reveal the thickness of the board.
  box(0.12, 1.02, 4.62, silver, -5.48, 0.39, 0, 'Silver mounting bracket');
  box(0.5, 0.08, 4.62, silver, -5.3, 0.86, 0, 'Folded bracket lip');
  for (const z of [-1.35, -0.45, 0.45, 1.35]) {
    box(0.55, 0.38, 0.72, silver, -5.12, 0.27, z, 'Connector shield');
    box(
      0.024,
      0.23,
      0.52,
      packageBlack,
      -5.55,
      0.3,
      z,
      'Recessed connector opening',
    );
    box(
      0.025,
      0.12,
      0.42,
      packageBlack,
      -4.832,
      0.3,
      z,
      'Connector socket interior',
    );
  }
  boxes(
    0.026,
    0.045,
    0.24,
    darkMetal,
    Array.from(
      { length: 8 },
      (_, index) =>
        [-5.55, 0.69, -1.55 + index * 0.44] as [number, number, number],
    ),
    'Bracket ventilation slots',
  );

  // Notched edge connector; contacts exist on both faces of the laminate.
  box(1.27, 0.13, 0.6, boardEdge, -3.24, 0, 2.32, 'Short PCIe connector tab');
  box(3.74, 0.13, 0.6, boardEdge, -0.58, 0, 2.32, 'Long PCIe connector tab');
  const contactPositions: [number, number, number][] = [];
  for (let index = 0; index < 32; index++) {
    const x = -3.8 + index * 0.15 + (index >= 8 ? 0.17 : 0);
    contactPositions.push([x, 0.078, 2.34], [x, -0.078, 2.34]);
  }
  boxes(0.105, 0.014, 0.5, gold, contactPositions, 'Gold PCIe contacts');

  // Chip substrate and fine solder pads provide a physical frame for logical regions.
  box(3.65, 0.16, 2.91, boardEdge, 0, 0.15, 0, 'GPU chip substrate');
  box(3.4, 0.05, 2.66, silver, 0, 0.25, 0, 'GPU package rim');
  box(3.24, 0.047, 2.5, packageBlack, 0, 0.28, 0, 'Exposed die surround');
  const chipPads: [number, number, number][] = [];
  for (let index = 0; index < 22; index++) {
    const x = -1.64 + index * 0.156;
    chipPads.push([x, 0.237, -1.39], [x, 0.237, 1.39]);
  }
  boxes(0.065, 0.014, 0.055, solder, chipPads, 'Package solder pads');

  const memoryPositions: [number, number, number][] = [];
  for (const x of [-1.35, -0.45, 0.45, 1.35]) {
    memoryPositions.push([x, 0.18, -1.78], [x, 0.18, 1.78]);
  }
  boxes(0.73, 0.19, 0.44, packageBlack, memoryPositions, 'Memory packages');
  boxes(
    0.62,
    0.012,
    0.34,
    memoryTop,
    memoryPositions.map(([x, , z]) => [x, 0.282, z]),
    'Memory package tops',
  );
  for (const x of [-2.23, 2.23]) {
    boxes(
      0.48,
      0.19,
      0.76,
      packageBlack,
      [
        [x, 0.18, -0.8],
        [x, 0.18, 0.8],
      ],
      'Side memory packages',
    );
  }

  const powerPositions: [number, number, number][] = [];
  const capacitorPositions: [number, number, number][] = [];
  for (let index = 0; index < 5; index++) {
    const z = -1.52 + index * 0.69;
    powerPositions.push([3.35, 0.26, z]);
    capacitorPositions.push([4.05, 0.29, z]);
  }
  boxes(0.55, 0.35, 0.45, coil, powerPositions, 'Voltage regulator inductors');
  cylinders(0.19, 0.41, darkMetal, capacitorPositions, 'Power capacitors');
  cylinders(
    0.175,
    0.014,
    silver,
    capacitorPositions.map(([x, , z]) => [x, 0.502, z]),
    'Capacitor tops',
  );
  boxes(
    0.13,
    0.012,
    0.024,
    packageBlack,
    capacitorPositions.map(([x, , z]) => [x, 0.515, z]),
    'Capacitor pressure marks',
  );
  box(
    0.74,
    0.48,
    1.29,
    packageBlack,
    4.83,
    0.31,
    -0.58,
    'Auxiliary power connector',
  );
  boxes(
    0.03,
    0.21,
    0.08,
    gold,
    Array.from(
      { length: 6 },
      (_, index) =>
        [5.215, 0.33, -1.08 + index * 0.2] as [number, number, number],
    ),
    'Power connector pins',
  );
  box(0.54, 0.13, 0.56, packageBlack, -3.34, 0.15, -0.1, 'Board controller');
  box(0.42, 0.17, 0.86, packageBlack, -3.8, 0.17, 1.16, 'Interface controller');

  const passivePositions: [number, number, number][] = [];
  for (let index = 0; index < 12; index++) {
    passivePositions.push([
      -4.5 + (index % 4) * 0.24,
      0.107,
      -1.76 + Math.floor(index / 4) * 0.23,
    ]);
    passivePositions.push([
      2.88 + (index % 3) * 0.23,
      0.107,
      1.38 + Math.floor(index / 3) * 0.17,
    ]);
  }
  boxes(
    0.12,
    0.065,
    0.07,
    resistor,
    passivePositions,
    'Surface mount components',
  );
  boxes(
    0.03,
    0.07,
    0.078,
    solder,
    passivePositions.flatMap(([x, y, z]) => [
      [x - 0.07, y, z],
      [x + 0.07, y, z],
    ]),
    'Surface mount solder ends',
  );

  const traceVertices: number[] = [];
  function trace(points: readonly [number, number][]) {
    for (let index = 1; index < points.length; index++) {
      traceVertices.push(
        points[index - 1][0],
        0.079,
        points[index - 1][1],
        points[index][0],
        0.079,
        points[index][1],
      );
    }
  }
  for (let index = 0; index < 9; index++) {
    const offset = index * 0.085;
    trace([
      [-4.7, -1.3 + offset],
      [-3.65, -1.3 + offset],
      [-2.92, -0.57 + offset],
      [-2.56, -0.57 + offset],
    ]);
    trace([
      [2.62, -1.3 + offset],
      [2.81, -1.3 + offset],
      [3.02, -1.51 + offset],
      [3.11, -1.51 + offset],
    ]);
    trace([
      [-2.9 + offset, 2.03],
      [-2.9 + offset, 1.17],
      [-2.55 + offset, 0.82],
    ]);
  }
  const traceGeometry = geometry(new THREE.BufferGeometry());
  traceGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(traceVertices, 3),
  );
  const traces = new THREE.LineSegments(
    traceGeometry,
    material(
      new THREE.LineBasicMaterial({
        color: '#48765b',
        transparent: true,
        opacity: 0.43,
      }),
    ),
  );
  traces.name = 'Etched circuit traces';
  group.add(traces);
  cylinders(
    0.026,
    0.012,
    gold,
    Array.from({ length: 10 }, (_, index) => [
      -2.95 + index * 0.22,
      0.083,
      -1.92,
    ]),
    'PCB test vias',
  );

  for (const [x, z] of [
    [-4.66, -1.89],
    [-4.63, 1.79],
    [4.78, -1.78],
    [4.8, 1.78],
  ]) {
    mesh(
      geometry(new THREE.TorusGeometry(0.115, 0.023, 6, 18)),
      gold,
      x,
      0.083,
      z,
      'Mounting pad',
    ).rotation.x = -Math.PI / 2;
    mesh(
      geometry(new THREE.CylinderGeometry(0.084, 0.084, 0.046, 18)),
      silver,
      x,
      0.108,
      z,
      'Mounting screw',
    );
    box(
      0.105,
      0.008,
      0.018,
      packageBlack,
      x,
      0.135,
      z,
      'Screw slot',
    ).rotation.y = Math.PI / 4;
  }
  box(
    0.47,
    0.018,
    0.1,
    green,
    -3.5,
    0.085,
    0.57,
    'Green board identification stripe',
  );

  function chipLabel(
    label: string,
    width: number,
    depth: number,
    x: number,
    z: number,
  ) {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = Math.max(
      128,
      Math.min(512, Math.round((512 * depth) / width)),
    );
    let context: CanvasRenderingContext2D | null;
    try {
      context = canvas.getContext('2d');
    } catch {
      // Region names remain available in the adjacent HTML controls.
      return;
    }
    if (!context) return;
    let size = Math.min(90, canvas.height * 0.32);
    do {
      context.font = `600 ${size}px "JetBrains Mono Variable", monospace`;
      if (context.measureText(label).width <= canvas.width * 0.9) break;
      size -= 2;
    } while (size > 16);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.shadowColor = 'rgba(0, 0, 0, 0.8)';
    context.shadowBlur = 5;
    context.fillStyle = '#f1f8ed';
    context.fillText(
      label,
      canvas.width / 2,
      canvas.height / 2,
      canvas.width * 0.92,
    );
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    const labelMaterial = material(
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    const labelPlane = mesh(
      geometry(new THREE.PlaneGeometry(width * 0.92, depth * 0.92)),
      labelMaterial,
      x,
      CHIP_TOP + 0.006,
      z,
      'Chip region label',
    );
    labelPlane.rotation.x = -Math.PI / 2;
  }

  // A tiny local radial texture softens each particle without postprocessing.
  const particlePixels = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const index = (y * 16 + x) * 4;
      const radius = Math.hypot((x - 7.5) / 7.5, (y - 7.5) / 7.5);
      particlePixels.set(
        [255, 255, 255, Math.round(255 * Math.max(0, 1 - radius) ** 2)],
        index,
      );
    }
  }
  const particleTexture = new THREE.DataTexture(particlePixels, 16, 16);
  particleTexture.colorSpace = THREE.SRGBColorSpace;
  particleTexture.minFilter = THREE.LinearFilter;
  particleTexture.magFilter = THREE.LinearFilter;
  particleTexture.needsUpdate = true;
  textures.add(particleTexture);
  const haloPixels = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const distance = Math.min(x, y, 31 - x, 31 - y) / 31;
      const alpha = Math.max(0, 1 - distance / 0.17) ** 2;
      haloPixels.set(
        [255, 255, 255, Math.round(255 * alpha)],
        (y * 32 + x) * 4,
      );
    }
  }
  const haloTexture = new THREE.DataTexture(haloPixels, 32, 32);
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  haloTexture.minFilter = THREE.LinearFilter;
  haloTexture.magFilter = THREE.LinearFilter;
  haloTexture.needsUpdate = true;
  textures.add(haloTexture);

  function addChipRegion(region: BoardRegion | null) {
    const bounds = region ?? { x: 0, y: 0, width: 1, height: 1 };
    const width = Math.max(0.02, bounds.width * CHIP_WIDTH - 0.035);
    const depth = Math.max(0.02, bounds.height * CHIP_DEPTH - 0.035);
    const x = (bounds.x + bounds.width / 2 - 0.5) * CHIP_WIDTH;
    const z = (bounds.y + bounds.height / 2 - 0.5) * CHIP_DEPTH;
    const idle = new THREE.Color(GPU_CHIP_COLORS[theme].unknown);
    const face = standard(neutralDie.clone().lerp(idle, 0.05), 0.4, 0.35);
    face.emissive.copy(idle);
    face.emissiveIntensity = 0;
    const chip = box(
      width,
      0.045,
      depth,
      face,
      x,
      CHIP_TOP - 0.0225,
      z,
      region ? `Logical region ${region.label}` : 'Unpartitioned GPU die',
    );
    const edgeGeometry = geometry(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x - width / 2, CHIP_TOP + 0.001, z - depth / 2),
        new THREE.Vector3(x + width / 2, CHIP_TOP + 0.001, z - depth / 2),
        new THREE.Vector3(x + width / 2, CHIP_TOP + 0.001, z + depth / 2),
        new THREE.Vector3(x - width / 2, CHIP_TOP + 0.001, z + depth / 2),
      ]),
    );
    const edge = material(
      new THREE.LineBasicMaterial({
        color: idle,
        transparent: true,
        opacity: 0.62,
      }),
    );
    const line = new THREE.LineLoop(edgeGeometry, edge);
    line.name = 'Logical chip region boundary';
    group.add(line);
    chipLabel(region?.label ?? 'GPU', width, depth, x, z);
    if (region) {
      const particleGeometry = geometry(new THREE.BufferGeometry());
      particleGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(12), 3),
      );
      particleGeometry.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(new Float32Array(16), 4),
      );
      particleGeometry.setDrawRange(0, 0);
      // All effect vertices remain on the die, below labels and inside its margins.
      particleGeometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(x - width * 0.42, CHIP_TOP + 0.003, z - depth * 0.42),
        new THREE.Vector3(x + width * 0.42, CHIP_TOP + 0.03, z + depth * 0.42),
      );
      const particles = new THREE.Points(
        particleGeometry,
        material(
          new THREE.PointsMaterial({
            map: particleTexture,
            color: idle,
            size: Math.min(0.07, width * 0.1, depth * 0.1),
            transparent: true,
            opacity: 0,
            vertexColors: true,
            depthWrite: false,
            toneMapped: false,
          }),
        ),
      );
      particles.name = 'Chip activity particles';
      particles.userData.excludeFromFraming = true;
      particles.userData.regionId = region.id;
      particles.raycast = () => {};
      particles.visible = false;
      particles.frustumCulled = false;
      group.add(particles);
      const halo = new THREE.Mesh(
        geometry(new THREE.PlaneGeometry(width * 0.985, depth * 0.985)),
        material(
          new THREE.MeshBasicMaterial({
            color: idle,
            map: haloTexture,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
          }),
        ),
      );
      halo.name = 'Chip activity halo';
      halo.position.set(x, CHIP_TOP + 0.002, z);
      halo.rotation.x = -Math.PI / 2;
      halo.userData.excludeFromFraming = true;
      halo.userData.regionId = region.id;
      halo.raycast = () => {};
      group.add(halo);
      chip.userData.regionId = region.id;
      pickables.push(chip);
      let seed = 0;
      for (let index = 0; index < region.id.length; index++) {
        seed = (seed * 31 + region.id.charCodeAt(index)) >>> 0;
      }
      const state: RegionHighlight = {
        id: region.id,
        material: face,
        edge,
        current: 0,
        from: 0,
        target: 0,
        appearance: { id: region.id, state: 'unknown', activity: null },
        appearanceElapsed: HIGHLIGHT_MS,
        fromColor: face.color.clone(),
        targetColor: face.color.clone(),
        fromEmissive: idle.clone(),
        targetEmissive: idle.clone(),
        fromIntensity: 0,
        targetIntensity: 0,
        particles,
        halo,
        bounds: { x, z, width, depth },
        phase: 0,
        seed: (seed % 1000) / 1000,
      };
      paintParticles(state);
      highlights.push(state);
    }
  }
  if (regions.length === 0) addChipRegion(null);
  else regions.forEach(addChipRegion);

  const activeEdge = new THREE.Color(theme === 'dark' ? '#e7f6df' : '#172414');
  function paintHighlight(region: RegionHighlight, amount: number) {
    region.current = amount;
    region.edge.color.copy(region.material.emissive).lerp(activeEdge, amount);
    region.edge.opacity = 0.62 + amount * 0.38;
  }
  function paintParticles(region: RegionHighlight) {
    const activity = region.appearance.activity;
    const count =
      motionEnabled && activity !== null && activity > 0
        ? Math.ceil(activity / 25)
        : 0;
    region.particles.visible = count > 0;
    region.particles.geometry.setDrawRange(0, count);
    region.particles.material.color.copy(region.material.emissive);
    region.halo.material.color.copy(region.material.emissive);
    region.halo.material.opacity =
      region.material.emissiveIntensity * (theme === 'dark' ? 1.8 : 1.5);
    region.particles.material.opacity =
      (theme === 'dark' ? 0.22 : 0.15) *
      Math.min(
        1,
        region.material.emissiveIntensity / (theme === 'dark' ? 0.122 : 0.083),
      );
    const positions = region.particles.geometry.getAttribute('position');
    const colors = region.particles.geometry.getAttribute('color');
    for (let index = 0; index < 4; index++) {
      const angle =
        region.phase * (0.55 + (activity ?? 0) / 200) +
        region.seed * Math.PI * 2 +
        index * 1.9;
      const life = (region.phase * 0.35 + region.seed + index * 0.25) % 1;
      positions.setXYZ(
        index,
        region.bounds.x +
          region.bounds.width * (-0.3 + index * 0.2 + Math.sin(angle) * 0.035),
        CHIP_TOP + 0.003 + life * 0.023,
        region.bounds.z +
          region.bounds.depth *
            ((index % 2 === 0 ? -1 : 1) *
              (0.32 + Math.cos(angle * 0.7) * 0.035)),
      );
      colors.setXYZW(index, 1, 1, 1, Math.sin(life * Math.PI) ** 2);
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;
  }
  function setAppearance(
    appearances: readonly GPUChipAppearance[] = [],
    immediate = false,
  ): boolean {
    if (disposed) return false;
    const byId = new Map(
      appearances.map((appearance) => [appearance.id, appearance]),
    );
    let changed = false;
    for (const region of highlights) {
      const input = byId.get(region.id);
      const state = input?.state ?? 'unknown';
      const activity =
        (state === 'assigned' || state === 'unassigned') &&
        input?.activity != null &&
        Number.isFinite(input.activity)
          ? THREE.MathUtils.clamp(input.activity, 0, 100)
          : null;
      if (
        region.appearance.state === state &&
        region.appearance.activity === activity &&
        (!immediate || region.appearanceElapsed >= HIGHLIGHT_MS)
      )
        continue;
      changed = true;
      region.appearance = { id: region.id, state, activity };
      region.fromColor.copy(region.material.color);
      region.fromEmissive.copy(region.material.emissive);
      region.targetEmissive.set(GPU_CHIP_COLORS[theme][state]);
      region.targetColor
        .copy(neutralDie)
        .lerp(region.targetEmissive, 0.05 + (activity ?? 0) * 0.0005);
      region.fromIntensity = region.material.emissiveIntensity;
      region.targetIntensity =
        activity === null
          ? 0
          : theme === 'dark'
            ? 0.012 + activity * 0.0011
            : 0.008 + activity * 0.00075;
      region.appearanceElapsed = immediate ? HIGHLIGHT_MS : 0;
      if (immediate) {
        region.material.color.copy(region.targetColor);
        region.material.emissive.copy(region.targetEmissive);
        region.material.emissiveIntensity = region.targetIntensity;
      }
      // Invalid/stale data stops motion immediately, even while the old glow fades.
      paintParticles(region);
      paintHighlight(region, region.current);
    }
    return changed;
  }
  function setMotionEnabled(enabled: boolean) {
    if (disposed || motionEnabled === enabled) return;
    motionEnabled = enabled;
    for (const region of highlights) paintParticles(region);
  }
  function setHighlight(id: string | null, immediate = false) {
    if (disposed) return;
    const next = highlights.some((region) => region.id === id) ? id : null;
    if (next === highlighted && !immediate) return;
    highlighted = next;
    elapsed = immediate ? HIGHLIGHT_MS : 0;
    for (const region of highlights) {
      region.from = region.current;
      region.target = region.id === next ? 1 : 0;
      if (immediate) paintHighlight(region, region.target);
    }
  }
  function isTransitioning() {
    return (
      !disposed &&
      (elapsed < HIGHLIGHT_MS ||
        highlights.some((region) => region.appearanceElapsed < HIGHLIGHT_MS))
    );
  }
  function hasAmbientActivity() {
    return !disposed && highlights.some((region) => region.particles.visible);
  }
  function update(deltaMs: number): boolean {
    if (disposed) return false;
    const delta = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
    elapsed = Math.min(HIGHLIGHT_MS, elapsed + delta);
    const amount = 1 - (1 - elapsed / HIGHLIGHT_MS) ** 3;
    for (const region of highlights) {
      region.appearanceElapsed = Math.min(
        HIGHLIGHT_MS,
        region.appearanceElapsed + delta,
      );
      const appearanceAmount =
        1 - (1 - region.appearanceElapsed / HIGHLIGHT_MS) ** 3;
      region.material.color.lerpColors(
        region.fromColor,
        region.targetColor,
        appearanceAmount,
      );
      region.material.emissive.lerpColors(
        region.fromEmissive,
        region.targetEmissive,
        appearanceAmount,
      );
      region.material.emissiveIntensity =
        region.fromIntensity +
        (region.targetIntensity - region.fromIntensity) * appearanceAmount;
      paintHighlight(
        region,
        region.from + (region.target - region.from) * amount,
      );
      if (region.particles.visible) region.phase += delta / 1000;
      paintParticles(region);
    }
    return isTransitioning() || hasAmbientActivity();
  }
  function getActivityState() {
    return highlights.map((region) => ({
      ...region.appearance,
      emissiveIntensity: region.material.emissiveIntensity,
      haloOpacity: region.halo.material.opacity,
      particleCount: region.particles.visible
        ? region.particles.geometry.drawRange.count
        : 0,
      phase: region.phase,
      transitioning: region.appearanceElapsed < HIGHLIGHT_MS,
    }));
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const instance of instances) instance.dispose();
    for (const texture of textures) texture.dispose();
    for (const value of materials) value.dispose();
    for (const value of geometries) value.dispose();
    group.clear();
    pickables.length = 0;
    highlights.length = 0;
  }
  return {
    group,
    pickables,
    setHighlight,
    setAppearance,
    setMotionEnabled,
    isTransitioning,
    hasAmbientActivity,
    getActivityState,
    update,
    dispose,
  };
}
