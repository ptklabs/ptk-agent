'use strict';

const { compactText, normalizeActions, stableHash } = require('./actionModel.cjs');
const { locatorPlanFromControl, locatorPlanFromField } = require('./locatorResolver.cjs');

function isSpaHashRoute(hash) {
  const value = String(hash || '');
  if (!value) return false;
  return value === '#/' || value.startsWith('#/') || value.startsWith('#!/');
}

function normalizeUrl(rawUrl, baseUrl, options = {}) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl, baseUrl || undefined);
    const preserveSpaHashRoutes = options.preserveSpaHashRoutes !== false;
    if (!preserveSpaHashRoutes || !isSpaHashRoute(parsed.hash)) {
      parsed.hash = '';
    } else if (options.spaHashBaseUrl) {
      const spaBase = new URL(options.spaHashBaseUrl);
      parsed.pathname = spaBase.pathname || '/';
      parsed.search = spaBase.search || '';
    }
    return parsed.href;
  } catch (_) {
    return null;
  }
}

function normalizePathShape(pathname) {
  const parts = String(pathname || '/')
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .map(part => {
      if (/^\d+$/.test(part)) return ':id';
      if (/^[0-9a-f]{8,}$/i.test(part)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ':id';
      return part;
    });
  return `/${parts.join('/')}` || '/';
}

function normalizeHashRouteShape(hash) {
  if (!isSpaHashRoute(hash)) return '';
  let route = String(hash).slice(1);
  if (route.startsWith('!')) route = route.slice(1);
  if (!route.startsWith('/')) route = `/${route}`;
  return `#${normalizePathShape(route)}`;
}

function normalizeRouteShape(rawUrl, options = {}) {
  const normalized = normalizeUrl(rawUrl, undefined, options);
  if (!normalized) return '/';
  const parsed = new URL(normalized);
  return `${normalizePathShape(parsed.pathname)}${normalizeHashRouteShape(parsed.hash)}`;
}

function routeShape(url, options = {}) {
  const normalized = normalizeUrl(url, undefined, options);
  if (!normalized) return String(url || '');
  const parsed = new URL(normalized);
  return `${parsed.origin}${normalizeRouteShape(normalized, options)}`;
}

function summarizeVisibleText(text, maxChars = 500) {
  return compactText(text, maxChars);
}

function normalizeLinks(links, baseUrl, options = {}) {
  const seen = new Set();
  const normalized = [];
  for (const link of links || []) {
    const href = normalizeUrl(link.href || link.url, baseUrl, options);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    normalized.push({
      id: link.id || `link:${stableHash(href)}`,
      href,
      text: compactText(link.text || link.label || link.title || href, 140),
      label: compactText(link.label || link.text || link.title || href, 140),
      selector: link.selector || null,
      sameOrigin: baseUrl ? new URL(href).origin === new URL(baseUrl).origin : undefined
    });
  }
  return normalized;
}

function normalizeControlHref(control = {}, baseUrl, options = {}) {
  if (control.href) return control.href;
  const routeTarget = control.routeTarget || control.dataRoute;
  if (!routeTarget) return null;
  const raw = String(routeTarget).trim();
  if (!raw) return null;
  try {
    const base = new URL(baseUrl || options.spaHashBaseUrl || undefined);
    if ((raw.startsWith('#/') || raw.startsWith('#!/'))) {
      base.hash = raw;
      return base.href;
    }
    if (raw.startsWith('/') && isSpaHashRoute(base.hash)) {
      base.hash = raw;
      return base.href;
    }
  } catch (_) {
    // Fall back to normal URL handling below.
  }
  return raw;
}

function inferFormKind(fields = [], form = {}) {
  const text = [
    form.id,
    form.name,
    form.action,
    form.kind,
    ...(fields || []).map(field => `${field.name || ''} ${field.id || ''} ${field.type || ''} ${field.label || ''} ${field.placeholder || ''}`)
  ].join(' ').toLowerCase();
  if (/pass/.test(text)) return 'login';
  if (/\b(search|query|q)\b/.test(text)) return 'search';
  if (/\b(upload|attachment|file)\b/.test(text)) return 'file-upload';
  if (/\btransfer|fromaccount|toaccount|from account|to account|amount\b/.test(text)) return 'transfer';
  if (/\b(feedback|contact|support|message|comment|complain|complaint)\b/.test(text)) {
    return /\b(contact|support)\b/.test(text) ? 'contact' : 'feedback';
  }
  if (/\b(delete|remove|destroy|close account|revoke|disable|deactivate|cancel account)\b/.test(text)) return 'destructive';
  return 'generic';
}

function normalizeForms(forms, baseUrl, options = {}) {
  return (forms || []).map((form, index) => {
    const fields = (form.fields || []).map((field, fieldIndex) => ({
      id: field.id || field.name || `field:${fieldIndex}`,
      name: field.name || null,
      type: String(field.type || 'text').toLowerCase(),
      required: Boolean(field.required),
      label: compactText(field.label || field.placeholder || field.name || '', 120),
      placeholder: field.placeholder || null,
      selector: field.selector || null,
      autocomplete: field.autocomplete || null
    })).map(field => ({
      ...field,
      locatorPlan: locatorPlanFromField(field, { critical: true, strict: true })
    }));
    return {
      id: form.id || form.name || `form:${index}`,
      selector: form.selector || null,
      action: normalizeUrl(form.action || baseUrl, baseUrl, options),
      method: String(form.method || 'get').toUpperCase(),
      kind: form.kind || inferFormKind(fields, form),
      fieldCount: fields.length,
      fields,
      submitSelector: form.submitSelector || null,
      submitLocatorPlan: locatorPlanFromControl({
        selector: form.submitSelector || null,
        label: form.submitLabel || 'Submit',
        role: 'button'
      }, { critical: true, strict: true }),
      synthetic: Boolean(form.synthetic),
      virtual: Boolean(form.virtual || form.synthetic)
    };
  });
}

function deriveAuthSignals(snapshot, forms, links) {
  const text = String(snapshot.visibleText || snapshot.text || snapshot.visibleTextSummary || '').toLowerCase();
  const hasPasswordField = forms.some(form => form.fields.some(field => field.type === 'password'));
  const hasLogoutLink = links.some(link => /\b(log out|logout|sign out|signout)\b/i.test(link.text || link.label));
  const signals = [];
  if (hasPasswordField) signals.push('password-field');
  if (hasPasswordField && /\b(log in|login|sign in|signin)\b/.test(text)) signals.push('login-form');
  if (hasLogoutLink || /\b(my account|profile|dashboard)\b/.test(text)) signals.push('authenticated-text');
  return signals;
}

function deriveBlockers(snapshot) {
  const text = String(snapshot.visibleText || snapshot.text || snapshot.visibleTextSummary || '').toLowerCase();
  const blockers = Array.isArray(snapshot.blockers) ? snapshot.blockers.slice() : [];
  if (/\bcaptcha\b/.test(text)) blockers.push({ kind: 'captcha', evidence: 'visible-text' });
  if (/\bcookie\b.*\b(accept|consent)\b/.test(text)) blockers.push({ kind: 'cookie-consent', evidence: 'visible-text' });
  if (/\baccess denied|forbidden|not authorized\b/.test(text)) blockers.push({ kind: 'authorization', evidence: 'visible-text' });
  return blockers;
}

function inferSurfaceType(model) {
  const text = `${model.title || ''} ${model.visibleTextSummary || ''}`.toLowerCase();
  if ((model.forms || []).some(form => form.kind === 'login') || /\blogin|sign in\b/.test(text)) return 'login';
  if (model.blockers && model.blockers.some(blocker => blocker.kind === 'dialog')) return 'modal-capable';
  if (/\bcart|basket|checkout\b/.test(text)) return 'checkout';
  if (/\bsearch\b/.test(text) || (model.forms || []).some(form => form.kind === 'search')) return 'search';
  if ((model.forms || []).length) return 'form';
  if ((model.links || []).length > 8) return 'navigation';
  return 'content';
}

function normalizePageModel(raw, options = {}) {
  const baseUrl = options.baseUrl || raw.url;
  const probeSnapshot = raw.probeSnapshot || null;
  const routeCandidatesSource = probeSnapshot && Array.isArray(probeSnapshot.routeCandidates)
    ? probeSnapshot.routeCandidates
    : Array.isArray(raw.routeCandidates)
      ? raw.routeCandidates
      : [];
  const probeRoutes = routeCandidatesSource.length
    ? routeCandidatesSource.map(candidate => ({
      href: candidate.href,
      text: candidate.text || candidate.label || candidate.href,
      label: candidate.label || candidate.text || candidate.href,
      selector: candidate.selector || null,
      source: candidate.source || 'browser-probe'
    }))
    : [];
  const links = normalizeLinks([...(raw.links || []), ...probeRoutes], baseUrl, options);
  const forms = normalizeForms(raw.forms || [], baseUrl, options);
  const controlsSource = probeSnapshot && Array.isArray(probeSnapshot.newlyDiscoveredControls)
    ? probeSnapshot.newlyDiscoveredControls
    : Array.isArray(raw.newlyDiscoveredControls)
      ? raw.newlyDiscoveredControls
      : [];
  const probeControls = controlsSource.length
    ? controlsSource.map(control => ({
      ...control,
      source: control.source || 'browser-probe'
    }))
    : [];
  const probeActionControls = probeControls.filter(isProbeControlActionCandidate).map(control => ({
    ...control,
    href: normalizeControlHref(control, baseUrl, options),
    riskTier: control.riskTier || 'safe-interaction',
    expectedEffect: expectedEffectForProbeControl(control)
  }));
  const provisional = {
    url: normalizeUrl(raw.url, baseUrl, options) || raw.url || '',
    routeShape: raw.routeShape || routeShape(raw.url || '', options),
    title: compactText(raw.title || '', 180),
    links,
    forms,
    actions: [...(raw.actions || []), ...probeActionControls],
    visibleTextSummary: summarizeVisibleText(raw.visibleTextSummary || raw.visibleText || raw.text || '', options.maxVisibleTextChars || 1200),
    authSignals: raw.authSignals || deriveAuthSignals(raw, forms, links),
    blockers: deriveBlockers(raw),
    routeCandidates: routeCandidatesSource.length ? routeCandidatesSource : probeRoutes,
    newlyDiscoveredControls: probeControls,
    interactionGraph: probeSnapshot && probeSnapshot.interactionGraph || raw.interactionGraph || null,
    surfaces: probeSnapshot && probeSnapshot.surfaces || raw.surfaces || [],
    stateKey: probeSnapshot && probeSnapshot.stateKey || raw.stateKey || null,
    probe: probeSnapshot ? {
      version: probeSnapshot.version || null,
      events: probeSnapshot.events || [],
      mutationSummary: probeSnapshot.mutationSummary || null
    } : null
  };
  provisional.actions = normalizeActions({ links: [], actions: [...(raw.actions || []), ...probeActionControls], forms: [] }, options).map(action => ({
    ...action,
    locatorPlan: locatorPlanFromControl(action, { critical: false })
  }));
  provisional.surfaceType = raw.surfaceType || inferSurfaceType(provisional);
  provisional.id = `page:${stableHash([provisional.url, provisional.title, provisional.visibleTextSummary.slice(0, 80)])}`;
  provisional.metadata = {
    linkCount: links.length,
    formCount: forms.length,
    actionCount: provisional.actions.length,
    routeCandidateCount: provisional.routeCandidates.length,
    probe: Boolean(probeSnapshot),
    capturedAt: raw.capturedAt || new Date().toISOString()
  };
  return provisional;
}

function isProbeControlActionCandidate(control = {}) {
  if (!control || !control.selector) return false;
  const semanticKind = String(control.semanticKind || '').toLowerCase();
  if (semanticKind === 'form-widget') return false;
  const tag = String(control.tagName || control.tag || '').toLowerCase();
  const role = String(control.role || '').toLowerCase();
  const type = String(control.type || '').toLowerCase();
  const hasPopup = String(control.hasPopup || control.ariaHasPopup || '').toLowerCase();
  if (['input', 'textarea', 'select', 'option', 'mat-select'].includes(tag)) return false;
  if (['text', 'email', 'password', 'search', 'number', 'tel', 'url', 'hidden'].includes(type)) return false;
  if (role === 'combobox' || role === 'listbox' || hasPopup === 'listbox') return false;
  if (['route-control', 'navigation-toggle', 'menu-toggle', 'tab-toggle', 'accordion-toggle', 'modal-toggle'].includes(semanticKind)) return true;
  if (role === 'menuitem' || role === 'tab' || role === 'link') return true;
  if (control.href || control.routeTarget || control.expands || control.ariaExpanded !== undefined && control.ariaExpanded !== null || hasPopup === 'menu' || hasPopup === 'dialog') return true;
  return false;
}

function expectedEffectForProbeControl(control = {}) {
  const semanticKind = String(control.semanticKind || '').toLowerCase();
  if (control.href || control.routeTarget || semanticKind === 'route-control') return 'route-change';
  if (semanticKind === 'navigation-toggle' || semanticKind === 'menu-toggle' || String(control.hasPopup || '').toLowerCase() === 'menu' || control.expands) return 'surface-expansion';
  if (semanticKind === 'tab-toggle' || String(control.role || '').toLowerCase() === 'tab') return 'surface-change';
  if (semanticKind === 'accordion-toggle') return 'toggle-surface';
  if (semanticKind === 'modal-toggle' || String(control.hasPopup || '').toLowerCase() === 'dialog') return 'modal-open';
  return 'route-change';
}

async function extractPageSnapshot(page, options = {}) {
  const probeSnapshot = options.browserProbe && options.browserProbe.enabled === false
    ? null
    : await maybeGetProbeSnapshot(page, options);
  if (page && typeof page.snapshot === 'function') {
    const snapshot = await page.snapshot();
    return probeSnapshot ? { ...snapshot, probeSnapshot } : snapshot;
  }
  if (page && page.__snapshot) return probeSnapshot ? { ...page.__snapshot, probeSnapshot } : page.__snapshot;
  if (!page || typeof page.evaluate !== 'function') return { url: '', title: '', links: [], forms: [], actions: [] };
  const snapshot = await page.evaluate(() => {
    const cssEscape = value => {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
      const input = String(value ?? '');
      const length = input.length;
      const firstCodeUnit = length ? input.charCodeAt(0) : NaN;
      let result = '';
      for (let index = 0; index < length; index += 1) {
        const codeUnit = input.charCodeAt(index);
        if (codeUnit === 0x0000) {
          result += '\uFFFD';
        } else if (
          (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
          codeUnit === 0x007f ||
          (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
          (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
        ) {
          result += `\\${codeUnit.toString(16)} `;
        } else if (index === 0 && codeUnit === 0x002d && length === 1) {
          result += '\\-';
        } else if (
          codeUnit >= 0x0080 ||
          codeUnit === 0x002d ||
          codeUnit === 0x005f ||
          (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
          (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
          (codeUnit >= 0x0061 && codeUnit <= 0x007a)
        ) {
          result += input.charAt(index);
        } else {
          result += `\\${input.charAt(index)}`;
        }
      }
      return result;
    };
    const attrSelector = (tag, attr, value) => `${tag}[${attr}="${cssEscape(value)}"]`;
    const textOf = element => (element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const controlLabelOf = element => (element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent || element.getAttribute('value') || element.getAttribute('name') || '').replace(/\s+/g, ' ').trim();
    const visible = element => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && (element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const structuralSelectorFor = element => {
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 5) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        const siblings = parent ? Array.from(parent.children).filter(child => child.tagName === current.tagName) : [];
        const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
        parts.unshift(`${tag}${nth}`);
        current = parent;
      }
      return parts.join(' > ') || element.tagName.toLowerCase();
    };
    const selectorFor = element => {
      if (element.id) return `#${cssEscape(element.id)}`;
      const testId = element.getAttribute('data-testid') || element.getAttribute('data-test');
      if (testId) return `[data-testid="${cssEscape(testId)}"]`;
      const name = element.getAttribute('name');
      if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      const routerLink = element.getAttribute('routerlink') || element.getAttribute('ng-reflect-router-link');
      if (routerLink) return attrSelector(element.tagName.toLowerCase(), element.getAttribute('routerlink') ? 'routerlink' : 'ng-reflect-router-link', routerLink);
      return structuralSelectorFor(element);
    };
    const fieldFor = field => ({
      id: field.id || field.getAttribute('name'),
      name: field.getAttribute('name'),
      type: field.getAttribute('type') || field.tagName.toLowerCase(),
      required: Boolean(field.required),
      label: field.labels && field.labels[0] ? textOf(field.labels[0]) : '',
      placeholder: field.getAttribute('placeholder'),
      selector: selectorFor(field),
      autocomplete: field.getAttribute('autocomplete')
    });
    const submitSelectorFor = root => {
      const candidates = Array.from((root || document).querySelectorAll('button,input[type="submit"],[role="button"]')).filter(visible);
      const preferred = candidates.find(button => /log\s*in|login|sign\s*in|signin|search|submit|send|continue/i.test(textOf(button) || button.getAttribute('value') || button.id || button.name || ''))
        || candidates.find(button => String(button.getAttribute('type') || '').toLowerCase() === 'submit')
        || candidates[0];
      return preferred ? selectorFor(preferred) : null;
    };
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 250).map((a, index) => ({
      id: `link:${index}`,
      href: a.href,
      text: textOf(a).slice(0, 140),
      selector: selectorFor(a)
    }));
    const routeAttrs = ['routerlink', 'ng-reflect-router-link', 'data-route', 'data-href', 'data-url'];
    const routeSelectors = routeAttrs.map(attr => `[${attr}]`).join(',');
    const routeLike = value => /^(?:#\/|#!\/|\/(?!\/)|\.\/|\.\.\/)/.test(String(value || '').trim());
    const isSpaHashLocation = () => /^#!?\//.test(location.hash || '');
    const resolveRouteAttr = (raw, attr) => {
      if ((attr === 'routerlink' || attr === 'ng-reflect-router-link' || attr === 'data-route') && String(raw || '').trim().startsWith('/') && isSpaHashLocation()) {
        const url = new URL(location.href);
        url.hash = String(raw || '').trim();
        return url.href;
      }
      return new URL(raw, location.href).href;
    };
    for (const element of Array.from(document.querySelectorAll(routeSelectors)).slice(0, 250)) {
      const attr = routeAttrs.find(candidateAttr => routeLike(element.getAttribute(candidateAttr)));
      if (!attr) continue;
      const raw = element.getAttribute(attr);
      links.push({
        id: `route-attr:${links.length}`,
        href: resolveRouteAttr(raw, attr),
        text: textOf(element).slice(0, 140),
        selector: selectorFor(element)
      });
    }
    const forms = Array.from(document.querySelectorAll('form')).slice(0, 50).map((form, index) => ({
      id: form.id || form.getAttribute('name') || `form:${index}`,
      selector: selectorFor(form),
      action: form.action || location.href,
      method: form.getAttribute('method') || 'get',
      fields: Array.from(form.querySelectorAll('input,textarea,select')).slice(0, 80).map(fieldFor),
      submitSelector: submitSelectorFor(form)
    }));
    const standaloneFields = Array.from(document.querySelectorAll('input,textarea,select'))
      .filter(field => !field.closest('form') && visible(field) && !/hidden|submit|button|file/i.test(field.type || ''))
      .slice(0, 80);
    const fieldText = standaloneFields.map(field => `${field.id || ''} ${field.name || ''} ${field.type || ''} ${field.getAttribute('aria-label') || ''} ${field.labels && field.labels[0] ? textOf(field.labels[0]) : ''}`).join(' ').toLowerCase();
    if (standaloneFields.length) {
      let syntheticKind = null;
      if (/password/.test(fieldText)) syntheticKind = 'login';
      else if (/\b(search|query|q)\b/.test(fieldText)) syntheticKind = 'search';
      else if (/\btransfer|fromaccount|toaccount|from account|to account|amount\b/.test(fieldText)) syntheticKind = 'transfer';
      else if (/\b(feedback|contact|support|message|comment|complain|complaint)\b/.test(fieldText)) syntheticKind = /contact|support/.test(fieldText) ? 'contact' : 'feedback';
      if (syntheticKind) {
        forms.push({
          id: `synthetic-${syntheticKind}`,
          selector: null,
          action: location.href,
          method: syntheticKind === 'search' ? 'get' : 'post',
          kind: syntheticKind,
          synthetic: true,
          virtual: true,
          submitSelector: submitSelectorFor(document),
          fields: standaloneFields.map(fieldFor)
        });
      }
    }
    const controls = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],input[type="button"],input[type="submit"],input[type="search"],summary,[aria-expanded],[aria-haspopup]')).slice(0, 250).map((el, index) => ({
      id: el.id || el.getAttribute('data-testid') || `action:${index}`,
      tagName: el.tagName,
      role: el.getAttribute('role'),
      type: el.getAttribute('type') || '',
      ariaLabel: el.getAttribute('aria-label') || null,
      title: el.getAttribute('title') || null,
      label: controlLabelOf(el),
      href: el.href || el.getAttribute('href') || null,
      selector: selectorFor(el),
      hasPopup: el.getAttribute('aria-haspopup'),
      expands: el.getAttribute('aria-expanded') !== null,
      ariaExpanded: el.getAttribute('aria-expanded'),
      opensDialog: el.getAttribute('data-bs-toggle') === 'modal' || el.getAttribute('data-toggle') === 'modal',
      formId: el.form ? el.form.id || el.form.getAttribute('name') : null
    }));
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"],dialog,.modal,[aria-modal="true"]')).filter(el => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    return {
      url: location.href,
      title: document.title || '',
      visibleText: document.body && document.body.innerText ? document.body.innerText : '',
      links,
      forms,
      actions: controls,
      blockers: dialogs.map((dialog, index) => ({
        id: dialog.id || `dialog:${index}`,
        kind: 'dialog',
        text: textOf(dialog).slice(0, 300)
      })),
      capturedAt: new Date().toISOString()
    };
  });
  return probeSnapshot ? { ...snapshot, probeSnapshot } : snapshot;
}

async function extractPageModel(page, options = {}) {
  return normalizePageModel(await extractPageSnapshot(page, options), options);
}

async function maybeGetProbeSnapshot(page, options = {}) {
  if (!page || typeof page.evaluate !== 'function') return null;
  const config = options.config || {
    target: { baseUrl: options.spaHashBaseUrl || options.baseUrl || null },
    crawler: { preserveSpaHashRoutes: options.preserveSpaHashRoutes !== false },
    browserProbe: options.browserProbe || {}
  };
  if (config.browserProbe && config.browserProbe.enabled === false) return null;
  try {
    const { getBrowserProbeSnapshot } = require('./browserProbe.cjs');
    return await getBrowserProbeSnapshot(page, config);
  } catch (_) {
    return null;
  }
}

module.exports = {
  normalizeUrl,
  isSpaHashRoute,
  normalizeRouteShape,
  normalizeHashRouteShape,
  normalizePathShape,
  routeShape,
  summarizeVisibleText,
  normalizeLinks,
  normalizeForms,
  deriveAuthSignals,
  deriveBlockers,
  inferSurfaceType,
  normalizePageModel,
  extractPageSnapshot,
  extractPageModel
};
