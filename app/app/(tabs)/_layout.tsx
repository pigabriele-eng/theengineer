import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useClientOnlyValue } from '@/components/useClientOnlyValue';

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme].tint,
        // Disable the static render of the header on web
        // to prevent a hydration error in React Navigation v6.
        headerShown: useClientOnlyValue(false, true),
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'flag.checkered', android: 'flag', web: 'flag' }}
              tintColor={color}
              size={26}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="debrief"
        options={{
          title: 'Debrief',
          tabBarIcon: ({ color }) => (
            <SymbolView name={{ ios: 'mic', android: 'mic', web: 'mic' }} tintColor={color} size={26} />
          ),
        }}
      />
    </Tabs>
  );
}
