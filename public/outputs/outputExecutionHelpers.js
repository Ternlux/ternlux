/**
 * Output Execution Helper Functions
 * Shared utilities for executing output operations (export to file or insert to connection)
 */

const Datastore = require('@seald-io/nedb');
const { Parser } = require('@json2csv/plainjs');
const fs = require('fs');
const XLSX = require('xlsx');
const parquet = require('parquetjs');
const avro = require('avsc');

/**
 * Infer SQL column type from sample data values
 * @param {string} columnName - Column name
 * @param {Array} sampleValues - Array of sample values from the column
 * @param {string} dbType - Database type (sqlite, postgresql, mysql, mssql)
 * @returns {string} SQL column type definition
 */
// 1. Define dialect mappings in a dictionary for easy maintenance
const DIALECT_MAP = {
  sqlite: {
    NULL: () => 'TEXT',
    DATE: () => 'TEXT',
    BOOLEAN: () => 'INTEGER',
    INTEGER: () => 'INTEGER',
    FLOAT: () => 'REAL',
    OBJECT: () => 'TEXT',
    STRING: () => 'TEXT'
  },
  postgresql: {
    NULL: () => 'TEXT',
    DATE: () => 'TIMESTAMP',
    BOOLEAN: () => 'BOOLEAN',
    INTEGER: () => 'INTEGER',
    FLOAT: () => 'DOUBLE PRECISION',
    OBJECT: () => 'TEXT', // Consider 'JSONB' here depending on your needs
    STRING: (maxLen) => maxLen > 255 ? 'TEXT' : `VARCHAR(${calculateVarchar(maxLen)})`
  },
  mysql: {
    NULL: () => 'TEXT',
    DATE: () => 'DATETIME',
    BOOLEAN: () => 'BOOLEAN',
    INTEGER: () => 'INT',
    FLOAT: () => 'DOUBLE',
    OBJECT: () => 'TEXT', // Consider 'JSON' 
    STRING: (maxLen) => maxLen > 255 ? 'TEXT' : `VARCHAR(${calculateVarchar(maxLen)})`
  },
  mssql: {
    NULL: () => 'TEXT',
    DATE: () => 'DATETIME2',
    BOOLEAN: () => 'BIT',
    INTEGER: () => 'INT',
    FLOAT: () => 'FLOAT',
    OBJECT: () => 'TEXT',
    STRING: (maxLen) => maxLen > 255 ? 'VARCHAR(MAX)' : `VARCHAR(${calculateVarchar(maxLen)})`
  },
  bigquery: {
    NULL: () => 'STRING',
    DATE: () => 'TIMESTAMP',
    BOOLEAN: () => 'BOOL',
    INTEGER: () => 'INT64',
    FLOAT: () => 'FLOAT64',
    OBJECT: () => 'STRING',
    STRING: () => 'STRING'
  }
};

// Helper for VARCHAR size logic
function calculateVarchar(maxLength) {
  return Math.ceil(Math.min(Math.max(maxLength * 1.5, 255), 65535));
}

