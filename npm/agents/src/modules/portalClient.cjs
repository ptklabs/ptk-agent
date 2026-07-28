'use strict';

function createPortalClient({ token = process.env.PTK_PORTAL_TOKEN || null } = {}) {
  return {
    config: {
      token: token ? '[redacted]' : null
    },
    tokenPresent: Boolean(token),
    async entitlements() {
      if (!token) return { ok: false, reason: 'missing_PTK_PORTAL_TOKEN', packs: [] };
      return { ok: false, reason: 'portal_network_deferred', packs: [] };
    },
    async checkEntitlement(packId) {
      return {
        status: 'skipped',
        packId,
        reason: 'portal-network-disabled'
      };
    }
  };
}

module.exports = { createPortalClient };
