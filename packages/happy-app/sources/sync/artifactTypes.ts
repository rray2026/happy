// Stub — artifact feature removed.

export interface ArtifactHeader {
    title: string | null;
    sessions?: string[];
    draft?: boolean;
}

export interface ArtifactBody {
    body: string | null;
}

export interface Artifact {
    id: string;
    header: string;
    body?: string;
    encryptedKey: string;
    dataEncryptionKey: string;
    headerVersion: number;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
}

export interface DecryptedArtifact {
    id: string;
    title: string | null;
    body: string | null;
    sessions: string[];
    draft: boolean;
    createdAt: number;
    updatedAt: number;
    seq?: number;
    headerVersion?: number;
    bodyVersion?: number;
}

export interface ArtifactCreateRequest {
    title: string | null;
    body: string;
    sessions: string[];
    draft: boolean;
}

export interface ArtifactUpdateRequest {
    artifactId: string;
    title?: string | null;
    body?: string;
    sessions?: string[];
    draft?: boolean;
}
