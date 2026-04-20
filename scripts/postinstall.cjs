const { execSync } = require('child_process');

// Apply patches to node_modules
require('../patches/fix-livekit-room-reuse.cjs');
