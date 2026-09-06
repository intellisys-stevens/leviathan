import type { BoardRegion } from './gpu-board-model';
import type { GPUChipAppearance } from './gpu-chip-appearance';
import {
  HardwareBoardView,
  type HardwareBoardViewProps,
} from './hardware-board-view';

export type GPUBoardViewProps = Omit<
  HardwareBoardViewProps,
  'sceneKey' | 'scene' | 'selectedId'
> & {
  gpuKey: string;
  regions: readonly BoardRegion[];
  appearances?: readonly GPUChipAppearance[];
};

/** GPU defaults and public props stay stable as more hardware shares the canvas. */
export function GPUBoardView({
  gpuKey,
  regions,
  appearances,
  label = 'GPU board',
  ...props
}: GPUBoardViewProps) {
  return (
    <HardwareBoardView
      {...props}
      sceneKey={gpuKey}
      scene={{ kind: 'gpu', regions, appearances }}
      label={label}
    />
  );
}

export default GPUBoardView;
