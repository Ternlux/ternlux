const fs = require('fs');
const path = require('path');
const Datastore = require('@seald-io/nedb');
const { app } = require('electron');

const sanitizePathSegment = (value) => String(value || '')
  .replace(/[^a-zA-Z0-9._-]+/g, '_')
  .replace(/^[._]+|[._]+$/g, '')
  .slice(0, 80);

/**
 * Where a local NeDB collection lives.
 *
 * Scoped per workflow AND per node — `local-collections/<workflowId>/<nodeId>.db`
 * — because the flat layout keyed only on a collection name let two nodes
 * collide whenever their names sanitized to the same string, and each run
 * deletes the file first in new_table mode, so one node would silently wipe
 * another's data.
 *
 * The scope is optional on purpose: connection imports and error paths have no
 * workflow, and those keep the original flat layout so nothing that already
 * works starts resolving somewhere new.
 */
function resolveLocalCollectionPath(targetCollection, scope = {}) {
  const root = path.join(app.getPath('userData'), 'local-collections');
  const workflowId = sanitizePathSegment(scope.workflowId);
  const nodeId = sanitizePathSegment(scope.nodeId);

  if (workflowId && nodeId) return path.join(root, workflowId, `${nodeId}.db`);
  if (workflowId) return path.join(root, workflowId, `${sanitizePathSegment(targetCollection)}.db`);
  return path.join(root, `${targetCollection}.db`);
}

/**
 * Helper function to save documents to local NeDB file
 * Sanitizes MongoDB ObjectIds and Dates for NeDB compatibility
 *
 * `scope` is { workflowId, nodeId } — both optional. An explicit
 * targetLocalPath always wins, so already-saved nodes keep reading and writing
 * the exact file recorded in their config.
 */
