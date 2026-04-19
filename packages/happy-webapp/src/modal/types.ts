export interface ModalButton {
    text: string;
    style?: 'default' | 'cancel' | 'destructive';
    onPress?: () => void;
}

export interface ModalConfig {
    title: string;
    message?: string;
    buttons: ModalButton[];
    prompt?: {
        placeholder?: string;
        defaultValue?: string;
        onSubmit: (value: string) => void;
    };
}
