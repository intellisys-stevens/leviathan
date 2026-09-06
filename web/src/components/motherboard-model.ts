import * as THREE from 'three';
import {
  MOTHERBOARD_COLORS,
  motherboardGlowIntensity,
  type MotherboardAppearance,
  type MotherboardCategoryId,
} from './motherboard-appearance';

export type {
  MotherboardAppearance,
  MotherboardCategoryId,
} from './motherboard-appearance';

type Point = readonly [number, number, number];
type Channel = { value: number; from: number; target: number; elapsed: number };
const TRANSITION_MS = 180;

/** A fixed illustrative motherboard; shapes never assert the host's physical slot count. */
export function createMotherboardModel(theme: 'dark' | 'light') {
  const group = new THREE.Group();
  group.name = 'Illustrative host motherboard';
  const pickables: THREE.Object3D[] = [];
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const instances = new Set<THREE.InstancedMesh>();
  const colors = MOTHERBOARD_COLORS[theme];
  let disposed = false;
  let motionEnabled = true;
  let selected: MotherboardCategoryId | null = null;
  let highlighted: MotherboardCategoryId | null = null;
  const appearance: MotherboardAppearance = { cpu: null, memory: null };

  function geometry<T extends THREE.BufferGeometry>(value: T): T {
    geometries.add(value);
    return value;
  }
  function material<T extends THREE.Material>(value: T): T {
    materials.add(value);
    return value;
  }
  function standard(color: string, roughness = 0.65, metalness = 0.18) {
    return material(
      new THREE.MeshStandardMaterial({ color, roughness, metalness }),
    );
  }
  const pcb = standard(colors.pcb, 0.82, 0.12);
  const laminate = standard('#273b40', 0.73, 0.2);
  const black = standard('#171d21', 0.64, 0.12);
  const packageTop = standard('#30393e', 0.61, 0.2);
  const steel = standard('#a9b5bc', 0.32, 0.72);
  const graphite = standard('#46535b', 0.42, 0.56);
  const gold = standard('#c5a25b', 0.36, 0.72);
  const copper = standard('#638e8c', 0.47, 0.4);
  const cpuFace = standard('#64757c', 0.38, 0.62);
  const ramFace = standard('#28383d', 0.52, 0.3);
  cpuFace.emissive.set(colors.accent);
  ramFace.emissive.set(colors.accent);
  cpuFace.emissiveIntensity = 0;
  ramFace.emissiveIntensity = 0;

  function mesh(
    geom: THREE.BufferGeometry,
    mat: THREE.Material,
    position: Point,
    name: string,
  ) {
    const value = new THREE.Mesh(geom, mat);
    value.position.set(...position);
    value.name = name;
    group.add(value);
    return value;
  }
  function box(
    width: number,
    height: number,
    depth: number,
    mat: THREE.Material,
    position: Point,
    name: string,
  ) {
    return mesh(
      geometry(new THREE.BoxGeometry(width, height, depth)),
      mat,
      position,
      name,
    );
  }
  function batch(
    geom: THREE.BufferGeometry,
    mat: THREE.Material,
    positions: readonly Point[],
    name: string,
  ) {
    const value = new THREE.InstancedMesh(geom, mat, positions.length);
    const matrix = new THREE.Matrix4();
    positions.forEach((point, index) =>
      value.setMatrixAt(index, matrix.makeTranslation(...point)),
    );
    value.name = name;
    group.add(value);
    instances.add(value);
    return value;
  }
  function boxes(
    width: number,
    height: number,
    depth: number,
    mat: THREE.Material,
    positions: readonly Point[],
    name: string,
  ) {
    return batch(
      geometry(new THREE.BoxGeometry(width, height, depth)),
      mat,
      positions,
      name,
    );
  }
  function cylinders(
    radius: number,
    height: number,
    mat: THREE.Material,
    positions: readonly Point[],
    name: string,
  ) {
    return batch(
      geometry(new THREE.CylinderGeometry(radius, radius, height, 16)),
      mat,
      positions,
      name,
    );
  }

  const perimeter: readonly [number, number][] = [
    [-4.45, -5.15],
    [4.1, -5.15],
    [4.45, -4.8],
    [4.45, 4.8],
    [4.1, 5.15],
    [-4.1, 5.15],
    [-4.45, 4.8],
  ];
  const shape = new THREE.Shape();
  perimeter.forEach(([x, z], index) =>
    index ? shape.lineTo(x, -z) : shape.moveTo(x, -z),
  );
  shape.closePath();
  const mountingPoints: Point[] = [-3.96, 0, 3.97].flatMap((x) =>
    [-4.68, 4.63].map((z): Point => [x, 0.13, z]),
  );
  for (const [x, , z] of mountingPoints) {
    const hole = new THREE.Path();
    hole.absarc(x, -z, 0.095, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const board = geometry(
    new THREE.ExtrudeGeometry(shape, {
      depth: 0.18,
      bevelEnabled: true,
      bevelThickness: 0.025,
      bevelSize: 0.025,
      bevelSegments: 1,
      steps: 1,
      curveSegments: 12,
    }),
  );
  board.rotateX(-Math.PI / 2);
  board.translate(0, -0.09, 0);
  mesh(board, pcb, [0, 0, 0], 'Chamfered multilayer motherboard PCB');
  for (const y of [-0.055, 0.045]) {
    const points = [...perimeter, perimeter[0]].map(
      ([x, z]) => new THREE.Vector3(x, y, z),
    );
    const edge = new THREE.Line(
      geometry(new THREE.BufferGeometry().setFromPoints(points)),
      material(
        new THREE.LineBasicMaterial({
          color: '#547b80',
          transparent: true,
          opacity: 0.55,
        }),
      ),
    );
    edge.name = 'Visible PCB laminate layer';
    group.add(edge);
  }

  // CPU socket, retention frame, exposed heat spreader and locking arm.
  box(2.78, 0.19, 2.84, black, [-0.72, 0.2, -1.28], 'CPU socket substrate');
  box(2.5, 0.12, 2.54, laminate, [-0.72, 0.35, -1.28], 'CPU package substrate');
  const cpu = box(
    2.13,
    0.16,
    2.17,
    cpuFace,
    [-0.72, 0.5, -1.28],
    'Exposed CPU heat spreader',
  );
  cpu.userData.regionId = 'cpu';
  pickables.push(cpu);
  for (const x of [-2.06, 0.62])
    box(0.11, 0.15, 2.9, steel, [x, 0.43, -1.28], 'CPU retention frame');
  for (const z of [-2.72, 0.16])
    box(2.72, 0.15, 0.11, steel, [-0.72, 0.43, z], 'CPU retention frame');
  box(0.07, 0.07, 2.53, steel, [0.87, 0.55, -1.1], 'CPU socket locking arm');
  box(0.31, 0.08, 0.12, steel, [0.76, 0.55, 0.17], 'CPU socket release tab');
  cylinders(
    0.075,
    0.07,
    graphite,
    [-2.02, 0.58].flatMap((x) => [-2.62, 0.06].map((z): Point => [x, 0.54, z])),
    'CPU frame fasteners',
  );

  // The illustrative RAM bank is one aggregate target, independent of capacity.
  const dimmX = [1.65, 2.18, 2.71, 3.24];
  boxes(
    0.35,
    0.21,
    4.36,
    black,
    dimmX.map((x): Point => [x, 0.23, -1.38]),
    'Illustrative DIMM sockets',
  );
  boxes(
    0.12,
    0.97,
    3.88,
    pcb,
    dimmX.map((x): Point => [x, 0.77, -1.38]),
    'Illustrative memory module PCBs',
  );
  boxes(
    0.2,
    0.48,
    0.58,
    ramFace,
    dimmX.flatMap((x) =>
      [-2.67, -1.82, -0.97, -0.12].map((z): Point => [x, 0.92, z]),
    ),
    'Aggregate RAM packages',
  );
  boxes(
    0.28,
    0.09,
    3.9,
    graphite,
    dimmX.map((x): Point => [x, 1.3, -1.38]),
    'Memory top rails',
  );
  boxes(
    0.44,
    0.4,
    0.23,
    steel,
    dimmX.flatMap((x) => [-3.58, 0.82].map((z): Point => [x, 0.37, z])),
    'DIMM retention clips',
  );
  boxes(
    0.135,
    0.19,
    0.08,
    gold,
    dimmX.flatMap((x) =>
      Array.from({ length: 26 }, (_, i): Point => [x, 0.4, -3.17 + i * 0.143]),
    ),
    'Memory edge contacts',
  );

  // M.2-shaped storage is an aggregate category, not an asserted physical drive.
  box(
    3.18,
    0.11,
    1.05,
    pcb,
    [0.98, 0.25, 2.34],
    'Illustrative M.2 storage PCB',
  );
  box(0.55, 0.2, 0.83, graphite, [-0.27, 0.36, 2.34], 'M.2 controller');
  boxes(
    0.66,
    0.17,
    0.8,
    packageTop,
    [
      [0.52, 0.35, 2.34],
      [1.34, 0.35, 2.34],
    ],
    'Storage packages',
  );
  box(0.24, 0.22, 1.07, black, [-0.72, 0.28, 2.34], 'M.2 connector');
  boxes(
    0.3,
    0.02,
    0.05,
    gold,
    Array.from({ length: 11 }, (_, i): Point => [
      -0.46,
      0.31,
      1.99 + i * 0.066,
    ]),
    'M.2 gold connector fingers',
  );
  cylinders(0.105, 0.07, steel, [[2.4, 0.35, 2.34]], 'M.2 retention screw');

  // Rear I/O shielding, expansion connectors and a finned chipset heat sink.
  box(0.85, 0.22, 5.23, graphite, [-3.91, 0.24, -1.36], 'Rear I/O shield base');
  boxes(
    0.8,
    0.68,
    0.84,
    steel,
    [-3.36, -2.27, -1.18, -0.09, 0.91].map((z): Point => [-4.03, 0.57, z]),
    'Rear I/O metal housings',
  );
  boxes(
    0.025,
    0.36,
    0.56,
    black,
    [-3.36, -2.27, -1.18, -0.09, 0.91].map((z): Point => [-4.44, 0.56, z]),
    'Recessed rear I/O ports',
  );
  for (const z of [1.02, 3.56]) {
    box(4.48, 0.27, 0.35, black, [-1.19, 0.3, z], 'PCIe expansion socket');
    box(4.09, 0.035, 0.055, copper, [-1.3, 0.45, z], 'PCIe connector channel');
    box(0.21, 0.27, 0.47, steel, [1.12, 0.3, z], 'PCIe retention latch');
  }
  box(1.17, 0.23, 1.18, graphite, [2.9, 0.28, 3.87], 'Chipset heatsink base');
  boxes(
    0.08,
    0.3,
    1.13,
    steel,
    Array.from({ length: 9 }, (_, i): Point => [2.41 + i * 0.12, 0.54, 3.87]),
    'Chipset heatsink fins',
  );

  // VRM chokes, MOSFETs, paired solder pads, capacitors and power plugs.
  const vrmX = [-2.54, -1.83, -1.12, -0.41, 0.3, 1.01];
  boxes(
    0.49,
    0.31,
    0.5,
    graphite,
    vrmX.map((x): Point => [x, 0.33, -3.69]),
    'CPU power chokes',
  );
  boxes(
    0.38,
    0.16,
    0.3,
    black,
    vrmX.map((x): Point => [x, 0.21, -4.25]),
    'Voltage regulation MOSFETs',
  );
  const capacitorPoints: Point[] = [
    ...vrmX.map((x): Point => [x, 0.41, -3.1]),
    ...[-2.61, -1.81, -1.01, -0.21].map((z): Point => [-2.58, 0.41, z]),
    ...[1.62, 2.13, 2.64].map((z): Point => [-3.69, 0.41, z]),
  ];
  cylinders(0.135, 0.59, steel, capacitorPoints, 'Solid-state capacitors');
  cylinders(
    0.14,
    0.05,
    black,
    capacitorPoints.map(([x, , z]): Point => [x, 0.14, z]),
    'Capacitor insulating bases',
  );
  cylinders(
    0.095,
    0.006,
    graphite,
    capacitorPoints.map(([x, , z]): Point => [x, 0.708, z]),
    'Capacitor vent marks',
  );
  box(0.54, 0.5, 2.3, black, [3.94, 0.42, -1.48], '24-pin power socket');
  boxes(
    0.09,
    0.04,
    0.12,
    gold,
    [3.82, 4.06].flatMap((x) =>
      Array.from({ length: 12 }, (_, i): Point => [
        x,
        0.682,
        -2.44 + i * 0.176,
      ]),
    ),
    '24-pin power contacts',
  );
  box(1.3, 0.47, 0.53, black, [2.72, 0.39, -4.52], 'CPU power socket');
  boxes(
    0.13,
    0.02,
    0.12,
    gold,
    [0, 1].flatMap((row) =>
      Array.from({ length: 4 }, (_, i): Point => [
        2.22 + i * 0.33,
        0.635,
        -4.67 + row * 0.29,
      ]),
    ),
    'CPU power contacts',
  );
  boxes(
    0.34,
    0.27,
    0.54,
    black,
    [2.04, 2.53, 3.02, 3.51].map((x): Point => [x, 0.25, 1.19]),
    'Illustrative storage connectors',
  );
  boxes(
    0.22,
    0.15,
    0.3,
    black,
    Array.from({ length: 10 }, (_, i): Point => [-2.8 + i * 0.37, 0.23, 4.68]),
    'Front-panel header sockets',
  );
  boxes(
    0.03,
    0.21,
    0.035,
    gold,
    Array.from({ length: 20 }, (_, i): Point => [-2.88 + i * 0.183, 0.4, 4.68]),
    'Front-panel header pins',
  );

  const tracePoints: THREE.Vector3[] = [];
  function trace(points: readonly [number, number][]) {
    for (let i = 1; i < points.length; i++) {
      for (const [x, z] of [points[i - 1], points[i]])
        tracePoints.push(new THREE.Vector3(x, 0.123, z));
    }
  }
  for (let i = 0; i < 13; i++) {
    const d = i * 0.075;
    trace([
      [-1.8 + d, 0.34],
      [-1.8 + d, 0.52 + d],
      [-2.72 + d, 1.44 + d],
      [-2.72 + d, 2.85],
      [-0.8, 2.85],
    ]);
    trace([
      [0.77, -2.5 + d],
      [1.05 + d * 0.3, -2.5 + d],
      [1.37, -2.18 + d],
      [1.5, -2.18 + d],
    ]);
    trace([
      [-3.3, 3.92 + d * 0.6],
      [-2.9 + d, 3.92 + d * 0.6],
      [-2.4 + d, 4.42],
      [0.9, 4.42],
    ]);
  }
  const traces = new THREE.LineSegments(
    geometry(new THREE.BufferGeometry().setFromPoints(tracePoints)),
    material(
      new THREE.LineBasicMaterial({
        color: '#48797e',
        transparent: true,
        opacity: theme === 'dark' ? 0.5 : 0.42,
      }),
    ),
  );
  traces.name = 'Fine routed motherboard copper traces';
  group.add(traces);
  const smallPads: Point[] = Array.from({ length: 30 }, (_, i): Point => [
    -3.08 + (i % 6) * 0.12,
    0.17,
    -2.63 + Math.floor(i / 6) * 0.35,
  ]);
  boxes(0.065, 0.045, 0.12, steel, smallPads, 'Surface-mount solder pads');
  boxes(
    0.08,
    0.075,
    0.2,
    black,
    smallPads
      .filter((_, i) => i % 2 === 0)
      .map(([x, , z]): Point => [x + 0.065, 0.205, z]),
    'Surface-mount resistors',
  );
  const washer = geometry(new THREE.TorusGeometry(0.145, 0.025, 6, 18));
  washer.rotateX(Math.PI / 2);
  batch(washer, steel, mountingPoints, 'Motherboard mounting rings');
  cylinders(
    0.07,
    0.12,
    graphite,
    mountingPoints.map(([x, , z]): Point => [x, 0.015, z]),
    'Recessed mounting holes',
  );

  function label(text: string, position: Point, width: number, depth: number) {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = '600 60px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#e8f3f6';
    context.fillText(text, 256, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    const plane = mesh(
      geometry(new THREE.PlaneGeometry(width, depth)),
      material(
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
      position,
      `${text} silkscreen label`,
    );
    plane.rotation.x = -Math.PI / 2;
    plane.raycast = () => undefined;
  }
  label('CPU', [-0.72, 0.584, -1.28], 1.28, 0.34);
  label('RAM', [2.43, 0.137, 1.68], 1.3, 0.33);
  label('STORAGE', [0.95, 0.14, 3.13], 1.86, 0.34);
  label('LEVIATHAN', [-2.25, 0.14, -4.74], 2.75, 0.34);

  const bounds = {
    cpu: new THREE.Box3(
      new THREE.Vector3(-2.17, 0.12, -2.83),
      new THREE.Vector3(0.99, 0.65, 0.29),
    ),
    memory: new THREE.Box3(
      new THREE.Vector3(1.39, 0.12, -3.76),
      new THREE.Vector3(3.52, 1.37, 0.97),
    ),
    storage: new THREE.Box3(
      new THREE.Vector3(-0.92, 0.12, 1.75),
      new THREE.Vector3(2.66, 0.51, 2.94),
    ),
  };
  const proxyMaterial = material(
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
    }),
  );
  for (const id of ['memory', 'storage'] as const) {
    const size = bounds[id].getSize(new THREE.Vector3());
    const center = bounds[id].getCenter(new THREE.Vector3());
    const proxy = box(
      size.x,
      size.y,
      size.z,
      proxyMaterial,
      center.toArray(),
      `Aggregate ${id} pick target`,
    );
    proxy.userData.regionId = id;
    pickables.push(proxy);
  }
  function channel(): Channel {
    return { value: 0, from: 0, target: 0, elapsed: TRANSITION_MS };
  }
  const glows = { cpu: channel(), memory: channel() };
  // A local, transparent ring catches the component rim. It is not bloom and
  // never lights unrelated hardware or changes the camera's measured bounds.
  const haloPixels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const u = Math.abs((x + 0.5) / 32 - 1);
      const v = Math.abs((y + 0.5) / 32 - 1);
      const radius = (u ** 8 + v ** 8) ** (1 / 8);
      const ring = Math.exp(-(((radius - 0.8) / 0.11) ** 2));
      const fade = Math.max(0, Math.min(1, (0.99 - radius) / 0.12));
      haloPixels.set(
        [255, 255, 255, Math.round(255 * ring * fade)],
        (y * 64 + x) * 4,
      );
    }
  }
  const haloTexture = new THREE.DataTexture(haloPixels, 64, 64);
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  haloTexture.minFilter = THREE.LinearFilter;
  haloTexture.magFilter = THREE.LinearFilter;
  haloTexture.needsUpdate = true;
  textures.add(haloTexture);
  const halos = {
    cpu: { width: 2.68, depth: 2.72, position: [-0.72, 0.583, -1.28] as Point },
    memory: {
      width: 2.63,
      depth: 5.13,
      position: [2.455, 0.135, -1.395] as Point,
    },
  };
  const haloMaterials = (['cpu', 'memory'] as const).map((id) => {
    const bounds = halos[id];
    const haloMaterial = material(
      new THREE.MeshBasicMaterial({
        color: colors.accent,
        map: haloTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    const halo = mesh(
      geometry(new THREE.PlaneGeometry(bounds.width, bounds.depth)),
      haloMaterial,
      bounds.position,
      `${id} measured activity halo`,
    );
    halo.rotation.x = -Math.PI / 2;
    halo.userData.excludeFromFraming = true;
    halo.userData.regionId = id;
    halo.raycast = () => undefined;
    return { id, material: haloMaterial };
  });
  const outlines = (['cpu', 'memory', 'storage'] as const).map((id) => {
    const size = bounds[id].getSize(new THREE.Vector3());
    const center = bounds[id].getCenter(new THREE.Vector3());
    const outlineGeometry = geometry(
      new THREE.EdgesGeometry(
        geometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
      ),
    );
    const outlineMaterial = material(
      new THREE.LineBasicMaterial({
        color: colors.outline,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    const outline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
    outline.position.copy(center);
    outline.name = `${id} selection outline`;
    outline.raycast = () => undefined;
    group.add(outline);
    return { id, material: outlineMaterial, channel: channel() };
  });
  function corners(box: THREE.Box3) {
    return [box.min.x, box.max.x].flatMap((x) =>
      [box.min.y, box.max.y].flatMap((y) =>
        [box.min.z, box.max.z].map((z) => new THREE.Vector3(x, y, z)),
      ),
    );
  }
  group.updateMatrixWorld(true);
  const wholeBounds = new THREE.Box3().setFromObject(group);
  const frames = {
    board: {
      target: wholeBounds.getCenter(new THREE.Vector3()),
      points: corners(wholeBounds),
    },
    cpu: {
      target: bounds.cpu.getCenter(new THREE.Vector3()),
      points: corners(bounds.cpu.clone().expandByScalar(0.16)),
    },
    memory: {
      target: bounds.memory.getCenter(new THREE.Vector3()),
      points: corners(bounds.memory.clone().expandByScalar(0.16)),
    },
    storage: {
      target: bounds.storage.getCenter(new THREE.Vector3()),
      points: corners(bounds.storage.clone().expandByScalar(0.18)),
    },
  };
  function target(value: Channel, next: number, immediate: boolean) {
    const snap = immediate || !motionEnabled;
    if (value.target === next && (!snap || value.value === next)) return false;
    value.from = value.value;
    value.target = next;
    value.elapsed = snap ? TRANSITION_MS : 0;
    if (snap) value.value = next;
    return true;
  }
  function paint() {
    cpuFace.emissiveIntensity = glows.cpu.value;
    ramFace.emissiveIntensity = glows.memory.value;
    for (const halo of haloMaterials)
      halo.material.opacity =
        glows[halo.id].value * (theme === 'dark' ? 0.65 : 0.5);
    for (const outline of outlines)
      outline.material.opacity = outline.channel.value;
  }
  function outlineState(immediate: boolean) {
    let changed = false;
    for (const outline of outlines)
      changed =
        target(
          outline.channel,
          selected === outline.id
            ? 0.98
            : highlighted === outline.id
              ? 0.62
              : 0,
          immediate,
        ) || changed;
    paint();
    return changed;
  }
  const allChannels = [
    ...Object.values(glows),
    ...outlines.map((outline) => outline.channel),
  ];
  function isTransitioning() {
    return (
      !disposed && allChannels.some((value) => value.elapsed < TRANSITION_MS)
    );
  }
  const validId = (id: string | null): MotherboardCategoryId | null =>
    id === 'cpu' || id === 'memory' || id === 'storage' ? id : null;

  return {
    group,
    pickables,
    frames,
    defaultFrame: 'board' as const,
    setHighlight(id: string | null, immediate = false) {
      if (disposed) return false;
      highlighted = validId(id);
      return outlineState(immediate);
    },
    setSelected(id: string | null, immediate = false) {
      if (disposed) return false;
      selected = validId(id);
      return outlineState(immediate);
    },
    updateState(next: MotherboardAppearance, immediate = false) {
      if (disposed) return false;
      let changed = false;
      for (const id of ['cpu', 'memory'] as const) {
        const value = next[id];
        appearance[id] =
          value != null && Number.isFinite(value)
            ? Math.max(0, Math.min(100, value))
            : null;
        changed =
          target(
            glows[id],
            motherboardGlowIntensity(appearance[id]),
            immediate,
          ) || changed;
      }
      paint();
      return changed;
    },
    setMotionEnabled(enabled: boolean) {
      motionEnabled = enabled;
      if (!enabled) {
        for (const value of allChannels) {
          value.value = value.target;
          value.elapsed = TRANSITION_MS;
        }
        paint();
      }
    },
    update(deltaMs: number) {
      if (disposed) return false;
      const delta = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
      for (const value of allChannels) {
        if (value.elapsed >= TRANSITION_MS) continue;
        value.elapsed = Math.min(TRANSITION_MS, value.elapsed + delta);
        const eased = 1 - (1 - value.elapsed / TRANSITION_MS) ** 3;
        value.value = value.from + (value.target - value.from) * eased;
      }
      paint();
      return isTransitioning();
    },
    isTransitioning,
    hasAmbientActivity: () => false,
    getActivityState: () =>
      (['cpu', 'memory', 'storage'] as const).map((id) => ({
        id,
        activity: id === 'storage' ? null : appearance[id],
        emissiveIntensity:
          id === 'cpu'
            ? cpuFace.emissiveIntensity
            : id === 'memory'
              ? ramFace.emissiveIntensity
              : 0,
        haloOpacity:
          id === 'storage'
            ? 0
            : (haloMaterials.find((halo) => halo.id === id)?.material.opacity ??
              0),
        selected: selected === id,
        highlighted: highlighted === id,
        transitioning:
          id === 'storage' ? false : glows[id].elapsed < TRANSITION_MS,
      })),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const value of instances) value.dispose();
      for (const value of geometries) value.dispose();
      for (const value of materials) value.dispose();
      for (const value of textures) value.dispose();
      group.clear();
      pickables.length = 0;
    },
  };
}
