'use strict';

// CSSOM-compatible CSS.escape() implementation for Node-side selector plans.
// Keep this function self-contained: browser probe scripts serialize it into
// the page context when native CSS.escape is unavailable.
function cssEscape(value) {
  const input = String(value ?? '');
  const length = input.length;
  const firstCodeUnit = length ? input.charCodeAt(0) : NaN;
  let result = '';

  for (let index = 0; index < length; index += 1) {
    const codeUnit = input.charCodeAt(index);

    if (codeUnit === 0x0000) {
      result += '\uFFFD';
      continue;
    }

    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
    ) {
      result += '\\' + codeUnit.toString(16) + ' ';
      continue;
    }

    if (index === 0 && codeUnit === 0x002d && length === 1) {
      result += '\\-';
      continue;
    }

    if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += input.charAt(index);
      continue;
    }

    result += '\\' + input.charAt(index);
  }

  return result;
}

function cssIdSelector(value) {
  return `#${cssEscape(value)}`;
}

function cssAttributeSelector(attribute, value, tag = '') {
  const safeAttribute = String(attribute || '');
  const safeTag = String(tag || '');
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(safeAttribute)) {
    throw new TypeError(`Invalid CSS attribute name: ${safeAttribute}`);
  }
  if (safeTag && !/^[A-Za-z][A-Za-z0-9-]*$/.test(safeTag)) {
    throw new TypeError(`Invalid CSS tag name: ${safeTag}`);
  }
  return `${safeTag}[${safeAttribute}="${cssEscape(value)}"]`;
}

module.exports = {
  cssAttributeSelector,
  cssEscape,
  cssIdSelector
};
