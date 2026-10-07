/**
 * Text and View in the app's colours (constants/Colors.ts), in the scheme picked in Tools › Appearance, and Text in the
 * programme's faces (constants/Theme.ts resolveFont): Anton for headlines and big figures, Archivo Narrow for labels
 * and numbers in columns, Newsreader for the rest.
 */
import { Text as DefaultText, View as DefaultView, StyleSheet, TextStyle } from 'react-native';

import { useColorScheme } from './useColorScheme';

import Colors, { Palette } from '@/constants/Colors';
import { resolveFont } from '@/constants/Theme';

type ThemeProps = {
  lightColor?: string;
  darkColor?: string;
};

export type TextProps = ThemeProps & DefaultText['props'];
export type ViewProps = ThemeProps & DefaultView['props'];

// the tokens that are a single colour
type ColorName = { [K in keyof Palette]: Palette[K] extends string ? K : never }[keyof Palette];

export function useThemeColor(props: { light?: string; dark?: string }, colorName: ColorName) {
  const theme = useColorScheme();
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}

export function Text(props: TextProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const font = resolveFont(flat);

  return <DefaultText style={font ? [{ color }, flat, font] : [{ color }, flat]} {...otherProps} />;
}

// Views are see-through: the paper shows behind them.
export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const theme = useColorScheme();
  const backgroundColor = (theme === 'dark' ? darkColor : lightColor) ?? 'transparent';

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
