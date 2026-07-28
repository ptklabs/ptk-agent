'use strict';

async function downloadModulePack({ packName }) {
  return {
    ok: false,
    packName,
    reason: 'network_download_deferred',
    requiresToken: true
  };
}

function createModuleDownloader({ portalClient } = {}) {
  return {
    async installPack(packId) {
      return {
        status: 'skipped',
        packId,
        reason: 'network-downloads-disabled'
      };
    }
  };
}

module.exports = {
  createModuleDownloader,
  downloadModulePack
};
