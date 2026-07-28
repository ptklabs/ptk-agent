'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  MAX_PROVIDER_OUTPUT_CHARS,
  appendBoundedProviderOutput,
  buildMissionPrompt,
  boundedProviderText,
  parseProviderChoice,
  providerSnippet
} = require('./opencodeProvider.cjs');

const DEFAULT_PROVIDER_TIMEOUT_MS = 60000;

class CodexProvider {
  constructor({ model = 'gpt-5.3-codex-spark', maxProviderMs = DEFAULT_PROVIDER_TIMEOUT_MS, cwd = process.cwd() } = {}) {
    this.kind = 'codex';
    this.model = model || 'gpt-5.3-codex-spark';
    this.maxProviderMs = maxProviderMs;
    this.cwd = cwd;
  }

  async chooseMission(context = {}) {
    const prompt = buildMissionPrompt(context);
    const result = await runCodex(prompt, {
      model: this.model,
      cwd: this.cwd,
      timeoutMs: this.maxProviderMs
    });
    if (!result.ok) {
      const timedOut = result.code === 'ERR_PTK_AGENT_PROVIDER_TIMEOUT';
      return {
        missionId: null,
        reason: timedOut ? 'provider_timeout' : 'codex_provider_failed',
        provider: 'codex',
        error: result.error,
        code: result.code || null,
        stdout: providerSnippet(result.stdout),
        stderr: providerSnippet(result.stderr),
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        messageTruncated: result.messageTruncated
      };
    }
    const parsed = parseProviderChoice(result.message || result.stdout);
    if (!parsed || !parsed.missionId) {
      return {
        missionId: null,
        reason: 'codex_provider_parse_failed',
        provider: 'codex',
        stdout: providerSnippet(result.stdout),
        stderr: providerSnippet(result.stderr),
        message: providerSnippet(result.message),
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        messageTruncated: result.messageTruncated
      };
    }
    return {
      provider: 'codex',
      ...parsed,
      raw: providerSnippet(result.message || result.stdout),
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      messageTruncated: result.messageTruncated
    };
  }
}

function runCodex(prompt, { model, cwd, timeoutMs } = {}) {
  return new Promise(resolve => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-codex-provider-'));
    const outputFile = path.join(outputDir, 'last-message.txt');
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--output-last-message',
      outputFile
    ];
    if (model) args.push('-m', model);
    args.push(prompt);

    const child = spawn('codex', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let message = '';
      let messageTruncated = false;
      try {
        if (fs.existsSync(outputFile)) {
          const read = readBoundedFileTail(outputFile, MAX_PROVIDER_OUTPUT_CHARS);
          message = read.value;
          messageTruncated = read.truncated;
        }
      } catch (_) {}
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch (_) {}
      resolve({ ...payload, stdout, stderr, message, stdoutTruncated, stderrTruncated, messageTruncated });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, code: 'ERR_PTK_AGENT_PROVIDER_TIMEOUT', error: `codex timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      const bounded = appendBoundedProviderOutput(stdout, chunk);
      stdout = bounded.value;
      stdoutTruncated = stdoutTruncated || bounded.truncated;
    });
    child.stderr.on('data', chunk => {
      const bounded = appendBoundedProviderOutput(stderr, chunk);
      stderr = bounded.value;
      stderrTruncated = stderrTruncated || bounded.truncated;
    });
    child.on('error', err => finish({ ok: false, error: err.message }));
    child.on('close', code => finish({ ok: code === 0, code, error: code === 0 ? null : `codex exited with ${code}` }));
  });
}

function readBoundedFileTail(file, maxChars = MAX_PROVIDER_OUTPUT_CHARS) {
  const stat = fs.statSync(file);
  const maxBytes = maxChars * 4;
  if (stat.size <= maxBytes) {
    return { value: boundedProviderText(fs.readFileSync(file, 'utf8'), maxChars), truncated: false };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const offset = Math.max(0, stat.size - maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, offset);
    return { value: boundedProviderText(buffer.slice(0, bytesRead).toString('utf8'), maxChars), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  CodexProvider,
  readBoundedFileTail,
  runCodex
};
