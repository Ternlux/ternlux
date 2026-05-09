
/**
 * Execute DDL (ALTER TABLE) and/or UPDATE/DELETE on a table in the app's SQLite database
 * @param {string} appDbPath - Path to the app's SQLite database
 * @param {string} ddl - ALTER TABLE statement (optional, can be null)
 * @param {string} sql - UPDATE or DELETE SQL statement (optional, can be null)
 * @param {string} tableName - Name of the table being modified
 */
async function inPlaceLocalUpdate(appDbPath, ddl, sql, tableName, sqlitePool) {
    if (!sqlitePool) {
        throw new Error('[Sqlite.inPlaceLocalUpdate] sqlitePool is required');
    }

    return sqlitePool.executeWrite(async (db) => {
        let ddlRowCount = 0;
        let sqlRowCount = 0;
        let messages = [];

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

            return {
                success: true,
                message: messages.length > 0
                    ? messages.join('. ') + ` in table "${tableName}"`
                    : `Operation completed successfully in table "${tableName}"`,
                rowCount: sqlRowCount,
                localPath: appDbPath
            };
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    });
}

/**
 * Create a new table in the app's SQLite database from local SQLite source
 * @param {string} appDbPath - Path to the app's SQLite database
 * @param {string} ddl - CREATE TABLE statement
 * @param {string} sql - INSERT statement or SELECT to copy data
 * @param {string} targetTableName - Target table name
 */
async function createLocalTable(appDbPath, ddl, sql, targetTableName, sqlitePool) {
    if (!sqlitePool) {
        throw new Error('[Sqlite.createLocalTable] sqlitePool is required');
    }

    return sqlitePool.executeWrite(async (db) => {
        try {
            // Drop table if exists
            await new Promise((resolve, reject) => {
                db.run(`DROP TABLE IF EXISTS ${targetTableName}`, (dropErr) => {
                    if (dropErr) reject(new Error(`Failed to drop existing table: ${dropErr.message}`));
                    else resolve();
                });
            });

            // Create table
            await new Promise((resolve, reject) => {
                db.run(ddl, (createErr) => {
                    if (createErr) reject(new Error(`Failed to create table: ${createErr.message}`));
                    else resolve();
                });
            });

            // Execute INSERT or SELECT INTO statement
            const rowCount = await new Promise((resolve, reject) => {
                db.run(sql, function(execErr) {
                    if (execErr) reject(new Error(`Failed to execute SQL: ${execErr.message}`));
                    else resolve(this.changes);
                });
            });

            return {
                success: true,
                message: `Table "${targetTableName}" created successfully. ${rowCount} rows processed.`,
                rowCount: rowCount,
                localPath: appDbPath
            };
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
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
async function databaseToLocal(fullConfig, plugin, connectionId, sql, ddl, insertSql, targetTableName, appDbPath, sqlitePool) {
      if (!sqlitePool) {
        throw new Error('[Sqlite.databaseToLocal] sqlitePool is required');
      }

      const localDbPath = appDbPath;

      // Check if plugin supports streaming
      if (typeof plugin.streamQuery === 'function') {
        // Use streaming to avoid loading all data into memory
        return sqlitePool.executeWrite(async (db) => {

          try {
            // Drop table if exists
            await new Promise((resolve, reject) => {
              db.run(`DROP TABLE IF EXISTS ${targetTableName}`, (dropErr) => {
                if (dropErr) reject(new Error(`Failed to drop existing table: ${dropErr.message}`));
                else resolve();
              });
            });

            // Create table
            await new Promise((resolve, reject) => {
              db.run(ddl, (createErr) => {
                if (createErr) reject(new Error(`Failed to create local table: ${createErr.message}`));
                else resolve();
              });
            });

            let totalProcessed = 0;
            let columns = null;

            // Stream data from database and insert into SQLite
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

            if (result.success) {
              return {
                success: true,
                message: `Data streamed and saved to local SQLite. ${totalProcessed} rows processed.`,
                rowCount: totalProcessed,
                localPath: localDbPath
              };
            } else {
              return {
                success: false,
                message: result.message || 'Streaming failed'
              };
            }
          } catch (error) {
            return {
              success: false,
              message: `Streaming failed: ${error.message}`
            };
          }
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

        return sqlitePool.executeWrite(async (db) => {
          try {
            const rows = result.rows || [];
            const columns = result.columns || [];

            if (rows.length === 0) {
              return {
                success: true,
                message: 'No data to transform',
                rowCount: 0,
                localPath: localDbPath
              };
            }

            // Drop table if exists
            await new Promise((resolve, reject) => {
              db.run(`DROP TABLE IF EXISTS ${targetTableName}`, (dropErr) => {
                if (dropErr) reject(new Error(`Failed to drop existing table: ${dropErr.message}`));
                else resolve();
              });
            });

            // Create table using provided DDL
            await new Promise((resolve, reject) => {
              db.run(ddl, (createErr) => {
                if (createErr) reject(new Error(`Failed to create local table: ${createErr.message}`));
                else resolve();
              });
            });

            // Use provided insertSql or fallback to auto-generated one
            const finalInsertSql = insertSql || `INSERT INTO ${targetTableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;

            // Process data in chunks to avoid heap errors
            const CHUNK_SIZE = 1000;
            const totalRows = rows.length;
            let processedRows = 0;

            const processChunk = async (startIndex) => {
              const endIndex = Math.min(startIndex + CHUNK_SIZE, totalRows);
              const chunk = rows.slice(startIndex, endIndex);

              await new Promise((resolve, reject) => {
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
                    reject(finalizeErr);
                  } else {
                    processedRows += chunk.length;
                    resolve();
                  }
                });
              });

              if (endIndex < totalRows) {
                // Process next chunk
                await processChunk(endIndex);
              }
            };

            // Start processing chunks
            await processChunk(0);

            return {
              success: true,
              message: `Data saved to local SQLite. ${processedRows} rows processed.`,
              rowCount: processedRows,
              localPath: localDbPath
            };
          } catch (error) {
            return {
              success: false,
              message: error.message
            };
          }
        });
      }
}

module.exports = {inPlaceLocalUpdate, databaseToLocal, createLocalTable}