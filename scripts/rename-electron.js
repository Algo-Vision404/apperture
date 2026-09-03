#!/usr/bin/env node
// Windows dev convenience only — keep Electron's real name. apperture builds must not
// impersonate Microsoft software; that triggers SmartScreen "harmful app" warnings.
if (process.platform !== 'win32') process.exit(0);
