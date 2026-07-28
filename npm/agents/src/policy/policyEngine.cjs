'use strict';

const { tierForCapability, isDestructiveTier } = require('./capabilities.cjs');

function classifyActionRisk(action = {}) {
  const text = `${action.label || ''} ${action.text || ''} ${action.kind || ''}`.toLowerCase();
  if (/delete|remove|destroy|close account|payment|wire|transfer/.test(text)) return 'destructive';
  if (/submit|save|create|update|upload|checkout|add to cart/.test(text)) return 'business-mutation';
  return 'safe';
}

function evaluateCapability(capability, policy = {}) {
  const tier = tierForCapability(capability);
  const allowedTiers = policy.allowedTiers || ['read', 'safe-interaction'];
  const requiresFlag = requiredFlagForTier(tier);
  const allowed = allowedTiers.includes(tier) && !isDestructiveTier(tier);
  return {
    allowed,
    capability,
    tier,
    reason: allowed ? 'allowed_by_policy' : `blocked_${tier}`,
    requiresFlag: allowed ? null : requiresFlag,
    destructive: isDestructiveTier(tier),
    safeAlternative: allowed ? null : safeAlternative(capability)
  };
}

function requiredFlagForTier(tier) {
  if (tier === 'business-mutation') return 'allowBusinessMutation';
  if (tier === 'terminal-destructive') return 'allowTerminalDestructive';
  if (tier === 'admin-destructive') return 'allowAdminDestructive';
  return null;
}

function safeAlternative(capability) {
  if (/delete|payment|admin/.test(capability)) return 'state.assert';
  if (/record|cart|checkout|upload/.test(capability)) return 'route.visit';
  return null;
}

function capabilityForAction(action) {
  if (!action) return 'state.assert';
  if (action.kind === 'click-link') return 'route.visit';
  if (action.kind === 'type-search') return 'search.submit';
  if (action.kind === 'submit-form' && action.riskTier === 'business-mutation') return 'record.create';
  if (action.expectedEffect === 'surface-expansion') return 'menu.open';
  return 'modal.open';
}

function filterAllowedActions(actions = [], policy = {}) {
  return actions.filter(action => evaluateCapability(capabilityForAction(action), policy).allowed);
}

function createPolicyEngine(policy = {}) {
  return {
    evaluateMission(mission = {}, context = {}) {
      if (!context.baselineComplete) {
        return {
          allowed: false,
          capability: 'mission:plan',
          tier: 'safe-interaction',
          reason: 'baseline-not-complete',
          requiresFlag: null,
          destructive: false,
          safeAlternative: 'crawl:direct'
        };
      }
      const actions = (mission.inputs && mission.inputs.actions) || [];
      const destructive = actions.find(action => classifyActionRisk(action) === 'destructive');
      if (destructive && !policy.allowDestructive) {
        return {
          allowed: false,
          capability: 'mutation:destructive',
          tier: 'terminal-destructive',
          reason: 'destructive-action-blocked',
          requiresFlag: 'allowDestructive',
          destructive: true,
          safeAlternative: 'state.assert'
        };
      }
      return {
        allowed: true,
        capability: 'mission:plan',
        tier: 'safe-interaction',
        reason: 'allowed_by_policy',
        requiresFlag: null,
        destructive: false,
        safeAlternative: null
      };
    },
    evaluateCapability(capability) {
      return evaluateCapability(capability, policy);
    }
  };
}

module.exports = {
  classifyActionRisk,
  createPolicyEngine,
  evaluateCapability,
  capabilityForAction,
  filterAllowedActions
};
