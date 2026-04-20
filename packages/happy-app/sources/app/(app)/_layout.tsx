import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

export const unstable_settings = {
    initialRouteName: 'index',
};

export default function RootLayout() {
    const { theme } = useUnistyles();

    return (
        <Stack
            initialRouteName='index'
            screenOptions={{
                headerBackTitle: t('common.back'),
                headerShadowVisible: false,
                contentStyle: {
                    backgroundColor: theme.colors.surface,
                },
                headerStyle: {
                    backgroundColor: theme.colors.header.background,
                },
                headerTintColor: theme.colors.header.tint,
                headerTitleStyle: {
                    color: theme.colors.header.tint,
                    ...Typography.default('semiBold'),
                },
            }}
        >
            <Stack.Screen
                name="index"
                options={{ headerShown: false }}
            />
            <Stack.Screen
                name="direct/index"
                options={{
                    headerShown: true,
                    headerTitle: 'Direct Connect',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="terminal/connect"
                options={{ headerTitle: t('navigation.connectTerminal') }}
            />
            <Stack.Screen
                name="terminal/index"
                options={{ headerTitle: t('navigation.connectTerminal') }}
            />
            <Stack.Screen
                name="dev/index"
                options={{ headerTitle: 'Developer Tools' }}
            />
            <Stack.Screen
                name="dev/logs"
                options={{ headerTitle: 'Logs', headerBackTitle: 'Dev' }}
            />
            <Stack.Screen
                name="dev/list-demo"
                options={{ headerTitle: 'List Components Demo' }}
            />
            <Stack.Screen
                name="dev/typography"
                options={{ headerTitle: 'Typography' }}
            />
            <Stack.Screen
                name="dev/colors"
                options={{ headerTitle: 'Colors' }}
            />
            <Stack.Screen
                name="dev/shimmer-demo"
                options={{ headerTitle: 'Shimmer View Demo' }}
            />
            <Stack.Screen
                name="dev/multi-text-input"
                options={{ headerTitle: 'Multi Text Input' }}
            />
            <Stack.Screen
                name="dev/session-composer"
                options={{ headerTitle: 'Session Composer' }}
            />
        </Stack>
    );
}
