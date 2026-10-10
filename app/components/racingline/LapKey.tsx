// A lap's key: a short piece of its line, in its colour and its pattern (solid, dashed, dotted, dash-dot), so a lap is
// told by more than its colour; and the marker shapes of the 3D view (brake a square, turn-in a triangle, apex a
// circle, throttle a diamond) for the legend.
import Svg, { Circle, Line, Polygon, Rect } from 'react-native-svg';

import { PATTERNS } from '@/lib/racingLineMath';
import { useTheme } from '@/constants/Theme';

export function LapKey({ k, color, width = 34 }: { k: number; color: string; width?: number }) {
  const p = PATTERNS[k % PATTERNS.length];
  return (
    <Svg width={width} height={12} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Line x1={1} x2={width - 1} y1={6} y2={6} stroke={color} strokeWidth={4} strokeDasharray={p.svg}
        strokeLinecap="butt" />
    </Svg>
  );
}

export type MarkerKind = 'brake' | 'turn_in' | 'apex' | 'throttle';
export const MARKER_NAMES: Record<MarkerKind, string> = {
  brake: 'Brake point (square)', turn_in: 'Turn-in (triangle)', apex: 'Apex (circle)', throttle: 'Throttle (diamond)',
};

export function MarkerShape({ kind, color, size = 16 }: { kind: MarkerKind; color?: string; size?: number }) {
  const c = useTheme();
  const fill = color ?? c.textSecondary;
  const s = size;
  const ink = { stroke: c.text, strokeWidth: 1.2 };
  return (
    <Svg width={s} height={s} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {kind === 'brake' && <Rect x={2} y={2} width={s - 4} height={s - 4} fill={fill} {...ink} />}
      {kind === 'turn_in' && <Polygon points={`${s / 2},1.5 ${s - 1.5},${s - 2} 1.5,${s - 2}`} fill={fill} {...ink} />}
      {kind === 'apex' && <Circle cx={s / 2} cy={s / 2} r={s / 2 - 1.5} fill={fill} {...ink} />}
      {kind === 'throttle' && <Polygon points={`${s / 2},1 ${s - 1},${s / 2} ${s / 2},${s - 1} 1,${s / 2}`} fill={fill} {...ink} />}
    </Svg>
  );
}
