/**
 * SharePoint Storage Connector Plugin for DagFlux
 * Handles all SharePoint storage operations via Microsoft Graph API
 */

const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

// SharePoint client cache
const sharepointClients = new Map();

/**
 * Get or create SharePoint client
 */
function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!sharepointClients.has(key)) {
    const client = Client.init({
      authProvider: (done) => {
        done(null, config.accessToken);
      }
    });

    sharepointClients.set(key, client);
  }

  return sharepointClients.get(key);
}

module.exports = {
  type: 'connector',
  id: 'sharepoint',
  name: 'SharePoint',
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

      const scopes = encodeURIComponent('Sites.ReadWrite.All Files.ReadWrite.All offline_access');
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
        scopes: ['Sites.ReadWrite.All', 'Files.ReadWrite.All', 'offline_access']
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
      console.error('[SharePoint] Token exchange error:', error);
      return {
        success: false,
        message: error.response?.data?.error_description || error.message
      };
    }
  },

  /**
   * Test SharePoint connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const client = getClient(config, connectionId);

      if (config.siteId) {
        // Test specific site
        await client.api(`/sites/${config.siteId}`).get();
      } else {
        // Test by getting user info
        await client.api('/me').get();
      }

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List containers (SharePoint document libraries)
   */
  getContainers: async (config, connectionId = null) => {
    try {
      const client = getClient(config, connectionId);

      let siteId = config.siteId;

      // If no site ID provided, get root site
      if (!siteId) {
        const rootSite = await client.api('/sites/root').get();
        siteId = rootSite.id;
      }

      // Get document libraries (drives) for the site
      const response = await client.api(`/sites/${siteId}/drives`).get();

      return {
        success: true,
        containers: response.value.map(drive => ({
          name: drive.name,
          id: drive.id,
          driveType: drive.driveType,
          webUrl: drive.webUrl,
          description: drive.description
        }))
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List objects in a document library folder
   */
  listObjects: async (config, connectionId, driveId, folderId = 'root', top = 1000) => {
    try {
      const client = getClient(config, connectionId);

      let siteId = config.siteId;

      // If no site ID provided, get root site
      if (!siteId) {
        const rootSite = await client.api('/sites/root').get();
        siteId = rootSite.id;
      }

      // Build the API path
      const path = folderId === 'root'
        ? `/sites/${siteId}/drives/${driveId}/root/children`
        : `/sites/${siteId}/drives/${driveId}/items/${folderId}/children`;

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
  downloadObject: async (config, connectionId, driveId, itemId) => {
    try {
      const client = getClient(config, connectionId);

      let siteId = config.siteId;

      // If no site ID provided, get root site
      if (!siteId) {
        const rootSite = await client.api('/sites/root').get();
        siteId = rootSite.id;
      }

      // Get item metadata
      const item = await client.api(`/sites/${siteId}/drives/${driveId}/items/${itemId}`).get();

      if (item.folder) {
        return { success: false, message: 'Cannot download a folder' };
      }

      // Download content
      const response = await client
        .api(`/sites/${siteId}/drives/${driveId}/items/${itemId}/content`)
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
  uploadObject: async (config, connectionId, driveId, fileName, data, contentType) => {
    try {
      const client = getClient(config, connectionId);

      let siteId = config.siteId;

      // If no site ID provided, get root site
      if (!siteId) {
        const rootSite = await client.api('/sites/root').get();
        siteId = rootSite.id;
      }

      // Upload to root of the drive
      const path = `/sites/${siteId}/drives/${driveId}/root:/${fileName}:/content`;

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
  deleteObject: async (config, connectionId, driveId, itemId) => {
    try {
      const client = getClient(config, connectionId);

      let siteId = config.siteId;

      // If no site ID provided, get root site
      if (!siteId) {
        const rootSite = await client.api('/sites/root').get();
        siteId = rootSite.id;
      }

      await client.api(`/sites/${siteId}/drives/${driveId}/items/${itemId}`).delete();

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
  getObjectMetadata: async (config, connectionId, driveId, itemId) => {
    try {
      const client = getClient(config, connectionId);

      let siteId = config.siteId;

      // If no site ID provided, get root site
      if (!siteId) {
        const rootSite = await client.api('/sites/root').get();
        siteId = rootSite.id;
      }

      const item = await client.api(`/sites/${siteId}/drives/${driveId}/items/${itemId}`).get();

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
    if (sharepointClients.has(connectionId)) {
      sharepointClients.delete(connectionId);
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
        name: 'siteId',
        type: 'string',
        label: 'Site ID (Optional)',
        placeholder: 'contoso.sharepoint.com,abc123,def456',
        required: false,
        sensitive: false,
        helpText: 'Specific SharePoint site ID. Leave empty for root site.'
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
