/**
 * Plugin Manager for DagFlux
 * Handles loading and managing database connector plugins
 */

const fs = require('fs');
const path = require('path');

class PluginManager {
  constructor() {
    this.connectors = new Map();
    this.pluginDir = path.join(__dirname, '../plugins/connectors');
  }

  /**
   * Load all plugins from the plugins directory
   */
  loadPlugins() {
    console.log('Loading plugins from:', this.pluginDir);

    if (!fs.existsSync(this.pluginDir)) {
      console.warn('Plugins directory does not exist:', this.pluginDir);
      return;
    }

    const pluginFolders = fs.readdirSync(this.pluginDir);

    for (const folder of pluginFolders) {
      try {
        this.loadPlugin(folder);
      } catch (error) {
        console.error(`Failed to load plugin ${folder}:`, error.message);
      }
    }

    console.log(`Loaded ${this.connectors.size} connector plugins`);
  }

  /**
   * Load a single plugin
   */
  loadPlugin(pluginFolder) {
    const pluginPath = path.join(this.pluginDir, pluginFolder);
    const packageJsonPath = path.join(pluginPath, 'package.json');
    const indexPath = path.join(pluginPath, 'index.js');

    // Check if package.json exists
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`package.json not found in ${pluginFolder}`);
    }

    // Read package.json
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    if (!packageJson.dagflux) {
      throw new Error(`Plugin ${pluginFolder} missing dagflux metadata in package.json`);
    }

    // Check if index.js exists
    if (!fs.existsSync(indexPath)) {
      throw new Error(`index.js not found in ${pluginFolder}`);
    }

    // Load the plugin module
    const plugin = require(indexPath);

    // Validate plugin interface
    if (!this.validatePlugin(plugin)) {
      throw new Error(`Plugin ${pluginFolder} does not implement required interface`);
    }

    // Register plugin
    const pluginId = packageJson.dagflux.id || plugin.id;
    this.connectors.set(pluginId, {
      ...plugin,
      metadata: packageJson.dagflux,
      packageInfo: {
        name: packageJson.name,
        version: packageJson.version,
        description: packageJson.description
      }
    });

    console.log(`✓ Loaded connector plugin: ${packageJson.dagflux.displayName || pluginId}`);
  }

  /**
   * Validate that a plugin implements the required interface
   */
  validatePlugin(plugin) {
    // Different validation rules for different connector types
    let requiredMethods;

    if (plugin.storageType === 'cloud-storage') {
      // Cloud storage connectors require different methods
      requiredMethods = ['testConnection', 'getContainers', 'listObjects', 'downloadObject', 'uploadObject', 'deleteObject'];
    } else {
      // Database connectors require these methods
      requiredMethods = ['testConnection', 'getTables', 'getColumns', 'runQuery'];
    }

    for (const method of requiredMethods) {
      if (typeof plugin[method] !== 'function') {
        console.error(`Plugin missing required method: ${method}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Get a connector plugin by ID
   */
  getConnector(id) {
    return this.connectors.get(id);
  }

  /**
   * Check if a connector exists
   */
  hasConnector(id) {
    return this.connectors.has(id);
  }

  /**
   * List all available connector plugins
   */
  listConnectors() {
    return Array.from(this.connectors.values()).map(plugin => ({
      id: plugin.id,
      name: plugin.metadata.displayName || plugin.name,
      type: plugin.type,
      icon: plugin.icon,
      configSchema: plugin.configSchema,
      version: plugin.packageInfo.version,
      description: plugin.packageInfo.description,
      dbCategory: plugin.dbCategory || null,
      storageType: plugin.storageType || null,
      authType: plugin.authType || null
    }));
  }

  /**
   * Unload a plugin
   */
  unloadPlugin(pluginId) {
    const plugin = this.connectors.get(pluginId);
    if (plugin && typeof plugin.closeConnection === 'function') {
      // Close any open connections
      plugin.closeConnection();
    }
    this.connectors.delete(pluginId);
  }
}

module.exports = new PluginManager();
