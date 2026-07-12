/**
 * Plugin Manager for Ternlux
 * Handles loading and managing database connector plugins
 */

const fs = require('fs');
const path = require('path');

class PluginManager {
  constructor() {
    this.connectors = new Map();
    this.skills = new Map();
    this.connectorsDir = path.join(__dirname, '../plugins/connectors');
    this.skillsDir = path.join(__dirname, '../plugins/skills');
  }

  /**
   * Load all plugins from the plugins directory
   */
  loadPlugins() {
    this.loadConnectors();
    this.loadSkills();
  }

  /**
   * Load all connector plugins
   */
  loadConnectors() {
    console.log('Loading connector plugins from:', this.connectorsDir);

    if (!fs.existsSync(this.connectorsDir)) {
      console.warn('Connectors directory does not exist:', this.connectorsDir);
      return;
    }

    const pluginFolders = fs.readdirSync(this.connectorsDir);

    for (const folder of pluginFolders) {
      try {
        // Skip non-directories and hidden files
        const pluginPath = path.join(this.connectorsDir, folder);
        if (!fs.statSync(pluginPath).isDirectory() || folder.startsWith('.')) {
          continue;
        }

        this.loadConnectorPlugin(folder);
      } catch (error) {
        console.error(`Failed to load connector plugin ${folder}:`, error.message);
      }
    }

    console.log(`Loaded ${this.connectors.size} connector plugins`);
  }

  /**
   * Load all skill plugins
   */
  loadSkills() {
    console.log('Loading skill plugins from:', this.skillsDir);

    if (!fs.existsSync(this.skillsDir)) {
      console.warn('Skills directory does not exist:', this.skillsDir);
      return;
    }

    const skillFolders = fs.readdirSync(this.skillsDir);

    for (const folder of skillFolders) {
      try {
        // Skip non-directories and hidden files
        const skillPath = path.join(this.skillsDir, folder);
        if (!fs.statSync(skillPath).isDirectory() || folder.startsWith('.')) {
          continue;
        }

        this.loadSkillPlugin(folder);
      } catch (error) {
        console.error(`Failed to load skill plugin ${folder}:`, error.message);
      }
    }

    console.log(`Loaded ${this.skills.size} skill plugins`);
  }

  /**
   * Load a single connector plugin
   */
  loadConnectorPlugin(pluginFolder) {
    const pluginPath = path.join(this.connectorsDir, pluginFolder);
    const indexPath = path.join(pluginPath, 'index.js');

    // Check if index.js exists
    if (!fs.existsSync(indexPath)) {
      throw new Error(`index.js not found in ${pluginFolder}`);
    }

    // Load the plugin module
    const plugin = require(indexPath);

    // Validate plugin type
    if (plugin.type !== 'connector') {
      throw new Error(`Plugin ${pluginFolder} is not a connector plugin`);
    }

    // Validate plugin interface
    if (!this.validateConnectorPlugin(plugin)) {
      throw new Error(`Plugin ${pluginFolder} does not implement required connector interface`);
    }

    // Register plugin
    const pluginId = plugin.id;
    this.connectors.set(pluginId, {
      ...plugin,
      metadata: plugin.metadata || {}
    });

    console.log(`✓ Loaded connector plugin: ${plugin.metadata?.displayName || plugin.name || pluginId}`);
  }

  /**
   * Load a single skill plugin
   */
  loadSkillPlugin(pluginFolder) {
    const pluginPath = path.join(this.skillsDir, pluginFolder);
    const indexPath = path.join(pluginPath, 'index.js');

    // Check if index.js exists
    if (!fs.existsSync(indexPath)) {
      throw new Error(`index.js not found in ${pluginFolder}`);
    }

    // Load the plugin module
    const plugin = require(indexPath);

    // Validate plugin type
    if (plugin.type !== 'skill') {
      throw new Error(`Plugin ${pluginFolder} is not a skill plugin`);
    }

    // Validate plugin interface
    if (!this.validateSkillPlugin(plugin)) {
      throw new Error(`Plugin ${pluginFolder} does not implement required skill interface`);
    }

    // Register plugin
    const pluginId = plugin.id;
    this.skills.set(pluginId, {
      ...plugin,
      metadata: plugin.metadata || {}
    });

    console.log(`✓ Loaded skill plugin: ${plugin.metadata?.displayName || plugin.name || pluginId}`);
  }

