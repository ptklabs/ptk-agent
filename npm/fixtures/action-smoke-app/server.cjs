#!/usr/bin/env node
'use strict';

const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);

function page(body, script = '') {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>PTK Agent Action Fixture</title></head>
<body>
  <nav><a href="/">Home</a> <a href="/dom?value=hello">DOM sink</a> <a href="/search?q=hello">Search</a></nav>
  ${body}
  <script src="/assets/jquery-3.4.0.min.js"></script>
  ${script}
</body>
</html>`;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  if (url.pathname === '/assets/jquery-3.4.0.min.js') {
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    response.end('/*! jQuery v3.4.0 | jquery.org/license */\nwindow.jQuery=window.$=function(selector){return document.querySelectorAll(selector)};');
    return;
  }
  if (url.pathname === '/assets/dom-app.js') {
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    response.end(`const value = new URLSearchParams(location.search).get('value') || location.hash.slice(1);\n
document.querySelector('#output').innerHTML = value || 'empty';\n
if (new URLSearchParams(location.search).has('run')) eval('window.__fixtureExecuted = true');`);
    return;
  }
  if (url.pathname === '/api/items') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ id: url.searchParams.get('id'), items: ['one', 'two'] }));
    return;
  }
  if (url.pathname === '/search') {
    const query = url.searchParams.get('q') || '';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(`<h1>Search</h1><div id="result">${query}</div><form method="get"><input name="q"><button>Search</button></form>`));
    return;
  }
  if (url.pathname === '/dom') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page('<h1>DOM sink</h1><div id="output"></div>', '<script src="/assets/dom-app.js"></script>'));
    return;
  }
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page('<h1>PTK Agent Action Fixture</h1><a href="/api/items?id=1">API item</a>'));
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`PTK Agent Action fixture listening on http://${HOST}:${PORT}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

