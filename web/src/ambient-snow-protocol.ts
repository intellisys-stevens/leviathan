export type SnowMode = 'running' | 'paused' | 'static' | 'hidden';

export type SnowWorkerInput =
  | { type: 'probe' }
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      pixelRatio: number;
      coarse: boolean;
      mode: SnowMode;
    }
  | {
      type: 'configure';
      width: number;
      height: number;
      pixelRatio: number;
      coarse: boolean;
    }
  | { type: 'mode'; mode: SnowMode }
  | { type: 'dispose' };

export type SnowWorkerOutput =
  | { type: 'probe-ready' }
  | {
      type: 'state';
      state: SnowMode;
      particleCount: number;
      pixelRatio: number;
    }
  | { type: 'frame'; sequence: number }
  | { type: 'error'; message: string };
