const parquet = require('parquetjs');
const avro = require('avsc');
const XLSX = require('xlsx');
const fs = require('fs');

/**
 * Get sample data from SQLite table and build schema
 * @param {string} tableName - Name of the table
 * @param {object} db - SQLite database instance
 * @param {Array<string>} headers - Column names
 * @param {Array<string>} columnTypes - Inferred column types
 * @param {number} sampleLimit - Number of sample rows to fetch (default: 5)
 * @returns {Promise<Object>} Schema object with columns and sampleData
 */
async function buildSchemaFromInferredTypes(tableName, db, headers, columnTypes, sampleLimit = 5) {
  return new Promise((resolve, reject) => {
    // Get sample data
    db.all(`SELECT * FROM "${tableName}" LIMIT ${sampleLimit}`, (dataErr, dataRows) => {
      if (dataErr) {
        reject(dataErr);
        return;
      }

      // Build column schema from inferred types
      const columns = headers.map((header, index) => ({
        name: header,
        type: columnTypes[index],
        nullable: true,
        isPrimary: false
      }));

      // Trim long text fields in sample data
      const sampleData = dataRows.map(row => {
        const trimmedRow = {};
        Object.keys(row).forEach(key => {
          let value = row[key];
          if (typeof value === 'string' && value.length > 100) {
            value = value.substring(0, 100) + '...';
          }
          trimmedRow[key] = value;
        });
        return trimmedRow;
      });

      resolve({
        tableName,
        columns,
        sampleData
      });
    });
  });
}

/**
 * Import Parquet file to SQLite
 */
async function importParquetToSqlite(filePath, sanitizedTableName, db, dbPath) {
  return new Promise(async (resolve) => {
    try {
      // Open Parquet file
      const reader = await parquet.ParquetReader.openFile(filePath);
      const schema = reader.schema;

      // Get cursor to read all rows
      const cursor = reader.getCursor();
      const rows = [];
      let record = null;

      while (record = await cursor.next()) {
        rows.push(record);
      }

      await reader.close();

      if (rows.length === 0) {
        resolve({
          success: false,
          message: 'No data found in Parquet file'
        });
        return;
      }

      // Extract column names from schema
      const rawHeaders = schema.fieldList.map(field =>
        field.name.replace(/[^a-zA-Z0-9_]/g, '_')
      );

      // Deduplicate column names
      const headers = [];
      const headerCounts = new Map();

      for (const header of rawHeaders) {
        const count = headerCounts.get(header) || 0;
        headerCounts.set(header, count + 1);

        if (count === 0) {
          headers.push(header);
        } else {
          headers.push(`${header}_${count + 1}`);
        }
      }

      console.log('[importParquetToSqlite] Deduplicated headers:', headers);

      // Infer column types from data
      const inferColumnType = (columnData) => {
        const validValues = columnData.filter(v => v !== null && v !== undefined);
        if (validValues.length === 0) return 'TEXT';

        const firstValue = validValues[0];
        if (typeof firstValue === 'boolean') return 'INTEGER'; // SQLite boolean as integer
        if (typeof firstValue === 'number') {
          const allIntegers = validValues.every(v => Number.isInteger(v));
          return allIntegers ? 'INTEGER' : 'REAL';
        }
        return 'TEXT';
      };

      const columnTypes = headers.map((header) => {
        const columnData = rows.map(row => row[header]);
        return inferColumnType(columnData);
      });

      // console.log('Inferred column types:', headers.map((h, i) => `${h}: ${columnTypes[i]}`));

      const tableNameForFile = sanitizedTableName;

      db.serialize(() => {
        // Drop existing table
        db.run(`DROP TABLE IF EXISTS "${tableNameForFile}"`, (dropErr) => {
          if (dropErr) {
            console.error('Drop table error:', dropErr);
            resolve({ success: false, message: 'Failed to drop existing table' });
            return;
          }

          // Create table
          const columnDefs = headers.map((h, i) => `"${h}" ${columnTypes[i]}`).join(', ');
          const createTableSQL = `CREATE TABLE "${tableNameForFile}" (${columnDefs})`;

          db.run(createTableSQL, (createErr) => {
            if (createErr) {
              console.error('Create table error:', createErr);
              resolve({ success: false, message: 'Failed to create table' });
              return;
            }

            // Insert data
            const placeholders = headers.map(() => '?').join(', ');
            const insertSQL = `INSERT INTO "${tableNameForFile}" (${headers.map(h => `"${h}"`).join(', ')}) VALUES (${placeholders})`;

            const stmt = db.prepare(insertSQL);
            rows.forEach(row => {
              const values = headers.map((header, i) => {
                const val = row[header];
                if (val === null || val === undefined) return null;

                const colType = columnTypes[i];
                if (colType === 'INTEGER') {
                  return typeof val === 'boolean' ? (val ? 1 : 0) : Math.floor(Number(val));
                } else if (colType === 'REAL') {
                  return Number(val);
                } else {
                  return String(val);
                }
              });
              stmt.run(values);
            });

            stmt.finalize(async () => {
              // Build schema from inferred types
              try {
                const schema = await buildSchemaFromInferredTypes(tableNameForFile, db, headers, columnTypes, 5);
                resolve({
                  success: true,
                  dbPath,
                  tableName: sanitizedTableName,
                  tables: [tableNameForFile],
                  rowCount: rows.length,
                  message: `Imported ${rows.length} rows from Parquet file`,
                  schema: schema
                });
              } catch (schemaErr) {
                console.error('Failed to build schema:', schemaErr);
                // Still resolve successfully, just without schema
                resolve({
                  success: true,
                  dbPath,
                  tableName: sanitizedTableName,
                  tables: [tableNameForFile],
                  rowCount: rows.length,
                  message: `Imported ${rows.length} rows from Parquet file`
                });
              }
            });
          });
        });
      });
    } catch (error) {
      console.error('Parquet import error:', error);
      resolve({
        success: false,
        message: `Failed to import Parquet: ${error.message}`
      });
    }
  });
}

