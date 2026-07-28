#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const CRX_MAGIC = Buffer.from('Cr24');
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const DEFAULT_ZIP_LIMITS = {
  maxFiles: 5000,
  maxUnpackedBytes: 150 * 1024 * 1024,
  allowSymlinks: false
};

function getCrxZipOffset(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('buffer must be a Buffer');
  }
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(CRX_MAGIC)) {
    return 0;
  }
  if (buffer.length < 12) {
    throw new Error('Invalid CRX: truncated header');
  }
  const version = buffer.readUInt32LE(4);
  if (version === 2) {
    if (buffer.length < 16) throw new Error('Invalid CRX2: truncated header');
    const publicKeyLength = buffer.readUInt32LE(8);
    const signatureLength = buffer.readUInt32LE(12);
    const offset = 16 + publicKeyLength + signatureLength;
    if (offset >= buffer.length) throw new Error('Invalid CRX2: missing ZIP payload');
    return offset;
  }
  if (version === 3) {
    const headerLength = buffer.readUInt32LE(8);
    const offset = 12 + headerLength;
    if (offset >= buffer.length) throw new Error('Invalid CRX3: missing ZIP payload');
    return offset;
  }
  throw new Error(`Unsupported CRX version: ${version}`);
}

function extractZipPayload(crxPath, zipPath) {
  const buffer = fs.readFileSync(crxPath);
  const offset = getCrxZipOffset(buffer);
  fs.writeFileSync(zipPath, buffer.subarray(offset));
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== buffer.length) continue;
    return {
      entryCount: buffer.readUInt16LE(offset + 10),
      centralDirectorySize: buffer.readUInt32LE(offset + 12),
      centralDirectoryOffset: buffer.readUInt32LE(offset + 16)
    };
  }
  throw new Error('Invalid ZIP payload: end of central directory was not found');
}

