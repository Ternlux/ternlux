/**
 * Google Sheets Connector Plugin for Ternlux
 * OAuth2.0-based authentication for accessing Google Sheets
 */

const { OAuth2Client } = require('google-auth-library');
const { sheets: sheetsApi } = require('@googleapis/sheets');
const { drive: driveApi } = require('@googleapis/drive');
const axios = require('axios');

// OAuth client cache
const oauthClients = new Map();
const tokenRefreshCallbacks = new Map();

/**
 * Get or create OAuth2 client
 */
function getOAuthClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!oauthClients.has(key)) {
    const oauth2Client = new OAuth2Client(
      config.clientId,
      config.clientSecret,
      config.redirectUri || 'http://localhost:3000/oauth/callback'
    );

    // Set credentials if tokens exist
    if (config.accessToken) {
      oauth2Client.setCredentials({
        access_token: config.accessToken,
        refresh_token: config.refreshToken,
        scope: config.scope,
        token_type: 'Bearer',
        expiry_date: config.expiryDate
      });
    }

    oauthClients.set(key, oauth2Client);
  }

  return oauthClients.get(key);
}

/**
 * Refresh access token if expired
 */
async function refreshAccessTokenIfNeeded(oauth2Client, connectionId) {
  try {
    const tokens = oauth2Client.credentials;

    // Check if token is expired or about to expire (within 5 minutes)
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 5 * 60 * 1000) {
      console.log('[Google Sheets] Refreshing access token...');
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Trigger callback to update connection in database if registered
      if (connectionId && tokenRefreshCallbacks.has(connectionId)) {
        const callback = tokenRefreshCallbacks.get(connectionId);
        await callback({
          accessToken: credentials.access_token,
          refreshToken: credentials.refresh_token,
          expiryDate: credentials.expiry_date,
          tokenType: credentials.token_type,
          scope: credentials.scope
        });
      }

      return credentials;
    }

    return tokens;
  } catch (error) {
    console.error('[Google Sheets] Token refresh error:', error);
    throw error;
  }
}

/**
 * Register a callback to be called when token is refreshed
 * This allows the main app to update the connection config
 */
function registerTokenRefreshCallback(connectionId, callback) {
  tokenRefreshCallbacks.set(connectionId, callback);
}

