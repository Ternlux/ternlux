const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Execute DDL (ALTER TABLE) and/or UPDATE/DELETE on a table in the app's SQLite database
 * @param {string} appDbPath - Path to the app's SQLite database
 * @param {string} ddl - ALTER TABLE statement (optional, can be null)
 * @param {string} sql - UPDATE or DELETE SQL statement (optional, can be null)
 * @param {string} tableName - Name of the table being modified
 */
async function inPlaceLocalUpdate(appDbPath, ddl, sql, tableName) {
    const db = new sqlite3.Database(appDbPath);

    return new Promise((resolve) => {
        const executeSequentially = async () => {
            let ddlRowCount = 0;
            let sqlRowCount = 0;
            let messages = [];
            // console.log('ddl: ', ddl, sql, tableName)
            try {
                // Execute DDL first if it exists (ALTER TABLE operations)
                if (ddl) {
                    await new Promise((resolveDdl) => {
                        db.run(ddl, function(err) {
                            console.log('err: ', err)
                            if (err) {
                                messages.push(`DDL execution failed: ${err.message}`);
                                resolveDdl();
                            } else {
                                ddlRowCount = this.changes;
                                messages.push('DDL executed successfully');
                                resolveDdl();
                            }
                        });
                    });
                }

                // Execute SQL (UPDATE/DELETE) if it exists
                if (sql) {
                    await new Promise((resolveSql, rejectSql) => {
                        db.run(sql, function(err) {
                            if (err) {
                                rejectSql(new Error(`SQL execution failed: ${err.message}`));
                            } else {
                                sqlRowCount = this.changes;
                                messages.push(`${sqlRowCount} rows modified`);
                                resolveSql();
                            }
                        });
                    });
                }

                db.close();
                resolve({
                    success: true,
                    message: messages.length > 0
                        ? messages.join('. ') + ` in table "${tableName}"`
                        : `Operation completed successfully in table "${tableName}"`,
                    rowCount: sqlRowCount,
                    localPath: appDbPath
                });
            } catch (error) {
                db.close();
                resolve({
                    success: false,
                    message: error.message
                });
            }
        };

        executeSequentially();
    });
}

/**
 * Create a new table in the app's SQLite database from local SQLite source
 * @param {string} appDbPath - Path to the app's SQLite database
 * @param {string} ddl - CREATE TABLE statement
 * @param {string} sql - INSERT statement or SELECT to copy data
 * @param {string} targetTableName - Target table name
 */
async function createLocalTable(appDbPath, ddl, sql, targetTableName) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(appDbPath);

    return new Promise((resolve) => {
        db.serialize(() => {
            // Drop table if exists
            db.run(`DROP TABLE IF EXISTS ${targetTableName}`, (dropErr) => {
                if (dropErr) {
                    db.close();
                    resolve({
                        success: false,
                        message: `Failed to drop existing table: ${dropErr.message}`
                    });
                    return;
                }

                // Create table
                db.run(ddl, (createErr) => {
                    if (createErr) {
                        db.close();
                        resolve({
                            success: false,
                            message: `Failed to create table: ${createErr.message}`
                        });
                        return;
                    }

                    // Execute INSERT or SELECT INTO statement
                    db.run(sql, function(execErr) {
                        if (execErr) {
                            db.close();
                            resolve({
                                success: false,
                                message: `Failed to execute SQL: ${execErr.message}`
                            });
                            return;
                        }

                        const rowCount = this.changes;
                        db.close();
                        resolve({
                            success: true,
                            message: `Table "${targetTableName}" created successfully. ${rowCount} rows processed.`,
                            rowCount: rowCount,
                            localPath: appDbPath
                        });
                    });
                });
            });
        });
    });
}

/**
 * Fetch data from a remote database and save to the app's SQLite database
 * @param {object} fullConfig - Database connection config
 * @param {object} plugin - Database plugin
 * @param {string} connectionId - Connection ID
 * @param {string} sql - SELECT query to fetch data
 * @param {string} ddl - CREATE TABLE statement for SQLite
 * @param {string} insertSql - INSERT statement for SQLite
 * @param {string} targetTableName - Target table name
 * @param {string} appDbPath - Path to the app's SQLite database
 */