/**
 * Import Avro file to SQLite
 */
async function importAvroToSqlite(filePath, sanitizedTableName, db, dbPath) {
  return new Promise((resolve) => {
    try {
      // Read Avro file
      const fileStream = fs.createReadStream(filePath);
      const decoder = avro.createFileDecoder(fileStream);
      const rows = [];

      decoder.on('data', (record) => {
        rows.push(record);
      });

      decoder.on('end', () => {
        if (rows.length === 0) {
          resolve({
            success: false,
            message: 'No data found in Avro file'
          });
          return;
        }

        // Extract column names
        const rawHeaders = Object.keys(rows[0]).map(h =>
          h.replace(/[^a-zA-Z0-9_]/g, '_')
        );

        // Deduplicate column names
        const headers = [];
        const headerCounts = new Map();

        for (const header of rawHeaders) {
          const count = headerCounts.get(header) || 0;
          headerCounts.set(header, count + 1);

          if (count === 0) {
            headers.push(header);
          } else {
            headers.push(`${header}_${count + 1}`);
          }
        }

        console.log('[importAvroToSqlite] Deduplicated headers:', headers);

        // Infer column types
        const inferColumnType = (columnData) => {
          const validValues = columnData.filter(v => v !== null && v !== undefined);
          if (validValues.length === 0) return 'TEXT';

          const firstValue = validValues[0];
          if (typeof firstValue === 'boolean') return 'INTEGER';
          if (typeof firstValue === 'number') {
            const allIntegers = validValues.every(v => Number.isInteger(v));
            return allIntegers ? 'INTEGER' : 'REAL';
          }
          return 'TEXT';
        };

        const columnTypes = headers.map((header) => {
          const columnData = rows.map(row => row[header]);
          return inferColumnType(columnData);
        });

        // console.log('Inferred column types:', headers.map((h, i) => `${h}: ${columnTypes[i]}`));

        const tableNameForFile = sanitizedTableName;

        db.serialize(() => {
          // Drop existing table
          db.run(`DROP TABLE IF EXISTS "${tableNameForFile}"`, (dropErr) => {
            if (dropErr) {
              console.error('Drop table error:', dropErr);
              resolve({ success: false, message: 'Failed to drop existing table' });
              return;
            }

            // Create table
            const columnDefs = headers.map((h, i) => `"${h}" ${columnTypes[i]}`).join(', ');
            const createTableSQL = `CREATE TABLE "${tableNameForFile}" (${columnDefs})`;

            db.run(createTableSQL, (createErr) => {
              if (createErr) {
                console.error('Create table error:', createErr);
                resolve({ success: false, message: 'Failed to create table' });
                return;
              }

              // Insert data
              const placeholders = headers.map(() => '?').join(', ');
              const insertSQL = `INSERT INTO "${tableNameForFile}" (${headers.map(h => `"${h}"`).join(', ')}) VALUES (${placeholders})`;

              const stmt = db.prepare(insertSQL);
              rows.forEach(row => {
                const values = headers.map((header, i) => {
                  const val = row[header];
                  if (val === null || val === undefined) return null;

                  const colType = columnTypes[i];
                  if (colType === 'INTEGER') {
                    return typeof val === 'boolean' ? (val ? 1 : 0) : Math.floor(Number(val));
                  } else if (colType === 'REAL') {
                    return Number(val);
                  } else {
                    return String(val);
                  }
                });
                stmt.run(values);
              });

              stmt.finalize(async () => {
                // Build schema from inferred types
                try {
                  const schema = await buildSchemaFromInferredTypes(tableNameForFile, db, headers, columnTypes, 5);
                  resolve({
                    success: true,
                    dbPath,
                    tableName: sanitizedTableName,
                    tables: [tableNameForFile],
                    rowCount: rows.length,
                    message: `Imported ${rows.length} rows from Avro file`,
                    schema: schema
                  });
                } catch (schemaErr) {
                  console.error('Failed to build schema:', schemaErr);
                  // Still resolve successfully, just without schema
                  resolve({
                    success: true,
                    dbPath,
                    tableName: sanitizedTableName,
                    tables: [tableNameForFile],
                    rowCount: rows.length,
                    message: `Imported ${rows.length} rows from Avro file`
                  });
                }
              });
            });
          });
        });
      });

      decoder.on('error', (error) => {
        console.error('Avro read error:', error);
        resolve({
          success: false,
          message: `Failed to read Avro file: ${error.message}`
        });
      });
    } catch (error) {
      console.error('Avro import error:', error);
      resolve({
        success: false,
        message: `Failed to import Avro: ${error.message}`
      });
    }
  });
}

