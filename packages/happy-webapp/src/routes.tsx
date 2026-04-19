import { createBrowserRouter } from 'react-router';
import { RootLayout } from './root';
import { lazy, Suspense } from 'react';
import React from 'react';

function L(factory: () => Promise<{ default: React.ComponentType }>) {
    const C = lazy(factory);
    return (
        <Suspense fallback={<div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)' }}>Loading...</div>}>
            <C />
        </Suspense>
    );
}

// AppAuthGate is a layout route: shows LandingPage when unauth, AppLayout+Outlet when auth.
// All app routes are children of this layout so they all get the sidebar.
export const router = createBrowserRouter([
    {
        path: '/',
        element: <RootLayout />,
        children: [
            {
                element: L(() => import('./pages/HomePage').then(m => ({ default: m.AppAuthGate }))),
                children: [
                    { index: true, element: L(() => import('./pages/HomePage').then(m => ({ default: m.SessionsIndexPage }))) },
                    { path: 'session/recent', element: L(() => import('./pages/RecentSessionsPage').then(m => ({ default: m.RecentSessionsPage }))) },
                    { path: 'session/:id', element: L(() => import('./pages/SessionPage').then(m => ({ default: m.SessionPage }))) },
                    { path: 'session/:id/info', element: L(() => import('./pages/SessionInfoPage').then(m => ({ default: m.SessionInfoPage }))) },
                    { path: 'session/:id/files', element: L(() => import('./pages/SessionFilesPage').then(m => ({ default: m.SessionFilesPage }))) },
                    { path: 'session/:id/file', element: L(() => import('./pages/SessionFilePage').then(m => ({ default: m.SessionFilePage }))) },
                    { path: 'session/:id/message/:messageId', element: L(() => import('./pages/MessageDetailPage').then(m => ({ default: m.MessageDetailPage }))) },
                    { path: 'settings', element: L(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage }))) },
                    { path: 'settings/account', element: L(() => import('./pages/AccountSettingsPage').then(m => ({ default: m.AccountSettingsPage }))) },
                    { path: 'settings/appearance', element: L(() => import('./pages/AppearancePage').then(m => ({ default: m.AppearancePage }))) },
                    { path: 'settings/features', element: L(() => import('./pages/FeaturesPage').then(m => ({ default: m.FeaturesPage }))) },
                    { path: 'friends', element: L(() => import('./pages/FriendsPage').then(m => ({ default: m.FriendsPage }))) },
                    { path: 'friends/search', element: L(() => import('./pages/FriendSearchPage').then(m => ({ default: m.FriendSearchPage }))) },
                    { path: 'inbox', element: L(() => import('./pages/InboxPage').then(m => ({ default: m.InboxPage }))) },
                    { path: 'machine/:id', element: L(() => import('./pages/MachinePage').then(m => ({ default: m.MachinePage }))) },
                    { path: 'artifacts', element: L(() => import('./pages/ArtifactsPage').then(m => ({ default: m.ArtifactsPage }))) },
                    { path: 'artifacts/new', element: L(() => import('./pages/NewArtifactPage').then(m => ({ default: m.NewArtifactPage }))) },
                    { path: 'artifacts/:id', element: L(() => import('./pages/ArtifactPage').then(m => ({ default: m.ArtifactPage }))) },
                    { path: 'artifacts/edit/:id', element: L(() => import('./pages/EditArtifactPage').then(m => ({ default: m.EditArtifactPage }))) },
                ],
            },
        ],
    },
]);