function normalizeZipPath(rawName) {
  const normalized = rawName.replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Invalid ZIP payload: empty or NUL-containing path');
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Invalid ZIP payload: absolute path is not allowed (${rawName})`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) {
    throw new Error(`Invalid ZIP payload: path traversal is not allowed (${rawName})`);
  }
  return parts.filter((part) => part && part !== '.').join('/');
}

function isSymlinkEntry(entry) {
  const unixMode = entry.externalAttributes >>> 16;
  return (unixMode & 0o170000) === 0o120000;
}

function readZipEntries(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
  const limits = { ...DEFAULT_ZIP_LIMITS, ...options };
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd.entryCount > limits.maxFiles) {
    throw new Error(`Invalid ZIP payload: file count ${eocd.entryCount} exceeds ${limits.maxFiles}`);
  }
  if (eocd.centralDirectoryOffset + eocd.centralDirectorySize > buffer.length) {
    throw new Error('Invalid ZIP payload: central directory is out of range');
  }

  const entries = [];
  const seen = new Set();
  let offset = eocd.centralDirectoryOffset;
  let unpackedBytes = 0;
  for (let index = 0; index < eocd.entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error('Invalid ZIP payload: malformed central directory entry');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buffer.length) throw new Error('Invalid ZIP payload: truncated file name');
    const rawName = buffer.subarray(nameStart, nameEnd).toString('utf8');
    const isDirectory = rawName.endsWith('/');
    const normalizedPath = normalizeZipPath(rawName);
    if (!normalizedPath && !isDirectory) {
      throw new Error(`Invalid ZIP payload: invalid file path (${rawName})`);
    }
    if (normalizedPath) {
      const duplicateKey = normalizedPath.toLowerCase();
      if (seen.has(duplicateKey)) {
        throw new Error(`Invalid ZIP payload: duplicate path ${normalizedPath}`);
      }
      seen.add(duplicateKey);
    }
    if ((flags & 0x1) !== 0) {
      throw new Error(`Invalid ZIP payload: encrypted entries are not supported (${rawName})`);
    }
    if (![0, 8].includes(method) && !isDirectory) {
      throw new Error(`Invalid ZIP payload: unsupported compression method ${method} for ${rawName}`);
    }
    const entry = {
      rawName,
      path: normalizedPath,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttributes,
      isDirectory
    };
    if (!limits.allowSymlinks && isSymlinkEntry(entry)) {
      throw new Error(`Invalid ZIP payload: symlink entries are not allowed (${rawName})`);
    }
    unpackedBytes += isDirectory ? 0 : uncompressedSize;
    if (unpackedBytes > limits.maxUnpackedBytes) {
      throw new Error(`Invalid ZIP payload: unpacked size exceeds ${limits.maxUnpackedBytes} bytes`);
    }
    entries.push(entry);
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryContent(buffer, entry) {
  if (entry.isDirectory) return Buffer.alloc(0);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error(`Invalid ZIP payload: malformed local file header for ${entry.rawName}`);
  }
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new Error(`Invalid ZIP payload: truncated file data for ${entry.rawName}`);
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  const content = entry.method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed);
  if (content.length !== entry.uncompressedSize) {
    throw new Error(`Invalid ZIP payload: size mismatch for ${entry.rawName}`);
  }
  return content;
}

function unpackZipBuffer(buffer, destination, options = {}) {
  const resolvedDestination = path.resolve(destination);
  fs.rmSync(resolvedDestination, { recursive: true, force: true });
  fs.mkdirSync(resolvedDestination, { recursive: true });
  const entries = readZipEntries(buffer, options);
  for (const entry of entries) {
    if (!entry.path) continue;
    const outputPath = path.resolve(resolvedDestination, entry.path);
    if (!outputPath.startsWith(`${resolvedDestination}${path.sep}`)) {
      throw new Error(`Invalid ZIP payload: output path escapes destination (${entry.rawName})`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(outputPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, readZipEntryContent(buffer, entry));
    const mode = (entry.externalAttributes >>> 16) & 0o777;
    fs.chmodSync(outputPath, mode || 0o644);
  }
  return entries;
}

function readZipFile(zipPath, relativePath, options = {}) {
  const buffer = fs.readFileSync(zipPath);
  const normalizedNeedle = normalizeZipPath(relativePath).toLowerCase();
  for (const entry of readZipEntries(buffer, options)) {
    if (entry.path && entry.path.toLowerCase() === normalizedNeedle) {
      return readZipEntryContent(buffer, entry);
    }
  }
  return null;
}

function readZipManifest(zipPath, options = {}) {
  const content = readZipFile(zipPath, 'manifest.json', options);
  if (!content) throw new Error(`Invalid ZIP payload: manifest.json was not found in ${zipPath}`);
  return JSON.parse(content.toString('utf8'));
}

function unpackCrx(crxPath, destination) {
  const resolvedCrx = path.resolve(crxPath);
  const resolvedDestination = path.resolve(destination);
  if (!fs.existsSync(resolvedCrx)) {
    throw new Error(`CRX file not found: ${resolvedCrx}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-crx-'));
  const zipPath = path.join(tempDir, 'payload.zip');
  try {
    extractZipPayload(resolvedCrx, zipPath);
    unpackZipBuffer(fs.readFileSync(zipPath), resolvedDestination);
    const manifestPath = path.join(resolvedDestination, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Invalid CRX payload: manifest.json was not found after unpacking ${resolvedCrx}`);
    }
    return {
      crxPath: resolvedCrx,
      destination: resolvedDestination,
      manifestPath
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const [crxPath, destination] = argv;
  if (!crxPath || !destination) {
    console.error('Usage: node scripts/unpack-crx.cjs <ptk-latest.crx> <destination>');
    return 64;
  }
  try {
    const result = unpackCrx(crxPath, destination);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_ZIP_LIMITS,
  extractZipPayload,
  getCrxZipOffset,
  normalizeZipPath,
  readZipEntries,
  readZipFile,
  readZipManifest,
  unpackZipBuffer,
  unpackCrx
};
