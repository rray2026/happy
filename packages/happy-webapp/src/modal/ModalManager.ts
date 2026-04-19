import { ModalConfig, ModalButton } from './types';

type ShowFn = (config: ModalConfig) => void;
let showFn: ShowFn | null = null;

export function registerModalShow(fn: ShowFn) {
    showFn = fn;
}

export const Modal = {
    alert(title: string, message?: string, buttons?: ModalButton[]) {
        showFn?.({
            title,
            message,
            buttons: buttons ?? [{ text: 'OK', style: 'cancel' }],
        });
    },

    confirm(title: string, message?: string, onConfirm?: () => void, onCancel?: () => void) {
        showFn?.({
            title,
            message,
            buttons: [
                { text: 'Cancel', style: 'cancel', onPress: onCancel },
                { text: 'OK', style: 'default', onPress: onConfirm },
            ],
        });
    },

    prompt(title: string, placeholder?: string, defaultValue?: string, onSubmit?: (value: string) => void) {
        showFn?.({
            title,
            buttons: [{ text: 'Cancel', style: 'cancel' }],
            prompt: { placeholder, defaultValue, onSubmit: onSubmit ?? (() => {}) },
        });
    },
};
