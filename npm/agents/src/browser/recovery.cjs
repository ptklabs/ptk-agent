'use strict';

const { isStaticDocumentUrl } = require('./context.cjs');
const { assertNavigationAllowed } = require('./scopeGuard.cjs');
const { withTimeout } = require('../core/budgets.cjs');

const DEFAULT_OVERLAY_TIMEOUT_MS = 250;
const DEFAULT_RECOVERY_TIMEOUT_MS = 1000;
const DEFAULT_BLOCKER_TIMEOUT_MS = 350;

function boundedTimeout(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, 5000);
}

async function dismissCommonOverlays(page, options = {}) {
  const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_OVERLAY_TIMEOUT_MS);
  if (!page) return { attempted: false, dismissed: 0, reason: 'page_unavailable' };
  if (typeof page.dismissCommonOverlays === 'function') {
    const result = await withTimeout(
      Promise.resolve(page.dismissCommonOverlays({ timeout: timeoutMs, timeoutMs })),
      timeoutMs,
      'dismiss common overlays'
    );
    return normalizeDismissResult(result);
  }
  if (typeof page.evaluate !== 'function') {
    return { attempted: false, dismissed: 0, reason: 'evaluate_unavailable' };
  }
  const result = await withTimeout(page.evaluate(() => {
    const textPattern = /\b(accept|agree|allow|ok|got it|continue|close|dismiss|no thanks|reject all)\b/i;
    const selector = [
      '[role="dialog"] button',
      '[aria-modal="true"] button',
      'dialog button',
      '.modal button',
      '.cookie button',
      '[class*="cookie" i] button',
      '[id*="cookie" i] button',
      '[class*="consent" i] button',
      '[id*="consent" i] button',
      'button[aria-label*="close" i]',
      'button[title*="close" i]',
      '[role="button"]'
    ].join(',');
    const visible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const controls = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 40);
    let dismissed = 0;
    for (const control of controls) {
      const label = [
        control.textContent,
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
        control.value
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!textPattern.test(label)) continue;
      control.click();
      dismissed += 1;
      if (dismissed >= 3) break;
    }
    if (dismissed === 0) {
      const unsafe = /\b(delete|remove|logout|log out|sign out|checkout|purchase|buy|pay|transfer|reset password)\b/i;
      const roots = Array.from(document.querySelectorAll([
        '[role="dialog"]',
        '[aria-modal="true"]',
        'dialog',
        '.modal',
        '.cookie',
        '[class*="cookie" i]',
        '[id*="cookie" i]',
        '[class*="consent" i]',
        '[id*="consent" i]'
      ].join(','))).filter(visible).slice(0, 8);
      for (const root of roots) {
        const scopedControls = Array.from(root.querySelectorAll('button,[role="button"]')).filter(visible).slice(0, 4);
        const safeControls = scopedControls.filter(control => {
          const label = [
            control.textContent,
            control.getAttribute('aria-label'),
            control.getAttribute('title'),
            control.value
          ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
          return !unsafe.test(label);
        });
        if (safeControls.length === 0 || safeControls.length > 3) continue;
        safeControls[safeControls.length - 1].click();
        dismissed += 1;
        if (dismissed >= 3) break;
      }
    }
    return { attempted: true, dismissed };
  }), timeoutMs, 'dismiss common overlays');
  return normalizeDismissResult(result);
}

function normalizeDismissResult(result) {
  if (!result || typeof result !== 'object') {
    return { attempted: true, dismissed: Number(result) || 0 };
  }
  return {
    attempted: result.attempted !== false,
    dismissed: Number(result.dismissed || result.count || 0),
    reason: result.reason || null
  };
}

async function recoverToRoute(page, url, options = {}) {
  const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_RECOVERY_TIMEOUT_MS);
  if (!page || !url) return { attempted: false, ok: false, reason: 'recovery_target_unavailable' };
  assertNavigationAllowed(url, { config: options.config || {}, scope: options.scope || null, kind: 'recovery' });
  const currentUrl = currentPageUrl(page);
  if (currentUrl && currentUrl === url) {
    return { attempted: false, ok: true, reason: 'already_at_target', url };
  }
  if (typeof page.recoverToRoute === 'function') {
    const result = await withTimeout(
      Promise.resolve(page.recoverToRoute(url, { timeout: timeoutMs })),
      timeoutMs,
      `recover to ${url}`
    );
    return normalizeRecoveryResult(result, url);
  }
  if (typeof page.goto !== 'function') {
    return { attempted: false, ok: false, reason: 'goto_unavailable', url };
  }
  const waitUntil = isStaticDocumentUrl(url, options.config && options.config.target && options.config.target.baseUrl)
    ? 'commit'
    : 'domcontentloaded';
  await withTimeout(page.goto(url, { waitUntil, timeout: timeoutMs }), timeoutMs, `recover to ${url}`);
  return { attempted: true, ok: true, url, waitUntil };
}

