/**
 * Text and View in the app's colours (constants/Colors.ts), in the scheme picked in Tools › Appearance.
 */
import { Text as DefaultText, View as DefaultView } from 'react-native';

import { useColorScheme } from './useColorScheme';

import Colors, { Palette } from '@/constants/Colors';

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

  return <DefaultText style={[{ color }, style]} {...otherProps} />;
}

// Views are see-through, so the page's race-track picture shows between the cards; a card paints its own `surface`.
export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const theme = useColorScheme();
  const backgroundColor = (theme === 'dark' ? darkColor : lightColor) ?? 'transparent';

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
