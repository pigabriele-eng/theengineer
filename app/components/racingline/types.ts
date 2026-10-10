// What the racing line page hands its 3D view (components/racingline/Scene3D.web.tsx): the playhead, read every frame.
import type { MutableRefObject } from 'react';

import type { RacingLine } from '@/lib/racingLine';
import type { Sync } from '@/lib/racingLineMath';
import type { ScenePalette } from '@/components/racingline/colors';

export type CameraMode = 'chase' | 'above' | 'bird' | 'trackside';

// m: the playhead, metres along the first lap; sync: same place or real time
export type Playhead = MutableRefObject<{ m: number; sync: Sync }>;

export type SceneProps = {
  data: RacingLine;
  colors: string[];
  palette: ScenePalette;
  playhead: Playhead;
  camera: CameraMode;
  trails: boolean; // each tyre's load painted along the lap's line
  resetKey: number; // a change puts the camera back where its mode has it
  height: number;
  label: string; // what the view shows, for a screen reader
};