async function saveToLocalNeDB(targetCollection, documents, operationMode, totalProcessed, targetLocalPath = null, scope = {}) {
  // Honor the caller's configured target path so the writer and every reader
  // (preview via db:read-local-collection, downstream output/join nodes) all
  // point at the same file. Fall back to the scoped default only when no
  // path was configured. Without this, a targetLocalPath outside
  // userData/local-collections leaves the data here while readers look there.
  // console.log("saveToLocalNeDB: ", targetCollection, targetLocalPath, )
  const localDbPath = targetLocalPath || resolveLocalCollectionPath(targetCollection, scope);
  const localDbDir = path.dirname(localDbPath);

  // Ensure directory exists
  if (!fs.existsSync(localDbDir)) {
    fs.mkdirSync(localDbDir, { recursive: true });
  }

  // Delete existing local database files if they exist (for new_table mode)
  if (operationMode === 'new_table') {
    try {
      // Delete main database file
      if (fs.existsSync(localDbPath)) {
        fs.unlinkSync(localDbPath);
      }
      // Delete temporary file if it exists
      const tempFilePath = localDbPath + '~';
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch (deleteErr) {
      console.error('Error deleting existing database files:', deleteErr);
      // Continue anyway - NeDB might be able to handle it
    }
  }

  // Convert MongoDB documents to NeDB-compatible format
  const sanitizeForNeDB = (doc) => {
    if (!doc || typeof doc !== 'object') return doc;

    const sanitized = Array.isArray(doc) ? [] : {};

    for (const key in doc) {
      const value = doc[key];

      // Convert MongoDB ObjectId to string
      if (value && typeof value === 'object' && value._bsontype === 'ObjectId') {
        sanitized[key] = value.toString();
      }
      // Convert Date to ISO string
      else if (value instanceof Date) {
        sanitized[key] = value.toISOString();
      }
      // Recursively handle nested objects/arrays
      else if (value && typeof value === 'object') {
        sanitized[key] = sanitizeForNeDB(value);
      }
      // Primitive values
      else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  };

  const sanitizedDocs = documents.map(sanitizeForNeDB);
  const localDb = new Datastore({
    filename: localDbPath,
    autoload: false
  });

  return new Promise((resolve) => {
    localDb.loadDatabase((loadErr) => {
      if (loadErr) {
        resolve({
          success: false,
          message: `Failed to load local database: ${loadErr.message}`
        });
        return;
      }

      localDb.insert(sanitizedDocs, (err, newDocs) => {
        if (err) {
          resolve({
            success: false,
            message: `Failed to save locally: ${err.message}`
          });
          return;
        }

        // Compact and persist the database to ensure all writes are completed
        localDb.persistence.compactDatafile();

        // Wait a bit for compaction to complete
        setTimeout(() => {
          resolve({
            success: true,
            message: `Transformation completed. ${newDocs.length} documents saved locally to "${targetCollection}"`,
            documentsProcessed: totalProcessed,
            documentsInserted: newDocs.length,
            localPath: localDbPath
          });
        }, 100);
      });
    });
  });
}

/**
 * Native NeDB transformation function (local file operations)
 * Supports: filter, update, delete, javascript operations (no aggregation)
 */
async function transformNeDB({
    sourceLocalPath,
    targetCollection,
    targetLocalPath = null,
    operationType,
    nosqlOperation,
    transformFunction,
    operationMode,
    // Optional scope for the local NeDB fallback path.
    workflowId = null,
    nodeId = null
  }) {
    console.log({
      sourceLocalPath,
      targetCollection,
      operationType,
      nosqlOperation,
      transformFunction,
      operationMode
    })
    try {
      if (!sourceLocalPath || !fs.existsSync(sourceLocalPath)) {
        return { success: false, message: 'Source NeDB file not found' };
      }
  
      const sourceDb = new Datastore({ filename: sourceLocalPath });
  
      return new Promise((resolve) => {
        sourceDb.loadDatabase(async (loadErr) => {
          if (loadErr) {
            resolve({
              success: false,
              message: `Failed to load source database: ${loadErr.message}`
            });
            return;
          }
  
          let transformFn = null;
          if (transformFunction) {
            try {
              transformFn = eval(`(${transformFunction})`);
            } catch (err) {
              resolve({
                success: false,
                message: `Failed to parse transform function: ${err.message}`
              });
              return;
            }
          }
  
          // Handle different operation types
          if (operationType === 'filter' || operationType === 'javascript') {
            const filter = nosqlOperation ? JSON.parse(nosqlOperation) : {};
  
            // For in-place mode with JavaScript transformation, process in batches
            if (operationMode === 'in_place' && transformFn) {
              const BATCH_SIZE = 10000;
              let totalProcessed = 0;
              let totalUpdated = 0;
              let skip = 0;
  
              const processBatch = () => {
                return new Promise((batchResolve) => {
                  sourceDb.find(filter).skip(skip).limit(BATCH_SIZE).exec((err, docs) => {
                    if (err) {
                      batchResolve({ error: err.message });
                      return;
                    }
  
                    if (docs.length === 0) {
                      batchResolve({ done: true });
                      return;
                    }
  
                    // Transform documents
                    const updates = [];
                    for (const doc of docs) {
                      try {
                        const transformedDoc = transformFn(doc);
                        if (transformedDoc !== null && transformedDoc !== undefined) {
                          // Update the document in place
                          updates.push({ _id: doc._id, transformed: transformedDoc });
                        }
                      } catch (transformErr) {
                        console.error(`Transform error for doc ${doc._id}:`, transformErr);
                      }
                    }
  
                    // Update documents sequentially
                    let updatedCount = 0;
                    const updatePromises = updates.map(({ _id, transformed }) => {
                      return new Promise((updateResolve) => {
                        sourceDb.update({ _id }, transformed, {}, (updateErr, numReplaced) => {
                          if (!updateErr && numReplaced > 0) {
                            updatedCount++;
                          }
                          updateResolve();
                        });
                      });
                    });
  
                    Promise.all(updatePromises).then(() => {
                      totalProcessed += docs.length;
                      totalUpdated += updatedCount;
                      skip += BATCH_SIZE;
  
                      batchResolve({ continue: true, updatedCount });
                    });
                  });
                });
              };
  
              // Process all batches
              try {
                while (true) {
                  const result = await processBatch();
                  if (result.error) {
                    resolve({ success: false, message: `Batch processing failed: ${result.error}` });
                    return;
                  }
                  if (result.done) {
                    break;
                  }
                }
  
                resolve({
                  success: true,
                  message: `JavaScript transformation completed. ${totalUpdated} documents updated in place (${totalProcessed} documents processed)`,
                  documentsProcessed: totalProcessed,
                  documentsUpdated: totalUpdated
                });
              } catch (err) {
                resolve({ success: false, message: `Batch processing error: ${err.message}` });
              }
              return;
            }
  
            // For new_table mode, load all and transform
            sourceDb.find(filter, async (err, docs) => {
              if (err) {
                resolve({ success: false, message: `Query failed: ${err.message}` });
                return;
              }
  
              let transformedDocs = docs;
  
              if (transformFn) {
                transformedDocs = docs
                  .map(doc => transformFn(doc))
                  .filter(doc => doc !== null && doc !== undefined);
              }
  
              // Save to local NeDB file
              const result = await saveToLocalNeDB(
                targetCollection,
                transformedDocs,
                operationMode,
                docs.length,
                targetLocalPath,
                { workflowId, nodeId }
              );
              resolve(result);
            });
          } else if (operationType === 'delete') {
            const filter = JSON.parse(nosqlOperation);
  
            if (operationMode === 'in_place') {
              sourceDb.remove(filter, { multi: true }, (err, numRemoved) => {
                if (err) {
                  resolve({ success: false, message: `Delete failed: ${err.message}` });
                } else {
                  resolve({
                    success: true,
                    message: `Deleted ${numRemoved} documents`,
                    documentsProcessed: numRemoved
                  });
                }
              });
            } else {
              resolve({
                success: false,
                message: 'Delete operation only supports in_place mode for NeDB'
              });
            }
          } else if (operationType === 'update') {
            const updateOp = JSON.parse(nosqlOperation);
  
            if (operationMode === 'in_place') {
              sourceDb.update(
                updateOp.filter,
                updateOp.update,
                { multi: true },
                (err, numUpdated) => {
                  if (err) {
                    resolve({ success: false, message: `Update failed: ${err.message}` });
                  } else {
                    resolve({
                      success: true,
                      message: `Updated ${numUpdated} documents`,
                      documentsProcessed: numUpdated
                    });
                  }
                }
              );
            } else {
              resolve({
                success: false,
                message: 'Update operation only supports in_place mode for NeDB'
              });
            }
          } else {
            resolve({
              success: false,
              message: `Unsupported operation type: ${operationType}. NeDB supports filter, javascript, delete, and update.`
            });
          }
        });
      });
    } catch (error) {
      return {
        success: false,
        message: `Transformation failed: ${error.message}`,
        error: error.stack
      };
    }
  }
  module.exports = {transformNeDB, saveToLocalNeDB, resolveLocalCollectionPath}