/**
 * Import CSV/Excel (spreadsheet) file to SQLite
 */
async function importSpreadsheetToSqlite(filePath, sanitizedTableName, db, dbPath, sheets = []) {
  return new Promise((resolve) => {
    try {
      // Read the Excel/CSV file
      const workbook = XLSX.readFile(filePath, { cellDates: true, raw: false });

      // Process all sheets
      let totalRows = 0;
      const tables = [];

      // Filter out empty sheets
      let sheetsToProcess = workbook.SheetNames.filter(sheetName => {
        const ws = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
        return rawRows.length > 0;
      });

      // If specific sheets are requested, filter to only those sheets
      if (sheets && sheets.length > 0) {
        sheetsToProcess = sheetsToProcess.filter(sheetName => sheets.includes(sheetName));
        console.log(`[importSpreadsheetToSqlite] Importing only selected sheets:`, sheets);
      } else {
        console.log(`[importSpreadsheetToSqlite] Importing all sheets:`, sheetsToProcess);
      }

      if (sheetsToProcess.length === 0) {
        resolve({
          success: false,
          message: 'No data found in spreadsheet'
        });
        return;
      }

      let sheetsProcessed = 0;
      const schemas = []; // Collect schemas for all sheets

      const finishImport = () => {
        resolve({
          success: true,
          dbPath,
          tableName: sanitizedTableName,
          tables,
          rowCount: totalRows,
          message: `Imported ${totalRows} rows into ${tables.length} table(s)`,
          schemas: schemas // Return all schemas
        });
      };

      // Helper function to infer column type from data
      const inferColumnType = (columnData, maxSamples = 10000) => {
        // Filter out null/undefined/empty values
        const validValues = columnData
          .slice(0, maxSamples)
          .filter(val => val !== null && val !== undefined && val !== '');

        if (validValues.length === 0) {
          return 'TEXT'; // Default if all values are null/empty
        }

        let allInteger = true;
        let allNumeric = true;

        for (const val of validValues) {
          const strVal = String(val).trim();

          // Check if it's a number
          if (strVal === '' || isNaN(strVal)) {
            allInteger = false;
            allNumeric = false;
            break;
          }

          // Check if it's an integer
          if (!Number.isInteger(Number(strVal))) {
            allInteger = false;
          }
        }

        if (allInteger) {
          return 'INTEGER';
        } else if (allNumeric) {
          return 'REAL';
        } else {
          return 'TEXT';
        }
      };

      db.serialize(() => {
        sheetsToProcess.forEach((sheetName) => {
          const ws = workbook.Sheets[sheetName];
          const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

          // Get headers
          const rawHeaders = (rawRows[0] || []).map((h, i) =>
            h !== null && h !== undefined && String(h).trim() !== ''
              ? String(h).replace(/[^a-zA-Z0-9_]/g, '_')
              : `column_${i + 1}`
          );

          // Deduplicate column names
          const headers = [];
          const headerCounts = new Map();

          for (const header of rawHeaders) {
            const count = headerCounts.get(header) || 0;
            headerCounts.set(header, count + 1);

            if (count === 0) {
              headers.push(header);
            } else {
              headers.push(`${header}_${count + 1}`);
            }
          }

          // console.log(`[importSpreadsheetToSqlite] Sheet "${sheetName}" - Deduplicated headers:`, headers);

          // Get data rows for type inference
          const dataRows = rawRows.slice(1);

          // Infer types for each column by examining up to 10,000 rows
          const columnTypes = headers.map((header, colIndex) => {
            const columnData = dataRows.map(row => row[colIndex]);
            return inferColumnType(columnData, 10000);
          });

          // console.log('Inferred column types:', headers.map((h, i) => `${h}: ${columnTypes[i]}`));

          // Sanitize sheet name for SQLite table naming
          const sanitizedSheetName = String(sheetName)
            .replace(/[^a-zA-Z0-9_]/g, '_')
            .replace(/^[0-9]/, '_$&') // Prefix with underscore if starts with number
            .substring(0, 64); // Limit length

          // Always prefix table name with the base file name
          const tableNameForSheet = `${sanitizedTableName}_${sanitizedSheetName}`;

          tables.push(tableNameForSheet);
          console.log("tableNameForSheet: ", tableNameForSheet)
          // Drop existing table if it exists (re-importing data)
          db.run(`DROP TABLE IF EXISTS "${tableNameForSheet}"`, (dropErr) => {
            if (dropErr) {
              console.error('Drop table error:', dropErr);
              sheetsProcessed++;
              if (sheetsProcessed === sheetsToProcess.length) {
                finishImport();
              }
              return;
            }

            // Create table with inferred types
            const columnDefs = headers.map((h, i) => `"${h}" ${columnTypes[i]}`).join(', ');
            const createTableSQL = `CREATE TABLE "${tableNameForSheet}" (${columnDefs})`;

            db.run(createTableSQL, (createErr) => {
              if (createErr) {
                console.error('Create table error:', createErr);
                sheetsProcessed++;
                if (sheetsProcessed === sheetsToProcess.length) {
                  finishImport();
                }
                return;
              }

              // Insert data with type conversion
              const placeholders = headers.map(() => '?').join(', ');
              const insertSQL = `INSERT INTO "${tableNameForSheet}" (${headers.map(h => `"${h}"`).join(', ')}) VALUES (${placeholders})`;

              const stmt = db.prepare(insertSQL);
              dataRows.forEach(row => {
                const values = headers.map((_, i) => {
                  let val = row[i];

                  // Handle undefined/null
                  if (val === undefined || val === null || val === '') {
                    return null;
                  }

                  // Convert based on inferred type
                  const colType = columnTypes[i];
                  if (colType === 'INTEGER') {
                    const num = Number(val);
                    return isNaN(num) ? null : Math.floor(num);
                  } else if (colType === 'REAL') {
                    const num = Number(val);
                    return isNaN(num) ? null : num;
                  } else {
                    // TEXT - keep as string
                    return String(val);
                  }
                });

                stmt.run(values);
                totalRows++;
              });

              // Wait for finalize to complete before moving to next sheet
              stmt.finalize(async (finalizeErr) => {
                if (finalizeErr) {
                  console.error('Finalize error:', finalizeErr);
                } else {
                  // Build schema for this sheet
                  try {
                    const schema = await buildSchemaFromInferredTypes(tableNameForSheet, db, headers, columnTypes, 5);
                    schemas.push(schema);
                  } catch (schemaErr) {
                    console.error(`Failed to build schema for sheet ${tableNameForSheet}:`, schemaErr);
                  }
                }

                sheetsProcessed++;
                if (sheetsProcessed === sheetsToProcess.length) {
                  finishImport();
                }
              });
            });
          });
        });
      });
    } catch (error) {
      console.error('Import to SQLite error:', error);
      resolve({
        success: false,
        message: `Failed to import spreadsheet: ${error.message}`
      });
    }
  });
}

