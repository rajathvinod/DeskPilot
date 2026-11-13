import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <>
      {/* One stack for now. Real screens (Connect, Screen, Approvals) get added in later phases. */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0B0F14' } }} />
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
    </>
  );
}
