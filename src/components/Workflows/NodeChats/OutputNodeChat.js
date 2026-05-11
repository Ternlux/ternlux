import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import { connectionsDb } from '../../../utils/localDb';
import ChatArea from '../../Chat/ChatArea';
import { loadTableSchema } from '../../../utils/tableSchemaUtils';
import CloudStorageBrowser from '../CloudStorageBrowser';
import {
  FileExcelOutlined,
  FileTextOutlined,
  DatabaseOutlined,
  ApiOutlined,
  CloudOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { ReactComponent as PostgresIcon } from '../../ConnectorImages/Postgres.svg';
import { ReactComponent as MysqlIcon } from '../../ConnectorImages/Mysql.svg';
import { ReactComponent as MssqlIcon } from '../../ConnectorImages/Mssql.svg';
import { ReactComponent as MongodbIcon } from '../../ConnectorImages/Mongodb.svg';
import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
import { ReactComponent as GoogleCloudStorageIcon } from '../../ConnectorImages/GoogleCloudStorage.svg';
import { ReactComponent as DropboxIcon } from '../../ConnectorImages/Dropbox.svg';
import { ReactComponent as GoogleDriveIcon } from '../../ConnectorImages/GoogleDrive.svg';
import { ReactComponent as GoogleSheetsIcon } from '../../ConnectorImages/GoogleSheets.svg';

// ─────────────────────────────────────────────────────────────────────────────
// Output Node Chat Component
// Handles workflow output (export to file or insert to connection)
// ─────────────────────────────────────────────────────────────────────────────

const DESTINATION_GROUP_COLOR = {
  'Cloud Storage': '#0891b2',
  APIs: '#2563eb',
  Vector: '#16a34a',
  Databases: '#7c3aed',
  'Local Files': '#d97706',
  Other: '#5a6678',
};

const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);

const categorizeConnection = (conn) => {
  if (!conn) return 'Other';
  if (conn.dbCategory === 'CloudStorage') return 'Cloud Storage';
  if (conn.dbCategory === 'API' || conn.dbType === 'rest-api') return 'APIs';
  if (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType)) return 'Vector';
  if (conn.connectionType === 'database') return 'Databases';
  if (conn.connectionType === 'file') return 'Local Files';
  return 'Other';
};

const getDbIcon = (dbType) => {
  const iconMap = {
    postgres: PostgresIcon,
    mysql: MysqlIcon,
    mssql: MssqlIcon,
    mongodb: MongodbIcon,
    sqlite: SqlliteIcon,
    nedb: SqlliteIcon,
    gcs: GoogleCloudStorageIcon,
    dropbox: DropboxIcon,
    'google-drive': GoogleDriveIcon,
    'google-sheets': GoogleSheetsIcon,
  };
  return iconMap[dbType?.toLowerCase()] || null;
};

const getConnectionIcon = (connection) => {
  if (!connection) return null;
  const category = categorizeConnection(connection);
  if (category === 'APIs') return <ApiOutlined style={{ fontSize: 18 }} />;
  if (category === 'Vector') return <AppstoreOutlined style={{ fontSize: 18 }} />;
  if (category === 'Cloud Storage') {
    const IconComponent = getDbIcon(connection.dbType);
    return IconComponent
      ? <IconComponent style={{ width: 20, height: 20 }} />
      : <CloudOutlined style={{ fontSize: 18 }} />;
  }
  if (connection.connectionType === 'file') {
    const fileName = connection.fileInfo?.fileName?.toLowerCase() || '';
    if (fileName.endsWith('.csv')) {
      return <FileTextOutlined style={{ fontSize: 20 }} />;
    }
    const IconComponent = getDbIcon(connection.dbType);
    if (IconComponent) {
      return <IconComponent style={{ width: 20, height: 20 }} />;
    }
    return <FileExcelOutlined style={{ fontSize: 20 }} />;
  }
  const IconComponent = getDbIcon(connection.dbType);
  return IconComponent
    ? <IconComponent style={{ width: 20, height: 20 }} />
    : <DatabaseOutlined style={{ fontSize: 18 }} />;
};