async function closeBlockingSurfaces(page, options = {}) {
  const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_BLOCKER_TIMEOUT_MS);
  if (!page) return { attempted: false, closed: false, reason: 'page_unavailable' };
  const result = {
    attempted: true,
    closed: false,
    escapePressed: false,
    backdropClicked: false,
    backdropCount: 0,
    reason: null
  };
  if (page.keyboard && typeof page.keyboard.press === 'function') {
    await withTimeout(
      page.keyboard.press('Escape').then(() => {
        result.escapePressed = true;
        result.closed = true;
      }).catch(error => {
        result.reason = error && error.message || String(error || 'escape_failed');
      }),
      timeoutMs,
      'close blocking surface escape'
    ).catch(error => {
      result.reason = error && error.message || String(error || 'escape_timeout');
    });
  }
  if (typeof page.locator === 'function') {
    const locator = page.locator('[class*="backdrop" i],[data-backdrop],[role="presentation"],[aria-modal="true"]');
    const target = locator && typeof locator.first === 'function' ? locator.first() : locator;
    if (target && typeof target.click === 'function') {
      const clicked = await withTimeout(
        target.click({ timeout: Math.min(150, timeoutMs), force: true }).then(() => true).catch(() => false),
        timeoutMs,
        'close blocking surface backdrop'
      ).catch(() => false);
      if (clicked) {
        result.backdropClicked = true;
        result.closed = true;
      }
    }
  }
  if (typeof page.evaluate === 'function') {
    const domResult = await withTimeout(page.evaluate(() => {
      const visible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const blockers = Array.from(document.querySelectorAll([
        '[class*="backdrop" i]',
        '[data-backdrop]',
        '[role="presentation"]',
        '[role="dialog"]',
        '[aria-modal="true"]',
        'dialog'
      ].join(','))).filter(visible).slice(0, 8);
      const PointerLikeEvent = window.PointerEvent || window.MouseEvent;
      for (const blocker of blockers) {
        if (String(blocker.getAttribute('role') || '').toLowerCase() === 'dialog' || blocker.tagName.toLowerCase() === 'dialog') continue;
        blocker.dispatchEvent(new PointerLikeEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
        blocker.dispatchEvent(new PointerLikeEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
        blocker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
      return { blockerCount: blockers.length, dispatchedEscape: true, clickedBackdrop: blockers.length > 0 };
    }), timeoutMs, 'close blocking surface dom').catch(error => ({
      error: error && error.message || String(error || 'dom_close_failed')
    }));
    if (domResult && domResult.dispatchedEscape) {
      result.escapePressed = true;
      result.closed = true;
    }
    if (domResult && domResult.clickedBackdrop) {
      result.backdropClicked = true;
      result.closed = true;
    }
    if (domResult && Number(domResult.blockerCount) > 0) result.backdropCount = Number(domResult.blockerCount);
    if (domResult && domResult.error && !result.reason) result.reason = domResult.error;
  }
  if (page.waitForTimeout && timeoutMs > 25) {
    await withTimeout(page.waitForTimeout(Math.min(75, timeoutMs)), timeoutMs, 'settle blocking surface close').catch(() => {});
  }
  return result;
}

function currentPageUrl(page) {
  try {
    if (page && typeof page.url === 'function') return page.url();
    if (page && typeof page.currentUrl === 'string') return page.currentUrl;
  } catch (_) {
    return null;
  }
  return null;
}

function normalizeRecoveryResult(result, url) {
  if (!result || typeof result !== 'object') {
    return { attempted: true, ok: Boolean(result), url };
  }
  return {
    attempted: result.attempted !== false,
    ok: result.ok !== false,
    url: result.url || url,
    reason: result.reason || null
  };
}

module.exports = {
  DEFAULT_OVERLAY_TIMEOUT_MS,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  closeBlockingSurfaces,
  dismissCommonOverlays,
  recoverToRoute
};
