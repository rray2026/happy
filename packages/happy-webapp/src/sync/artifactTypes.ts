export interface Artifact {
    id: string;
    header: string;
    headerVersion: number;
    body?: string;
    bodyVersion?: number;
    dataEncryptionKey: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
}

export interface DecryptedArtifact {
    id: string;
    title: string | null;
    sessions?: string[];
    draft?: boolean;
    body?: string | null;
    headerVersion: number;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    isDecrypted: boolean;
}
