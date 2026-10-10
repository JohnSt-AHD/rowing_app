import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'nz.org.rowing.strokedebug',
  appName: 'CrewSight Stroke Debug',
  webDir: 'www',
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#0a1628',
    useLegacyBridge: true,
  },
};

export default config;
