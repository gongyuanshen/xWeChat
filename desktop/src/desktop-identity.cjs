const fs = require('node:fs');
const path = require('node:path');

function hasProfileState(directory) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (names.includes('desktop-settings.json') || names.includes('ai-notifications.json')) return true;
  return ['Local Storage', 'output'].some(name =>
    names.includes(name) && fs.readdirSync(path.join(directory, name)).length > 0
  );
}

function configureDesktopIdentity(app) {
  const appData = app.getPath('appData');
  // Historical storage identity is retained to preserve existing accounts and settings.
  const legacyProfile = path.join(appData, 'wechat-data-analysis-desktop');
  const currentProfile = path.join(appData, 'xwechat');
  let profile = legacyProfile;
  if (app.isPackaged) {
    profile = hasProfileState(currentProfile) || !hasProfileState(legacyProfile)
      ? currentProfile
      : legacyProfile;
  }
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.setName('xwechat');
}

module.exports = { configureDesktopIdentity };
