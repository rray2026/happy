import qrcode from 'qrcode-terminal';

export function displayQRCode(payload: string): void {
    console.log('='.repeat(80));
    console.log('📱 Scan this QR code with the cowork-webapp to connect:');
    console.log('='.repeat(80));
    qrcode.generate(payload, { small: true }, (qr) => {
        for (const line of qr.split('\n')) {
            console.log(' '.repeat(10) + line);
        }
    });
    console.log('='.repeat(80));
}
