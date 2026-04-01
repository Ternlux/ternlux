/**
 * Dropbox Storage Connector Plugin for DagFlux
 * Handles all Dropbox storage operations
 */

const { Dropbox } = require('dropbox');

// Dropbox client cache
const dropboxClients = new Map();

/**
 * Get or create Dropbox client
 */
function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!dropboxClients.has(key)) {
    const client = new Dropbox({
      accessToken: config.accessToken
    });

    dropboxClients.set(key, client);
  }

  return dropboxClients.get(key);
}

module.exports = {
  type: 'connector',
  id: 'dropbox',
  name: 'Dropbox',
  icon: './icon.svg',
  storageType: 'cloud-storage',
  dbCategory: 'CloudStorage',
  authType: 'oauth2',

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl: (config) => {
    try {
      const clientId = config.clientId;
      const redirectUri = config.redirectUri || 'http://localhost:3000/oauth/callback';
      const state = config.state;

      const authUrl = `https://www.dropbox.com/oauth2/authorize?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}` +
        `&token_access_type=offline`;

      return {
        success: true,
        authUrl,
        scopes: ['files.content.read', 'files.content.write', 'files.metadata.read']
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
      const axios = require('axios');
      const params = new URLSearchParams();
      params.append('code', code);
      params.append('grant_type', 'authorization_code');
      params.append('client_id', config.clientId);
      params.append('client_secret', config.clientSecret);
      params.append('redirect_uri', config.redirectUri || 'http://localhost:3000/oauth/callback');

      const response = await axios.post('https://api.dropboxapi.com/oauth2/token', params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return {
        success: true,
        tokens: {
          accessToken: response.data.access_token,
          refreshToken: response.data.refresh_token,
          expiryDate: Date.now() + (response.data.expires_in * 1000),
          tokenType: response.data.token_type,
          scope: response.data.scope
        }
      };
    } catch (error) {
      console.error('[Dropbox] Token exchange error:', error);
      return {
        success: false,
        message: error.response?.data?.error_description || error.message
      };
    }
  },

  /**
   * Test Dropbox connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const dbx = getClient(config, connectionId);

      // Get current account to verify credentials
      await dbx.usersGetCurrentAccount();

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List containers (Dropbox has no container concept, returns root)
   */
  getContainers: async (config, connectionId = null) => {
    try {
      // Dropbox doesn't have buckets/containers, return a single root container
      return {
        success: true,
        containers: [
          {
            name: 'root',
            path: '',
            description: 'Dropbox root folder'
          }
        ]
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List objects in a path
   */
  listObjects: async (config, connectionId, containerName, path = '', limit = 1000) => {
    try {
      const dbx = getClient(config, connectionId);

      // Normalize path
      const folderPath = path === '' || path === '/' ? '' : path.startsWith('/') ? path : `/${path}`;

      const response = await dbx.filesListFolder({
        path: folderPath,
        limit: Math.min(limit, 2000)
      });

      return {
        success: true,
        objects: response.result.entries.map(entry => ({
          name: entry.name,
          path: entry.path_display,
          objectKey: entry.path_display, // Use path for downloading
          size: entry.size || 0,
          isFolder: entry['.tag'] === 'folder',
          lastModified: entry.client_modified || entry.server_modified,
          id: entry.id
        })),
        hasMore: response.result.has_more,
        cursor: response.result.cursor
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Download object
   */
  downloadObject: async (config, connectionId, containerName, objectPath) => {
    try {
      const dbx = getClient(config, connectionId);

      // Normalize path
      const filePath = objectPath.startsWith('/') ? objectPath : `/${objectPath}`;

      const response = await dbx.filesDownload({ path: filePath });

      return {
        success: true,
        data: response.result.fileBinary,
        size: response.result.size,
        lastModified: response.result.client_modified
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Upload object
   */
  uploadObject: async (config, connectionId, containerName, objectPath, data, contentType) => {
    try {
      const dbx = getClient(config, connectionId);

      // Normalize path
      const filePath = objectPath.startsWith('/') ? objectPath : `/${objectPath}`;

      await dbx.filesUpload({
        path: filePath,
        contents: data,
        mode: { '.tag': 'overwrite' }
      });

      return {
        success: true,
        message: `Successfully uploaded ${objectPath}`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Delete object
   */
  deleteObject: async (config, connectionId, containerName, objectPath) => {
    try {
      const dbx = getClient(config, connectionId);

      // Normalize path
      const filePath = objectPath.startsWith('/') ? objectPath : `/${objectPath}`;

      await dbx.filesDeleteV2({ path: filePath });

      return {
        success: true,
        message: `Successfully deleted ${objectPath}`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Get object metadata
   */
  getObjectMetadata: async (config, connectionId, containerName, objectPath) => {
    try {
      const dbx = getClient(config, connectionId);

      // Normalize path
      const filePath = objectPath.startsWith('/') ? objectPath : `/${objectPath}`;

      const response = await dbx.filesGetMetadata({ path: filePath });

      return {
        success: true,
        metadata: {
          name: response.result.name,
          path: response.result.path_display,
          size: response.result.size || 0,
          isFolder: response.result['.tag'] === 'folder',
          lastModified: response.result.client_modified || response.result.server_modified,
          id: response.result.id
        }
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Close connection (cleanup client)
   */
  closeConnection: async (connectionId) => {
    if (dropboxClients.has(connectionId)) {
      dropboxClients.delete(connectionId);
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
        label: 'App Key (Client ID)',
        placeholder: 'xxxxxxxxxxxxxxx',
        required: true,
        sensitive: true,
        helpText: 'Get this from Dropbox App Console'
      },
      {
        name: 'clientSecret',
        type: 'password',
        label: 'App Secret (Client Secret)',
        required: true,
        sensitive: true,
        helpText: 'Get this from Dropbox App Console'
      },
      {
        name: 'redirectUri',
        type: 'string',
        label: 'Redirect URI',
        placeholder: 'http://localhost:3000/oauth/callback',
        default: 'http://localhost:3000/oauth/callback',
        required: false,
        sensitive: false,
        helpText: 'Must match the redirect URI in your Dropbox App settings'
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