  /**
   * Validate that a connector plugin implements the required interface
   */
  validateConnectorPlugin(plugin) {
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
        console.error(`Connector plugin missing required method: ${method}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Validate that a skill plugin implements the required interface
   */
  validateSkillPlugin(plugin) {
    // Skills require these methods
    const requiredMethods = ['getDescription', 'execute'];

    for (const method of requiredMethods) {
      if (typeof plugin[method] !== 'function') {
        console.error(`Skill plugin missing required method: ${method}`);
        return false;
      }
    }

    // Validate category
    if (!plugin.category || !['transformer', 'join', 'both'].includes(plugin.category)) {
      console.error(`Skill plugin must have category: transformer, join, or both`);
      return false;
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
      name: plugin.metadata?.displayName || plugin.name,
      type: plugin.type,
      icon: plugin.icon,
      configSchema: plugin.configSchema,
      version: plugin.metadata?.version || '1.0.0',
      description: plugin.metadata?.description || '',
      dbCategory: plugin.dbCategory || null,
      storageType: plugin.storageType || null,
      authType: plugin.authType || null
    }));
  }

  /**
   * Get a skill plugin by ID
   */
  getSkill(id) {
    return this.skills.get(id);
  }

  /**
   * Check if a skill exists
   */
  hasSkill(id) {
    return this.skills.has(id);
  }

  /**
   * List all available skill plugins
   */
  listSkills() {
    return Array.from(this.skills.values()).map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      type: plugin.type,
      category: plugin.category,
      icon: plugin.icon,
      version: plugin.metadata?.version || '1.0.0',
      description: plugin.metadata?.description || '',
      metadata: plugin.metadata || {}
    }));
  }

  /**
   * Get skills by category
   */
  getSkillsByCategory(category) {
    return Array.from(this.skills.values())
      .filter(skill => skill.category === category || skill.category === 'both')
      .map(plugin => ({
        id: plugin.id,
        name: plugin.name,
        category: plugin.category,
        description: plugin.metadata?.description || '',
        metadata: plugin.metadata || {}
      }));
  }

  /**
   * Get skill descriptions for AI context
   * Used to inject skill information into transformation/join prompts
   * @param {String} category - Filter by category ('transformer', 'join', or null for all)
   * @param {Object} context - Context to pass to getTransformPrompts (e.g., operationType, sourceSchema)
   */
  getSkillDescriptions(category = null, context = {}) {
    const skills = category
      ? this.getSkillsByCategory(category)
      : this.listSkills();

    return skills.map(skill => {
      const plugin = this.skills.get(skill.id);
      const description = plugin.getDescription ? plugin.getDescription() : {};
      const prompts = plugin.getTransformPrompts ? plugin.getTransformPrompts(context) : {};

      return {
        id: skill.id,
        name: skill.name,
        category: skill.category,
        description: description,
        prompts: prompts
      };
    });
  }

  /**
   * Analyze a skill request
   * @param {String} skillId - The skill ID
   * @param {Object} params - Analysis parameters
   */
  async analyzeSkillRequest(skillId, params) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (typeof skill.analyzeRequest !== 'function') {
      // If skill doesn't have analyzeRequest, assume it's ready to execute
      return {
        action: 'generate_transformation',
        skillParams: params.skillParams || {}
      };
    }

    return await skill.analyzeRequest(params);
  }

  /**
   * Build a skill prompt (main skill interaction function)
   * @param {String} skillId - The skill ID
   * @param {Object} params - Request parameters
   */
  async buildSkillPrompt(skillId, params) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (typeof skill.buildSkillPrompt !== 'function') {
      throw new Error(`Skill ${skillId} does not implement buildSkillPrompt method`);
    }

    return await skill.buildSkillPrompt(params);
  }

  /**
   * Process a skill response from AI
   * @param {String} skillId - The skill ID
   * @param {String} aiResponse - AI response to process
   * @param {String} operationType - 'sql' or 'nosql' or 'vector'
   * @param {Object} currentState - Current state including isSourceVector flag
   * @param {Array} availableConnections - Available database connections
   * @param {Object} [helpers] - Injected helpers (callAI, runQuery, ...) for skills that need them
   */
  async processSkillResponse(skillId, aiResponse, operationType, currentState = {}, availableConnections = [], helpers = null) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (typeof skill.processSkillResponse !== 'function') {
      throw new Error(`Skill ${skillId} does not implement processSkillResponse method`);
    }

    return skill.processSkillResponse(aiResponse, operationType, currentState, availableConnections, helpers);
  }

  /**
   * Execute a skill
   */
  async executeSkill(skillId, params) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (typeof skill.execute !== 'function') {
      throw new Error(`Skill ${skillId} does not implement execute method`);
    }

    return await skill.execute(params);
  }

  /**
   * Unload a connector plugin
   */
  unloadConnector(pluginId) {
    const plugin = this.connectors.get(pluginId);
    if (plugin && typeof plugin.closeConnection === 'function') {
      // Close any open connections
      plugin.closeConnection();
    }
    this.connectors.delete(pluginId);
  }

  /**
   * Unload a skill plugin
   */
  unloadSkill(pluginId) {
    this.skills.delete(pluginId);
  }
}

module.exports = new PluginManager();