async function databaseToLocal(fullConfig, plugin, connectionId, sql, ddl, insertSql, targetTableName, appDbPath) {


      const sqlite3 = require('sqlite3').verbose();

      // Use the single app SQLite database instead of creating separate files
      const localDbPath = appDbPath;

      // Check if plugin supports streaming
      if (typeof plugin.streamQuery === 'function') {
        // Use streaming to avoid loading all data into memory
        const db = new sqlite3.Database(localDbPath);

        return new Promise(async (resolve, reject) => {
          // Prepare database
          db.serialize(() => {
            db.run(`DROP TABLE IF EXISTS ${targetTableName}`, (dropErr) => {
              if (dropErr) {
                db.close();
                resolve({
                  success: false,
                  message: `Failed to drop existing table: ${dropErr.message}`
                });
                return;
              }

              db.run(ddl, async (createErr) => {
                if (createErr) {
                  db.close();
                  resolve({
                    success: false,
                    message: `Failed to create local table: ${createErr.message}`
                  });
                  return;
                }

                let totalProcessed = 0;
                let columns = null;

                // Stream data from database and insert into SQLite
                try {
                  const result = await plugin.streamQuery(
                    fullConfig,
                    connectionId,
                    sql,
                    async (rows, cols) => {
                      // Store columns from first batch
                      if (!columns) {
                        columns = cols;
                      }

                      // Use provided insertSql or fallback to auto-generated one
                      const finalInsertSql = insertSql || `INSERT INTO ${targetTableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;

                      return new Promise((batchResolve, batchReject) => {
                        const stmt = db.prepare(finalInsertSql);

                        for (const row of rows) {
                          const values = columns.map(col => row[col]);
                          stmt.run(values, (runErr) => {
                            if (runErr) {
                              console.error('Insert error:', runErr);
                            }
                          });
                        }

                        stmt.finalize((finalizeErr) => {
                          if (finalizeErr) {
                            batchReject(finalizeErr);
                          } else {
                            totalProcessed += rows.length;
                            batchResolve();
                          }
                        });
                      });
                    },
                    1000 // Batch size
                  );

                  db.close(() => {
                    if (result.success) {
                      resolve({
                        success: true,
                        message: `Data streamed and saved to local SQLite. ${totalProcessed} rows processed.`,
                        rowCount: totalProcessed,
                        localPath: localDbPath
                      });
                    } else {
                      resolve({
                        success: false,
                        message: result.message || 'Streaming failed'
                      });
                    }
                  });
                } catch (streamErr) {
                  db.close();
                  resolve({
                    success: false,
                    message: `Streaming failed: ${streamErr.message}`
                  });
                }
              });
            });
          });
        });
      } else {
        // Fallback to runQuery (loads all data into memory)
        const result = await plugin.runQuery(fullConfig, connectionId, { query: sql });

        if (!result.success) {
          return {
            success: false,
            message: `Failed to fetch data: ${result.message}`
          };
        }

        // Use the single app SQLite database
        const db = new sqlite3.Database(localDbPath);

        return new Promise((resolve) => {
          db.serialize(() => {
            const rows = result.rows || [];
            const columns = result.columns || [];

            if (rows.length === 0) {
              db.close();
              resolve({
                success: true,
                message: 'No data to transform',
                rowCount: 0,
                localPath: localDbPath
              });
              return;
            }

            // Drop table if exists and create new table using DDL
            db.run(`DROP TABLE IF EXISTS ${targetTableName}`, (dropErr) => {
              if (dropErr) {
                db.close();
                resolve({
                  success: false,
                  message: `Failed to drop existing table: ${dropErr.message}`
                });
                return;
              }

              // Create table using provided DDL
              db.run(ddl, (createErr) => {
                if (createErr) {
                  db.close();
                  resolve({
                    success: false,
                    message: `Failed to create local table: ${createErr.message}`
                  });
                  return;
                }

                // Use provided insertSql or fallback to auto-generated one
                const finalInsertSql = insertSql || `INSERT INTO ${targetTableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;

                // Process data in chunks to avoid heap errors
                const CHUNK_SIZE = 1000;
                const totalRows = rows.length;
                let processedRows = 0;

                const processChunk = (startIndex) => {
                  const endIndex = Math.min(startIndex + CHUNK_SIZE, totalRows);
                  const chunk = rows.slice(startIndex, endIndex);

                  const stmt = db.prepare(finalInsertSql);

                  for (const row of chunk) {
                    const values = columns.map(col => row[col]);
                    stmt.run(values, (runErr) => {
                      if (runErr) {
                        console.error('Insert error:', runErr);
                      }
                    });
                  }

                  stmt.finalize((finalizeErr) => {
                    if (finalizeErr) {
                      console.error('Finalize error:', finalizeErr);
                    }

                    processedRows += chunk.length;

                    if (endIndex < totalRows) {
                      // Process next chunk
                      setImmediate(() => processChunk(endIndex));
                    } else {
                      // All chunks processed
                      db.close(() => {
                        resolve({
                          success: true,
                          message: `Data saved to local SQLite. ${processedRows} rows processed.`,
                          rowCount: processedRows,
                          localPath: localDbPath
                        });
                      });
                    }
                  });
                };

                // Start processing chunks
                processChunk(0);
              });
            });
          });
        });
      }
}

module.exports = {inPlaceLocalUpdate, databaseToLocal, createLocalTable}