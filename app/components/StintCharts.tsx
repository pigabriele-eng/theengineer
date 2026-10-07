// Charts for the stint tool. Colours: the app's time colours for the fade (red: slower, green: quicker), each phase's
// own colour on its row, and the balance pair (understeer, oversteer, grey: within the normal). Values and labels
// always use text colours, and every bar keeps its signed value beside it. The programme's chrome: square bars from
// an ink centre line, Archivo capitals for the legend and the axis words.
import { useRef, useState } from 'react';
import { LayoutChangeEvent, Platform, Pressable, StyleSheet, TextStyle } from 'react-native';
import Svg, { Circle, Line, Rect } from 'react-native-svg';

import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { FadeRow, signed } from '@/lib/stint';
import { byScheme, chartPlate, deltaColor, face, Fonts, phaseColor, themed, Type, useTheme } from '@/constants/Theme';

const BALANCE = byScheme((c) => c.balance);
export const useBalanceColors = () => BALANCE[useColorScheme() === 'dark' ? 'dark' : 'light'];
export const MIN_SHIFT = 0.15; // ° of understeer angle: a smaller shift reads as holding (as the server's words)

/** The colour of a balance shift: blue towards understeer, red towards oversteer, grey when it holds. */
export function shiftColor(shift: number, pal: { under: string; over: string; neutral: string }) {
  return Math.abs(shift) < MIN_SHIFT ? pal.neutral : shift > 0 ? pal.under : pal.over;
}

/** Point at a corner to find it on the track map: on the web a mouse over it shows it and leaving clears it, and a
 * tap (or a click) picks it; tapping the picked one again clears it, unless the mouse is over it. */
export type OnCorner = (code: string | null) => void;

// A corner the way the analysis names it ("T6", "T2-T5", "T8/T9"; C1, C2... on a track without official numbers).
const CORNER = /(\b[TC]\d+(?:[-/][TC]?\d+)*)/;

/** Text naming corners, with each corner of `codes` in it pointable: hover or tap it to find it on the map. The
 * corner is underlined; the one on the map is in programme red. */
export function CornerText({ text, codes, focus, onCorner, style }: {
  text: string; codes: string[]; focus?: string | null; onCorner?: OnCorner; style?: TextStyle;
}) {
  const styles = useStyles();
  const over = useRef<string | null>(null);
  if (!onCorner) return <Text style={style}>{text}</Text>;
  return (
    <Text style={style}>
      {text.split(CORNER).map((part, i) => {
        if (i % 2 === 0 || !codes.includes(part)) return part;
        const hover = Platform.OS === 'web' ? {
          onPointerEnter: (e: any) => {
            if (e.nativeEvent?.pointerType !== 'mouse') return;
            over.current = part;
            onCorner(part);
          },
          onPointerLeave: (e: any) => {
            if (e.nativeEvent?.pointerType !== 'mouse') return;
            over.current = null;
            onCorner(null);
          },
        } : {};
        return (
          <Text key={i} {...hover} accessibilityRole="button" accessibilityLabel={`Show ${part} on the track map`}
            onPress={() => onCorner(focus === part && over.current !== part ? null : part)}
            style={StyleSheet.flatten([styles.corner, focus === part && styles.cornerOn])}>
            {part}
          </Text>
        );
      })}
    </Text>
  );
}

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(e.nativeEvent.layout.width)];
}

/** A square bar from the ink centre line. */
function CentreBar({ width, value, max, color, height = 12, faded = false }: {
  width: number; value: number; max: number; color: string; height?: number; faded?: boolean;
}) {
  const c = useTheme().chart;
  const mid = width / 2;
  const len = Math.min(Math.abs(value) / (max || 1), 1) * (mid - 2);
  return (
    <Svg width={width} height={height}>
      {len > 0.5 ? (
        <Rect x={value >= 0 ? mid : mid - len} y={0} width={len} height={height} fill={color}
          fillOpacity={faded ? 0.35 : 1} />
      ) : null}
      <Line x1={mid} x2={mid} y1={0} y2={height} stroke={c.axis} strokeWidth={1} />
    </Svg>
  );
}

