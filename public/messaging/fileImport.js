/**
 * A data file sent to a chat bot (Telegram, Slack) → a connection.
 *
 * The file is kept under <userData>/<folder>/<chatId>/<time>/ — a connection
 * points at it, so it has to stay — then registered the way Connections → add
 * file does, and saved in the shape LocalFileConnectionForm builds.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createFileImporter({ userData, folder, getDb, registerLocalFile, broadcast = () => {}, description }) {
  async function saveUpload(chatId, fileName, buffer) {
    const safe = path.basename(String(fileName)).replace(/[^\w.\- ]+/g, '_') || 'upload';
    const dir = path.join(userData, folder, String(chatId).replace(/[^\w-]+/g, '_'), String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, safe);
    fs.writeFileSync(target, buffer);
    return target;
  }

  async function importFile(localPath, { name, originalName, fileType }) {
    const result = await registerLocalFile(localPath, userData);
    if (!result?.success) throw new Error(result?.message || 'the file could not be read');

    const connections = getDb('connections');
    const taken = new Set((await connections.findAsync({})).map((c) => String(c.name || '').toLowerCase()));
    const base = String(name || '').trim().slice(0, 80) || 'Uploaded file';
    let unique = base;
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${base} (${n})`;

    const sheeted = result.tables.filter((t) => t.sheet);
    const now = new Date().toISOString();
    const connection = {
      id: crypto.randomUUID(),
      name: unique,
      description,
      connectionType: 'file',
      dbType: 'duckdb',
      fileType,
      fileInfo: {
        originalName,
        filePath: result.tables[0].path,
        sourceFilePath: localPath,
        format: result.format,
        fileSize: fs.statSync(localPath).size,
        uploadedAt: now,
        tables: result.tables.map((t) => t.name),
        tablePaths: Object.fromEntries(result.tables.map((t) => [t.name, t.path])),
        tableSheets: sheeted.length ? Object.fromEntries(sheeted.map((t) => [t.name, t.sheet])) : null,
        schemas: result.tables.map((t) => t.schema).filter(Boolean),
      },
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    await connections.insertAsync(connection);
    broadcast('connections:changed');
    return {
      connection,
      tables: result.tables.map((t) => ({ name: t.name, columns: t.schema?.columns?.length || null })),
    };
  }

  return { saveUpload, importFile };
}

module.exports = { createFileImporter };
