import { Platform } from 'react-native';

export function isRunningOnMac(): boolean {
    return Platform.OS !== 'ios';
}
