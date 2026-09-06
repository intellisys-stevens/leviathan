import * as THREE from 'three';
import { createGPUBoard, type BoardRegion } from './gpu-board-model';
import type { GPUChipAppearance } from './gpu-chip-appearance';
import {
  createMotherboardModel,
  type MotherboardAppearance,
} from './motherboard-model';

export type HardwareScene =
  | {
      kind: 'gpu';
      regions: readonly BoardRegion[];
      appearances?: readonly GPUChipAppearance[];
    }
  | { kind: 'motherboard'; appearance: MotherboardAppearance };

export type HardwareFrame = {
  target: THREE.Vector3;
  points: readonly THREE.Vector3[];
};

export type HardwareSceneModel = {
  group: THREE.Group;
  pickables: THREE.Object3D[];
  resolvePick?: (hit: THREE.Intersection) => string | null;
  frames: Readonly<Record<string, HardwareFrame>>;
  defaultFrame: string;
  setState: (scene: HardwareScene, immediate: boolean) => boolean;
  setHighlight: (id: string | null, immediate: boolean) => void;
  setSelected: (id: string | null, immediate: boolean) => void;
  setMotionEnabled: (enabled: boolean) => void;
  update: (deltaMs: number) => boolean | void;
  isTransitioning: () => boolean;
  hasAmbientActivity: () => boolean;
  getActivityState?: () => unknown;
  dispose: () => void;
};

export function resolveHardwarePick(
  model: Pick<HardwareSceneModel, 'resolvePick'>,
  hit: THREE.Intersection | undefined,
) {
  if (!hit) return null;
  if (model.resolvePick) return model.resolvePick(hit);
  return typeof hit.object.userData.regionId === 'string'
    ? hit.object.userData.regionId
    : null;
}

export function createHardwareScene(
  scene: HardwareScene,
  theme: 'dark' | 'light',
): HardwareSceneModel {
  if (scene.kind === 'motherboard') {
    const model = createMotherboardModel(theme);
    return {
      ...model,
      setState: (next, immediate) =>
        next.kind === 'motherboard' &&
        model.updateState(next.appearance, immediate),
    };
  }
  const model = createGPUBoard(scene.regions, theme);
  const points: THREE.Vector3[] = [];
  for (const x of [-1.59, 1.59])
    for (const y of [0.27, 0.39])
      for (const z of [-1.22, 1.22]) points.push(new THREE.Vector3(x, y, z));
  return {
    ...model,
    frames: { chip: { target: new THREE.Vector3(0, 0.33, 0), points } },
    defaultFrame: 'chip',
    setSelected: () => {},
    setState: (next, immediate) =>
      next.kind === 'gpu' && model.setAppearance(next.appearances, immediate),
  };
}
