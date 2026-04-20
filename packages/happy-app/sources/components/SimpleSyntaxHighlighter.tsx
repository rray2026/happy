import * as React from 'react';
import { Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

interface Props {
    code: string;
    language?: string | null;
    selectable?: boolean;
}

export function SimpleSyntaxHighlighter({ code, selectable }: Props) {
    const { styles } = useStyles.use();
    return <Text style={styles.code} selectable={selectable}>{code}</Text>;
}

const useStyles = StyleSheet.create((theme) => ({
    code: {
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 13,
        color: theme.colors.text.primary,
    },
}));