/**
 * Import CSV file to SQLite
 * Dedicated function for CSV files to avoid multi-sheet processing
 */
async function importCsvToSqlite(filePath, sanitizedTableName, db, dbPath) {
  return new Promise((resolve) => {
    try {
      // Read CSV file using XLSX (it handles CSV well)
      const workbook = XLSX.readFile(filePath, { cellDates: true, raw: false });

      // Get the first (and only) sheet
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      // Convert to array of arrays
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null, raw: false });

      if (rawRows.length === 0) {
        resolve({
          success: false,
          message: 'No data found in CSV file'
        });
        return;
      }

      // Get headers from first row
      const rawHeaders = (rawRows[0] || []).map((h, i) =>
        h !== null && h !== undefined && String(h).trim() !== ''
          ? String(h).replace(/[^a-zA-Z0-9_]/g, '_')
          : `column_${i + 1}`
      );

      // Deduplicate column names
      const headers = [];
      const headerCounts = new Map();

      for (const header of rawHeaders) {
        const count = headerCounts.get(header) || 0;
        headerCounts.set(header, count + 1);

        if (count === 0) {
          headers.push(header);
        } else {
          headers.push(`${header}_${count + 1}`);
        }
      }

      console.log('[importCsvToSqlite] Deduplicated headers:', headers);

      // Get data rows
      const dataRows = rawRows.slice(1);

      // Helper function to infer column type from data
      const inferColumnType = (columnData, maxSamples = 10000) => {
        const validValues = columnData
          .slice(0, maxSamples)
          .filter(val => val !== null && val !== undefined && val !== '');

        if (validValues.length === 0) {
          return 'TEXT';
        }

        let allInteger = true;
        let allNumeric = true;

        for (const val of validValues) {
          const strVal = String(val).trim();

          if (strVal === '' || isNaN(strVal)) {
            allInteger = false;
            allNumeric = false;
            break;
          }

          if (!Number.isInteger(Number(strVal))) {
            allInteger = false;
          }
        }

        if (allInteger) {
          return 'INTEGER';
        } else if (allNumeric) {
          return 'REAL';
        } else {
          return 'TEXT';
        }
      };

      // Infer types for each column
      const columnTypes = headers.map((header, colIndex) => {
        const columnData = dataRows.map(row => row[colIndex]);
        return inferColumnType(columnData, 10000);
      });

      // console.log('[CSV Import] Inferred column types:', headers.map((h, i) => `${h}: ${columnTypes[i]}`));

      // Use the sanitized table name directly (no sheet suffix for CSV)
      const tableNameForFile = sanitizedTableName;

      db.serialize(() => {
        // Drop existing table
        db.run(`DROP TABLE IF EXISTS "${tableNameForFile}"`, (dropErr) => {
          if (dropErr) {
            console.error('[CSV Import] Drop table error:', dropErr);
            resolve({ success: false, message: 'Failed to drop existing table' });
            return;
          }

          // Create table with inferred types
          const columnDefs = headers.map((h, i) => `"${h}" ${columnTypes[i]}`).join(', ');
          const createTableSQL = `CREATE TABLE "${tableNameForFile}" (${columnDefs})`;

          console.log('[CSV Import] Creating table:', createTableSQL);

          db.run(createTableSQL, (createErr) => {
            if (createErr) {
              console.error('[CSV Import] Create table error:', createErr);
              resolve({ success: false, message: 'Failed to create table' });
              return;
            }

            // Insert data with type conversion
            const placeholders = headers.map(() => '?').join(', ');
            const insertSQL = `INSERT INTO "${tableNameForFile}" (${headers.map(h => `"${h}"`).join(', ')}) VALUES (${placeholders})`;

            const stmt = db.prepare(insertSQL);
            let insertedRows = 0;

            dataRows.forEach(row => {
              const values = headers.map((_, i) => {
                let val = row[i];

                if (val === undefined || val === null || val === '') {
                  return null;
                }

                const colType = columnTypes[i];
                if (colType === 'INTEGER') {
                  const num = Number(val);
                  return isNaN(num) ? null : Math.floor(num);
                } else if (colType === 'REAL') {
                  const num = Number(val);
                  return isNaN(num) ? null : num;
                } else {
                  return String(val);
                }
              });

              stmt.run(values);
              insertedRows++;
            });

            stmt.finalize((finalizeErr) => {
              if (finalizeErr) {
                console.error('[CSV Import] Finalize error:', finalizeErr);
                resolve({ success: false, message: 'Failed to finalize import' });
                return;
              }

              console.log(`[CSV Import] Successfully imported ${insertedRows} rows to table "${tableNameForFile}"`);

              // Build schema from inferred types
              buildSchemaFromInferredTypes(tableNameForFile, db, headers, columnTypes, 5)
                .then(schema => {
                  resolve({
                    success: true,
                    dbPath,
                    tableName: sanitizedTableName,
                    tables: [tableNameForFile],
                    rowCount: insertedRows,
                    message: `Imported ${insertedRows} rows from CSV file`,
                    schema: schema
                  });
                })
                .catch(schemaErr => {
                  console.error('[CSV Import] Failed to build schema:', schemaErr);
                  // Still resolve successfully, just without schema
                  resolve({
                    success: true,
                    dbPath,
                    tableName: sanitizedTableName,
                    tables: [tableNameForFile],
                    rowCount: insertedRows,
                    message: `Imported ${insertedRows} rows from CSV file`
                  });
                });
            });
          });
        });
      });
    } catch (error) {
      console.error('[CSV Import] Error:', error);
      resolve({
        success: false,
        message: `Failed to import CSV: ${error.message}`
      });
    }
  });
}

module.exports = {
  importParquetToSqlite,
  importAvroToSqlite,
  importSpreadsheetToSqlite,
  importCsvToSqlite
};