const formatTimestamp = (ts) => {
  const diff = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (diff < 1) return 'Just now';
  if (diff < 60) return `${diff}m`;
  return `${Math.floor(diff / 60)}h`;
};

const OutputNodeChat = ({
  node,
  nodes,
  edges,
  initialChat,
  onSave,
  onConfigUpdate,
  executeOutput,
  executingInd,
  executing = false
}) => {
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);
  const inputRef = useRef(null);
  const initialized = useRef(false);

  const [chat, setChat] = useState(initialChat);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);

  // Source node (output requires exactly 1 input)
  const [sourceNode, setSourceNode] = useState(null);
  const [sourceConnection, setSourceConnection] = useState(null);
  const [sourceTableSchema, setSourceTableSchema] = useState(null);

  // Available connections for connection output
  const [availableConnections, setAvailableConnections] = useState([]);

  // Output configuration state
  const [outputSettings, setOutputSettings] = useState({
    outputType: null,           // "connection" or "local"
    format: null,               // For local: "json", "csv", "excel", "nedb", "sqlite", "lancedb", "parquet", "avro"
    savePath: null,             // For local: file path
    connectionId: null,         // For connection: target connection ID
    tableName: null,            // For connection: target table name
  });

  const [pendingChoices, setPendingChoices] = useState([]);
  const [saveState, setSaveState] = useState(false);
  const [disableInput, setDisableInput] = useState(false);
  const [executionError, setExecutionError] = useState(null);

  // Cloud storage browser state
  const [cloudStorageBrowserOpen, setCloudStorageBrowserOpen] = useState(false);
  const [cloudStorageConnection, setCloudStorageConnection] = useState(null);
  const [pluginManager, setPluginManager] = useState(null);

  // ─────────────────────────────────────────────────────────────────────────
  // Initialize
  // ─────────────────────────────────────────────────────────────────────────

  const initializationFunc = async () => {
    const sourceDetectionResult = await detectSourceNode();

    // Restore state from saved config if reopening a saved node
    const savedConfig = node?.data?.config;
    if (savedConfig && initialChat.length > 0) {
      console.log('Restoring saved output config:', savedConfig);

      // Restore output settings
      if (savedConfig.outputSettings) {
        setOutputSettings(savedConfig.outputSettings);
      }
    } else {
      // New node - start with output type selection
      if (initialChat.length === 0 && sourceDetectionResult) {
        setDisableInput(true);

        const choices = [
          {
            label: 'Connection',
            value: 'connection',
            description: 'Insert data into a database connection',
            variant: 'outlined',
            fullWidth: true
          },
          {
            label: 'Local Environment',
            value: 'local',
            description: 'Export data to a local file',
            variant: 'outlined',
            fullWidth: true
          }
        ];

        const questionText = `I detected a data source connected to this output node.\n\n**Where would you like to output the data?**`;

        setPendingChoices(choices);
        addBotMessage(questionText, true, 'choice', 'outputType', '', null);

        setDisableInput(false);
      }
    }
  };

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      initializationFunc();
    }
  }, []);

  // Load plugin manager on mount
  useEffect(() => {
    const loadPluginManager = async () => {
      if (window.electronAPI?.dbConnect?.listPlugins) {
        try {
          const result = await window.electronAPI.dbConnect.listPlugins();
          if (result.success) {
            const manager = {
              getConnector: (dbType) => {
                const connector = result.connectors?.find(c => c.id === dbType);
                return connector || null;
              }
            };
            setPluginManager(manager);
          }
        } catch (error) {
          console.error('Failed to load plugin manager:', error);
        }
      }
    };
    loadPluginManager();
  }, []);

  // Sync chat state with initialChat prop when node changes
  useEffect(() => {
    if (initialized.current && initialChat.length > 0) {
      setChat(initialChat);
    }
  }, [node?.id, initialChat]);

  // Auto-scroll to bottom when chat messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chat]);

  // ─────────────────────────────────────────────────────────────────────────
  // Core Functions
  // ─────────────────────────────────────────────────────────────────────────

  const addBotMessage = (text, responseRequired = false, responseType = 'text', ref = '', placeholder = '', metadata = null) => {
    setChat(prev => [...prev, {
      id: `bot-${Date.now()}-${Math.random()}`,
      sender: 'bot',
      text,
      timestamp: new Date(),
      responseRequired,
      responseType,
      ref,
      placeholder: placeholder || 'Type your response…',
      metadata,
    }]);
  };

  const addUserMessage = (text, ref, value, data = null) => {
    const userMsg = {
      id: `user-${Date.now()}-${Math.random()}`,
      sender: 'user',
      text,
      timestamp: new Date(),
      ref,
      value: value || text,
      data,
    };
    setChat(prev => [...prev, userMsg]);
    return userMsg;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Detect Source Node
  // ─────────────────────────────────────────────────────────────────────────

  const detectSourceNode = async () => {
    setLoading(true);

    // Find connected source node (must have exactly 1 for output)
    const connectedEdges = edges.filter(e => e.target === node.id);
    if (connectedEdges.length === 0) {
      addBotMessage('An output node requires a connected data source. Please connect a source.', false);
      setLoading(false);
      return null;
    }

    if (connectedEdges.length > 1) {
      addBotMessage('An output node can only have one connected source. Please remove extra connections.', false);
      setLoading(false);
      return null;
    }

    const edge = connectedEdges[0];
    const source = nodes.find(n => n.id === edge.source);

    if (!source || !source.data?.config) {
      addBotMessage(`Source node "${source?.data?.label}" is not configured. Please configure the source first.`, false);
      setLoading(false);
      return null;
    }

    const sourceConfig = source.data.config;
    const nodeType = sourceConfig.nodeType;
    const isDataSource = nodeType === 'datasource';

    // Extract connection info (use target for transformers/joins, source for data sources)
    const connection = {
      id: isDataSource ? sourceConfig.sourceConnectionId : sourceConfig.targetConnectionId,
      name: isDataSource ? sourceConfig.sourceConnectionName : sourceConfig.targetConnectionName,
      connectionType: isDataSource
        ? (sourceConfig.sourceConnectionType || 'database')
        : (sourceConfig.targetConnectionType || 'database'),
      dbType: isDataSource ? sourceConfig.sourceDbType : sourceConfig.targetDbType,
      dbConfig: isDataSource
        ? (sourceConfig.sourceDbConfig || {})
        : (sourceConfig.targetDbConfig || {}),
      localPath: isDataSource ? sourceConfig.sourceLocalPath : sourceConfig.targetLocalPath,
      fileInfo: sourceConfig.fileInfo
    };

    // Get schema from saved config
    const savedSchema = isDataSource ? sourceConfig.sourceTableSchema : sourceConfig.targetTableSchema;

    let schema;
    if (savedSchema) {
      schema = {
        sourceNodeId: source.id,
        sourceNodeLabel: source.data.label,
        tableName: (isDataSource ? sourceConfig.sourceTableName : sourceConfig.targetTableName) ||
                   (isDataSource ? sourceConfig.sourceCollection : sourceConfig.targetCollection) ||
                   savedSchema.tableName,
        columns: savedSchema.columns,
        sampleData: savedSchema.sampleData,
        // Include the stored query for use in output execution
        query: isDataSource ? sourceConfig.sourceSql : sourceConfig.targetSql,
        sheetName: savedSchema.sheetName
      };
    } else {
      // Load schema from database
      schema = await loadSourceTableSchema(source, connection);
      if (schema) {
        schema.sourceNodeId = source.id;
        schema.sourceNodeLabel = source.data.label;
      }
    }

    if (!schema) {
      addBotMessage(`Failed to load schema for source "${source.data.label}".`, false);
      setLoading(false);
      return null;
    }
    console.log('schema: ', schema)

    setSourceNode(source);
    setSourceConnection(connection);
    setSourceTableSchema(schema);

    // Load all database connections for connection output option
    const token = localStorage.getItem('auth-token');
    let allConnections = [];
    if (!token) {
      allConnections = await connectionsDb.getAll();
    } else {
      const res = await axios.post('/workflow/connections', { transformer: false }, {
        headers: { 'auth-token': token },
      });
      allConnections = res.data || [];
    }

    // Load plugins to get dbCategory for each connection
    let pluginsMap = new Map();
    if (window.electronAPI?.dbConnect?.listPlugins) {
      try {
        const pluginsResult = await window.electronAPI.dbConnect.listPlugins();
        if (pluginsResult.success && pluginsResult.connectors) {
          pluginsResult.connectors.forEach(plugin => {
            pluginsMap.set(plugin.id, plugin);
          });
        }
      } catch (error) {
        console.error('Failed to load plugins:', error);
      }
    }

    // Enrich connections with plugin metadata
    const enrichedConnections = allConnections.map(conn => {
      const plugin = pluginsMap.get(conn.dbType);
      return {
        ...conn,
        dbCategory: plugin?.dbCategory || null,
        storageType: plugin?.storageType || null
      };
    });

    const connections = enrichedConnections
      .filter(conn => {
        // Include database connections, cloud storage connections, and vector databases
        return conn.connectionType === 'database' ||
               conn.dbCategory === 'CloudStorage' ||
               conn.dbCategory === 'Vector';
      })
      .map(conn => {
        const isCloudStorage = conn.dbCategory === 'CloudStorage';
        const isVector = conn.dbCategory === 'Vector';
        const group = categorizeConnection(conn);
        return {
          id: conn.id,
          label: conn.name,
          value: conn.id,
          description: isCloudStorage
            ? `Upload to ${conn.name} (${conn.dbType})`
            : isVector
              ? `Insert vectors into ${conn.name} (${conn.dbType})`
              : `Insert into ${conn.name} (${conn.dbType})`,
          connection: conn,
          icon: getConnectionIcon(conn),
          group,
          groupColor: DESTINATION_GROUP_COLOR[group] || DESTINATION_GROUP_COLOR.Other,
        };
      });

    setAvailableConnections(connections);
    setLoading(false);

    return { source, schema };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Load Source Table Schema
  // ─────────────────────────────────────────────────────────────────────────

  const loadSourceTableSchema = async (source, connection) => {
    if (!window.electronAPI?.dbConnect && connection.connectionType === 'database') {
      console.warn('Database API not available');
      return null;
    }

    try {
      const sourceConfig = source?.data?.config || {};
      const isNoSQL = connection.dbType === 'mongodb' || connection.dbType === 'nedb';

      let tableName = null;
      let tableSchema = null;
      let localPath = null;
      let queryConnection = connection;

      if (isNoSQL) {
        tableName = sourceConfig.targetCollection ||
                    sourceConfig.sourceCollection ||
                    sourceConfig.table;
        localPath = sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;

        if (connection.dbType === 'nedb') {
          queryConnection = { ...connection, dbType: 'mongodb' };
        }
      } else {
        tableSchema = sourceConfig.targetSchema || sourceConfig.sourceSchema || connection.dbConfig?.schema;
        tableName = sourceConfig.targetTableName ||
                    sourceConfig.sourceTableName ||
                    sourceConfig.table;
      }

      if (!tableName && !localPath) {
        console.warn('Could not determine table name or local path from source config');
        return null;
      }

      const schema = await loadTableSchema({
        connection: queryConnection,
        tableName,
        tableSchema,
        localPath,
        limit: 5
      });

      return schema;
    } catch (error) {
      console.error('Failed to load source schema:', error);
      return null;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Handle User Responses
  // ─────────────────────────────────────────────────────────────────────────

  const handleUserResponse = async (text, ref, value, data) => {
    const userMsg = addUserMessage(text, ref, value, data);

    if (ref === 'outputType') {
      await handleOutputTypeResponse(value);
    } else if (ref === 'format') {
      await handleFormatResponse(value);
    } else if (ref === 'savePath') {
      await handleSavePathResponse(text);
    } else if (ref === 'connectionSelection') {
      await handleConnectionResponse(value, data);
    } else if (ref === 'tableName') {
      await handleTableNameResponse(text);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Choice Response Handlers
  // ─────────────────────────────────────────────────────────────────────────

  const handleOutputTypeResponse = async (value) => {
    const updatedSettings = {
      ...outputSettings,
      outputType: value
    };

    setOutputSettings(updatedSettings);
    setPendingChoices([]);

    if (value === 'local') {
      // Show format choices
      const formatChoices = [
        { label: 'JSON', value: 'json', description: 'Export as JSON file', variant: 'outlined', fullWidth: true },
        { label: 'CSV', value: 'csv', description: 'Export as CSV file', variant: 'outlined', fullWidth: true },
        { label: 'Excel', value: 'excel', description: 'Export as Excel file (.xlsx)', variant: 'outlined', fullWidth: true },
        { label: 'NeDB', value: 'nedb', description: 'Export to local NeDB database', variant: 'outlined', fullWidth: true },
        { label: 'SQLite', value: 'sqlite', description: 'Export to local SQLite database', variant: 'outlined', fullWidth: true },
        { label: 'LanceDB', value: 'lancedb', description: 'Export to local LanceDB vector database', variant: 'outlined', fullWidth: true },
        { label: 'Parquet', value: 'parquet', description: 'Export as Parquet file', variant: 'outlined', fullWidth: true },
        { label: 'Avro', value: 'avro', description: 'Export as Avro file', variant: 'outlined', fullWidth: true },
      ];

      setPendingChoices(formatChoices);
      addBotMessage(
        'Select the output format:',
        true,
        'choice',
        'format',
        '',
        null
      );
    } else if (value === 'connection') {
      // Show connection choices
      if (availableConnections.length === 0) {
        addBotMessage('No database connections available. Please create a connection first.', false);
        return;
      }

      const connectionChoices = availableConnections.map(conn => ({
        label: conn.label,
        value: conn.value,
        description: conn.description,
        _data: conn,
        variant: 'outlined',
        fullWidth: true,
        icon: conn.icon,
        group: conn.group,
        groupColor: conn.groupColor,
      }));

      setPendingChoices(connectionChoices);
      addBotMessage(
        'Select the destination connection:',
        true,
        'choice',
        'connectionSelection',
        '',
        null
      );
    }
  };

  const handleFormatResponse = async (format) => {
    const updatedSettings = {
      ...outputSettings,
      format
    };

    setOutputSettings(updatedSettings);
    setPendingChoices([]);

    // Open file dialog for save path
    const fileExtension = format === 'excel' ? 'xlsx' : format;
    const defaultFileName = `output_${node.id.slice(0, 8)}.${fileExtension}`;

    try {
      const result = await window.electronAPI.selectSavePath(defaultFileName, fileExtension);

      if (result.canceled) {
        addBotMessage('File selection canceled. Please select a file path.', false);
        // Re-show format selection
        const formatChoices = [
          { label: 'JSON', value: 'json', description: 'Export as JSON file', variant: 'outlined', fullWidth: true },
          { label: 'CSV', value: 'csv', description: 'Export as CSV file', variant: 'outlined', fullWidth: true },
          { label: 'Excel', value: 'excel', description: 'Export as Excel file (.xlsx)', variant: 'outlined', fullWidth: true },
          { label: 'NeDB', value: 'nedb', description: 'Export to local NeDB database', variant: 'outlined', fullWidth: true },
          { label: 'SQLite', value: 'sqlite', description: 'Export to local SQLite database', variant: 'outlined', fullWidth: true },
          { label: 'LanceDB', value: 'lancedb', description: 'Export to local LanceDB vector database', variant: 'outlined', fullWidth: true },
          { label: 'Parquet', value: 'parquet', description: 'Export as Parquet file', variant: 'outlined', fullWidth: true },
          { label: 'Avro', value: 'avro', description: 'Export as Avro file', variant: 'outlined', fullWidth: true },
        ];
        setPendingChoices(formatChoices);
        return;
      }

      const savePath = result.filePath;
      const finalSettings = {
        ...updatedSettings,
        savePath
      };

      setOutputSettings(finalSettings);
      setSaveState(true);

      addBotMessage(`✓ Configuration complete!\n\nOutput will be saved to: ${savePath}`, false);
      addBotMessage('Click Run & Save Configuration when ready.', false);

    } catch (error) {
      console.error('Error selecting save path:', error);
      addBotMessage('Failed to open file dialog. Please try again.', false);
    }
  };

  const handleSavePathResponse = async (savePath) => {
    const updatedSettings = {
      ...outputSettings,
      savePath
    };

    setOutputSettings(updatedSettings);
    setSaveState(true);

    addBotMessage(`✓ Configuration complete!\n\nOutput will be saved to: ${savePath}`, false);
    addBotMessage('Click Run & Save Configuration when ready.', false);
  };

  const handleConnectionResponse = async (value, data) => {
    const connection = data || availableConnections.find(c => c.value === value);
    if (!connection) {
      addBotMessage('Invalid connection selection. Please try again.', false);
      return;
    }

    const updatedSettings = {
      ...outputSettings,
      connectionId: value
    };

    setOutputSettings(updatedSettings);
    setPendingChoices([]);
    console.log('connection.connection: ', connection.connection, data, availableConnections)

    // Check if this is a cloud storage connection
    const isCloudStorage = connection.connection?.dbCategory === 'CloudStorage';
    const isVector = connection.connection?.dbCategory === 'Vector';

    if (isCloudStorage) {
      // Open cloud storage browser for path selection
      setCloudStorageConnection(connection.connection);
      setCloudStorageBrowserOpen(true);
      addBotMessage(`Opening cloud storage browser to select output path...`, false);
      return;
    }

    if (isVector) {
      // For vector databases, ask for index/table name
      const dbType = connection.connection?.dbType;
      let prompt = '';
      let placeholder = '';

      if (dbType === 'pinecone') {
        prompt = 'What Pinecone index should the vectors be inserted into?\n\n**Note**: Use format `index-name` or `index-name/namespace` to specify a namespace';
        placeholder = 'index-name or index-name/namespace';
      } else {
        // LanceDB or other vector databases
        prompt = 'What table name should the vectors be inserted into?';
        placeholder = 'Enter table name...';
      }

      addBotMessage(prompt, true, 'text', 'tableName', placeholder);
      return;
    }

    // For database connections, ask for table name
    // Check if this database needs schema qualification
    const needsSchemaInfo = connection.connection?.dbType === 'bigquery'
      ? '\n\n**Note**: For BigQuery, use the format `dataset.table_name`'
      : connection.connection?.dbType === 'snowflake'
      ? '\n\n**Note**: For Snowflake, you can use `schema.table_name` or just `table_name`'
      : '';

    addBotMessage(
      `What table name should the data be inserted into?${needsSchemaInfo}`,
      true,
      'text',
      'tableName',
      connection.connection?.dbType === 'bigquery' ? 'dataset.table_name' : 'Enter table name...'
    );
  };

  const handleTableNameResponse = async (tableName) => {
    // Get the connection to access dbType and dbConfig
    const selectedConnection = availableConnections.find(c => c.value === outputSettings.connectionId);

    let quotedTableName = tableName;

    // Use quoteIdentifier to add schema qualification for databases that need it
    if (selectedConnection?.connection) {
      const conn = selectedConnection.connection;
      const dbType = conn.dbType;
      const dbConfig = conn.dbConfig || {};

      try {
        // Parse schema from table name if user provided it (e.g., "dataset.table" or "schema.table")
        let parsedSchema = null;
        let parsedTableName = tableName;

        if (tableName.includes('.')) {
          const parts = tableName.split('.');
          if (parts.length === 2) {
            // format: schema.table
            [parsedSchema, parsedTableName] = parts;
          } else if (parts.length === 3 && dbType === 'bigquery') {
            // format: project.dataset.table (BigQuery)
            parsedTableName = tableName; // Keep full format for BigQuery
          }
        }

        // Determine schema to use
        let schema = parsedSchema || dbConfig.schema;

        // Apply default schemas for specific database types if not provided
        if (!schema) {
          if (dbType === 'mssql') {
            schema = 'dbo';
          } else if (dbType === 'bigquery') {
            schema = dbConfig.dataset;
          }
        }

        // Only call quoteIdentifier if we have a simple table name (not already qualified)
        if (!tableName.includes('.') || (tableName.includes('.') && dbType !== 'bigquery')) {
          const result = await window.electronAPI.dbConnect.quoteIdentifier(
            dbType,
            parsedTableName,
            schema,
            dbConfig,
            conn.id
          );

          if (result.success) {
            quotedTableName = result.quotedIdentifier;
          }
        } else {
          // User provided fully qualified name (e.g., dataset.table for BigQuery)
          // Use it as-is
          quotedTableName = tableName;
        }
      } catch (err) {
        console.log('Could not quote identifier, using table name as-is:', err);
      }
    }

    const updatedSettings = {
      ...outputSettings,
      tableName: quotedTableName
    };

    setOutputSettings(updatedSettings);
    setSaveState(true);

    addBotMessage(`✓ Configuration complete!\n\nData will be inserted into table: ${quotedTableName}`, false);
    addBotMessage('Click Run & Save Configuration when ready.', false);
  };

  const handleCloudStoragePathSelect = (pathInfo) => {
    setCloudStorageBrowserOpen(false);

    // pathInfo contains: { containerName, objectPath, fullPath }
    const tableName = pathInfo.fullPath;

    const updatedSettings = {
      ...outputSettings,
      tableName
    };
    console.log('updatedSettings: ', updatedSettings)
    setOutputSettings(updatedSettings);
    setSaveState(true);

    addBotMessage(`✓ Configuration complete!\n\nData will be uploaded to: ${tableName}`, false);
    addBotMessage('Click Run & Save Configuration when ready.', false);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Build Configuration
  // ─────────────────────────────────────────────────────────────────────────

  const buildConfig = () => {
    if (!sourceNode || !sourceConnection) return {};

    const config = {
      nodeType: 'output',

      // Source information
      sourceNodeId: sourceNode.id,
      sourceNodeLabel: sourceNode.data?.label,
      sourceConnectionId: sourceConnection.id,
      sourceConnectionName: sourceConnection.name,
      sourceConnectionType: sourceConnection.connectionType,
      sourceDbType: sourceConnection.dbType,
      sourceDbConfig: sourceConnection.dbConfig,
      sourceTableSchema: sourceTableSchema,
      sourceTableName: sourceTableSchema?.tableName,
      sourceCollection: sourceTableSchema?.tableName,
      sourceLocalPath: sourceConnection.localPath,

      // Output settings
      outputSettings: outputSettings,
    };

    return config;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Execute Output
  // ─────────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaveState(false);
    setExecutionError(null);

    executingInd(true);

    const result = await executeOutput({
      sourceConnection,
      sourceTableSchema,
      outputSettings,
      onSuccess: (res) => {
        addBotMessage(`✓ ${res.message}`, false);
        if (res.filePath) {
          addBotMessage(`📁 File saved at: ${res.filePath}`, false);
        }
      },
      onError: (err) => {
        addBotMessage(`✗ Output failed: ${err.error || err.message}`, false);
        setExecutionError({
          error: err.error || err.message
        });
      }
    });

    executingInd(false);

    if (!result.success) return;

    setSaveState(false);

    // Save configuration
    const config = buildConfig();
    console.log('Saving output config:', config);
    onSave(config, chat);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // UI Helpers
  // ─────────────────────────────────────────────────────────────────────────

  const getCurrentQuestion = () => {
    for (let i = 0; i < chat.length; i++) {
      const msg = chat[i];
      if (msg.sender === 'bot' && msg.responseRequired) {
        const nextMsg = chat[i + 1];
        if (!nextMsg || nextMsg.sender !== 'user') {
          return msg;
        }
      }
    }
    return null;
  };

  const currentQ = getCurrentQuestion();

  const getPlaceholder = () => {
    if (!currentQ) return '';
    return currentQ.placeholder || 'Type your response…';
  };

  const handleSendMessage = () => {
    const text = inputValue.trim();
    if (!text || !currentQ) return;
    setInputValue('');
    handleUserResponse(text, currentQ.ref, text, null);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const displayChoices = () => {
    if (loading || executing) return [];

    if (pendingChoices.length > 0) {
      return pendingChoices;
    }

    if (executionError) {
      return [{
        label: '🔄 Retry Configuration',
        value: 'retry',
        variant: 'outlined',
        fullWidth: true
      }];
    }

    if (saveState) {
      return [{ label: 'Run & Save Configuration', value: 'save', variant: 'contained', fullWidth: true }];
    }

    return [];
  };

  const handleChoiceClick = (choice) => {
    if (choice.value === 'save') {
      handleSave();
      return;
    }

    if (choice.value === 'retry') {
      // Reset to start
      setPendingChoices([]);
      setOutputSettings({
        outputType: null,
        format: null,
        savePath: null,
        connectionId: null,
        tableName: null,
      });
      setExecutionError(null);
      initializationFunc();
      return;
    }

    const currentQ = getCurrentQuestion();
    if (!currentQ) return;

    handleUserResponse(
      choice.label,
      currentQ.ref,
      choice.value,
      choice._data || null
    );
  };

  const displayMessages = chat.map(m => ({
    id: m.id,
    text: m.text,
    metadata: m.metadata,
    sender: m.sender,
    timestamp: m.timestamp || new Date(),
  }));

  // ─────────────────────────────────────────────────────────────────────────
  // Code popup wiring
  // ─────────────────────────────────────────────────────────────────────────
  const handleCodeSave = useCallback((field, value, message) => {
    setChat(prev => prev.map(m =>
      m.id === message?.id
        ? { ...m, metadata: { ...m.metadata, [field]: value } }
        : m
    ));

    if (!onConfigUpdate || !node?.id) return;

    let update;
    switch (field) {
      case 'sql':
        update = { targetSql: value };
        break;
      case 'ddl':
      case 'targetDdl':
        update = { targetDdl: value };
        break;
      default:
        update = { [field]: value };
    }
    onConfigUpdate(node.id, update);
  }, [onConfigUpdate, node?.id]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <ChatArea
        hideHeader
        isFullscreen={false}
        currentChatTitle=""
        multiStepData={null}
        handleFullscreen={() => {}}
        handleToggleChat={() => {}}
        chatContainerRef={chatContainerRef}
        messages={displayMessages}
        isLoading={loading}
        progressInfo={{ progress: 0, stage: loading ? 'Processing...' : '' }}
        messagesEndRef={messagesEndRef}
        inputRef={inputRef}
        inputValue={inputValue}
        setInputValue={setInputValue}
        handleKeyPress={handleKeyPress}
        handleSendMessage={handleSendMessage}
        formatTimestamp={formatTimestamp}
        onSaveToMain={null}
        choices={displayChoices()}
        onChoiceSelect={handleChoiceClick}
        inputPlaceholder={getPlaceholder()}
        disableInput={disableInput}
        showRunButton={false}
        onRun={null}
        runButtonLoading={false}
        onCodeSave={handleCodeSave}
      />

      {cloudStorageBrowserOpen && cloudStorageConnection && pluginManager && (
        <CloudStorageBrowser
          open={cloudStorageBrowserOpen}
          onClose={() => setCloudStorageBrowserOpen(false)}
          connection={cloudStorageConnection}
          onFileSelect={handleCloudStoragePathSelect}
          pluginManager={pluginManager}
          mode="output"
          sourceDbType={sourceConnection?.dbType}
        />
      )}
    </div>
  );
};

export default OutputNodeChat;
