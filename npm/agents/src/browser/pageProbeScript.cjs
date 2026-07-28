'use strict';

const { cssEscape } = require('./cssSelector.cjs');

const PROBE_VERSION = 'ptk-crawler-v2-probe-1';

function buildPageProbeScript(options = {}) {
  const config = {
    version: PROBE_VERSION,
    maxNodes: Math.max(1, Number(options.maxNodes) || 1500),
    maxControls: Math.max(1, Number(options.maxControls) || 300),
    maxRoutes: Math.max(1, Number(options.maxRoutes) || 500),
    maxTextChars: Math.max(0, Number(options.maxTextChars) || 8000),
    observeMutations: options.observeMutations !== false,
    redactValues: options.redactValues !== false
  };
  const cssEscapeFallbackSource = cssEscape.toString();
  return `(() => {
    const config = ${JSON.stringify(config)};
    if (window.__PTK_CRAWLER_V2__ && window.__PTK_CRAWLER_V2__.version === config.version) return;
    const state = {
      version: config.version,
      installedAt: Date.now(),
      events: [],
      routes: new Map(),
      controls: new Map(),
      generation: 0,
      mutationSummary: { addedNodes: 0, removedNodes: 0, textChanges: 0 },
      config
    };
    const compact = (value, max = 180) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const textOf = element => compact(element && (element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('value') || element.getAttribute('name')));
    const controlLabelOf = element => compact(element && (element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || element.getAttribute('value') || element.getAttribute('name')));
    const lower = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && (element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const cssEscapeFallback = ${cssEscapeFallbackSource};
    const cssEscape = value => window.CSS && typeof window.CSS.escape === 'function'
      ? window.CSS.escape(String(value))
      : cssEscapeFallback(value);
    const structuralSelectorFor = element => {
      if (!element || !element.tagName) return null;
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 5) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        const siblings = parent ? Array.from(parent.children).filter(child => child.tagName === current.tagName) : [];
        const nth = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : '';
        parts.unshift(tag + nth);
        current = parent;
      }
      return parts.join(' > ') || element.tagName.toLowerCase();
    };
    const selectorFor = element => {
      if (!element) return null;
      if (element.id) return '#' + cssEscape(element.id);
      const testId = element.getAttribute('data-testid') || element.getAttribute('data-test');
      if (testId) return '[data-testid="' + cssEscape(testId) + '"]';
      const name = element.getAttribute('name');
      if (name) return element.tagName.toLowerCase() + '[name="' + cssEscape(name) + '"]';
      const routerLink = element.getAttribute('routerlink') || element.getAttribute('ng-reflect-router-link');
      if (routerLink) return element.tagName.toLowerCase() + '[' + (element.getAttribute('routerlink') ? 'routerlink' : 'ng-reflect-router-link') + '="' + cssEscape(routerLink) + '"]';
      return structuralSelectorFor(element);
    };
    const routeLike = value => /^(?:#\\/|#!\\/|\\/(?!\\/)|\\.\\/|\\.\\.\\/|https?:\\/\\/)/.test(String(value || '').trim());
    const routeTargetFor = element => {
      if (!element || !element.getAttribute) return null;
      return element.getAttribute('href') || element.getAttribute('routerlink') || element.getAttribute('ng-reflect-router-link') || element.getAttribute('data-route') || element.getAttribute('data-href') || element.getAttribute('data-url') || null;
    };
    const isSpaHashLocation = () => String(location.hash || '').startsWith('#/') || String(location.hash || '').startsWith('#!/');
    const resolveRoute = (value, source) => {
      const raw = String(value || '').trim();
      if (!routeLike(raw)) return null;
      try {
        if ((source === 'routerlink' || source === 'ng-reflect-router-link' || source === 'data-route') && raw.startsWith('/') && isSpaHashLocation()) {
          const url = new URL(location.href);
          url.hash = raw;
          return url.href;
        }
        return new URL(raw, location.href).href;
      } catch (_) { return null; }
    };
    const pushEvent = event => {
      state.events.push({ ts: Date.now(), ...event });
      if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
    };
    const addRoute = (href, source, element) => {
      const resolved = resolveRoute(href, source);
      if (!resolved || state.routes.size >= config.maxRoutes) return null;
      const id = source + ':' + resolved;
      if (!state.routes.has(id)) {
        state.routes.set(id, {
          id,
          href: resolved,
          source,
          text: textOf(element),
          selector: selectorFor(element)
        });
      }
      return state.routes.get(id);
    };
    const controlKeyFor = record => String(record.id || 'control') + ':' + String(record.selector || '');
    const currentElementForRecord = record => {
      if (!record || !record.selector) return null;
      try { return document.querySelector(record.selector); } catch (_) { return null; }
    };
    const currentVisibleControl = record => {
      const element = currentElementForRecord(record);
      return Boolean(element && visible(element));
    };
    const pruneStaleControls = (options = {}) => {
      const requireCurrentGeneration = options.requireCurrentGeneration === true;
      for (const [key, record] of Array.from(state.controls.entries())) {
        if (!currentVisibleControl(record) || (requireCurrentGeneration && record.generation !== state.generation)) {
          state.controls.delete(key);
        }
      }
    };
    const addControl = (element, source = 'dom') => {
      if (!element || !visible(element)) return null;
      pruneStaleControls();
      const label = controlLabelOf(element);
      const id = element.id || element.getAttribute('data-testid') || selectorFor(element) || label;
      const semantic = semanticForControl(element, label);
      const routeTarget = routeTargetFor(element);
      const selector = selectorFor(element);
      const record = {
        id: String(id || 'control'),
        source,
        tagName: element.tagName,
        role: element.getAttribute('role'),
        type: element.getAttribute('type') || '',
        label,
        ariaLabel: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
        href: element.href || element.getAttribute('href'),
        routeTarget,
        selector,
        hasPopup: element.getAttribute('aria-haspopup'),
        expands: element.getAttribute('aria-expanded') !== null,
        ariaExpanded: element.getAttribute('aria-expanded'),
        opensDialog: element.getAttribute('data-bs-toggle') === 'modal' || element.getAttribute('data-toggle') === 'modal',
        formId: element.form ? element.form.id || element.form.getAttribute('name') : null,
        semanticKind: semantic.kind,
        semanticScore: semantic.score,
        semanticSignals: semantic.signals,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        generation: state.generation
      };
      const key = controlKeyFor(record);
      const previous = state.controls.get(key);
      if (!previous && state.controls.size >= config.maxControls) {
        pruneStaleControls();
        if (state.controls.size >= config.maxControls) return null;
      }
      if (previous) record.firstSeen = previous.firstSeen || record.firstSeen;
      state.controls.set(key, record);
      return record;
    };
    const routeLinkCount = root => {
      if (!root || !root.querySelectorAll) return 0;
      return Array.from(root.querySelectorAll('a[href],[routerlink],[ng-reflect-router-link],[data-route],[data-href],[data-url]')).filter(element => {
        const href = element.getAttribute('href') || element.getAttribute('routerlink') || element.getAttribute('ng-reflect-router-link') || element.getAttribute('data-route') || element.getAttribute('data-href') || element.getAttribute('data-url');
        return routeLike(href);
      }).length;
    };
    const hasRouteLinks = root => routeLinkCount(root) > 0;
    const viewportArea = () => Math.max(1, window.innerWidth * window.innerHeight);
    const isSurfaceLike = element => {
      if (!element || element === document.body || element === document.documentElement || !element.querySelectorAll) return false;
      const tag = lower(element.tagName);
      const role = lower(element.getAttribute('role'));
      const routes = routeLinkCount(element);
      if (['nav', 'aside'].includes(tag) || role === 'navigation' || role === 'menu') return routes > 0;
      if (routes < 2) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const customElement = tag.includes('-');
      const boundedSurface = area > 0 && area < viewportArea() * 0.85;
      const positionedSurface = ['fixed', 'absolute', 'sticky'].includes(style.position);
      const controlledSurface = element.getAttribute('aria-hidden') !== null || element.getAttribute('tabindex') !== null;
      return customElement || boundedSurface || positionedSurface || controlledSurface;
    };
    const navigationSurfaceCandidates = () => Array.from(document.querySelectorAll('*'))
      .slice(0, config.maxNodes)
      .filter(isSurfaceLike)
      .sort((left, right) => routeLinkCount(right) - routeLinkCount(left))
      .slice(0, 25);
    const closestNavigationSurface = element => {
      let current = element && element.parentElement;
      while (current && current !== document.body && current !== document.documentElement) {
        if (isSurfaceLike(current)) return current;
        current = current.parentElement;
      }
      return null;
    };
    const hasNavigationSurface = () => navigationSurfaceCandidates().length > 0;
    const closestMatch = (element, selector) => {
      try { return element && element.closest ? element.closest(selector) : null; } catch (_) { return null; }
    };
    const semanticForControl = (element, label) => {
      const tag = lower(element && element.tagName);
      const role = lower(element && element.getAttribute('role'));
      const type = lower(element && element.getAttribute('type'));
      const popup = lower(element && element.getAttribute('aria-haspopup'));
      const expanded = element && element.getAttribute('aria-expanded') !== null;
      const href = element && (element.href || element.getAttribute('href'));
      const routeTarget = routeTargetFor(element);
      const signals = [];
      if (['input', 'textarea', 'select', 'option', 'mat-select'].includes(tag) || role === 'combobox' || role === 'listbox' || popup === 'listbox' || ['text', 'email', 'password', 'search', 'number', 'tel', 'url', 'hidden'].includes(type)) {
        return { kind: 'form-widget', score: -100, signals: ['form-widget'] };
      }
      if (routeTarget && routeLike(routeTarget)) return { kind: 'route-control', score: 50, signals: ['route-target'] };
      const rect = element && element.getBoundingClientRect ? element.getBoundingClientRect() : { top: 9999, height: 0 };
      const inHeader = Boolean(closestMatch(element, 'header,[role="banner"]')) || (rect.top >= 0 && rect.top < Math.max(96, window.innerHeight * 0.18));
      const inNavigation = Boolean(closestNavigationSurface(element));
      const innerIconText = lower(element && (element.innerText || element.textContent));
      const hasIconChild = Boolean(element && element.querySelector && element.querySelector('svg,mat-icon,[class*="icon" i]'));
      const iconLike = tag === 'button' && !href && !routeTarget && !popup && !expanded && (hasIconChild || (innerIconText.length > 0 && innerIconText.length <= 4 && !/\\s/.test(innerIconText)));
      const controlledSurface = element && element.getAttribute('aria-controls') ? document.getElementById(element.getAttribute('aria-controls')) : null;
      if (inHeader) signals.push('header');
      if (inNavigation) signals.push('inside-navigation');
      const routeSurfacePresent = hasNavigationSurface();
      if (routeSurfacePresent) signals.push('route-surface-present');
      if (controlledSurface && hasRouteLinks(controlledSurface)) signals.push('controls-route-surface');
      if (hasRouteLinks(closestNavigationSurface(element))) signals.push('near-route-links');
      if (tag === 'button' && !href && !popup && !expanded && (controlledSurface && hasRouteLinks(controlledSurface) || iconLike && inHeader && routeSurfacePresent)) {
        return { kind: 'navigation-toggle', score: 100, signals };
      }
      if (role === 'tab') return { kind: 'tab-toggle', score: 80, signals };
      if (tag === 'summary') return { kind: 'accordion-toggle', score: 75, signals };
      if (popup === 'dialog' || element && (element.getAttribute('data-bs-toggle') === 'modal' || element.getAttribute('data-toggle') === 'modal')) return { kind: 'modal-toggle', score: 75, signals };
      if (popup === 'menu' || expanded) return { kind: 'menu-toggle', score: 65, signals };
      return { kind: 'generic-control', score: 0, signals };
    };
    const scan = () => {
      state.generation += 1;
      pruneStaleControls();
      const all = Array.from(document.querySelectorAll('*')).slice(0, config.maxNodes);
      for (const element of all) {
        if (element.matches && element.matches('a[href]')) addRoute(element.getAttribute('href'), 'a[href]', element);
        for (const attr of ['routerlink', 'ng-reflect-router-link', 'data-route', 'data-href', 'data-url']) {
          const value = element.getAttribute && element.getAttribute(attr);
          if (value) addRoute(value, attr, element);
        }
        if (element.matches && element.matches('form[action]')) addRoute(element.getAttribute('action'), 'form[action]', element);
        if (element.matches && element.matches('button,[role="button"],[role="tab"],input[type="button"],input[type="submit"],input[type="search"],summary,[aria-expanded],[aria-haspopup]')) {
          addControl(element, 'control');
          for (const attr of ['data-route', 'data-href', 'data-url']) {
            const value = element.getAttribute(attr);
            if (value) addRoute(value, attr, element);
          }
        }
      }
      if (location.hash && /^#!?\\//.test(location.hash)) addRoute(location.hash, 'location.hash', document.body);
      pruneStaleControls({ requireCurrentGeneration: true });
    };
    const surfaceState = () => {
      const surfaces = [];
      for (const element of Array.from(new Set([
        ...Array.from(document.querySelectorAll('[role="dialog"],dialog,.modal,[aria-modal="true"],[aria-expanded="true"],[role="menu"],nav')).slice(0, 50),
        ...navigationSurfaceCandidates().slice(0, 50)
      ])).slice(0, 50)) {
        if (!visible(element)) continue;
        surfaces.push({
          id: element.id || selectorFor(element),
          kind: element.getAttribute('role') || element.tagName.toLowerCase(),
          label: compact(element.getAttribute('aria-label') || element.innerText || element.textContent, 160),
          selector: selectorFor(element)
        });
      }
      return surfaces;
    };
    const makeStateKey = () => {
      const open = surfaceState().map(item => item.id || item.kind).sort().join('|');
      return [location.origin, location.pathname, /^#!?\\//.test(location.hash) ? location.hash : '', location.search.replace(/=[^&]+/g, '=*'), open].join(' ');
    };
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function pushStateWrapper(...args) {
      const result = originalPushState.apply(this, args);
      pushEvent({ type: 'history.pushState', url: location.href });
      scan();
      return result;
    };
    history.replaceState = function replaceStateWrapper(...args) {
      const result = originalReplaceState.apply(this, args);
      pushEvent({ type: 'history.replaceState', url: location.href });
      scan();
      return result;
    };
    window.addEventListener('hashchange', () => { pushEvent({ type: 'hashchange', url: location.href }); scan(); }, true);
    window.addEventListener('popstate', () => { pushEvent({ type: 'popstate', url: location.href }); scan(); }, true);
    if (config.observeMutations && window.MutationObserver) {
      state.observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          state.mutationSummary.addedNodes += mutation.addedNodes ? mutation.addedNodes.length : 0;
          state.mutationSummary.removedNodes += mutation.removedNodes ? mutation.removedNodes.length : 0;
          if (mutation.type === 'characterData') state.mutationSummary.textChanges += 1;
        }
        pushEvent({ type: 'mutation', summary: { ...state.mutationSummary } });
        scan();
      });
      state.observer.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
    }
    const api = {
      version: config.version,
      snapshot() {
        scan();
        const controls = Array.from(state.controls.values()).filter(currentVisibleControl).slice(0, config.maxControls);
        const routes = Array.from(state.routes.values()).slice(0, config.maxRoutes);
        const surfaces = surfaceState();
        return {
          version: config.version,
          url: location.href,
          title: document.title || '',
          routeCandidates: routes,
          newlyDiscoveredControls: controls,
          interactionGraph: { controls, routes },
          surfaces,
          surfaceState: surfaces,
          stateKey: makeStateKey(),
          mutationSummary: { ...state.mutationSummary },
          events: state.events.slice(-200),
          visibleTextSummary: compact(document.body && document.body.innerText || '', config.maxTextChars)
        };
      },
      drainEvents() {
        const drained = state.events.slice();
        state.events = [];
        return drained;
      },
      getRouteCandidates() { return this.snapshot().routeCandidates; },
      getInteractionGraph() { return this.snapshot().interactionGraph; },
      getSurfaceState() { return this.snapshot().surfaceState; }
    };
    Object.defineProperty(window, '__PTK_CRAWLER_V2__', {
      value: api,
      configurable: true,
      enumerable: false,
      writable: true
    });
    scan();
    pushEvent({ type: 'probe.installed', url: location.href });
  })();`;
}

module.exports = {
  PROBE_VERSION,
  buildPageProbeScript
};
