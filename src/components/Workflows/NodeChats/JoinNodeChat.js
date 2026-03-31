import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { connectionsDb } from '../../../utils/localDb';
import { getWorkflowAssistance } from '../../../utils/workflowAI';
import ChatArea from '../../Chat/ChatArea';
import ChatPrompts from './ChatPrompts/Join';
import { loadTableSchema } from '../../../utils/tableSchemaUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Join Node Chat Component
// Handles joining multiple data sources with intelligent configuration
// ─────────────────────────────────────────────────────────────────────────────

const formatTimestamp = (ts) => {
  const diff = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (diff < 1) return 'Just now';
  if (diff < 60) return `${diff}m`;
  return `${Math.floor(diff / 60)}h`;
};

const JoinNodeChat = ({
  node,
  nodes,
  edges,
  initialChat,
  onSave,
  onLoadDatabaseTables,
  onConfigUpdate,
  onPreviewConfigUpdate,
  onExecute,
  executeJoin,
  executingInd,
  executing = false
}) => {
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);
  const inputRef = useRef(null);
  const initialized = useRef(false);
  const userRequestRef = useRef(null);

  const [chat, setChat] = useState(initialChat);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  // Multiple source nodes (joins require 2+ inputs)
  const [sourceNodes, setSourceNodes] = useState([]);
  const [sourceConnections, setSourceConnections] = useState([]);
  const [sourceTableSchemas, setSourceTableSchemas] = useState([]);

  // Destination/target configuration
  const [targetConnection, setTargetConnection] = useState(null);
  const [availableDestinations, setAvailableDestinations] = useState([]);
  const [destinationTables, setDestinationTables] = useState([]); // Tables in destination for merge_existing

  // Join configuration state
  const [latestJoinConfig, setLatestJoinConfig] = useState(null);
  const [saveState, setSaveState] = useState(false);
  const [disableInput, setDisableInput] = useState(false);

  // Error state for failed joins
  const [executionError, setExecutionError] = useState(null);

  // Join settings state
  const [joinSettings, setJoinSettings] = useState({
    operationMode: null,           // "new_table" or "merge_existing"
    destinationSelection: null,    // Selected destination connection ID
    targetTableName: null,         // Table name for output
    joinColumns: [],               // Array of join conditions
    selectedColumns: {},           // {sourceNodeId: [columns]}
    userRequest: null              // Original user request
  });

  const [pendingChoices, setPendingChoices] = useState([]);

  // ─────────────────────────────────────────────────────────────────────────
  // Initialize
  // ─────────────────────────────────────────────────────────────────────────

  const initializationFunc = async () => {
    const sourcesDetectionResult = await detectSourceNodes();

    // Restore state from saved config if reopening a saved node
    const savedConfig = node?.data?.config;
    if (savedConfig && initialChat.length > 0) {
      console.log('Restoring saved join config:', savedConfig);

      // Restore latestJoinConfig
      if (savedConfig.targetSql || savedConfig.aggregationPipeline) {
        const restoredData = {
          ddl: savedConfig.targetDdl || '',
          sql: savedConfig.targetSql,
          insertSql: savedConfig.targetInsertSql || null,
          previewSql: savedConfig.targetPreviewSql || '',
          explanation: savedConfig.targetSqlExplanation || '',
          joinRequest: savedConfig.joinRequest || '',
          joinSettings: savedConfig.joinSettings || null,
          targetDbType: savedConfig.targetDbType || null,
          joinColumns: savedConfig.joinColumns,
          executionPlan: savedConfig.executionPlan
        };

        // Add NoSQL-specific fields if present
        if (savedConfig.aggregationPipeline) {
          restoredData.aggregationPipeline = savedConfig.aggregationPipeline;
        }

        setLatestJoinConfig(restoredData);
      }

      // Restore join settings
      if (savedConfig.joinSettings) {
        setJoinSettings(savedConfig.joinSettings);
        if (savedConfig.joinSettings.userRequest) {
          userRequestRef.current = savedConfig.joinSettings.userRequest;
        }
      }

      // Restore target connection
      if (savedConfig.targetConnectionId) {
        const restoredConnection = availableDestinations.find(d => d.id === savedConfig.targetConnectionId);
        if (restoredConnection) {
          setTargetConnection(restoredConnection.connection);
        }
      }
    } else {
      // New node - start with destination selection
      if (initialChat.length === 0 && sourcesDetectionResult) {
        setDisableInput(true);

        // Get destination choices - use the result directly since state might not be updated yet
        if (sourcesDetectionResult.destinations && sourcesDetectionResult.destinations.length > 0) {
          const choices = sourcesDetectionResult.destinations.map(dest => ({
            label: dest.label,
            value: dest.value,
            description: dest.description,
            _data: dest,
            variant: 'outlined',
            fullWidth: true
          }));

          const questionText = `I detected ${sourcesDetectionResult.sources.length} data sources connected to this join node.\n\n**First, select where you want to store the joined data:**`;

          setPendingChoices(choices);
          addBotMessage(questionText, true, 'choice', 'destinationSelection', '', null);
        }

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
  // Detect Source Nodes
  // ─────────────────────────────────────────────────────────────────────────

  const detectSourceNodes = async () => {
    setLoading(true);

    // Find all connected source nodes (must have 2 or more for join)
    const connectedEdges = edges.filter(e => e.target === node.id);
    if (connectedEdges.length < 2) {
      addBotMessage('A join requires at least 2 connected data sources. Please connect more sources.', false);
      setLoading(false);
      return null;
    }

    const sources = [];
    const connections = [];
    const schemas = [];

    // Load each connected source
    for (const edge of connectedEdges) {
      const sourceNode = nodes.find(n => n.id === edge.source);
      if (!sourceNode || !sourceNode.data?.config) {
        addBotMessage(`Source node "${sourceNode?.data?.label}" is not configured. Please configure all sources first.`, false);
        setLoading(false);
        return null;
      }

      const sourceConfig = sourceNode.data.config;
      const nodeType = sourceConfig.nodeType;
      const isDataSource = nodeType === 'datasource';

      // Extract connection info (use target for transformers, source for data sources)
      const connection = {
        id: isDataSource ? sourceConfig.sourceConnectionId : sourceConfig.targetConnectionId,
        name: isDataSource ? sourceConfig.sourceConnectionName : sourceConfig.targetConnectionName,
        connectionType: isDataSource ? sourceConfig.sourceConnectionType : sourceConfig.targetConnectionType,
        dbType: isDataSource ? sourceConfig.sourceDbType : sourceConfig.targetDbType,
        dbConfig: isDataSource ? sourceConfig.sourceDbConfig : sourceConfig.targetDbConfig,
        localPath: isDataSource ? sourceConfig.sourceLocalPath : sourceConfig.targetLocalPath
      };

      // Get schema from saved config or load from database
      let schema;
      const savedSchema = isDataSource ? sourceConfig.sourceTableSchema : sourceConfig.targetTableSchema;

      if (savedSchema) {
        schema = {
          sourceNodeId: sourceNode.id,
          sourceNodeLabel: sourceNode.data.label,
          tableName: (isDataSource ? sourceConfig.sourceTableName : sourceConfig.targetTableName) ||
                     (isDataSource ? sourceConfig.sourceCollection : sourceConfig.targetCollection) ||
                     savedSchema.tableName,
          columns: savedSchema.columns,
          sampleData: savedSchema.sampleData
        };
      } else {
        // Load schema from database
        schema = await loadSourceTableSchema(sourceNode, connection);
        if (schema) {
          schema.sourceNodeId = sourceNode.id;
          schema.sourceNodeLabel = sourceNode.data.label;
        }
      }
      console.log('schema: ', sourceConfig, schema)
      if (!schema) {
        addBotMessage(`Failed to load schema for source "${sourceNode.data.label}".`, false);
        setLoading(false);
        return null;
      }

      sources.push(sourceNode);
      connections.push(connection);
      schemas.push(schema);
    }

    setSourceNodes(sources);
    setSourceConnections(connections);
    setSourceTableSchemas(schemas);

    // Build available destinations list from ALL database connections
    const destinations = [];
    const seenConnectionIds = new Set();

    // Load all database connections from the system
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

    // Add all database connections as potential destinations (deduplicated by connection ID)
    allConnections.forEach((conn) => {
      // console.log('conn: ', conn)
      if (conn.connectionType === 'database' && !seenConnectionIds.has(conn.id)) {
        seenConnectionIds.add(conn.id);
        destinations.push({
          id: conn.id,
          label: conn.name,
          value: conn.id,
          description: `Store in ${conn.name} (${conn.dbType})`,
          connection: conn
        });
      }
    });

    // Add local storage options (always available)
    destinations.push({
      id: 'local-sqlite',
      label: 'Local SQLite',
      value: 'local-sqlite',
      description: 'Store locally in SQLite file',
      connection: { dbType: 'sqlite', connectionType: 'file' }
    });

    destinations.push({
      id: 'local-nedb',
      label: 'Local NeDB',
      value: 'local-nedb',
      description: 'Store locally in NeDB file',
      connection: { dbType: 'nedb', connectionType: 'file' }
    });

    setAvailableDestinations(destinations);
    setLoading(false);

    // Return both sources and destinations for immediate use
    return {
      sources,
      destinations
    };
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

    if (ref === 'joinRequest' || ref === 'chatContinue') {
      await startJoinFlow(userMsg);
    } else if (ref === 'destinationSelection') {
      await handleDestinationResponse(value, data);
    } else if (ref === 'operationMode') {
      await handleOperationModeResponse(value);
    } else if (ref === 'targetTableName') {
      await handleTargetTableNameResponse(text);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Multi-Step Join Configuration Flow
  // ─────────────────────────────────────────────────────────────────────────

  const startJoinFlow = async (userMsg) => {
    setAiLoading(true);
    setLoading(true);

    // Store user's request
    userRequestRef.current = userMsg.text;
    setJoinSettings(prev => ({
      ...prev,
      userRequest: userMsg.text
    }));

    // Clear any pending state
    setPendingChoices([]);
    setExecutionError(null);

    try {
      // Build sources information for AI
      const sourcesInfo = sourceTableSchemas.map(schema => ({
        label: schema.sourceNodeLabel,
        tableName: schema.tableName,
        columns: schema.columns,
        sampleData: schema.sampleData
      }));

      const chatHistory = chat.map(msg => ({
        sender: msg.sender,
        text: msg.text
      }));

      // Analyze the join request to determine next steps
      await analyzeJoinRequest(userMsg.text, sourcesInfo, chatHistory);
    } catch (error) {
      console.error('Join analysis error:', error);
      addBotMessage('Failed to analyze your request. Please try again.', false);
      setAiLoading(false);
      setLoading(false);
    }
  };

  const analyzeJoinRequest = async (userRequest, sourcesInfo, chatHistory = []) => {
    const sourcesInfoStr = JSON.stringify(sourcesInfo, null, 2);

    const analysisPrompt = ChatPrompts.join.joinAnalysisRequest(
      userRequest,
      sourcesInfoStr,
      availableDestinations.map(d => `${d.label} (${d.description})`).join('\n'),
      joinSettings.operationMode
    );

    const response = await getWorkflowAssistance('join', analysisPrompt, {
      sources: sourcesInfo,
      destinations: availableDestinations,
      userRequest
    }, chatHistory);

    let analysis;
    try {
      analysis = JSON.parse(response);
    } catch (e) {
      console.error('Failed to parse join analysis:', e);
      // Fallback: ask for more details
      analysis = {
        action: 'ask_questions',
        followUpQuestion: 'I need more details about your join. Please specify which columns from each table should be matched, what type of join (INNER, LEFT, etc.), and which columns you want in the final result.',
        inferredSettings: {},
        reasoning: 'Failed to parse analysis, asking for clarification'
      };
    }

    console.log('Join analysis:', analysis);

    // Update join settings with inferred values
    const inferredSettings = { ...joinSettings, ...analysis.inferredSettings };
    inferredSettings.userRequest = userRequest;

    setJoinSettings(inferredSettings);

    if (analysis.action === 'answer_directly') {
      // Just answer the question without creating a join
      setAiLoading(false);
      setLoading(false);
      addBotMessage(analysis.directAnswer || 'Here is the information you requested.', false);
      addBotMessage(
        'Is there anything else you\'d like to know, or would you like to configure a join?',
        true,
        'text',
        'joinRequest',
        'Ask a question or describe a join...'
      );
    } else if (analysis.action === 'generate_join') {
      // Request is clear - generate join immediately
      setAiLoading(false);
      setLoading(false);

      const message = `✓ Join configuration complete.\nGenerating join query...`;
      addBotMessage(message, false);

      await generateJoinConfiguration(inferredSettings);
    } else if (analysis.action === 'ask_questions') {
      // Need to ask a follow-up question
      setAiLoading(false);
      setLoading(false);

      const followUpQuestion = analysis.followUpQuestion || 'Can you provide more details about how you want to join these tables?';

      // Ask the follow-up question and wait for user response
      addBotMessage(followUpQuestion, true, 'text', 'joinRequest', 'Describe your join...');
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Choice Response Handlers
  // ─────────────────────────────────────────────────────────────────────────

  const handleDestinationResponse = async (value, data) => {
    const destination = data || availableDestinations.find(d => d.value === value);
    if (!destination) {
      addBotMessage('Invalid destination selection. Please try again.', false);
      return;
    }

    setTargetConnection(destination.connection);

    const updatedSettings = {
      ...joinSettings,
      destinationSelection: value
    };

    setJoinSettings(updatedSettings);

    // Check if destination is NoSQL
    const isNoSQL = destination.connection?.dbType === 'mongodb' ||
                    destination.connection?.dbType === 'nedb' ||
                    value?.startsWith('local-nedb') ||
                    value?.startsWith('local-mongodb');

    // For NoSQL destinations, automatically set to new_table and skip the question
    if (isNoSQL) {
      const updatedSettingsWithMode = {
        ...updatedSettings,
        operationMode: 'new_table'
      };
      setJoinSettings(updatedSettingsWithMode);

      // Proceed directly to join request
      addBotMessage(
        'Great! Now, please describe how you want to join these sources.',
        true,
        'text',
        'joinRequest',
        'Describe your join...'
      );
      setPendingChoices([]);
      return;
    }

    // For SQL destinations, ask about operation mode
    const operationModeChoices = [
      {
        label: 'New Table',
        value: 'new_table',
        description: 'Create a new table with the joined data',
        variant: 'outlined',
        fullWidth: true
      },
      {
        label: 'Merge into Existing',
        value: 'merge_existing',
        description: 'Merge joined data into an existing table',
        variant: 'outlined',
        fullWidth: true
      }
    ];

    setPendingChoices(operationModeChoices);

    // Then add bot message
    addBotMessage(
      'How should the join be executed?',
      true,
      'choice',
      'operationMode',
      '',
      null
    );
  };

  const handleOperationModeResponse = async (value) => {
    const updatedSettings = {
      ...joinSettings,
      operationMode: value
    };

    setJoinSettings(updatedSettings);

    // If merge_existing, ask which table to merge into
    if (value === 'merge_existing') {
      setLoading(true);

      // Load tables from destination connection
      try {
        const isLocalPlaceholder = targetConnection?.id?.startsWith('local-');

        let tables = [];
        if (isLocalPlaceholder) {
          // For local storage, we can't list tables easily, ask user to type
          addBotMessage(
            'What is the name of the existing table you want to merge into?',
            true,
            'text',
            'targetTableName',
            'Enter table name...'
          );
          setLoading(false);
          return;
        } else {
          // Load tables from database connection using the prop function
          const result = await onLoadDatabaseTables(targetConnection);

          if (result.success) {
            tables = result.tables || [];
          }
        }

        if (tables.length === 0) {
          addBotMessage(
            'No tables found in the destination. What table name would you like to use?',
            true,
            'text',
            'targetTableName',
            'Enter table name...'
          );
        } else {
          setDestinationTables(tables);

          // Create choices from tables
          const tableChoices = tables.map(table => ({
            label: table.schema ? `${table.schema}.${table.name}` : table.name,
            value: table.name,
            description: `Merge into ${table.name}`,
            variant: 'outlined',
            fullWidth: true,
            displayType: 'dropdown'
          }));

          setPendingChoices(tableChoices);
          addBotMessage(
            'Select the existing table you want to merge the joined data into:',
            true,
            'choice',
            'targetTableName',
            'Select table...'
          );
        }
      } catch (error) {
        console.error('Error loading destination tables:', error);
        addBotMessage(
          'Could not load tables from destination. What table name would you like to use?',
          true,
          'text',
          'targetTableName',
          'Enter table name...'
        );
      } finally {
        setLoading(false);
      }
    } else {
      setPendingChoices([]);

      // For new_table, proceed directly to join request
      addBotMessage(
        'Great! Now, please describe how you want to join these sources.',
        true,
        'text',
        'joinRequest',
        'Describe your join...'
      );
    }
  };

  const handleTargetTableNameResponse = async (tableName) => {
    const updatedSettings = {
      ...joinSettings,
      targetTableName: tableName
    };

    setJoinSettings(updatedSettings);

    // Clear any pending choices from table selection
    setPendingChoices([]);

    // After getting table name, we should have all basic info - ask for join description
    addBotMessage(
      'Now, please describe how you want to join these sources.',
      true,
      'text',
      'joinRequest',
      'Describe your join...'
    );
  };

  // ─────────────────────────────────────────────────────────────────────────
  // AI Join Configuration Generation
  // ─────────────────────────────────────────────────────────────────────────

  const generateJoinConfiguration = async (settings) => {
    setAiLoading(true);
    setLoading(true);

    const targetDbType = targetConnection?.dbType ||
                        (settings.destinationSelection?.startsWith('local-')
                          ? settings.destinationSelection.replace('local-', '')
                          : 'sqlite');

    const isNoSQL = targetDbType === 'mongodb' || targetDbType === 'nedb';

    const targetTableName = settings.targetTableName || node.id.replace('-', '_').toLowerCase();

    const destinationConnectionId = targetConnection?.id || settings.destinationSelection;

    // Build sources info for AI with preprocessing to determine what's needed
    const sourcesInfo = sourceTableSchemas.map((schema, idx) => {
      const sourceConnectionId = sourceConnections[idx]?.id;
      const sourceDbType = sourceConnections[idx]?.dbType;
      const isSourceNoSQL = sourceDbType === 'mongodb' || sourceDbType === 'nedb';
      const isInDestinationDb = sourceConnectionId === destinationConnectionId;

      // Determine what fields are needed for this source
      let requiredFields = [];

      if (isNoSQL) {
        // NoSQL Destination: Everything loaded into memory, no temp tables
        if (isSourceNoSQL) {
          requiredFields = ['nosqlOperation']; // Query to fetch from NoSQL source
        } else {
          requiredFields = ['sql']; // Query to fetch from SQL source
        }
      } else {
        if (isSourceNoSQL) {
          requiredFields = ['tempTableName', 'ddl', 'nosqlOperation', 'insertSql']; // Query to fetch from NoSQL source
        } else if (isInDestinationDb) {
          // Source already in destination - reference directly in joinSql
          requiredFields = []; // No temp table needed
        } else {
          // External source - needs temp table
          requiredFields = ['tempTableName', 'ddl', 'sql', 'insertSql'];
        }
      }

      return {
        sourceNodeId: schema.sourceNodeId,
        sourceNodeLabel: schema.sourceNodeLabel,
        tableName: schema.tableName,
        columns: schema.columns,
        sampleData: schema.sampleData,
        connectionId: sourceConnectionId,
        dbType: sourceDbType,
        isInDestinationDb: isInDestinationDb,
        requiredFields: requiredFields
      };
    });

    const destinationConfig = {
      dbType: targetDbType,
      tableName: targetTableName,
      operationMode: settings.operationMode,
      connectionId: destinationConnectionId
    };

    const chatHistory = chat.slice(0, -1).map(msg => ({
      sender: msg.sender,
      text: msg.text
    }));

    try {
      const joinPrompt = ChatPrompts.join.generateJoinQuery(
        targetDbType,
        sourcesInfo,
        settings,
        destinationConfig
      );

      const response = await getWorkflowAssistance('join', joinPrompt, {
        sources: sourcesInfo,
        destination: destinationConfig,
        joinSettings: settings
      }, chatHistory);

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(response);
      } catch (e) {
        console.error('Failed to parse join response:', e);
        parsedResponse = {
          explanation: response,
          sql: '',
          ddl: ''
        };
      }

      console.log('Join configuration:', parsedResponse);

      // Enrich sourcesConfig with connection information
      if (parsedResponse.sourcesConfig) {
        parsedResponse.sourcesConfig = parsedResponse.sourcesConfig.map((sourceConfig) => {
          const sourceIndex = sourceTableSchemas.findIndex(
            schema => schema.sourceNodeId === sourceConfig.sourceNodeId
          );

          if (sourceIndex !== -1) {
            const connection = sourceConnections[sourceIndex];
            return {
              ...sourceConfig,
              connection: {
                id: connection.id,
                dbType: connection.dbType,
                dbConfig: connection.dbConfig,
                fileInfo: connection.fileInfo,
                localPath: connection.localPath
              }
            };
          }
          return sourceConfig;
        });
      }

      // Add targetTableName if not provided by AI
      if (!parsedResponse.targetTableName) {
        parsedResponse.targetTableName = targetTableName || node.id.replace(/-/g, '_').toLowerCase();
      }

      // Build execution plan (same for SQL and NoSQL)
      const executionPlan = buildExecutionPlan(sourcesInfo, destinationConfig, parsedResponse);

      // Apply join configuration
      const joinConfig = {
        ...parsedResponse,
        targetDbType,
        executionPlan,
        joinSettings: settings,
        joinRequest: settings.userRequest
      };

      // For NoSQL, store the JavaScript join function as transformFunction
      if (isNoSQL && parsedResponse.javascriptFunction) {
        joinConfig.transformFunction = parsedResponse.javascriptFunction;
      }

      setLatestJoinConfig(joinConfig);
      setSaveState(true);

      // Display explanation
      const executionNote = isNoSQL
        ? '\n\n**Note:** This join will be executed using JavaScript in the local environment, then uploaded to the destination database.'
        : '';

      addBotMessage(
        `✓ Join configuration generated!\n\n${parsedResponse.explanation || 'Join is ready to execute.'}${executionNote}`,
        false,
        'text',
        null,
        '',
        {
          sourcesConfig: parsedResponse.sourcesConfig,
          targetDdl: parsedResponse.targetDdl,
          joinSql: parsedResponse.joinSql,
          joinColumns: parsedResponse.joinColumns,
          selectedColumns: parsedResponse.selectedColumns,
          javascriptFunction: parsedResponse.javascriptFunction
        }
      );

      addBotMessage(
        'You can refine this join or click Run & Save Configuration when ready.',
        true,
        'text',
        'chatContinue',
        'Ask a follow-up question or request changes…'
      );

    } catch (error) {
      console.error('Join generation error:', error);
      addBotMessage('Failed to generate join configuration. Please try again.', false);
    } finally {
      setAiLoading(false);
      setLoading(false);
    }
  };

  const buildExecutionPlan = (sources, destination, joinConfig) => {
    const plan = {
      steps: []
    };

    // Step 1-N: Load each source into temp table in destination
    sources.forEach((source, idx) => {
      const tempTableName = `temp_join_${node.id}_source${idx + 1}_${Date.now()}`.replace(/-/g, '_');

      plan.steps.push({
        type: 'load_temp_table',
        stepNumber: idx + 1,
        sourceNodeId: source.sourceNodeId,
        sourceLabel: source.sourceNodeLabel,
        sourceTable: source.tableName,
        tempTableName: tempTableName,
        action: `Extract data from "${source.sourceNodeLabel}" and load into temp table "${tempTableName}" in destination database`,
        connection: source.connection
      });
    });

    // Final step: Execute join on temp tables
    plan.steps.push({
      type: 'execute_join',
      stepNumber: plan.steps.length + 1,
      action: `Execute join on temporary tables and insert into "${destination.tableName}"`,
      outputTable: destination.tableName
    });

    return plan;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Build Configuration
  // ─────────────────────────────────────────────────────────────────────────

  const buildConfig = async () => {
    if (!sourceConnections || sourceConnections.length === 0) return {};

    const isNoSQL = targetConnection?.dbType === 'mongodb' || targetConnection?.dbType === 'nedb';
    const isLocalStorage = joinSettings.destinationSelection?.startsWith('local-');

    // Base configuration
    const config = {
      nodeType: 'join',

      // Multiple sources
      sources: sourceNodes.map((sourceNode, idx) => ({
        sourceNodeId: sourceNode.id,
        sourceNodeLabel: sourceNode.data?.label,
        sourceConnectionId: sourceConnections[idx]?.id,
        sourceConnectionName: sourceConnections[idx]?.name,
        sourceConnectionType: sourceConnections[idx]?.connectionType,
        sourceDbType: sourceConnections[idx]?.dbType,
        sourceTableSchema: sourceTableSchemas[idx],
        sourceTableName: sourceTableSchemas[idx]?.tableName,
        sourceCollection: sourceTableSchemas[idx]?.tableName,
        sourceLocalPath: sourceConnections[idx]?.localPath
      }))
    };

    if (!latestJoinConfig) return config;

    // Join settings
    config.joinRequest = latestJoinConfig.joinRequest || userRequestRef.current;
    config.joinSettings = joinSettings;
    config.joinColumns = latestJoinConfig.joinColumns;
    config.executionPlan = latestJoinConfig.executionPlan;

    // Store sourcesConfig and join configuration for execution
    config.sourcesConfig = latestJoinConfig.sourcesConfig;
    config.joinSql = latestJoinConfig.joinSql;
    config.targetDdl = latestJoinConfig.targetDdl;
    config.transformFunction = latestJoinConfig.transformFunction || latestJoinConfig.javascriptFunction;

    // Target configuration
    const targetTableName = joinSettings.targetTableName || node.id.replace('-', '_').toLowerCase();

    if (isLocalStorage) {
      const localDbType = isNoSQL ? 'nedb' : 'sqlite';
      config.targetConnectionId = `local-${localDbType}`;
      config.targetConnectionName = localDbType === 'nedb' ? 'Local NeDB' : 'Local SQLite';
      config.targetConnectionType = 'file';
      config.targetDbType = localDbType;
      config.targetDbConfig = {};
    } else {
      config.targetConnectionId = targetConnection?.id;
      config.targetConnectionName = targetConnection?.name;
      config.targetConnectionType = targetConnection?.connectionType || 'database';
      config.targetDbType = targetConnection?.dbType;
      config.targetDbConfig = targetConnection?.dbConfig || {};
    }

    // NoSQL vs SQL specific config
    if (isNoSQL) {
      config.targetCollection = targetTableName;
      config.aggregationPipeline = latestJoinConfig.aggregationPipeline;
      config.targetPreviewSql = JSON.stringify({
        collection: targetTableName,
        filter: {},
        limit: 100
      });

      if (isLocalStorage || latestJoinConfig.localPath) {
        config.targetLocalPath = latestJoinConfig.localPath;
      }
    } else {
      config.targetTableName = targetTableName;
      config.targetDdl = latestJoinConfig.targetDdl || '';
      config.targetSql = latestJoinConfig.sql;
      config.targetInsertSql = latestJoinConfig.insertSql || null;
      config.targetSqlExplanation = latestJoinConfig.explanation || '';

      if (isLocalStorage) {
        // Local SQLite storage
        const previewResult = await window.electronAPI.dbConnect.getPreviewQuery('sqlite', targetTableName, 100);
        config.targetPreviewSql = latestJoinConfig.previewSql || previewResult.previewQuery;
        config.targetLocalPath = latestJoinConfig.localPath;
      } else {
        const targetSchema = targetConnection?.dbConfig?.schema;
        const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
          targetConnection.dbType,
          targetTableName,
          targetSchema,
          targetConnection.dbConfig,
          targetConnection.id
        );
        const fullTableName = quotedResult.quotedIdentifier;

        // Use database-specific preview query
        const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
          targetConnection.dbType,
          fullTableName,
          100
        );
        config.targetPreviewSql = latestJoinConfig.previewSql || previewResult.previewQuery;
      }
    }

    return config;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Execute Join
  // ─────────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaveState(false);
    setExecutionError(null);
    let localPathFromResult = null;

    const isNoSQL = targetConnection?.dbType === 'mongodb' || targetConnection?.dbType === 'nedb';
    const targetTableName = joinSettings.targetTableName || node.id.replace('-', '_').toLowerCase();

    // Execute join using the new executeJoin function
    executingInd(true);

    const result = await executeJoin({
      destinationConnection: targetConnection,
      joinConfig: latestJoinConfig,
      operationMode: joinSettings.operationMode || 'new_table',
      onSuccess: (res) => {
        addBotMessage(`✓ ${res.message}`, false);
        if (res.localPath) {
          addBotMessage(`📁 ${isNoSQL ? 'Local collection' : 'Local SQLite database'} saved at: ${res.localPath}`, false);
          localPathFromResult = res.localPath;
          setLatestJoinConfig(prev => ({ ...prev, localPath: res.localPath }));
        }
      },
      onError: (err) => {
        addBotMessage(`✗ Join failed: ${err.error || err.message}`, false);
        setExecutionError({
          error: err.error || err.message,
          joinConfig: latestJoinConfig
        });
      }
    });

    executingInd(false);

    if (!result.success) return;

    // Fetch joined table schema after successful execution
    let joinedSchema = null;
    try {
      const isLocalStorage = joinSettings.destinationSelection?.startsWith('local-');
      const targetDbType = targetConnection?.dbType ||
                          (joinSettings.destinationSelection?.startsWith('local-')
                            ? joinSettings.destinationSelection.replace('local-', '')
                            : 'sqlite');

      const schemaLocalPath = isLocalStorage ? localPathFromResult : null;

      if (isNoSQL) {
        joinedSchema = await loadTableSchema({
          connection: isLocalStorage ? { dbType: targetDbType, dbConfig: {} } : targetConnection,
          tableName: targetTableName,
          localPath: schemaLocalPath
        });
      } else {
        joinedSchema = await loadTableSchema({
          connection: isLocalStorage ? { dbType: 'sqlite', dbConfig: {} } : targetConnection,
          tableName: targetTableName,
          tableSchema: targetConnection?.dbConfig?.schema,
          localPath: schemaLocalPath
        });
      }
    } catch (error) {
      console.error('Failed to fetch joined schema:', error);
    }

    setSaveState(false);

    // Save configuration
    const config = await buildConfig();

    // Add local path if returned from execution
    if (localPathFromResult) {
      config.targetLocalPath = localPathFromResult;
    }

    // Add joined table schema
    if (joinedSchema) {
      config.targetTableSchema = joinedSchema;
    }

    console.log('Saving join config:', config);
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
    if (loading || aiLoading || executing) return [];

    if (pendingChoices.length > 0) {
      return pendingChoices;
    }

    if (executionError) {
      return [{
        label: '🔧 Ask AI to Fix Error',
        value: 'fix_error',
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

    if (choice.value === 'fix_error') {
      // TODO: Implement AI error fix
      addBotMessage('Error recovery not yet implemented. Please refine your join manually.', false);
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
        isLoading={loading || aiLoading}
        progressInfo={{ progress: 0, stage: (loading || aiLoading) ? 'Processing...' : '' }}
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
      />
    </div>
  );
};

export default JoinNodeChat;