// 2. Main inference function
function inferColumnType(columnName, sampleValues, dbType = 'sqlite') {
  const validValues = sampleValues.filter(v => v !== null && v !== undefined);

  // 1. Dialect Mapping Configuration
  const DIALECTS = {
    sqlite: {
      DATE_ONLY: 'TEXT',
      TIMESTAMP: 'TEXT',
      BOOLEAN: 'INTEGER',
      INTEGER: 'INTEGER',
      FLOAT: 'REAL',
      OBJECT: 'TEXT',
      STRING: () => 'TEXT'
    },
    postgresql: {
      DATE_ONLY: 'DATE',
      TIMESTAMP: 'TIMESTAMP',
      BOOLEAN: 'BOOLEAN',
      INTEGER: 'INTEGER',
      FLOAT: 'DOUBLE PRECISION',
      OBJECT: 'TEXT',
      STRING: (len) => len > 255 ? 'TEXT' : `VARCHAR(${calculateVarchar(len)})`
    },
    mysql: {
      DATE_ONLY: 'DATE',
      TIMESTAMP: 'DATETIME',
      BOOLEAN: 'BOOLEAN',
      INTEGER: 'INT',
      FLOAT: 'DOUBLE',
      OBJECT: 'TEXT',
      STRING: (len) => len > 255 ? 'TEXT' : `VARCHAR(${calculateVarchar(len)})`
    },
    mssql: {
      DATE_ONLY: 'DATE',
      TIMESTAMP: 'DATETIME2',
      BOOLEAN: 'BIT',
      INTEGER: 'INT',
      FLOAT: 'FLOAT',
      OBJECT: 'TEXT',
      STRING: (len) => len > 255 ? 'VARCHAR(MAX)' : `VARCHAR(${calculateVarchar(len)})`
    },
    bigquery: {
      DATE_ONLY: 'DATE',      // Fix: BigQuery needs DATE for YYYY-MM-DD
      TIMESTAMP: 'TIMESTAMP', // BigQuery needs HH:MM:SS for TIMESTAMP
      BOOLEAN: 'BOOL',
      INTEGER: 'INT64',
      FLOAT: 'FLOAT64',
      OBJECT: 'STRING',
      STRING: () => 'STRING'
    }
  };

  const dialect = DIALECTS[dbType] || DIALECTS.sqlite;

  if (validValues.length === 0) {
    return dbType === 'bigquery' ? 'STRING' : 'TEXT';
  }

  // 2. State tracking for single-pass detection
  let isAllDates = true;
  let hasTimeComponent = false;
  let isAllBools = true;
  let isAllInts = true;
  let isAllFloats = true;
  let hasObjects = false;
  let maxLength = 0;

  // 3. Single Pass Loop
  for (const v of validValues) {
    const strV = String(v);
    if (strV.length > maxLength) maxLength = strV.length;

    // Object Check
    const isObj = typeof v === 'object' && v !== null && !(v instanceof Date);
    if (isObj) hasObjects = true;

    // Date/Timestamp Check
    if (isAllDates) {
      const isDateInstance = v instanceof Date;
      const isDateStr = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
      
      if (isDateInstance || isDateStr) {
        // If any value contains a colon (:) or 'T', it has a time component
        if (strV.includes(':') || strV.includes('T')) {
          hasTimeComponent = true;
        }
      } else {
        isAllDates = false;
      }
    }

    // Boolean Check
    if (isAllBools) {
      const isBool = typeof v === 'boolean' || v === 'true' || v === 'false';
      if (!isBool) isAllBools = false;
    }

    // Number Check
    if (isAllFloats) {
      const isNum = typeof v === 'number' || (typeof v === 'string' && strV.trim() !== '' && !isNaN(Number(v)));
      if (!isNum) {
        isAllInts = false;
        isAllFloats = false;
      } else if (isAllInts && !Number.isInteger(Number(v))) {
        isAllInts = false;
      }
    }
  }

  // 4. Final Type Resolution
  if (isAllDates) {
    return hasTimeComponent ? dialect.TIMESTAMP : dialect.DATE_ONLY;
  }
  if (isAllBools) return dialect.BOOLEAN;
  if (isAllInts) return dialect.INTEGER;
  if (isAllFloats) return dialect.FLOAT;
  if (hasObjects) return dialect.OBJECT;

  // Default to String
  return typeof dialect.STRING === 'function' ? dialect.STRING(maxLength) : dialect.STRING;
}

/**
 * Infer column types for all columns from sample data
 * @param {Array} data - Array of data rows
 * @param {string} dbType - Database type (sqlite, postgresql, mysql, mssql)
 * @param {number} sampleSize - Number of rows to sample for type inference
 * @returns {Object} Map of column names to SQL types
 */
