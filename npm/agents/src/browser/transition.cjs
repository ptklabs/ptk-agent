'use strict';

function listIds(items, preferredKey) {
  return new Set((items || []).map(item => item && (item[preferredKey] || item.id || item.href || item.action || item.text || item.label)).filter(Boolean));
}

function countNew(beforeItems, afterItems, preferredKey) {
  const before = listIds(beforeItems, preferredKey);
  return (afterItems || []).filter(item => item && !before.has(item[preferredKey] || item.id || item.href || item.action || item.text || item.label)).length;
}

function endpointEvents(events) {
  if (!events) return [];
  if (Array.isArray(events)) return events.filter(event => ['request', 'response'].includes(event.type) || event.url || event.path);
  if (Array.isArray(events.events)) return endpointEvents(events.events);
  return events.endpoints || events.responses || events.requests || [];
}

function comparePageModels(before, after, eventBatch = {}) {
  if (!before || !after) {
    return {
      routeChanged: false,
      routeShapeChanged: false,
      modalOpened: false,
      newLinksAppeared: false,
      newFormAppeared: false,
      newActionAppeared: false,
      newEndpointObserved: false,
      blocked: false,
      changedState: false,
      noProgress: true,
      reasons: ['missing-model']
    };
  }
  const events = Array.isArray(eventBatch) ? eventBatch : eventBatch.events || [];
  const routeChanged = before.url !== after.url;
  const routeShapeChanged = before.routeShape !== after.routeShape;
  const newLinksAppeared = countNew(before.links, after.links, 'href') > 0;
  const newFormAppeared = countNew(before.forms, after.forms, 'id') > 0;
  const newActionAppeared = countNew(before.actions, after.actions, 'id') > 0;
  const newEndpointObserved = endpointEvents(eventBatch).some(event => event.status === undefined || event.status < 400);
  const modalOpened = (after.blockers || []).length > (before.blockers || []).length || events.some(event => event.type === 'dialog' || event.type === 'popup');
  const blocked = (after.blockers || []).some(blocker => blocker.kind === 'captcha' || blocker.kind === 'authorization');
  const changedState = routeChanged || routeShapeChanged || newLinksAppeared || newFormAppeared || newActionAppeared || newEndpointObserved || modalOpened;
  const noProgress = !changedState && !blocked;
  return {
    routeChanged,
    routeShapeChanged,
    modalOpened,
    newLinksAppeared,
    newFormAppeared,
    newActionAppeared,
    newEndpointObserved,
    blocked,
    changedState,
    noProgress,
    reasons: [
      routeChanged ? 'route-changed' : null,
      routeShapeChanged ? 'route-shape-changed' : null,
      modalOpened ? 'modal-opened' : null,
      newLinksAppeared ? 'new-links' : null,
      newFormAppeared ? 'new-form' : null,
      newActionAppeared ? 'new-actions' : null,
      newEndpointObserved ? 'endpoint-observed' : null,
      blocked ? 'blocked' : null,
      noProgress ? 'no-progress' : null
    ].filter(Boolean)
  };
}

function validateTransition({ before, after, events = [], action = null } = {}) {
  const transition = comparePageModels(before, after, Array.isArray(events) ? { events } : events);
  return {
    actionId: action && action.id,
    changed: transition.changedState,
    noProgress: transition.noProgress,
    signals: transition.reasons,
    reason: transition.changedState ? 'progress' : transition.blocked ? 'blocked' : 'no_progress',
    ...transition
  };
}

module.exports = {
  listIds,
  countNew,
  endpointEvents,
  comparePageModels,
  validateTransition
};
