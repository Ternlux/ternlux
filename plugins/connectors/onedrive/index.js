/**
 * OneDrive Storage Connector Plugin for DagFlux
 * Handles all OneDrive storage operations via Microsoft Graph API
 */

const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

// OneDrive client cache
const onedriveClients = new Map();

/**
 * Get or create OneDrive client
 */
function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!onedriveClients.has(key)) {
    const client = Client.init({
      authProvider: (done) => {
        done(null, config.accessToken);
      }
    });

    onedriveClients.set(key, client);
  }

  return onedriveClients.get(key);
}

module.exports = {
  type: 'connector',
  id: 'onedrive',
  name: 'OneDrive',
  icon: './icon.svg',
  storageType: 'cloud-storage',
  dbCategory: 'CloudStorage',
  authType: 'oauth2',

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthorizationUrl: (config) => {
    try {
      const tenantId = config.tenantId || 'common';
      const clientId = config.clientId;
      const redirectUri = config.redirectUri || 'http://localhost:3000/oauth/callback';
      const state = config.state;

      const scopes = encodeURIComponent('Files.ReadWrite.All offline_access');
      const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_mode=query` +
        `&scope=${scopes}` +
        `&state=${encodeURIComponent(state)}`;

      return {
        success: true,
        authUrl,
        scopes: ['Files.ReadWrite.All', 'offline_access']
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
      const tenantId = config.tenantId || 'common';
      const params = new URLSearchParams();
      params.append('client_id', config.clientId);
      params.append('client_secret', config.clientSecret);
      params.append('code', code);
      params.append('redirect_uri', config.redirectUri || 'http://localhost:3000/oauth/callback');
      params.append('grant_type', 'authorization_code');

      const response = await axios.post(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        params,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

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
      console.error('[OneDrive] Token exchange error:', error);
      return {
        success: false,
        message: error.response?.data?.error_description || error.message
      };
    }
  },

  /**
   * Test OneDrive connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const client = getClient(config, connectionId);

      // Get user info to verify credentials
      await client.api('/me').get();

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List containers (OneDrive has root drive)
   */
  getContainers: async (config, connectionId = null) => {
    try {
      const client = getClient(config, connectionId);

      // Get available drives
      const response = await client.api('/me/drives').get();

      return {
        success: true,
        containers: response.value.map(drive => ({
          name: drive.name || 'OneDrive',
          id: drive.id,
          driveType: drive.driveType,
          owner: drive.owner?.user?.displayName
        }))
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List objects in a folder
   */
  listObjects: async (config, connectionId, containerName, folderId = 'root', top = 1000) => {
    try {
      const client = getClient(config, connectionId);

      // Build the API path
      const path = folderId === 'root'
        ? '/me/drive/root/children'
        : `/me/drive/items/${folderId}/children`;

      const response = await client
        .api(path)
        .top(Math.min(top, 1000))
        .get();

      return {
        success: true,
        objects: response.value.map(item => ({
          name: item.name,
          id: item.id,
          objectKey: item.id, // Use ID for downloading
          size: item.size || 0,
          isFolder: !!item.folder,
          lastModified: item.lastModifiedDateTime,
          created: item.createdDateTime,
          webUrl: item.webUrl
        })),
        nextLink: response['@odata.nextLink']
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Download object
   */
  downloadObject: async (config, connectionId, containerName, itemId) => {
    try {
      const client = getClient(config, connectionId);

      // Get download URL
      const item = await client.api(`/me/drive/items/${itemId}`).get();

      if (item.folder) {
        return { success: false, message: 'Cannot download a folder' };
      }

      // Download content
      const response = await client
        .api(`/me/drive/items/${itemId}/content`)
        .getStream();

      // Convert stream to buffer
      const chunks = [];
      for await (const chunk of response) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      return {
        success: true,
        data: buffer,
        name: item.name,
        size: item.size,
        mimeType: item.file?.mimeType
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Upload object
   */
  uploadObject: async (config, connectionId, containerName, fileName, data, contentType) => {
    try {
      const client = getClient(config, connectionId);

      // Upload to root by default, or specific folder if containerName is a folder ID
      const path = containerName === 'root' || !containerName
        ? `/me/drive/root:/${fileName}:/content`
        : `/me/drive/items/${containerName}:/${fileName}:/content`;

      const response = await client
        .api(path)
        .putStream(data);

      return {
        success: true,
        message: `Successfully uploaded ${fileName}`,
        itemId: response.id
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Delete object
   */
  deleteObject: async (config, connectionId, containerName, itemId) => {
    try {
      const client = getClient(config, connectionId);

      await client.api(`/me/drive/items/${itemId}`).delete();

      return {
        success: true,
        message: `Successfully deleted item ${itemId}`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Get object metadata
   */
  getObjectMetadata: async (config, connectionId, containerName, itemId) => {
    try {
      const client = getClient(config, connectionId);

      const item = await client.api(`/me/drive/items/${itemId}`).get();

      return {
        success: true,
        metadata: {
          id: item.id,
          name: item.name,
          size: item.size || 0,
          isFolder: !!item.folder,
          lastModified: item.lastModifiedDateTime,
          created: item.createdDateTime,
          webUrl: item.webUrl,
          mimeType: item.file?.mimeType
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
    if (onedriveClients.has(connectionId)) {
      onedriveClients.delete(connectionId);
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
        label: 'Application (client) ID',
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        required: true,
        sensitive: true,
        helpText: 'Get this from Azure Portal App Registration'
      },
      {
        name: 'clientSecret',
        type: 'password',
        label: 'Client Secret',
        required: true,
        sensitive: true,
        helpText: 'Get this from Azure Portal App Registration > Certificates & secrets'
      },
      {
        name: 'tenantId',
        type: 'string',
        label: 'Tenant ID',
        placeholder: 'common',
        default: 'common',
        required: false,
        sensitive: false,
        helpText: 'Azure AD tenant ID (use "common" for multi-tenant apps)'
      },
      {
        name: 'redirectUri',
        type: 'string',
        label: 'Redirect URI',
        placeholder: 'http://localhost:3000/oauth/callback',
        default: 'http://localhost:3000/oauth/callback',
        required: false,
        sensitive: false,
        helpText: 'Must match the redirect URI in your Azure App Registration'
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
