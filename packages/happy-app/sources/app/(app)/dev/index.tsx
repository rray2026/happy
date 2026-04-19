import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';

export default function DevScreen() {
    const handleClearCache = async () => {
        const confirmed = await Modal.confirm(
            'Clear Cache',
            'Are you sure you want to clear all cached data?',
            { confirmText: 'Clear', destructive: true }
        );
        if (confirmed) {
            console.log('Cache cleared');
            Modal.alert('Success', 'Cache has been cleared');
        }
    };

    return (
        <ItemList>
            <ItemGroup title="Actions" footer="These actions may affect app stability">
                <Item
                    title="Test Crash"
                    subtitle="Trigger a test crash"
                    destructive={true}
                    icon={<Ionicons name="warning-outline" size={28} color="#FF3B30" />}
                    onPress={async () => {
                        const confirmed = await Modal.confirm(
                            'Test Crash',
                            'This will crash the app. Continue?',
                            { confirmText: 'Crash', destructive: true }
                        );
                        if (confirmed) {
                            throw new Error('Test crash triggered from dev menu');
                        }
                    }}
                />
                <Item
                    title="Clear Cache"
                    subtitle="Remove all cached data"
                    icon={<Ionicons name="trash-outline" size={28} color="#FF9500" />}
                    onPress={handleClearCache}
                />
                <Item
                    title="Reset App State"
                    subtitle="Clear all user data and preferences"
                    destructive={true}
                    icon={<Ionicons name="refresh-outline" size={28} color="#FF3B30" />}
                    onPress={async () => {
                        const confirmed = await Modal.confirm(
                            'Reset App',
                            'This will delete all data. Are you sure?',
                            { confirmText: 'Reset', destructive: true }
                        );
                        if (confirmed) {
                            console.log('App state reset');
                        }
                    }}
                />
            </ItemGroup>
        </ItemList>
    );
}
