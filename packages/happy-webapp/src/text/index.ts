// Simple flat key-based translation function for the webapp
// Keys match happy-app's t() call sites

type Params = Record<string, string | number | boolean>;

const translations: Record<string, string | ((p: Params) => string)> = {
    // Common
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.ok': 'OK',
    'common.back': 'Back',
    'common.create': 'Create',
    'common.retry': 'Retry',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.success': 'Success',
    'common.logout': 'Logout',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.message': 'Message',
    'common.files': 'Files',
    'common.home': 'Home',

    // Tabs
    'tabs.sessions': 'Terminals',
    'tabs.inbox': 'Inbox',
    'tabs.settings': 'Settings',

    // Status
    'status.online': 'online',
    'status.offline': 'offline',
    'status.connected': 'connected',
    'status.connecting': 'connecting',
    'status.disconnected': 'disconnected',
    'status.unknown': 'unknown',
    'status.permissionRequired': 'permission required',
    'status.lastSeen': ({ time }: Params) => `last seen ${time}`,
    'status.activeNow': 'Active now',

    // Time
    'time.justNow': 'just now',
    'time.minutesAgo': ({ count }: Params) => `${count} minute${count !== 1 ? 's' : ''} ago`,
    'time.hoursAgo': ({ count }: Params) => `${count} hour${count !== 1 ? 's' : ''} ago`,

    // Settings
    'settings.title': 'Settings',
    'settings.account': 'Account',
    'settings.accountSubtitle': 'Manage your account details',
    'settings.appearance': 'Appearance',
    'settings.appearanceSubtitle': 'Customize how the app looks',
    'settings.features': 'Features',
    'settings.featuresSubtitle': 'Enable or disable app features',
    'settings.social': 'Social',
    'settings.machines': 'Machines',
    'settings.github': 'GitHub',
    'settings.about': 'About',
    'settings.whatsNew': "What's New",
    'settings.reportIssue': 'Report an Issue',
    'settings.usage': 'Usage',
    'settings.usageSubtitle': 'View your API usage',
    'settings.connectGithubAccount': 'Connect your GitHub account',
    'settings.githubConnected': ({ login }: Params) => `Connected as @${login}`,

    // Appearance settings
    'settingsAppearance.theme': 'Theme',
    'settingsAppearance.themeOptions.adaptive': 'Adaptive',
    'settingsAppearance.themeOptions.light': 'Light',
    'settingsAppearance.themeOptions.dark': 'Dark',
    'settingsAppearance.display': 'Display',
    'settingsAppearance.inlineToolCalls': 'Inline Tool Calls',
    'settingsAppearance.expandTodoLists': 'Expand Todo Lists',
    'settingsAppearance.showLineNumbersInDiffs': 'Show Line Numbers in Diffs',
    'settingsAppearance.wrapLinesInDiffs': 'Wrap Lines in Diffs',
    'settingsAppearance.compactSessionView': 'Compact Session View',
    'settingsAppearance.avatarStyle': 'Avatar Style',
    'settingsAppearance.avatarOptions.pixelated': 'Pixelated',
    'settingsAppearance.avatarOptions.gradient': 'Gradient',
    'settingsAppearance.avatarOptions.brutalist': 'Brutalist',

    // Features settings
    'settingsFeatures.experiments': 'Experiments',
    'settingsFeatures.enterToSend': 'Enter to Send',
    'settingsFeatures.commandPalette': 'Command Palette',
    'settingsFeatures.hideInactiveSessions': 'Hide inactive sessions',
    'settingsFeatures.hideInactiveSessionsSubtitle': 'Show only active chats in your list',

    // Friends
    'friends.title': 'Friends',
    'friends.search': 'Search',
    'friends.pending': 'Pending',
    'friends.requested': 'Requested',
    'friends.myFriends': 'My Friends',
    'friends.addFriend': 'Add Friend',
    'friends.removeFriend': 'Remove Friend',
    'friends.accept': 'Accept',
    'friends.reject': 'Reject',
    'friends.searchPlaceholder': 'Search by username',
    'friends.noFriends': 'No friends yet',
    'friends.noResults': 'No users found',

    // Inbox
    'inbox.emptyTitle': 'Empty Inbox',
    'inbox.emptyDescription': 'Connect with friends to start sharing sessions',
    'inbox.updates': 'Updates',

    // Session
    'session.info': 'Session Info',
    'session.files': 'Files',
    'session.resume': 'Resume',
    'session.archive': 'Archive',
    'session.delete': 'Delete',
    'session.deleteConfirm': 'Are you sure you want to delete this session?',
    'session.noMessages': 'No messages yet',
    'session.inputPlaceholder': 'Message...',
    'session.thinking': 'Thinking...',
    'session.host': 'Host',
    'session.path': 'Path',
    'session.created': 'Created',
    'session.updated': 'Updated',
    'session.version': 'CLI Version',
    'session.machine': 'Machine',
    'session.recentSessions': 'Recent Sessions',
    'session.today': 'Today',
    'session.yesterday': 'Yesterday',

    // Machine
    'machine.title': 'Machine',
    'machine.daemon': 'Daemon',
    'machine.daemonRunning': 'Running',
    'machine.daemonStopped': 'Stopped',
    'machine.stopDaemon': 'Stop Daemon',
    'machine.spawnSession': 'Start New Session',
    'machine.pathPlaceholder': 'Enter path...',
    'machine.recentPaths': 'Recent Paths',
    'machine.deleteConfirm': 'Are you sure you want to delete this machine?',
    'machine.online': 'Online',
    'machine.offline': 'Offline',

    // Artifacts
    'artifacts.title': 'Artifacts',
    'artifacts.new': 'New Artifact',
    'artifacts.titlePlaceholder': 'Title (optional)',
    'artifacts.bodyPlaceholder': 'Content...',
    'artifacts.save': 'Save',
    'artifacts.deleteConfirm': 'Are you sure you want to delete this artifact?',
    'artifacts.empty': 'No artifacts yet',
    'artifacts.emptyDescription': 'Create your first artifact',

    // Account
    'account.title': 'Account',
    'account.publicId': 'Public ID',
    'account.anonId': 'Anonymous ID',
    'account.secretKey': 'Secret Key',
    'account.showSecretKey': 'Show Secret Key',
    'account.hideSecretKey': 'Hide Secret Key',
    'account.copySecretKey': 'Copy Secret Key',
    'account.logoutConfirm': 'Are you sure you want to logout?',
    'account.pushTokens': 'Push Tokens',
    'account.displayName': 'Display Name',

    // Connect / Auth
    'connect.createAccount': 'Create Account',
    'connect.linkAccount': 'Link / Restore Account',
    'connect.restoreAccount': 'Restore Account',
    'connect.enterSecretKey': 'Please enter your secret key',
    'connect.invalidSecretKey': 'Invalid secret key. Please check and try again.',
    'connect.scanQrCode': 'Scan QR Code',
    'connect.waitingForScan': 'Waiting for QR scan...',

    // Errors
    'errors.networkError': 'Network error occurred',
    'errors.serverError': 'Server error occurred',
    'errors.unknownError': 'An unknown error occurred',
    'errors.sessionNotFound': 'Session not found',
    'errors.operationFailed': 'Operation failed',
};

export function t(key: string, params?: Params): string {
    const val = translations[key];
    if (val === undefined) return key;
    if (typeof val === 'function') return val(params ?? {});
    return val;
}

// Re-export for compatibility
export default t;
