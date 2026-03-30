/**
 * Google Cloud Storage Connector Plugin for DagFlux
 * Handles all GCS storage operations
 */

const { Storage } = require('@google-cloud/storage');

// GCS client cache
const gcsClients = new Map();

/**
 * Get or create GCS client
 */
function getClient(config, connectionId) {
  const key = connectionId || JSON.stringify(config);

  if (!gcsClients.has(key)) {
    const options = {
      projectId: config.projectId,
    };

    if (config.keyFilePath) {
      options.keyFilename = config.keyFilePath;
    } else if (config.credentials) {
      const creds = typeof config.credentials === 'string'
        ? JSON.parse(config.credentials)
        : config.credentials;
      options.credentials = creds;
    }

    const client = new Storage(options);
    gcsClients.set(key, client);
  }

  return gcsClients.get(key);
}

module.exports = {
  type: 'connector',
  id: 'gcs',
  name: 'Google Cloud Storage',
  icon: './icon.svg',
  storageType: 'cloud-storage',
  dbCategory: 'CloudStorage',

  /**
   * Test GCS connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const storage = getClient(config, connectionId);

      // Try to list buckets to verify credentials
      await storage.getBuckets({ maxResults: 1 });

      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List containers (buckets in GCS)
   */
  getContainers: async (config, connectionId = null) => {
    try {
      const storage = getClient(config, connectionId);
      const [buckets] = await storage.getBuckets();

      return {
        success: true,
        containers: buckets.map(bucket => ({
          name: bucket.name,
          location: bucket.metadata.location,
          storageClass: bucket.metadata.storageClass,
          created: bucket.metadata.timeCreated
        }))
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * List objects in a container
   * @param {string} prefix - Filter objects by prefix (folder path)
   * @param {number} maxKeys - Maximum number of objects to return (default 100)
   * @param {string} pageToken - Token for pagination (from previous response)
   * @param {string} searchTerm - Search term to filter object names
   */
  listObjects: async (config, connectionId, containerName, prefix = '', maxKeys = 100, pageToken = null, searchTerm = '') => {
    try {
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);

      // Combine prefix with search term
      const effectivePrefix = searchTerm ? `${prefix}${searchTerm}` : prefix;

      const options = {
        prefix: effectivePrefix,
        maxResults: maxKeys,
        delimiter: '/',
        autoPaginate: false
      };

      if (pageToken) {
        options.pageToken = pageToken;
      }

      const [files, , response] = await bucket.getFiles(options);

      // Process folders (prefixes) - use original prefix, not effectivePrefix
      const folders = (response.prefixes || []).map(p => ({
        name: p.replace(prefix, '').replace(/\/$/, ''),
        objectKey: p, // Full key for navigation
        isFolder: true,
        size: 0,
        lastModified: null
      }));

      // Process files - use original prefix, not effectivePrefix
      const fileObjects = files
        .filter(file => file.name !== effectivePrefix)
        .map(file => ({
          name: file.name.replace(prefix, ''),
          objectKey: file.name, // Full key for downloading
          size: parseInt(file.metadata.size),
          contentType: file.metadata.contentType,
          lastModified: file.metadata.updated,
          created: file.metadata.timeCreated,
          isFolder: false
        }));

      return {
        success: true,
        objects: [...folders, ...fileObjects],
        isTruncated: !!response.nextPageToken,
        nextContinuationToken: response.nextPageToken || null,
        totalCount: folders.length + fileObjects.length
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Download object
   */
  downloadObject: async (config, connectionId, containerName, objectName) => {
    try {
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);
      const file = bucket.file(objectName);

      const [buffer] = await file.download();
      const [metadata] = await file.getMetadata();

      return {
        success: true,
        data: buffer,
        contentType: metadata.contentType,
        size: metadata.size
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Upload object
   */
  uploadObject: async (config, connectionId, containerName, objectName, data, contentType) => {
    try {
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);
      const file = bucket.file(objectName);

      await file.save(data, {
        contentType,
        resumable: false
      });

      return {
        success: true,
        message: `Successfully uploaded ${objectName} to ${containerName}`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Delete object
   */
  deleteObject: async (config, connectionId, containerName, objectName) => {
    try {
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);
      const file = bucket.file(objectName);

      await file.delete();

      return {
        success: true,
        message: `Successfully deleted ${objectName} from ${containerName}`
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Get object metadata
   */
  getObjectMetadata: async (config, connectionId, containerName, objectName) => {
    try {
      const storage = getClient(config, connectionId);
      const bucket = storage.bucket(containerName);
      const file = bucket.file(objectName);

      const [metadata] = await file.getMetadata();

      return {
        success: true,
        metadata: {
          size: metadata.size,
          contentType: metadata.contentType,
          lastModified: metadata.updated,
          etag: metadata.etag
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
    if (gcsClients.has(connectionId)) {
      gcsClients.delete(connectionId);
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'projectId',
        type: 'string',
        label: 'Project ID',
        placeholder: 'my-gcp-project',
        required: true,
        sensitive: true
      },
      {
        name: 'credentials',
        type: 'text',
        label: 'Service Account JSON',
        placeholder: '{ "type": "service_account", ... }',
        required: false,
        sensitive: true,
        helpText: 'Paste the entire service account JSON key file content'
      },
      {
        name: 'keyFilePath',
        type: 'string',
        label: 'Key File Path (Alternative)',
        placeholder: '/path/to/service-account.json',
        required: false,
        sensitive: true,
        helpText: 'Path to service account JSON file (use this OR credentials field)'
      }
    ]
  }
};
