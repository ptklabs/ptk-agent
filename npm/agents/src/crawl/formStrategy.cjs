'use strict';

const SENSITIVE_KEY_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth[_-]?header|credential|cookie|session)/i;

function formText(form = {}) {
  return [
    form.id,
    form.name,
    form.kind,
    form.action,
    form.selector,
    form.submitLabel,
    ...(form.fields || []).map(field => `${field.name || ''} ${field.id || ''} ${field.type || ''} ${field.label || ''} ${field.placeholder || ''}`)
  ].join(' ').toLowerCase();
}

function classifyField(field = {}) {
  const text = `${field.name || ''} ${field.id || ''} ${field.type || ''} ${field.label || ''} ${field.placeholder || ''} ${field.autocomplete || ''}`.toLowerCase();
  const type = String(field.type || '').toLowerCase();
  if (type === 'file' || /\b(upload|attachment|file)\b/.test(text)) return 'file';
  if (/pass/.test(text)) return 'password';
  if (/email/.test(text)) return 'email';
  if (/user|login|\buid\b|user[_-]?id|userid/.test(text)) return 'username';
  if (/\b(search|query|q)\b/.test(text)) return 'search';
  if (/phone|tel|mobile/.test(text)) return 'phone';
  if (/\b(from|source|debit)[_-]?(account|acct)?\b|fromaccount|fromacct/.test(text)) return 'accountFrom';
  if (/\b(to|dest|destination|credit)[_-]?(account|acct)?\b|toaccount|toacct/.test(text)) return 'accountTo';
  if (/amount|amt|value|sum|transfer/.test(text)) return 'amount';
  if (/subject|title|summary/.test(text)) return 'subject';
  if (/message|comment|feedback|description|body|details|content/.test(text)) return 'message';
  if (/address|street|line1|line 1/.test(text)) return 'address';
  if (/\bcity\b|town/.test(text)) return 'city';
  if (/state|province|region/.test(text)) return 'state';
  if (/zip|postal|postcode/.test(text)) return 'postalCode';
  if (/country/.test(text)) return 'country';
  if (/qty|quantity|count|age/.test(text) || type === 'number') return 'number';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (/first[_ -]?name|given[_ -]?name/.test(text)) return 'firstName';
  if (/last[_ -]?name|family[_ -]?name|surname/.test(text)) return 'lastName';
  if (/\bname\b/.test(text)) return 'name';
  return 'text';
}

function classifyFormSurface(form = {}) {
  if (form.kind && form.kind !== 'generic') return form.kind;
  const text = formText(form);
  const kinds = (form.fields || []).map(classifyField);
  if (kinds.includes('password')) return 'login';
  if (kinds.includes('search') || /\b(search|query)\b/.test(text)) return 'search';
  if (kinds.includes('file') || /\b(upload|attachment)\b/.test(text)) return 'file-upload';
  if (kinds.includes('accountFrom') || kinds.includes('accountTo') || /transfer|wire|payment/.test(text)) return 'transfer';
  if (/feedback|contact|support|message|comment|complain|complaint/.test(text) || kinds.includes('message')) {
    return /contact|support/.test(text) ? 'contact' : 'feedback';
  }
  if (/delete|remove|destroy|close account|reset account|revoke|disable|deactivate|cancel account/.test(text)) return 'destructive';
  return 'generic';
}

function isVirtualFormSurface(form = {}) {
  return Boolean(form.synthetic || form.virtual || form.selector === null);
}

function isBusinessMutationForm(form = {}) {
  const kind = classifyFormSurface(form);
  return ['feedback', 'contact', 'transfer', 'file-upload', 'generic'].includes(kind);
}

function isDestructiveForm(form = {}) {
  return classifyFormSurface(form) === 'destructive' || /delete|remove|destroy|close account|revoke|disable|deactivate|cancel account/.test(formText(form));
}

function isSensitiveField(field = {}, kind = classifyField(field)) {
  return kind === 'password' || SENSITIVE_KEY_RE.test(`${field.name || ''} ${field.id || ''} ${field.label || ''}`);
}

function resolveFormSubmitPermission(form = {}, { allowSubmit, authIntent = null, config = {} } = {}) {
  const kind = classifyFormSurface(form);
  if (allowSubmit === true) return { allowed: true, reason: null, kind };
  if (allowSubmit === false) return { allowed: false, reason: 'generic form submission is disabled unless allowSubmit is true', kind };
  const formPolicy = config.crawler && config.crawler.forms || {};
  if (formPolicy.enabled === false) return { allowed: false, reason: 'form submission is disabled by crawler.forms.enabled', kind };
  if (kind === 'search' && formPolicy.allowSearch !== false) return { allowed: true, reason: null, kind };
  if (kind === 'contact' && formPolicy.allowContact !== false) return { allowed: true, reason: null, kind };
  if (kind === 'feedback' && formPolicy.allowFeedback !== false) return { allowed: true, reason: null, kind };
  const auth = config.auth || {};
  const hasAuthIntent = authIntent && /^auth\./.test(String(authIntent.kind || authIntent.intent || ''))
    || auth.intent === 'login';
  if (kind === 'login' && hasAuthIntent && (auth.allowLogin === true || formPolicy.allowAuth === true)) {
    return { allowed: true, reason: null, kind };
  }
  if (isDestructiveForm(form)) {
    return {
      allowed: formPolicy.allowDestructive === true,
      reason: formPolicy.allowDestructive === true ? null : 'destructive form submission is blocked unless crawler.forms.allowDestructive is true',
      kind
    };
  }
  if (isBusinessMutationForm(form) && formPolicy.allowBusinessMutation === true) return { allowed: true, reason: null, kind };
  return { allowed: false, reason: 'generic form submission is disabled unless allowSubmit is true', kind };
}

module.exports = {
  classifyField,
  classifyFormSurface,
  formText,
  isBusinessMutationForm,
  isDestructiveForm,
  isSensitiveField,
  isVirtualFormSurface,
  resolveFormSubmitPermission
};