function inferColumnTypes(data, dbType = 'sqlite', sampleSize = 100) {
  if (!data || data.length === 0) return {};

  const columns = Object.keys(data[0]);
  const columnTypes = {};

  // Sample rows for type inference (use first N rows)
  const sampleRows = data.slice(0, Math.min(sampleSize, data.length));

  columns.forEach(col => {
    const sampleValues = sampleRows.map(row => row[col]);
    columnTypes[col] = inferColumnType(col, sampleValues, dbType);
  });

  return columnTypes;
}

/**
 * Infer Parquet schema from data
 * @param {Array} data - Array of data rows
 * @returns {Object} Parquet schema definition
 */
function inferParquetSchema(data) {
  if (!data || data.length === 0) return {};

  const schema = {};
  const sampleRow = data[0];

  Object.keys(sampleRow).forEach(col => {
    const sampleValues = data.slice(0, 100).map(row => row[col]).filter(v => v !== null && v !== undefined);

    if (sampleValues.length === 0) {
      schema[col] = { type: 'UTF8', optional: true };
      return;
    }

    const firstValue = sampleValues[0];

    if (typeof firstValue === 'boolean') {
      schema[col] = { type: 'BOOLEAN', optional: true };
    } else if (typeof firstValue === 'number') {
      // Check if all numbers are integers
      const allIntegers = sampleValues.every(v => Number.isInteger(v));
      if (allIntegers) {
        schema[col] = { type: 'INT64', optional: true };
      } else {
        schema[col] = { type: 'DOUBLE', optional: true };
      }
    } else if (firstValue instanceof Date) {
      schema[col] = { type: 'TIMESTAMP_MILLIS', optional: true };
    } else {
      schema[col] = { type: 'UTF8', optional: true };
    }
  });

  return schema;
}

/**
 * Infer Avro schema from data
 * @param {Array} data - Array of data rows
 * @returns {Object} Avro schema definition
 */
function inferAvroSchema(data) {
  if (!data || data.length === 0) {
    return {
      type: 'record',
      name: 'ExportedData',
      fields: []
    };
  }

  const fields = [];
  const sampleRow = data[0];

  Object.keys(sampleRow).forEach(col => {
    const sampleValues = data.slice(0, 100).map(row => row[col]).filter(v => v !== null && v !== undefined);

    let avroType = 'string';

    if (sampleValues.length > 0) {
      const firstValue = sampleValues[0];

      if (typeof firstValue === 'boolean') {
        avroType = 'boolean';
      } else if (typeof firstValue === 'number') {
        const allIntegers = sampleValues.every(v => Number.isInteger(v));
        avroType = allIntegers ? 'long' : 'double';
      } else if (firstValue instanceof Date) {
        avroType = 'long'; // Store as timestamp
      }
    }

    // Make all fields nullable
    fields.push({
      name: col,
      type: ['null', avroType]
    });
  });

  return {
    type: 'record',
    name: 'ExportedData',
    fields: fields
  };
}

/**
 * Execute output operation - export to local file or insert to database connection
 * @param {Object} sourceConnection - Source connection configuration
 * @param {Object} sourceTableSchema - Source table schema with columns and tableName
 * @param {Object} outputSettings - Output settings (outputType, format, savePath, connectionId, tableName)
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @param {Function} getDb - Function to get NeDB database instance by collection name
 * @returns {Promise<Object>} Result with success, message, filePath/rowsInserted
 */
