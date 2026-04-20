// Stub — artifact API removed.
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from './artifactTypes';

export async function fetchArtifacts(_credentials: AuthCredentials): Promise<Artifact[]> {
    return [];
}

export async function fetchArtifact(_credentials: AuthCredentials, _id: string): Promise<Artifact | null> {
    return null;
}

export async function createArtifact(_credentials: AuthCredentials, _request: ArtifactCreateRequest): Promise<Artifact | null> {
    return null;
}

export async function updateArtifact(_credentials: AuthCredentials, _request: ArtifactUpdateRequest): Promise<Artifact | null> {
    return null;
}