/** The tyre fade split by phase, biggest loss first: s a lap, slower to the right, quicker to the left. */
export function FadeBars({ rows, focus, onCorner }: { rows: FadeRow[]; focus?: string | null; onCorner?: OnCorner }) {
  const styles = useStyles();
  const theme = useTheme();
  const [width, onLayout] = useWidth();
  const max = Math.max(...rows.map((r) => Math.abs(r.per_lap)), 0.01);
  const top = rows.find((r) => r.clear && r.per_lap > 0)?.key;
  return (
    <View style={styles.chart}>
      <View style={styles.legend}>
        <Key color={theme.delta.loss} label="Slower as the stint goes on" />
        <Key color={theme.delta.gain} label="Quicker" />
        <Key color={theme.chart.muted} label="Faded: within the lap-to-lap scatter" faded />
      </View>
      <View onLayout={onLayout} style={styles.rows}>
        {rows.map((r, i) => (
          <View key={r.key} style={StyleSheet.flatten([styles.fadeRow, i === 0 && styles.fadeFirst])}
            accessibilityLabel={`${r.label}: ${signed(r.per_lap, 3)} s a lap${r.clear ? '' : ', within the scatter'}`}>
            <View style={styles.rowHead}>
              <View style={StyleSheet.flatten([styles.phaseKey, { backgroundColor: phaseColor(theme, r.key) }])} />
              <Text style={StyleSheet.flatten([styles.rowLabel, r.key === top && styles.strong])}>{r.label}</Text>
              <Text style={StyleSheet.flatten([styles.rowValue, { color: deltaColor(theme, r.per_lap) ?? theme.text },
                !r.clear && styles.dim])}>
                {signed(r.per_lap, 3)} s/lap
              </Text>
            </View>
            {width > 0 && (
              <CentreBar width={width} value={r.per_lap} max={max} color={r.per_lap >= 0 ? theme.delta.loss : theme.delta.gain}
                faded={!r.clear} />
            )}
            {r.per_lap > 0 && r.corners.length > 0 && (
              <CornerText style={styles.rowNote} codes={r.corners.map((x) => x.code)} focus={focus} onCorner={onCorner}
                text={`mostly ${r.corners.map((x) => `${x.code} (${x.per_lap.toFixed(3)})`).join(', ')}`} />
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

function Key({ color, label, faded = false, ring = false }: { color: string; label: string; faded?: boolean;
  ring?: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.legendItem}>
      {/* a ring keys the early laps' ring mark on the chart; every other key is a flat square */}
      {ring ? (
        <Svg width={12} height={12}>
          <Circle cx={6} cy={6} r={4} fill="none" stroke={color} strokeWidth={2} />
        </Svg>
      ) : (
        <View style={StyleSheet.flatten([styles.swatch, { backgroundColor: color, opacity: faded ? 0.35 : 1 }])} />
      )}
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

/** A change as a bar from the centre: grip in % (red falls, green rises) or balance in ° (blue/magenta). */
export function ChangeBar({ value, max, color, faded }: { value: number | null; max: number; color: string;
  faded?: boolean }) {
  const styles = useStyles();
  const [width, onLayout] = useWidth();
  return (
    <View onLayout={onLayout} style={styles.changeBar}>
      {width > 0 && value != null && <CentreBar width={width} value={value} max={max} color={color} height={10}
        faded={faded} />}
    </View>
  );
}

export type ShiftRow = { label: string; early: number; late: number; shift: number; strong?: boolean };

/** The balance early and late in the stint, per corner: a dumbbell from the early laps (ring) to the late laps
 * (dot), oversteer to the left of the car's normal, understeer to the right. */
export function BalanceDumbbell({ rows, early, late, onCorner }: { rows: ShiftRow[]; early: string; late: string;
  onCorner?: OnCorner }) {
  const styles = useStyles();
  const c = useTheme().chart;
  const pal = useBalanceColors();
  const [width, onLayout] = useWidth();
  const [picked, setPicked] = useState<number | null>(null);
  const over = useRef<number | null>(null); // the row under the mouse
  // the row picked, and its corner shown on the map (the whole lap isn't a corner)
  const pick = (i: number | null) => {
    setPicked(i);
    onCorner?.(i == null || rows[i]?.strong ? null : rows[i].label);
  };
  const span = Math.max(1, Math.ceil(Math.max(...rows.flatMap((r) => [Math.abs(r.early), Math.abs(r.late)])) * 2) / 2);
  const H = 22;
  const x = (v: number) => 6 + ((v + span) / (2 * span)) * (width - 12);
  const sel = picked != null ? rows[picked] : null;
  return (
    <View style={styles.chart}>
      <View style={styles.legend}>
        <Key color={c.ink} label={`Early laps (${early})`} ring />
        <Key color={pal.under} label={`Late laps (${late}): towards understeer`} />
        <Key color={pal.over} label="towards oversteer" />
        <Key color={pal.neutral} label={`holds (within ±${MIN_SHIFT}°)`} />
      </View>
      <View style={styles.dumbHead}>
        <Text style={styles.axisText}>← oversteer</Text>
        <Text style={styles.axisText}>normal</Text>
        <Text style={styles.axisText}>understeer →</Text>
      </View>
      {rows.map((r, i) => {
        const col = shiftColor(r.shift, pal);
        return (
          <Pressable key={r.label} onPress={() => pick(picked === i && over.current !== i ? null : i)}
            {...(Platform.OS === 'web' ? {
              onHoverIn: () => {
                over.current = i;
                pick(i);
              },
              onHoverOut: () => {
                over.current = null;
                pick(null);
              },
            } : {})}
            accessibilityLabel={`${r.label}: ${signed(r.early)}° to ${signed(r.late)}°, ${signed(r.shift)}°`}
            style={StyleSheet.flatten([styles.dumbRow, picked === i && styles.dumbRowOn])}>
            <Text style={StyleSheet.flatten([styles.dumbLabel, r.strong && styles.strongLabel])} numberOfLines={1}>
              {r.label}
            </Text>
            <View style={styles.dumbPlot} onLayout={i === 0 ? onLayout : undefined}>
              {width > 0 && (
                <Svg width={width} height={H}>
                  <Line x1={x(0)} x2={x(0)} y1={0} y2={H} stroke={c.axis} strokeWidth={1} />
                  <Line x1={x(-span)} x2={x(span)} y1={H / 2} y2={H / 2} stroke={c.grid} strokeWidth={1} />
                  <Line x1={x(r.early)} x2={x(r.late)} y1={H / 2} y2={H / 2} stroke={col} strokeWidth={2}
                    strokeOpacity={0.6} />
                  <Circle cx={x(r.early)} cy={H / 2} r={4} fill={c.surface} stroke={c.ink} strokeWidth={2} />
                  <Circle cx={x(r.late)} cy={H / 2} r={5} fill={col} stroke={c.surface} strokeWidth={2} />
                </Svg>
              )}
            </View>
            <Text style={StyleSheet.flatten([styles.dumbValue, Math.abs(r.shift) < MIN_SHIFT && styles.dim])}>
              {signed(r.shift)}°
            </Text>
          </Pressable>
        );
      })}
      <Text style={styles.readout}>
        {sel
          ? `${sel.label}: ${signed(sel.early)}° early, ${signed(sel.late)}° late (${signed(sel.shift)}°${
            Math.abs(sel.shift) < MIN_SHIFT ? ', holds' : sel.shift > 0 ? ', towards understeer' : ', towards oversteer'})`
          : `Scale ±${span}° from the car's normal. Tap a corner to read it.`}
      </Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  rows: { backgroundColor: 'transparent' },
  chart: { gap: 10, ...chartPlate(c) },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 6, backgroundColor: 'transparent' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'transparent' },
  swatch: { width: 14, height: 10 },
  legendText: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 0.8, color: c.textSecondary },
  fadeRow: { gap: 6, backgroundColor: 'transparent', paddingVertical: 10, borderTopWidth: 1, borderColor: c.separator },
  fadeFirst: { borderColor: c.rule },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'transparent' },
  phaseKey: { width: 12, height: 12 },
  rowLabel: { fontFamily: Fonts.body, fontSize: 16, color: c.text, flex: 1 },
  rowValue: { ...Type.number, fontFamily: face('label', 700), fontSize: 14 },
  rowNote: { fontFamily: Fonts.body, fontSize: 13, lineHeight: 18, color: c.textSecondary },
  strong: { fontFamily: face('body', 700) },
  strongLabel: { fontFamily: face('label', 700), color: c.text },
  dim: { opacity: 0.5 },
  changeBar: { flex: 1, minWidth: 40, backgroundColor: 'transparent' },
  dumbHead: { flexDirection: 'row', justifyContent: 'space-between', marginLeft: 76, marginRight: 58,
    backgroundColor: 'transparent' },
  axisText: { ...Type.label, fontSize: 10, color: c.textMuted },
  dumbRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 30, borderBottomWidth: 1,
    borderColor: c.separator },
  dumbRowOn: { backgroundColor: c.surfaceRaised },
  dumbLabel: { ...Type.number, width: 68, fontSize: 13, color: c.textSecondary },
  dumbPlot: { flex: 1, backgroundColor: 'transparent' },
  dumbValue: { ...Type.number, width: 50, fontSize: 13, textAlign: 'right', color: c.text },
  readout: { fontFamily: Fonts.body, fontSize: 13, lineHeight: 18, color: c.textSecondary, minHeight: 18 },
  corner: { textDecorationLine: 'underline', textDecorationStyle: 'dotted', textDecorationColor: c.text },
  cornerOn: { color: c.mark, textDecorationColor: c.mark },
}));