module.exports = {
  type: 'connector',
  id: 'google-sheets',
  name: 'Google Sheets',
  icon: './icon.svg',
  dbCategory: 'API',
  authType: 'oauth2',

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl: (config) => {
    try {
      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || 'http://localhost:3000/oauth/callback'
      );

      const scopes = [
        'https://www.googleapis.com/auth/spreadsheets', // Full read/write access to spreadsheets
        'https://www.googleapis.com/auth/drive.file'     // Access to files created/opened by the app
      ];

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent', // Force consent screen to get refresh token
        state: config.state // CSRF protection token
      });

      return {
        success: true,
        authUrl,
        scopes
      };
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Exchange authorization code for tokens
   */
  exchangeCodeForTokens: async (config, code) => {
    try {
      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || 'http://localhost:3000/oauth/callback'
      );

      const { tokens } = await oauth2Client.getToken(code);

      return {
        success: true,
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date,
          tokenType: tokens.token_type,
          scope: tokens.scope
        }
      };
    } catch (error) {
      console.error('[Google Sheets] Token exchange error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Refresh access token using refresh token
   */
  refreshAccessToken: async (config) => {
    try {
      if (!config.refreshToken) {
        return {
          success: false,
          message: 'No refresh token available'
        };
      }

      const oauth2Client = new OAuth2Client(
        config.clientId,
        config.clientSecret,
        config.redirectUri || 'http://localhost:3000/oauth/callback'
      );

      oauth2Client.setCredentials({
        refresh_token: config.refreshToken
      });

      const { credentials } = await oauth2Client.refreshAccessToken();

      return {
        success: true,
        tokens: {
          accessToken: credentials.access_token,
          refreshToken: credentials.refresh_token || config.refreshToken,
          expiryDate: credentials.expiry_date,
          tokenType: credentials.token_type,
          scope: credentials.scope
        }
      };
    } catch (error) {
      console.error('[Google Sheets] Token refresh error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Test connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      if (!config.accessToken) {
        return {
          success: false,
          message: 'No access token. Please complete OAuth authentication.'
        };
      }

      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      // Test by listing files
      const drive = driveApi({ version: 'v3', auth: oauth2Client });
      await drive.files.list({ pageSize: 1 });

      return {
        success: true,
        message: 'Connection successful'
      };
    } catch (error) {
      console.error('[Google Sheets] Test connection error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get list of spreadsheets (tables)
   */
  getTables: async (config, connectionId = null) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      const newTokens = await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const drive = driveApi({ version: 'v3', auth: oauth2Client });

      // Search for Google Sheets files
      const response = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.spreadsheet'",
        fields: 'files(id, name, createdTime, modifiedTime)',
        pageSize: 100,
        orderBy: 'modifiedTime desc'
      });

      const spreadsheets = response.data.files || [];

      return {
        success: true,
        tables: spreadsheets.map(sheet => ({
          schema: 'google_sheets',
          name: sheet.id, // Use ID as the identifier for querying
          displayName: sheet.name, // Human-readable name for display
          type: 'spreadsheet',
          created: sheet.createdTime,
          modified: sheet.modifiedTime
        })),
        newTokens: newTokens.expiry_date !== oauth2Client.credentials.expiry_date ? {
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token,
          expiryDate: newTokens.expiry_date
        } : null
      };
    } catch (error) {
      console.error('[Google Sheets] Get tables error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get sheet tabs and columns
   */
  getColumns: async (config, connectionId, schema, spreadsheetId) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });

      // Get spreadsheet metadata to list all sheets
      const metadata = await sheets.spreadsheets.get({
        spreadsheetId
      });

      const sheetsList = metadata.data.sheets || [];

      // Get columns from the first sheet
      if (sheetsList.length > 0) {
        const firstSheetName = sheetsList[0].properties.title;

        // Get header row
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${firstSheetName}!1:1`
        });

        const headers = response.data.values ? response.data.values[0] : [];

        return {
          success: true,
          columns: headers.map((header, index) => ({
            name: header || `Column_${index + 1}`,
            type: 'TEXT', // Google Sheets doesn't have strict types
            nullable: true,
            isPrimary: false
          })),
          sheets: sheetsList.map(s => ({
            name: s.properties.title,
            index: s.properties.index,
            rowCount: s.properties.gridProperties.rowCount,
            columnCount: s.properties.gridProperties.columnCount
          }))
        };
      }

      return {
        success: true,
        columns: [],
        sheets: []
      };
    } catch (error) {
      console.error('[Google Sheets] Get columns error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get table schema (columns with inferred types and sample data)
   */
  getTableSchema: async (config, connectionId, spreadsheetId, sheetName = null, limit = 5) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });

      // If no sheetName provided, get the first sheet
      let targetSheetName = sheetName;
      if (!targetSheetName) {
        const metadata = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetsList = metadata.data.sheets || [];
        targetSheetName = sheetsList.length > 0 ? sheetsList[0].properties.title : 'Sheet1';
      }

      // Fetch sample data (limit + header row)
      const range = `${targetSheetName}!A1:ZZ${limit + 1}`;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range
      });

      const values = response.data.values || [];

      if (values.length === 0) {
        return {
          success: true,
          tableName: spreadsheetId,
          columns: [],
          sampleData: []
        };
      }

      // First row as headers
      const headers = values[0];
      const dataRows = values.slice(1);

      // Infer column types from sample data
      const inferType = (value) => {
        if (value === null || value === undefined || value === '') return 'TEXT';

        // Check if it's a number
        const num = Number(value);
        if (!isNaN(num) && value.toString().trim() !== '') {
          return Number.isInteger(num) ? 'INTEGER' : 'REAL';
        }

        // Check if it's a boolean
        const lowerVal = String(value).toLowerCase();
        if (lowerVal === 'true' || lowerVal === 'false') return 'BOOLEAN';

        // Check if it's a date (basic check)
        const dateVal = new Date(value);
        if (!isNaN(dateVal.getTime()) && value.toString().match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/)) {
          return 'DATE';
        }

        return 'TEXT';
      };

      // Build columns with inferred types
      const columns = headers.map((header, colIndex) => {
        const columnName = header || `Column_${colIndex + 1}`;

        // Sample values from this column (excluding empty values)
        const columnValues = dataRows
          .map(row => row[colIndex])
          .filter(val => val !== null && val !== undefined && val !== '');

        // Infer type from multiple samples
        const types = columnValues.slice(0, 10).map(inferType);

        // Pick most common type, default to TEXT
        const typeCounts = {};
        types.forEach(t => typeCounts[t] = (typeCounts[t] || 0) + 1);
        const inferredType = Object.keys(typeCounts).reduce((a, b) =>
          typeCounts[a] > typeCounts[b] ? a : b, 'TEXT'
        );

        return {
          name: columnName,
          type: inferredType,
          nullable: true,
          isPrimary: false
        };
      });

      // Convert data rows to objects and trim long text
      const sampleData = dataRows.map(row => {
        const obj = {};
        headers.forEach((header, index) => {
          const columnName = header || `Column_${index + 1}`;
          let value = row[index] || null;

          // Trim long text fields
          if (typeof value === 'string' && value.length > 100) {
            value = value.substring(0, 100) + '...';
          }

          obj[columnName] = value;
        });
        return obj;
      });

      return {
        success: true,
        tableName: spreadsheetId,
        columns,
        sampleData
      };
    } catch (error) {
      console.error('[Google Sheets] Get table schema error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Run query (fetch data from specific sheet and range)
   */
  runQuery: async (config, connectionId, query) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });

      // Parse query - can be JSON string or object
      // Query object may contain fields for different database types
      // Pick only the fields relevant to Google Sheets: spreadsheetId, sheetName, range
      const queryObj = typeof query === 'string' ? JSON.parse(query) : query;
      const { spreadsheetId, range, sheetName } = queryObj;

      if (!spreadsheetId) {
        return {
          success: false,
          message: 'spreadsheetId is required for Google Sheets queries'
        };
      }

      // Default range if not specified
      const actualRange = range || `${sheetName || 'Sheet1'}!A1:ZZ`;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: actualRange
      });

      const values = response.data.values || [];

      if (values.length === 0) {
        return {
          success: true,
          rows: [],
          columns: [],
          rowCount: 0
        };
      }

      // First row as headers
      const headers = values[0];
      const dataRows = values.slice(1);

      // Convert to objects
      const rows = dataRows.map(row => {
        const obj = {};
        headers.forEach((header, index) => {
          obj[header || `Column_${index + 1}`] = row[index] || null;
        });
        return obj;
      });

      return {
        success: true,
        rows,
        columns: headers,
        rowCount: rows.length
      };
    } catch (error) {
      console.error('[Google Sheets] Run query error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Stream query results in batches
   */
  streamQuery: async (config, connectionId, query, onBatch, batchSize = 1000) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });

      const queryObj = typeof query === 'string' ? JSON.parse(query) : query;
      const { spreadsheetId, range, sheetName } = queryObj;

      const actualRange = range || `${sheetName || 'Sheet1'}!A1:ZZ`;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: actualRange
      });

      const values = response.data.values || [];

      if (values.length === 0) {
        return { success: true, totalRows: 0 };
      }

      const headers = values[0];
      const dataRows = values.slice(1);

      // Process in batches
      for (let i = 0; i < dataRows.length; i += batchSize) {
        const batch = dataRows.slice(i, i + batchSize);
        const rows = batch.map(row => {
          const obj = {};
          headers.forEach((header, index) => {
            obj[header || `Column_${index + 1}`] = row[index] || null;
          });
          return obj;
        });

        await onBatch(rows, headers);
      }

      return {
        success: true,
        totalRows: dataRows.length
      };
    } catch (error) {
      console.error('[Google Sheets] Stream query error:', error);
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Close connection
   */
  closeConnection: async (connectionId) => {
    if (oauthClients.has(connectionId)) {
      oauthClients.delete(connectionId);
    }
    if (tokenRefreshCallbacks.has(connectionId)) {
      tokenRefreshCallbacks.delete(connectionId);
    }
  },

  /**
   * Register token refresh callback
   */
  registerTokenRefreshCallback: (connectionId, callback) => {
    return registerTokenRefreshCallback(connectionId, callback);
  },

  /**
   * Upload object (create new spreadsheet and write data)
   * This makes Google Sheets compatible with cloud storage output interface
   */
  uploadObject: async (config, connectionId, containerName, fileName, data, contentType) => {
    try {
      const oauth2Client = getOAuthClient(config, connectionId);
      await refreshAccessTokenIfNeeded(oauth2Client, connectionId);

      const sheets = sheetsApi({ version: 'v4', auth: oauth2Client });

      // Parse data from Buffer if needed
      let jsonData;
      if (Buffer.isBuffer(data)) {
        const dataString = data.toString('utf-8');
        jsonData = JSON.parse(dataString);
      } else if (typeof data === 'string') {
        jsonData = JSON.parse(data);
      } else {
        jsonData = data;
      }

      if (!Array.isArray(jsonData) || jsonData.length === 0) {
        return {
          success: false,
          message: 'Data must be a non-empty array of objects'
        };
      }

      // Remove file extension from spreadsheet name
      const spreadsheetName = fileName.replace(/\.(json|csv)$/, '');
      const sheetTitle = 'Sheet1';

      // Create new spreadsheet
      const createResponse = await sheets.spreadsheets.create({
        requestBody: {
          properties: {
            title: spreadsheetName
          },
          sheets: [
            {
              properties: {
                title: sheetTitle
              }
            }
          ]
        }
      });

      const spreadsheetId = createResponse.data.spreadsheetId;

      // Extract headers from first object
      const headers = Object.keys(jsonData[0]);
      const rows = jsonData.map(row => headers.map(header => {
        const value = row[header];
        // Convert values to strings for Google Sheets
        return value !== null && value !== undefined ? String(value) : '';
      }));

      // Combine headers and rows
      const values = [headers, ...rows];

      // Write data to the spreadsheet
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: `${sheetTitle}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values
        }
      });

      return {
        success: true,
        message: `Successfully created spreadsheet "${spreadsheetName}" with ${jsonData.length} rows`,
        spreadsheetId: spreadsheetId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
      };
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'clientId',
        type: 'string',
        label: 'OAuth Client ID',
        placeholder: 'xxxxx.apps.googleusercontent.com',
        required: true,
        sensitive: true,
        helpText: 'Get this from Google Cloud Console'
      },
      {
        name: 'clientSecret',
        type: 'password',
        label: 'OAuth Client Secret',
        required: true,
        sensitive: true,
        helpText: 'Get this from Google Cloud Console'
      },
      {
        name: 'redirectUri',
        type: 'string',
        label: 'Redirect URI',
        placeholder: 'http://localhost:3000/oauth/callback',
        default: 'http://localhost:3000/oauth/callback',
        required: false,
        sensitive: false,
        helpText: 'Must match the redirect URI in your Google Cloud Console'
      },
      {
        name: 'accessToken',
        type: 'hidden',
        label: 'Access Token',
        required: false,
        sensitive: true
      },
      {
        name: 'refreshToken',
        type: 'hidden',
        label: 'Refresh Token',
        required: false,
        sensitive: true
      },
      {
        name: 'expiryDate',
        type: 'hidden',
        label: 'Token Expiry Date',
        required: false,
        sensitive: false
      }
    ]
  }
};
