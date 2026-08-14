/**
 * Utility functions for loading table/collection schemas
 */

/**
 * Load table schema (columns and sample data) from a database or local source
 * @param {Object} params - Parameters object
 * @param {Object} params.connection - Connection object { id, dbType, dbConfig, connectionType }
 * @param {string} params.tableName - Name of the table/collection
 * @param {string} params.tableSchema - Schema name (for SQL databases, optional)
 * @param {string} params.localPath - Path to local NeDB file (optional, for local MongoDB transformations)
 * @param {string} params.sheetName - Sheet name (for Google Sheets, optional)
 * @param {number} params.limit - Number of sample rows to fetch (default: 5)
 * @returns {Promise<Object|null>} Schema object { tableName, columns, sampleData } or null on error
 */
export const loadTableSchema = async ({
  connection,
  tableName,
  tableSchema = null,
  localPath = null,
  sheetName = null,
  limit = 5
}) => {
  try {
    const isMongoDB = connection.dbType === 'mongodb';
    const isSQLite = connection.dbType === 'sqlite';
    const isGoogleSheets = connection.dbType === 'google-sheets';
    const isVectorDB = connection.dbCategory === 'Vector'
      || connection.dbType === 'lancedb'
      || connection.dbType === 'pinecone';

    console.log('connection: ', connection)

    // Handle vector databases (LanceDB, Pinecone) via the vector-db-executor skill.
    // Must run before the localPath branch — LanceDB sets localPath but is not SQLite/NeDB.
    if (isVectorDB) {
      if (!window.electronAPI?.skills?.queryVectorPreview) {
        console.error('Vector DB preview API not available');
        return null;
      }

      const result = await window.electronAPI.skills.queryVectorPreview({
        vectorDbType: connection.dbType,
        tableName,
        namespace: tableSchema || '',
        dbConfig: connection.dbConfig || {},
        connectionId: connection.id,
        targetLocalPath: localPath
      });
      console.log('result: ', result)
      if (!result.success || !result.data) {
        console.error('Failed to query vector database for schema:', result.message);
        return null;
      }

      const sampleData = result.data.slice(0, limit);
      const columns = sampleData.length > 0
        ? Object.keys(sampleData[0]).map(name => {
            const value = sampleData[0][name];
            let type = 'unknown';
            if (typeof value === 'number') type = 'number';
            else if (typeof value === 'boolean') type = 'boolean';
            else if (Array.isArray(value)) type = 'array';
            else if (typeof value === 'string' && /\[\d+ dims\]/.test(value)) type = 'vector';
            else if (typeof value === 'string') type = 'string';
            else if (value && typeof value === 'object') type = 'object';
            return { name, type, nullable: true };
          })
        : [];

      return {
        tableName,
        columns,
        sampleData
      };
    }

    // Handle local files (NeDB for MongoDB, SQLite for SQL transformations)
    if (localPath && window.electronAPI?.db?.readLocalCollection) {
      // Determine storage type from connection dbType
      const storageType = connection.dbType === 'sqlite' ? 'sqlite' : connection.dbType === 'duckdb' ? 'duckdb' : 'nedb';

      // DuckDB reads the file in place and reports its own column types, so a
      // single read gives both the schema and the sample — no PRAGMA, and no
      // guessing types from the first row the way the NeDB path has to.
      if (storageType === 'duckdb') {
        const result = await window.electronAPI.db.readLocalCollection(localPath, limit, 'duckdb', null, tableName || null);
        if (!result.success || !result.rows) return null;
        return {
          tableName: tableName || result.currentTable,
          columns: (result.columns || []).map(({ name, type }) => ({
            name, type, nullable: true, isPrimary: false,
          })),
          sampleData: result.rows.slice(0, limit),
        };
      }

      if (storageType === 'sqlite' && tableName) {
        // Remove schema prefix if present (e.g., "public.tablename" -> "tablename")
        const tableNameOnly = tableName.includes('.') ? tableName.split('.').pop() : tableName;

        // Get column information using PRAGMA table_info
        const pragmaQuery = `PRAGMA table_info("${tableNameOnly}")`;
        const pragmaResult = await window.electronAPI.db.readLocalCollection(
          localPath,
          1000,
          'sqlite',
          pragmaQuery,
          tableNameOnly
        );

        let columns = [];
        if (pragmaResult.success && pragmaResult.rows && pragmaResult.rows.length > 0) {
          // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
          columns = pragmaResult.rows.map(row => ({
            name: row.name,
            type: row.type || 'TEXT',
            nullable: row.notnull === 0,
            isPrimary: row.pk === 1
          }));
        }

        // Get sample data using database-specific preview query
        const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
          'sqlite',
          `"${tableNameOnly}"`,
          limit
        );
        const previewSql = previewResult.success ? previewResult.previewQuery : `SELECT * FROM "${tableNameOnly}" LIMIT ${limit}`;

        const dataResult = await window.electronAPI.db.readLocalCollection(
          localPath,
          limit,
          'sqlite',
          previewSql,
          tableNameOnly
        );

        if (dataResult.success && dataResult.rows) {
          return {
            tableName,
            columns: columns.length > 0 ? columns : (
              dataResult.rows.length > 0
                ? Object.keys(dataResult.rows[0]).map(name => ({ name, type: 'TEXT' }))
                : []
            ),
            sampleData: dataResult.rows.slice(0, limit)
          };
        }

        return null;
      } else if (storageType === 'nedb') {
        // For NeDB, read sample data and infer columns
        const result = await window.electronAPI.db.readLocalCollection(localPath, limit, storageType, null, null);

        if (result.success && result.rows) {
          const rows = result.rows;
          return {
            tableName,
            columns: rows.length > 0 ? Object.keys(rows[0]).map(name => ({
              name,
              type: 'unknown',
              nullable: true,
              isPrimary: name === '_id'
            })) : [],
            sampleData: rows.slice(0, limit)
          };
        }
      }

      return null;
    }

    // For remote database connections, ensure dbConnect API is available
    if (!localPath && !window.electronAPI?.dbConnect) {
      console.error('Database API not available for remote connections');
      return null;
    }

    if (isMongoDB) {
      // MongoDB handling

      // MongoDB database collection
      const query = {
        collection: tableName,
        filter: {},
        limit
      };

      const result = await window.electronAPI.dbConnect.runQuery(
        connection.dbType,
        connection.dbConfig,
        query,
        connection.id
      );

      if (!result.success || !result.rows) {
        return null;
      }

      // Get sample data
      const sampleData = result.rows.slice(0, limit).map(row => {
        const trimmedRow = {};
        Object.keys(row).forEach(key => {
          const value = row[key];
          if (typeof value === 'string' && value.length > 100) {
            trimmedRow[key] = value.substring(0, 100) + '...';
          } else {
            trimmedRow[key] = value;
          }
        });
        return trimmedRow;
      });

      // Infer columns from sample data
      const columns = sampleData.length > 0
        ? Object.keys(sampleData[0]).map(name => ({ name, type: 'unknown' }))
        : [];

      return {
        tableName,
        columns,
        sampleData
      };
    } else if (isGoogleSheets) {
      // Google Sheets API handling - use plugin's getTableSchema method
      // tableName is actually the spreadsheet ID for Google Sheets
      const result = await window.electronAPI.dbConnect.getTableSchema(
        connection.dbType,
        connection.dbConfig,
        connection.id,
        tableName, // spreadsheetId
        sheetName,
        limit
      );

      if (!result.success) {
        console.error('Failed to get Google Sheets schema:', result.message);
        return null;
      }
      // console.log('google_sheets: ', {
      //   tableName: result.tableName,
      //   columns: result.columns,
      //   sampleData: result.sampleData
      // })
      return {
        tableName: result.tableName,
        columns: result.columns,
        sampleData: result.sampleData
      };
    } else {
      // SQL database handling
      const schema = tableSchema;

      // Get column metadata
      const columnsResult = await window.electronAPI.dbConnect.getColumns(
        connection.dbType,
        connection.dbConfig,
        schema,
        tableName,
        connection.id
      );

      if (!columnsResult.success || !columnsResult.columns) {
        console.log('tableSchemaUtils_FAILED: ', columnsResult)
        return null;
      }

      const columns = columnsResult.columns.map(col => ({
        name: col.name,
        type: col.type,
        nullable: col.nullable
      }));
      const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
        connection.dbType,
        tableName,
        schema,
        connection?.dbConfig,
        connection?.id
      );
      const fullTableName = quotedResult.quotedIdentifier;

      // Use database-specific preview query syntax
      const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
        connection.dbType,
        fullTableName,
        limit
      );
      const query = previewResult.success ? previewResult.previewQuery : `SELECT * FROM ${fullTableName} LIMIT ${limit}`;

      const result = await window.electronAPI.dbConnect.runQuery(
        connection.dbType,
        connection.dbConfig,
        {query},
        connection.id
      );

      if (!result.success || !result.rows) {
        return null;
      }

      // Trim long text fields
      const sampleData = result.rows.slice(0, limit).map(row => {
        const trimmedRow = {};
        Object.keys(row).forEach(key => {
          const value = row[key];
          if (typeof value === 'string' && value.length > 100) {
            trimmedRow[key] = value.substring(0, 100) + '...';
          } else {
            trimmedRow[key] = value;
          }
        });
        return trimmedRow;
      });

      // Infer columns from sample data if metadata not available
      const finalColumns = columns.length === 0 && sampleData.length > 0
        ? Object.keys(sampleData[0]).map(name => ({ name, type: 'unknown' }))
        : columns;

      return {
        tableName: fullTableName,
        columns: finalColumns,
        sampleData
      };
    }
  } catch (error) {
    console.error('Failed to load table schema:', error);
    return null;
  }
};
