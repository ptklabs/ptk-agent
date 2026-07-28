'use strict';

const CAPABILITY_TIERS = Object.freeze({
  read: ['route.visit', 'link.discover', 'endpoint.observe', 'state.assert'],
  'safe-interaction': ['menu.open', 'modal.open', 'tab.open', 'search.submit', 'auth.login'],
  'business-mutation': ['record.create', 'record.edit', 'cart.add', 'checkout.advance', 'file.upload'],
  'terminal-destructive': ['record.delete', 'account.close', 'payment.submit'],
  'admin-destructive': ['admin.delete-user', 'admin.change-role']
});

function defaultCapabilities() {
  return [
    'mission:plan',
    'mission:execute-deterministic',
    'crawl:direct',
    'scenario:execute',
    'form:submit-safe',
    'evidence:read'
  ];
}

function tierForCapability(capability) {
  for (const [tier, capabilities] of Object.entries(CAPABILITY_TIERS)) {
    if (capabilities.includes(capability)) return tier;
  }
  return 'safe-interaction';
}

function isDestructiveTier(tier) {
  return tier === 'terminal-destructive' || tier === 'admin-destructive';
}

module.exports = {
  CAPABILITY_TIERS,
  defaultCapabilities,
  tierForCapability,
  isDestructiveTier
};