async function executeOutput(
  sourceConnection,
  sourceTableSchema,
  outputSettings,
  pluginManager,
  getFullConfig,
  getDb
) {
  try {
    const { outputType, format, savePath, connectionId, tableName } = outputSettings;

    console.log(`[Output] Starting ${outputType} output operation`);

    // Step 1: Load source data
    let sourceData = [];

    // Handle local files separately (they don't use plugin system)
    const isLocalFile = sourceConnection.localPath;

    if (isLocalFile) {
      if (sourceConnection.dbType === 'nedb') {
        // Local NeDB file
        const db = new Datastore({ filename: sourceConnection.localPath, autoload: false });

        await new Promise((resolve, reject) => {
          db.loadDatabase((err) => err ? reject(err) : resolve());
        });

        sourceData = await new Promise((resolve, reject) => {
          db.find({}).limit(1000000).exec((err, docs) => {
            if (err) reject(err);
            else resolve(docs);
          });
        });
      } else if (sourceConnection.dbType === 'sqlite') {
        // Local SQLite file
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(sourceConnection.localPath);

        const query = `SELECT * FROM ${sourceTableSchema.tableName}`;
        sourceData = await new Promise((resolve, reject) => {
          db.all(query, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
        });

        db.close();
      }
    } else {
      // Remote connection - use plugin system
      // Use the stored query from schema if available, otherwise construct one
      let queryObj;


      // Fallback: construct query from scratch
      const schema = sourceConnection.dbConfig?.schema;
      const plugin = pluginManager.getConnector(sourceConnection.dbType);

      // Use quoteIdentifier to properly format table name with schema
      let fullTableName;
      if (plugin && plugin.quoteIdentifier) {
        fullTableName = plugin.quoteIdentifier(sourceTableSchema.tableName, schema, sourceConnection.dbConfig);
      } else {
        // Fallback to manual formatting
        fullTableName = schema ? `${schema}.${sourceTableSchema.tableName}` : sourceTableSchema.tableName;
      }

      const sqlQuery = `SELECT * FROM ${fullTableName}`;
      
      queryObj = {
        // For SQL databases
        query: sqlQuery,
        tableName: sourceTableSchema.tableName,
        schema: sourceConnection.dbConfig?.schema,

        // For MongoDB
        collection: sourceTableSchema.tableName,
        filter: {},

        // For Google Sheets
        spreadsheetId: sourceTableSchema.tableName,
        sheetName: sourceTableSchema.sheetName,
        range: null,

        // Common
        limit: 1000000
      };
      const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
      
      const result = await plugin.runQuery(fullConfig, sourceConnection.id, queryObj);
      // console.log('queryObj: ', queryObj)
      sourceData = result.rows || [];
      
  
      console.log(`[Output] Loaded ${sourceData.length} rows from source`);
    }


    if (outputType === 'local') {
      // Export to local file
      return await exportToLocalFile(sourceData, format, savePath);
    } else if (outputType === 'connection') {
      // Insert to database connection
      return await insertToConnection(sourceData, connectionId, tableName, pluginManager, getFullConfig, getDb);
    } else {
      return {
        success: false,
        message: `Invalid output type: ${outputType}`
      };
    }

  } catch (error) {
    console.error('Output execution error:', error);
    return {
      success: false,
      message: `Output execution failed: ${error.message}`,
      error: error.stack
    };
  }
}

/**
 * Export data to local file
 * @param {Array} sourceData - Array of data rows
 * @param {string} format - File format (json, csv, excel, nedb, sqlite, parquet, avro)
 * @param {string} savePath - File path to save to
 * @returns {Promise<Object>} Result with success, message, filePath
 */
async function exportToLocalFile(sourceData, format, savePath) {

  if (format === 'json') {
    fs.writeFileSync(savePath, JSON.stringify(sourceData, null, 2), 'utf8');
    return {
      success: true,
      message: `Successfully exported ${sourceData.length} rows to JSON`,
      filePath: savePath
    };
  } else if (format === 'csv') {
    const parser = new Parser();
    const csv = parser.parse(sourceData);
    fs.writeFileSync(savePath, csv, 'utf8');
    return {
      success: true,
      message: `Successfully exported ${sourceData.length} rows to CSV`,
      filePath: savePath
    };
  } else if (format === 'excel') {
    const worksheet = XLSX.utils.json_to_sheet(sourceData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
    XLSX.writeFile(workbook, savePath);
    return {
      success: true,
      message: `Successfully exported ${sourceData.length} rows to Excel`,
      filePath: savePath
    };
  } else if (format === 'nedb') {
    const db = new Datastore({ filename: savePath, autoload: false });
    await new Promise((resolve, reject) => {
      db.loadDatabase((err) => err ? reject(err) : resolve());
    });
    await new Promise((resolve, reject) => {
      db.insert(sourceData, (err, docs) => {
        if (err) reject(err);
        else resolve(docs);
      });
    });
    return {
      success: true,
      message: `Successfully exported ${sourceData.length} documents to NeDB`,
      filePath: savePath
    };
  } else if (format === 'sqlite') {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(savePath);
    console.log('savePath: ', savePath)
    // Infer columns and types from data
    if (sourceData.length > 0) {
      const columns = Object.keys(sourceData[0]);
      const columnTypes = inferColumnTypes(sourceData, 'sqlite');
      const columnDefs = columns.map(col => `${col} ${columnTypes[col]}`).join(', ');

      // Drop table if it exists to ensure fresh schema
      await new Promise((res, rej) => {
        db.run('DROP TABLE IF EXISTS data', (err) => err ? rej(err) : res());
      });

      const createTableSql = `CREATE TABLE data (${columnDefs})`;
      // console.log('columnDefs: ', columnDefs, columns)

      await new Promise((res, rej) => {
        db.run(createTableSql, (err) => err ? rej(err) : res());
      });

      // Insert data using transaction
      await new Promise((res, rej) => {
        db.serialize(() => {
          db.run("BEGIN TRANSACTION");
          const placeholders = columns.map(() => '?').join(', ');
          const stmt = db.prepare(`INSERT INTO data (${columns.join(', ')}) VALUES (${placeholders})`);

          for (const row of sourceData) {
            const values = columns.map(col => {
              const val = row[col];
              if (val === null || val === undefined) return null;
              if (val instanceof Date) return val.toISOString();
              if (typeof val === 'object') return JSON.stringify(val);
              return val;
            });
            stmt.run(values);
          }

          stmt.finalize();
          db.run("COMMIT", (err) => {
            if (err) rej(err);
            else res();
          });
        });
      });
    }

    db.close();

    return {
      success: true,
      message: `Successfully exported ${sourceData.length} rows to SQLite`,
      filePath: savePath
    };
  } else if (format === 'parquet') {
    try {
      // Infer schema from data
      const schemaFields = inferParquetSchema(sourceData);
      const schema = new parquet.ParquetSchema(schemaFields);

      // Create writer
      const writer = await parquet.ParquetWriter.openFile(schema, savePath);

      // Write rows
      for (const row of sourceData) {
        // Convert dates to timestamps
        const processedRow = {};
        Object.keys(row).forEach(key => {
          const value = row[key];
          if (value instanceof Date) {
            processedRow[key] = value.getTime();
          } else if (value === null || value === undefined) {
            processedRow[key] = null;
          } else {
            processedRow[key] = value;
          }
        });
        await writer.appendRow(processedRow);
      }

      await writer.close();

      return {
        success: true,
        message: `Successfully exported ${sourceData.length} rows to Parquet`,
        filePath: savePath
      };
    } catch (error) {
      console.error('Parquet export error:', error);
      return {
        success: false,
        message: `Failed to export Parquet: ${error.message}`
      };
    }
  } else if (format === 'avro') {
    try {
      // Infer schema from data
      const schemaDefinition = inferAvroSchema(sourceData);
      const avroType = avro.Type.forSchema(schemaDefinition);

      // Process data (convert dates to timestamps)
      const processedData = sourceData.map(row => {
        const processedRow = {};
        Object.keys(row).forEach(key => {
          const value = row[key];
          if (value instanceof Date) {
            processedRow[key] = value.getTime();
          } else if (value === null || value === undefined) {
            processedRow[key] = null;
          } else {
            processedRow[key] = value;
          }
        });
        return processedRow;
      });

      // Write to file
      const encoder = avroType.createFileEncoder(savePath);
      processedData.forEach(row => encoder.write(row));
      encoder.end();

      return new Promise((resolve, reject) => {
        encoder.on('finish', () => {
          resolve({
            success: true,
            message: `Successfully exported ${sourceData.length} rows to Avro`,
            filePath: savePath
          });
        });
        encoder.on('error', (error) => {
          reject({
            success: false,
            message: `Failed to export Avro: ${error.message}`
          });
        });
      });
    } catch (error) {
      console.error('Avro export error:', error);
      return {
        success: false,
        message: `Failed to export Avro: ${error.message}`
      };
    }
  } else {
    return {
      success: false,
      message: `Format ${format} is not supported. Supported formats: json, csv, excel, nedb, sqlite, parquet, avro`
    };
  }
}

/**
 * Insert data to database connection
 * @param {Array} sourceData - Array of data rows
 * @param {string} connectionId - Target connection ID
 * @param {string} tableName - Target table/collection name
 * @param {Object} pluginManager - Plugin manager instance
 * @param {Function} getFullConfig - Function to get full config with credentials
 * @param {Function} getDb - Function to get NeDB database instance by collection name
 * @returns {Promise<Object>} Result with success, message, documentsInserted/rowsInserted
 */
async function insertToConnection(sourceData, connectionId, tableName, pluginManager, getFullConfig, getDb) {
  const connectionsDb = getDb('connections');
  const targetConnectionDocs = await connectionsDb.findAsync({});
  const targetConnection = targetConnectionDocs.find(c => c.id === connectionId);

  if (!targetConnection) {
    return {
      success: false,
      message: `Connection ${connectionId} not found`
    };
  }

  // Check if target is cloud storage or Google Sheets
  const plugin = pluginManager.getConnector(targetConnection.dbType);
  const isCloudStorage = plugin?.storageType === 'cloud-storage' || targetConnection.dbType === 'google-sheets';

  if (isCloudStorage) {
    // Upload data to cloud storage as JSON or CSV
    const fullConfig = await getFullConfig(targetConnection.id, targetConnection.dbConfig || {});

    // Parse containerName and objectName from tableName
    // Format: "bucket-name/path/to/file.json" or "bucket-name/file.csv"
    const parts = tableName.split('/');

    let containerName, objectName, fileName;

    if (parts.length < 2) {
      // For Google Sheets, if no "/" separator, use entire tableName as filename
      if (targetConnection.dbType === 'google-sheets') {
        containerName = 'root'; // Not used by Google Sheets, but required by interface
        objectName = tableName;
        fileName = tableName;
      } else {
        return {
          success: false,
          message: 'Cloud storage output requires format: "bucket-name/path/to/file.ext" (e.g., "my-bucket/exports/data.json")'
        };
      }
    } else {
      containerName = parts[0];
      objectName = parts.slice(1).join('/');
      fileName = objectName.split('/').pop();
    }

    // Determine format from file extension
    let fileContent;
    let contentType;

    if (fileName.endsWith('.json')) {
      // Export as JSON
      fileContent = Buffer.from(JSON.stringify(sourceData, null, 2), 'utf-8');
      contentType = 'application/json';
    } else if (fileName.endsWith('.csv')) {
      // Export as CSV
      const parser = new Parser();
      const csv = parser.parse(sourceData);
      fileContent = Buffer.from(csv, 'utf-8');
      contentType = 'text/csv';
    } else {
      // Default to JSON
      fileContent = Buffer.from(JSON.stringify(sourceData, null, 2), 'utf-8');
      contentType = 'application/json';
    }

    // Upload to cloud storage
    const result = await plugin.uploadObject(
      fullConfig,
      targetConnection.id,
      containerName,
      objectName,
      fileContent,
      contentType
    );

    if (result.success) {
      return {
        success: true,
        message: `Successfully uploaded ${sourceData.length} rows to ${containerName}/${objectName}`,
        rowsUploaded: sourceData.length,
        cloudPath: `${containerName}/${objectName}`
      };
    } else {
      return {
        success: false,
        message: `Failed to upload to cloud storage: ${result.message}`
      };
    }
  }

  const isNoSQLTarget = ['mongodb', 'nedb'].includes(targetConnection.dbType);

  if (isNoSQLTarget) {
    // Insert to NoSQL database
    if (targetConnection.dbType === 'nedb') {
      return {
        success: false,
        message: 'NeDB connection output not yet implemented'
      };
    } else {
      // MongoDB
      const fullConfig = await getFullConfig(targetConnection.id, targetConnection.dbConfig || {});
      const plugin = pluginManager.getConnector(targetConnection.dbType);

      const result = await plugin.runQuery(fullConfig, targetConnection.id, {
        operation: 'insertMany',
        collection: tableName,
        documents: sourceData
      });

      return {
        success: true,
        message: `Successfully inserted ${sourceData.length} documents into ${tableName}`,
        documentsInserted: sourceData.length
      };
    }
  } else {
    // Insert to SQL database
    const fullConfig = await getFullConfig(targetConnection.id, targetConnection.dbConfig || {});
    const plugin = pluginManager.getConnector(targetConnection.dbType);

    // Infer columns and types from data
    if (sourceData.length > 0) {
      const columns = Object.keys(sourceData[0]);
      const columnTypes = inferColumnTypes(sourceData, targetConnection.dbType);
      const columnDefs = columns.map(col => `${col} ${columnTypes[col]}`).join(', ');

      // Quote the table name using the plugin's quoteIdentifier
      // For BigQuery with dataset.table format, parse and quote properly
      let quotedTableName = tableName;
      if (plugin && plugin.quoteIdentifier) {
        if (targetConnection.dbType === 'bigquery' && tableName.includes('.')) {
          const parts = tableName.split('.');
          if (parts.length === 2) {
            const [schema, table] = parts;
            quotedTableName = plugin.quoteIdentifier(table, schema, targetConnection.dbConfig);
          } else {
            quotedTableName = `\`${tableName}\``;
          }
        } else {
          quotedTableName = plugin.quoteIdentifier(tableName, null, targetConnection.dbConfig);
        }
      }

      // Try to create table - will fail silently if it already exists
      const createTableSql = `CREATE TABLE ${quotedTableName} (${columnDefs})`;
      console.log('createTableSql: ', createTableSql)
      try {
        await plugin.runQuery(fullConfig, targetConnection.id, {query: createTableSql});
      } catch (err) {
        // Table already exists, that's fine
        console.log('Table creation skipped (may already exist):', err);
      }

      // Insert data in chunks using plugin's batchInsert function
      const CHUNK_SIZE = 1000;
      let totalInserted = 0;

      for (let chunkStart = 0; chunkStart < sourceData.length; chunkStart += CHUNK_SIZE) {
        const chunk = sourceData.slice(chunkStart, chunkStart + CHUNK_SIZE);

        // Use plugin's batchInsert function if available, otherwise fallback to individual inserts
        if (plugin.batchInsert) {
          // batchInsert expects unquoted table name (it handles quoting internally)
          const result = await plugin.batchInsert(fullConfig, targetConnection.id, tableName, columns, chunk);
          if (!result.success) {
            throw new Error(result.message || 'Batch insert failed');
          }
          totalInserted += result.rowsInserted;
        } else {
          // Fallback: individual INSERT statements (use quoted table name)
          const insertStatements = chunk.map(row => {
            const values = columns.map(col => {
              const val = row[col];
              if (val === null || val === undefined) return 'NULL';
              if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
              if (val instanceof Date) return `'${val.toISOString()}'`;
              if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
              return val;
            });
            return `INSERT INTO ${quotedTableName} (${columns.join(', ')}) VALUES (${values.join(', ')})`;
          });

          const batchInsert = insertStatements.join('; ');
          await plugin.runQuery(fullConfig, targetConnection.id, {query: batchInsert});
          totalInserted += chunk.length;
        }
      }

      return {
        success: true,
        message: `Successfully inserted ${totalInserted} rows into ${tableName}`,
        rowsInserted: totalInserted
      };
    }

    return {
      success: false,
      message: 'No data to insert'
    };
  }
}

module.exports = {
  executeOutput,
  exportToLocalFile,
  insertToConnection,
  inferColumnTypes,
  inferColumnType,
  inferParquetSchema,
  inferAvroSchema
};
