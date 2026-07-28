'use strict';

const { normalizeUrl } = require('../browser/pageModel.cjs');
const { createDocumentHash, redactSecretLikeText } = require('./routeLifecycle.cjs');

const TERMINAL_DOCUMENT_EXTENSIONS = new Set([
  '.csv',
  '.json',
  '.log',
  '.md',
  '.text',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
]);

const TERMINAL_CONTENT_TYPE_RE = /(?:^|;|\s)(?:text\/plain|text\/markdown|text\/csv|application\/json|application\/xml|text\/xml|application\/rss\+xml|application\/atom\+xml|application\/x-yaml|text\/yaml)(?:;|$)/i;
const HTML_CONTENT_TYPE_RE = /(?:^|;|\s)text\/html(?:;|$)/i;
const LINK_RE = /\bhttps?:\/\/[^\s"'<>)]{3,}|\B\/(?!\/)[^\s"'<>)]{1,}/g;
const COMMON_TERMINAL_PATH_RE = /(?:^|\/)(?:\.git\/|\.hg\/|\.svn\/|\.htaccess$|nginx\.conf$|robots\.txt$|security\.txt$|sitemap\.xml$)/i;

function extensionForUrl(url, baseUrl = null) {
  try {
    const parsed = new URL(url, baseUrl || undefined);
    const pathname = parsed.pathname || '';
    const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
    const match = lastSegment.match(/(\.[a-z0-9]{1,12})$/i);
    return match ? match[1].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

function isTerminalDocumentCandidate(url, baseUrl = null) {
  try {
    const parsed = new URL(url, baseUrl || undefined);
    if (COMMON_TERMINAL_PATH_RE.test(parsed.pathname || '')) return true;
  } catch (_) {}
  return TERMINAL_DOCUMENT_EXTENSIONS.has(extensionForUrl(url, baseUrl));
}

function responseStatus(response) {
  try {
    return response && typeof response.status === 'function' ? response.status() : null;
  } catch (_) {
    return null;
  }
}

function responseHeaders(response) {
  try {
    return response && typeof response.headers === 'function' ? response.headers() || {} : {};
  } catch (_) {
    return {};
  }
}

function contentTypeFromResponse(response) {
  const headers = responseHeaders(response);
  return headers['content-type'] || headers['Content-Type'] || null;
}

function shouldTreatAsTerminalDocument({ url, baseUrl = null, response = null, pageModel = null } = {}) {
  const extension = extensionForUrl(url, baseUrl);
  const contentType = contentTypeFromResponse(response);
  const extensionTerminal = TERMINAL_DOCUMENT_EXTENSIONS.has(extension);
  const contentTypeTerminal = TERMINAL_CONTENT_TYPE_RE.test(String(contentType || ''));
  const contentTypeHtml = HTML_CONTENT_TYPE_RE.test(String(contentType || ''));
  const hasActionableSurface = Boolean(
    pageModel
      && (
        (Array.isArray(pageModel.forms) && pageModel.forms.length > 0)
        || (Array.isArray(pageModel.actions) && pageModel.actions.length > 0)
        || (pageModel.surfaceType && !['content', 'static-document', 'terminal-document'].includes(pageModel.surfaceType))
      )
  );
  if (contentTypeTerminal) return true;
  if (extensionTerminal && !contentTypeHtml) return true;
  if (extensionTerminal && contentTypeHtml && !hasActionableSurface) return true;
  return false;
}

async function readBoundedDocumentText(page, maxChars = 12000) {
  if (!page || typeof page.evaluate !== 'function') return '';
  return page.evaluate(limit => {
    const source = document.body && (document.body.innerText || document.body.textContent) || '';
    return String(source || '').slice(0, limit);
  }, Math.max(0, Math.min(Number(maxChars) || 12000, 50000))).catch(() => '');
}

function extractSameOriginLinksFromText(text, baseUrl, options = {}) {
  const maxLinks = Number(options.maxLinks) > 0 ? Number(options.maxLinks) : 50;
  const seen = new Set();
  const links = [];
  let match;
  while ((match = LINK_RE.exec(String(text || ''))) && links.length < maxLinks) {
    const raw = match[0].replace(/[.,;:!?]+$/, '');
    if (raw.startsWith('/') && match.index > 0 && String(text || '')[match.index - 1] === ':') continue;
    if (raw.startsWith('/') && /^[^@/:]+:[^@/]+@/.test(raw.slice(1))) continue;
    const href = normalizeUrl(raw, baseUrl, {
      preserveSpaHashRoutes: options.preserveSpaHashRoutes !== false,
      spaHashBaseUrl: options.spaHashBaseUrl || baseUrl
    });
    if (!href) continue;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(href).origin === new URL(baseUrl).origin;
    } catch (_) {
      sameOrigin = false;
    }
    if (!sameOrigin || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, source: 'terminal-document-text' });
  }
  return links;
}

function summarizeTerminalDocument({ url, response = null, contentType = null, text = '', extractedLinks = [], redactionApplied = true } = {}) {
  const statusCode = responseStatus(response);
  const rawLength = String(text || '').length;
  const redactedSnippet = redactSecretLikeText(String(text || '').slice(0, 500));
  return {
    url,
    statusCode,
    contentType: contentType || contentTypeFromResponse(response),
    size: rawLength || null,
    hash: rawLength ? createDocumentHash(text) : null,
    redactionApplied: Boolean(redactionApplied),
    redactedSnippet: redactedSnippet || null,
    extractedLinks: (extractedLinks || []).slice(0, 50)
  };
}

module.exports = {
  TERMINAL_DOCUMENT_EXTENSIONS,
  contentTypeFromResponse,
  extensionForUrl,
  extractSameOriginLinksFromText,
  isTerminalDocumentCandidate,
  readBoundedDocumentText,
  responseStatus,
  shouldTreatAsTerminalDocument,
  summarizeTerminalDocument
};
