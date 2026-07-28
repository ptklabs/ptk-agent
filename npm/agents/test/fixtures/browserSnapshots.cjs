'use strict';

const loginPage = {
  url: 'http://app.test/login',
  title: 'Login',
  visibleText: 'Sign in Login Email Password',
  links: [{ href: '/catalog', text: 'Catalog' }],
  forms: [{
    id: 'login',
    method: 'post',
    action: '/login',
    selector: '#login',
    fields: [
      { name: 'email', type: 'email', required: true, selector: '[name="email"]' },
      { name: 'password', type: 'password', required: true, selector: '[name="password"]' }
    ]
  }],
  actions: [
    { id: 'submit-login', tagName: 'button', type: 'submit', label: 'Login', selector: '#submit-login' }
  ]
};

const catalogPage = {
  url: 'http://app.test/catalog?page=1',
  title: 'Catalog',
  visibleText: 'Catalog Sort Filter Next Details',
  links: [
    { href: 'http://app.test/catalog/123', text: 'Item 123' },
    { href: 'http://app.test/catalog/456', text: 'Item 456' },
    { href: 'http://external.test/', text: 'External' }
  ],
  forms: [],
  actions: [
    { id: 'filters', tagName: 'button', label: 'Filters', selector: '#filters', expands: true },
    { id: 'delete', tagName: 'button', label: 'Delete item', selector: '#delete' },
    { id: 'next', tagName: 'button', label: 'Next page', selector: '#next' }
  ]
};

const formPage = {
  url: 'http://app.test/contact',
  title: 'Contact',
  visibleText: 'Contact us Name Email Message',
  links: [],
  forms: [{
    id: 'contact',
    method: 'post',
    action: '/contact',
    selector: '#contact',
    fields: [
      { name: 'name', type: 'text', required: true, selector: '[name="name"]' },
      { name: 'email', type: 'email', required: true, selector: '[name="email"]' },
      { name: 'message', type: 'textarea', required: false, selector: '[name="message"]' }
    ]
  }],
  actions: []
};

const modalPageBefore = {
  url: 'http://app.test/catalog',
  title: 'Catalog',
  visibleText: 'Catalog Details',
  links: [],
  forms: [],
  actions: [{ id: 'details', tagName: 'button', label: 'Details', selector: '#details', opensDialog: true }],
  blockers: []
};

const modalPageAfter = {
  ...modalPageBefore,
  visibleText: 'Catalog Details More links',
  links: [{ href: 'http://app.test/help', text: 'Help' }],
  blockers: [{ id: 'dialog:0', kind: 'dialog', text: 'Details dialog' }]
};

module.exports = {
  loginPage,
  catalogPage,
  formPage,
  modalPageBefore,
  modalPageAfter
};
