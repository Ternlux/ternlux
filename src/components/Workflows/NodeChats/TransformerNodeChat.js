import React, { useState, useEffect, useRef } from 'react';
import { getWorkflowAssistance } from '../../../utils/workflowAI';
import ChatArea from '../../Chat/ChatArea';
import ChatPrompts from './ChatPrompts/Transfomer';
import { loadTableSchema } from '../../../utils/tableSchemaUtils';
// ─────────────────────────────────────────────────────────────────────────────
// Transformer Node Chat Component
// Handles custom transformations and enrichments
// ─────────────────────────────────────────────────────────────────────────────

const formatTimestamp = (ts) => {
  const diff = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (diff < 1) return 'Just now';
  if (diff < 60) return `${diff}m`;
  return `${Math.floor(diff / 60)}h`;
};

const TransformerNodeChat = ({
  node,
  nodes,
  edges,
  initialChat,
  onSave,
  onConfigUpdate,
  onPreviewConfigUpdate,
  onExecute,
  executeTransformation,
  getSourceLocalPath,
  executingInd,
  executing = false
}) => {
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);
  const inputRef = useRef(null);
  const initialized = useRef(false);
  const userRequestRef = useRef(null); // Store latest user request

  const [chat, setChat] = useState(initialChat);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  // Source data state (single source node)
  const [sourceNode, setSourceNode] = useState(null); // Connected source node
  const [sourceConnection, setSourceConnection] = useState(null); // Source connection
  const [sourceTableSchema, setSourceTableSchema] = useState(null); // { tableName, columns, sampleData }
  const [latestWithSQL, setLatestWithSQL] = useState(null);
  const [saveState, setSaveState] = useState(false);
  const [disableInput, setDisableInput] = useState(false);

  // Error state for failed transformations
  const [executionError, setExecutionError] = useState(null); // { error: string, transformation: object }

  // Transformation settings state
  const [transformationSettings, setTransformationSettings] = useState({
    operationMode: null,      // "new_table" or "in_place"
    storageLocation: null,    // "database" or "local" (storage location)
    userRequest: null,        // original user request
    tableName: null           // custom output table/collection name
  });
  const [pendingChoices, setPendingChoices] = useState([]);
  const [questionsNeeded, setQuestionsNeeded] = useState({}); // Object: { operationMode: "question text", ... }
  const [questionKeys, setQuestionKeys] = useState([]); // Array of question keys to iterate through
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);

  // ─────────────────────────────────────────────────────────────────────────
  // Initialize
  // ─────────────────────────────────────────────────────────────────────────

  const initializationFunc = async () => {
    const source_name = await detectSourceNode();

    // Restore state from saved config if reopening a saved node
    const savedConfig = node?.data?.config;
    if (savedConfig && initialChat.length > 0) {
      console.log('Restoring saved transformer config:', savedConfig);

      // Restore latestWithSQL - read from target* prefixes (saved config) and store without prefix (internal state)
      if (savedConfig.targetSql || savedConfig.operationType) {
        const restoredData = {
          ddl: savedConfig.targetDdl || '',
          sql: savedConfig.targetSql,
          insertSql: savedConfig.targetInsertSql || null,
          previewSql: savedConfig.targetPreviewSql || '',
          explanation: savedConfig.targetSqlExplanation || '',
          transformationRequest: savedConfig.transformationRequest || '',
          transformationSettings: savedConfig.transformationSettings || null,
          targetDbType: savedConfig.targetDbType || null
        };

        // Add NoSQL-specific fields if present (MongoDB or NeDB)
        if (savedConfig.operationType) {
          restoredData.operationType = savedConfig.operationType;
          restoredData.nosqlOperation = savedConfig.nosqlOperation;
          restoredData.transformFunction = savedConfig.transformFunction;
          restoredData.sourceCollection = savedConfig.sourceCollection;
          restoredData.targetCollection = savedConfig.targetCollection;
          restoredData.localPath = savedConfig.targetLocalPath;
        }

        setLatestWithSQL(restoredData);
      }

      // Restore transformation settings
      if (savedConfig.transformationSettings) {
        setTransformationSettings(savedConfig.transformationSettings);
        // Also restore userRequest to ref
        if (savedConfig.transformationSettings.userRequest) {
          userRequestRef.current = savedConfig.transformationSettings.userRequest;
        }
      }
    } else {
      // New node - detect source and start chat
      if (initialChat.length === 0) {
        setDisableInput(true);
        // Show connected source
        addBotMessage(
          `Connected to source: ${source_name}\n\nDescribe how you want to transform this data:`,
          true,
          'text',
          'transformationRequest',
          'Describe the transformation…'
        );
        setDisableInput(false);

      }
    }
  }


  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      initializationFunc()
    }
  }, []);

  // Sync chat state with initialChat prop when node changes
  useEffect(() => {
    if (initialized.current && initialChat.length > 0) {
      setChat(initialChat);
    }
    // console.log('node?.id, initialChat: ', )
  }, [node?.id, initialChat]);

  // Auto-scroll to bottom when chat messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chat]);

  // Update node config when SQL changes to trigger data preview refresh
  useEffect(() => {
    if (latestWithSQL && latestWithSQL.previewSql && onPreviewConfigUpdate && sourceConnection) {
      const previewConfig = {
        connectionId: sourceConnection.id,
        connectionName: sourceConnection.name,
        connectionType: sourceConnection.connectionType,
        dbType: sourceConnection.dbType,
        dbConfig: sourceConnection.dbConfig,
        sourceType: sourceConnection.dbType,
        ddl: latestWithSQL.ddl || '',
        sql: latestWithSQL.sql,
        previewSql: latestWithSQL.previewSql,
        sqlExplanation: latestWithSQL.explanation,
        transformationRequest: latestWithSQL.transformationRequest
      };

      onPreviewConfigUpdate(node.id, previewConfig);
    }
  }, [latestWithSQL?.previewSql, sourceConnection]);

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

    // Find connected source node (only one)
    const connectedEdges = edges.filter(e => e.target === node.id);
    if (connectedEdges.length === 0) {
      addBotMessage('No source node connected. Please connect a data source or another transformer first.', false);
      setLoading(false);
      return;
    }

    // Get the first (and only) connected source
    const sourceNodeId = connectedEdges[0].source;
    const source = nodes.find(n => n.id === sourceNodeId);

    if (!source || !source.data?.config) {
      addBotMessage('Source node is not configured. Please configure the source node first.', false);
      setLoading(false);
      return;
    }

    // Extract connection info from source node
    const sourceConfig = source.data.config;
    // console.log('sourceConfig: ', sourceConfig, connectedEdges[0]);
    const nodeType = sourceConfig.nodeType;
    const dataSource = nodeType === 'datasource';

    // If source is a transformer, use its target properties as our source
    const connection = {
      id: dataSource ? sourceConfig.sourceConnectionId : sourceConfig.targetConnectionId,
      name: dataSource ? sourceConfig.sourceConnectionName : sourceConfig.targetConnectionName,
      connectionType: dataSource ? sourceConfig.sourceConnectionType : sourceConfig.targetConnectionType,
      dbType: dataSource ? sourceConfig.sourceDbType : sourceConfig.targetDbType,
      dbConfig: dataSource ? sourceConfig.sourceDbConfig : sourceConfig.targetDbConfig,
      localPath: dataSource ?  sourceConfig.sourceLocalPath : sourceConfig.targetLocalPath
    };

    // Get schema from saved config (if available) or load from database
    let schema;
    // Try target schema first (for transformer chains), then source schema (for data sources)
    const savedSchema = dataSource ? sourceConfig.sourceTableSchema : sourceConfig.targetTableSchema;
    if (savedSchema) {
      // Schema is already saved in the source node config
      schema = {
        sourceNodeLabel: source.data.label,
        tableName: sourceConfig.targetTableName || sourceConfig.sourceTableName || sourceConfig.targetCollection || sourceConfig.sourceCollection || savedSchema.tableName,
        columns: savedSchema.columns,
        sampleData: savedSchema.sampleData
      };
      // console.log('savedSchema: ', schema);
    } else {
      // Fallback: load schema from database (old nodes that don't have schema saved)
      console.log('Schema not found in config, loading from database...');
      schema = await loadSourceTableSchema(source, connection);
      if (schema) {
        schema.sourceNodeLabel = source.data.label;
      }
    }

    if (!schema) {
      addBotMessage('Failed to load source schema. Please check the source configuration.', false);
      setLoading(false);
      return;
    }

    console.log('detectSourceNode: ', source, connection, schema);
    setSourceNode(source);
    setSourceConnection(connection);
    setSourceTableSchema(schema);

    setLoading(false);
    setDisableInput(false);
    return source.data.label
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Load Source Table Schema
  // ─────────────────────────────────────────────────────────────────────────


  const loadSourceTableSchema = async (source, connection) => {
    if (!window.electronAPI?.dbConnect) {
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
        // 1. Resolve NoSQL/NeDB identifiers
        // Try target first (for transformer chains), then source (for data sources)
        tableName = sourceConfig.targetCollection ||
                    sourceConfig.sourceCollection ||
                    sourceConfig.table ||
                    sourceConfig.selectedTables?.[0];

        localPath = sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;

        // Workaround: loadTableSchema expects 'mongodb' to trigger the localPath/NeDB logic.
        // If it's 'nedb', we temporarily mask it as 'mongodb' so it doesn't fall into the SQL block.
        if (connection.dbType === 'nedb') {
          queryConnection = { ...connection, dbType: 'mongodb' };
        }
      } else {
        // 2. Resolve SQL identifiers
        tableSchema = sourceConfig.targetSchema || sourceConfig.sourceSchema || sourceConfig.dbConfig?.schema || null;

        tableName = sourceConfig.targetTableName ||
                    sourceConfig.sourceTableName ||
                    sourceConfig.table ||
                    (source.id ? source.id.replace('-', '_').toLowerCase() : null);
      }
  
      if (!tableName && !localPath) {
        console.warn('Could not determine table name or local path from source config');
        return null;
      }
  
      // 3. Call the unified utility function
      const schema = await loadTableSchema({
        connection: queryConnection,
        tableName,
        tableSchema,
        localPath,
        limit: 5 // Matching your original sample size
      });
  
      console.log('Loaded source schema:', schema);
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

    if (ref === 'transformationRequest' || ref === 'chatContinue') {
      // All user requests go through the intelligent analysis
      await startTransformationFlow(userMsg);
    } else if (ref === 'operationMode') {
      await handleOperationModeResponse(value);
    } else if (ref === 'storageLocation') {
      await handleStorageLocationResponse(value);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Multi-Step Transformation Configuration Flow
  // ─────────────────────────────────────────────────────────────────────────

  const startTransformationFlow = async (userMsg) => {
    setAiLoading(true);
    setLoading(true);

    // Store the user's request in both state and ref
    userRequestRef.current = userMsg.text;
    setTransformationSettings(prev => ({
      ...prev,
      userRequest: userMsg.text
    }));

    // Clear any pending state
    setPendingChoices([]);
    setQuestionsNeeded({});
    setQuestionKeys([]);
    setCurrentQuestionIndex(0);
    setExecutionError(null); // Clear any previous error state

    try {
      // Build chat history for AI context
      const chatHistory = chat.map(msg => ({
        sender: msg.sender,
        text: msg.text
      }));

      // Analyze the request to determine what to do next
      await analyzeTransformationRequest(userMsg.text, chatHistory);
    } catch (error) {
      console.error('Analysis error:', error);
      addBotMessage('Failed to analyze your request. Please try again.', false);
      setAiLoading(false);
      setLoading(false);
    }
  };
  // console.log('sourceNode: ', sourceNode)
  const analyzeTransformationRequest = async (userRequest, chatHistory = []) => {
    var finalSettings = {};

    // Get properly quoted source table name with schema
    const sourceSchema = sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema;
    const dbType = sourceConnection?.dbType;
    const isNoSQL = ['mongodb', 'nedb'].includes(dbType);

    let sourceFullTableName = sourceTableSchema.tableName || 'unknown';
    if (!isNoSQL && dbType !== 'sqlite' && sourceSchema) {
      const quotedSourceResult = await window.electronAPI.dbConnect.quoteIdentifier(
        dbType,
        sourceTableSchema.tableName,
        sourceSchema,
        sourceConnection?.dbConfig,
        sourceConnection?.id
      );
      sourceFullTableName = quotedSourceResult.quotedIdentifier;
    } else if (sourceSchema) {
      sourceFullTableName = `${sourceSchema}.${sourceTableSchema.tableName}`;
    }

    // Build source table information
    const sourceTableInfo = `
Source: ${sourceTableSchema.sourceNodeLabel}
- Table/Collection name: ${sourceFullTableName}
- Columns/Fields: ${JSON.stringify(sourceTableSchema.columns || [])}
- Sample data (first 5 rows/documents): ${JSON.stringify(sourceTableSchema.sampleData || [])}
    `;

    // Determine if source is local (data stored in local file vs remote database)
    const isSourceLocal = isFileLocal()

    const analysisPrompt = ChatPrompts.transfomer.transformationRequest(userRequest, sourceTableInfo, sourceConnection.dbType, isSourceLocal);

    const response = await getWorkflowAssistance('transformer', analysisPrompt, {
      sourceTable: sourceTableSchema.tableName,
      sourceSchema: sourceTableSchema,
      dbType: sourceConnection.dbType,
      userRequest
    }, chatHistory);

    // console.log('Analysis response:', response);

    let analysis;
    try {
      analysis = JSON.parse(response);
    } catch (e) {
      console.error('Failed to parse analysis:', e);
      // Fallback: ask all questions
      analysis = {
        action: 'ask_questions',
        inferredSettings: {
          operationMode: null,
          storageLocation: null,
          tableName: null
        },
        questionsNeeded: ['operationMode', 'storageLocation'],
        dynamicChoices: {},
        reasoning: 'Failed to parse analysis, asking all questions'
      };
    }

    console.log('Parsed analysis:', analysis);
    
    if(!analysis.inferredSettings.operationMode) delete analysis.inferredSettings.operationMode
    if(!analysis.inferredSettings.storageLocation) delete analysis.inferredSettings.storageLocation

    // Update transformation settings with inferred values
    const inferredSettings = {...transformationSettings, ...analysis.inferredSettings};
    inferredSettings.tableName = analysis.tableName || transformationSettings.tableName || node.id.replace(/-/g, '_').toLowerCase();

    // Default operationMode to 'new_table' if null and not being asked
    if (!inferredSettings.operationMode && !analysis.questionsNeeded.operationMode) {
      inferredSettings.operationMode = 'new_table';
    }
    // console.log('sourceNode?.data?.config?.targetLocalPath: ', sourceNode?.data?.config)
    // Default storageLocation based on source type if null and not being asked
    if (isFileLocal()) {
      // If parent source has targetLocalPath, data is stored locally
      inferredSettings.storageLocation = 'local';
    }else if(!analysis.questionsNeeded.storageLocation){
      inferredSettings.storageLocation = 'database';
    }

    setTransformationSettings(inferredSettings);

    if(analysis.questionsNeeded && Object.keys(analysis.questionsNeeded)){
      analysis.action = 'ask_questions'
    }
    // console.log('after_change:', analysis);

    // Handle the determined action
    if (analysis.action === 'answer_directly') {
      // Answer the question directly without generating transformation
      setAiLoading(false);
      setLoading(false);
      addBotMessage(analysis.directAnswer || 'Here is the information you requested.', false);
      addBotMessage(
        'Is there anything else you\'d like to know, or would you like to create a transformation?',
        true,
        'text',
        'chatContinue',
        'Ask a question or describe a transformation...'
      );
    } 
    // else if (analysis.action === 'refine_transformation') {
    //   // User wants to refine the existing transformation
    //   setAiLoading(false);
    //   setLoading(false);

    //   const update = analysis.transformationUpdate || {};

    //   // Apply the transformation result using consolidated helper
    //   const success = applyTransformationResult(update, inferredSettings, userRequest, true);

    //   if (success) {
    //     addBotMessage(
    //       'Continue refining, or click Run & Save Configuration when ready.',
    //       true,
    //       'text',
    //       'chatContinue',
    //       'Ask another question...'
    //     );
    //   }
    // } 
    else if (analysis.action === 'generate_transformation') {
      // Request is clear enough - generate transformation immediately
      setAiLoading(false);
      setLoading(false);

      finalSettings = {
        ...transformationSettings,
        operationMode: inferredSettings.operationMode,
        storageLocation: inferredSettings.storageLocation,
        tableName: inferredSettings.tableName,
        userRequest: userRequest
      };

      setTransformationSettings(finalSettings);
      const message = `✓ Request understood.\nGenerating transformation with:\n${[`• Mode: ${ finalSettings.operationMode === 'in_place' ?  'Updating Source Table' : 'Creating a New Table' }`,
        `• Storage Location: ${ finalSettings.storageLocation === 'database' ? 'Database' : 'Local' }`
      ].filter(Boolean).join('\n')}`;
      addBotMessage(message, false);

      await generateTransformation(finalSettings);
    } else {
      // Need to ask questions
      setAiLoading(false);
      setLoading(false);

      const questionsObj = analysis.questionsNeeded || {};
      let keys = Object.keys(questionsObj);

      // Reset settings for questions that need to be asked (questionsNeeded supersedes current settings)
      const resetSettings = {};
      keys.forEach(key => {
        resetSettings[key] = null;
      });
      // console.log('transformationSettings: ', transformationSettings, resetSettings, inferredSettings)

      // Apply the reset to transformationSettings
      setTransformationSettings(prev => ({
        ...prev,
        ...inferredSettings
      }));

      setQuestionsNeeded(questionsObj);
      setQuestionKeys(keys);
      setCurrentQuestionIndex(0);

      if (keys.length === 0) {
        // No questions needed but action is ask_questions - should not happen, but handle gracefully
        finalSettings = {
          ...transformationSettings,
          operationMode: inferredSettings.operationMode || 'new_table',
          storageLocation: inferredSettings.storageLocation || 'database',
          tableName: inferredSettings.tableName,
          userRequest
        };
        setTransformationSettings(finalSettings);
        await generateTransformation(finalSettings);
        return;
      }

      // Ask the first question - pass the fresh values instead of relying on state
      askNextQuestion(questionsObj, keys, 0, finalSettings);
    }
  };

  const askNextQuestion = (questionsObj = questionsNeeded, keys = questionKeys, index = currentQuestionIndex, currentSettings = null) => {
    console.log('finalSettings: ', currentSettings, transformationSettings)
    // Update state to reflect current values
    setQuestionsNeeded(questionsObj);
    setQuestionKeys(keys);
    setCurrentQuestionIndex(index);

    // Use passed settings or fall back to state
    const settingsToUse = currentSettings || transformationSettings;
    console.log('questionsObj: ', questionsObj, keys, index, settingsToUse)

    // Check if there are more questions to ask
    let currentIndex = index;
    while (currentIndex < keys.length) {
      const questionType = keys[currentIndex];

      // Check dependencies - skip question if dependency not met
      if (questionType === 'storageLocation') {
        // Only ask for storage location (storageLocation) if operationMode is new_table AND source is database
        if (settingsToUse.operationMode !== 'new_table') {
          currentIndex++;
          continue;
        }
      }

      // Update the current question index in state
      setCurrentQuestionIndex(currentIndex);

      // Get the question text from questionsNeeded object
      const questionText = questionsObj[questionType] || getDefaultQuestionText(questionType);

      // Get the choices for this question
      const choices = getDefaultChoices(questionType);

      if (choices.length > 0) {
        // Display the question with choices
        displayQuestionWithChoices(questionType, questionText, choices);
        return;
      } else {
        // No choices - display as text input question
        addBotMessage(questionText, true, 'text', questionType, '', null);
        return;
      }
    
    }

    // No more questions - generate transformation
    const finalSettings = {
      ...settingsToUse,
      // Always use the latest userRequest from ref to ensure it's not lost due to async state updates
      userRequest: userRequestRef.current || transformationSettings.userRequest
    };

    // Fill in any missing settings with defaults
    if (!finalSettings.operationMode) finalSettings.operationMode = 'new_table';

    // For storage location, apply defaults based on operation mode and source type
    if (!finalSettings.storageLocation) {
      finalSettings.storageLocation = sourceNode?.data?.config?.sourceConnectionType === 'database' ? 'database' : 'local' ;
    }

    setTransformationSettings(finalSettings);
    generateTransformation(finalSettings);
  };

  const getDefaultQuestionText = (questionType) => {
    const questionTexts = {
      operationMode: 'How would you like to handle the transformation output?',
      storageLocation: 'Where should the data be stored?'
    };
    return questionTexts[questionType] || 'Please select an option:';
  };

  const getDefaultChoices = (questionType) => {
    const isMongoDB = sourceConnection?.dbType === 'mongodb';

    switch (questionType) {
      case 'operationMode':
        return [
          {
            label: 'New Table',
            value: 'new_table',
            description: 'Create a new table/collection with transformed data'
          },
          {
            label: 'In Source Table',
            value: 'in_place',
            description: 'Update or delete existing records in the source table'
          }
        ];
      case 'storageLocation':
        return [
          {
            label: 'Database',
            value: 'database',
            description: isMongoDB
              ? 'Run transformation using MongoDB aggregation pipeline'
              : 'Run transformation using native SQL queries'
          },
          {
            label: 'Local',
            value: 'local',
            description: 'Run transformation locally'
          }
        ];
      default:
        return [];
    }
  };

  const displayQuestionWithChoices = (questionType, questionText, choices) => {

    // Set choices with appropriate display type
    const formattedChoices = choices.map(choice => ({
      ...choice,
      variant: 'outlined',
      fullWidth: true
    }));

    setPendingChoices(formattedChoices);

    // Add hidden message for ref tracking
    addBotMessage(questionText, true, 'choice', questionType, '', null);
  };

  const isFileLocal = () => {
    return sourceNode?.data?.config?.targetLocalPath || sourceNode?.data?.config?.sourceLocalPath
  }
  const handleOperationModeResponse = async (value) => {
    setPendingChoices([]);

    // Compute updated settings
    const updatedSettings = {
      ...transformationSettings,
      operationMode: value,
      // For in-place transformations, storage location (storageLocation) is always database
      ...(value === 'in_place' ? { storageLocation: isFileLocal() ? 'local' : 'database' } : {})
    };

    // Update state
    setTransformationSettings(updatedSettings);

    // Move to next question - pass updated settings directly to avoid stale state
    askNextQuestion(questionsNeeded, questionKeys, currentQuestionIndex + 1, updatedSettings);
  };

  const handleStorageLocationResponse = async (value) => {
    setPendingChoices([]);

    // Compute updated settings
    const updatedSettings = {
      ...transformationSettings,
      storageLocation: value
    };

    // Update state
    setTransformationSettings(updatedSettings);

    // Move to next question - pass updated settings directly to avoid stale state
    askNextQuestion(questionsNeeded, questionKeys, currentQuestionIndex + 1, updatedSettings);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Apply Transformation Result (Consolidation Helper)
  // ─────────────────────────────────────────────────────────────────────────

  const applyTransformationResult = async (transformationData, settings, userRequest, isRefinement = false) => {
    const explanation = transformationData.explanation || '';
    const isNoSQL = sourceConnection?.dbType === 'mongodb' || sourceConnection?.dbType === 'nedb';
    const dbType = sourceConnection?.dbType;
    const targetSchema = sourceConnection?.dbConfig?.schema;
    const targetTableName = settings.tableName || node.id.replace('-', '_').toLowerCase();

    // Get properly quoted table name for SQL databases
    let fullTableName = `${targetSchema}.${targetTableName}`;
    if (!isNoSQL && dbType !== 'sqlite') {
      const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
        dbType,
        targetTableName,
        targetSchema,
        sourceConnection?.dbConfig,
        sourceConnection?.id
      );
      fullTableName = quotedResult.quotedIdentifier;
    }

    if (isNoSQL) {
      // Handle NoSQL transformation (MongoDB or NeDB)
      const operationType = transformationData.operationType;
      const nosqlOperation = transformationData.nosqlOperation;
      const transformFunction = transformationData.transformFunction;

      if (nosqlOperation) {
        setSaveState(true);

        // Determine target database type based on storage location
        const targetDbType = settings.storageLocation === 'local' ? 'nedb' : dbType;

        setLatestWithSQL({
          ddl: '',
          sql: '',
          previewSql: JSON.stringify({
            collection: targetTableName,
            filter: {},
            limit: 100
          }),
          explanation,
          transformationRequest: userRequest,
          transformationSettings: settings,
          targetDbType,
          operationType,
          nosqlOperation,
          transformFunction: transformFunction || null,
          sourceCollection: sourceTableSchema.tableName,
          targetCollection: targetTableName
        });

        // Add bot message with explanation
        if (isRefinement) {
          addBotMessage(
            `✓ Transformation updated!\n\n${explanation}`,
            false,
            'text',
            '',
            '',
            { operationType, nosqlOperation, transformFunction }
          );
        } else {
          const dbLabel = dbType === 'mongodb' ? 'MongoDB' : dbType === 'nedb' ? 'NeDB' : 'NoSQL';
          const storageLabel = settings.storageLocation === 'database'
            ? (dbType === 'mongodb' ? 'In MongoDB' : 'In Database')
            : 'Local (NeDB)';

          addBotMessage(
            `✓ ${dbLabel} Transformation generated!\n\n${explanation}\n\nOperation: ${operationType}\nSettings:\n• Mode: ${settings.operationMode === 'in_place' ? 'Modify Source Table' : 'New Collection'}\n• Storage Location: ${storageLabel}`,
            false,
            'text',
            '',
            '',
            { operationType, nosqlOperation, transformFunction }
          );
        }

        return true;
      } else {
        addBotMessage(explanation || 'Unable to generate transformation.', false);
        return false;
      }
    } else {
      // Handle SQL transformation
      const ddl = transformationData.ddl || '';
      const sql = transformationData.sql;
      const insertSql = transformationData.insertSql || null;
      const previewSql = transformationData.previewSql;

      if (sql || ddl) {
        setSaveState(true);

        // Determine target database type based on storage location
        const targetDbType = settings.storageLocation === 'local' ? 'sqlite' : dbType;

        setLatestWithSQL({
          ddl,
          sql,
          insertSql,
          previewSql,
          explanation,
          transformationRequest: userRequest,
          transformationSettings: settings,
          targetDbType
        });

        // Add bot message with explanation
        if (isRefinement) {
          addBotMessage(
            `✓ Transformation updated!\n\n${explanation}`,
            false,
            'text',
            '',
            '',
            { ddl, sql, previewSql }
          );
        } else {
          const storageLabel = settings.storageLocation === 'database' ? 'Database' : 'Local (SQLite)';

          addBotMessage(
            `✓ Transformation generated!\n\n${explanation}\n\nSettings applied:\n• Mode: ${settings.operationMode === 'new_table' ? 'New Table' : 'Modify Source Table'}\n• Storage Location: ${storageLabel}`,
            false,
            'text',
            '',
            '',
            { ddl, sql, previewSql }
          );
        }

        return true;
      } else {
        addBotMessage(explanation || 'Unable to generate transformation.', false);
        return false;
      }
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // AI Transformation Generation
  // ─────────────────────────────────────────────────────────────────────────
  
  const generateTransformation = async (settings) => {
    console.log('generateTransformation: ', settings)
    // return;
    setAiLoading(true);
    setLoading(true);

    const targetSchema = sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema;
    // Use custom table name from settings if provided, otherwise use default from node ID
    const targetTableName = settings.tableName || node.id.replace('-', '_').toLowerCase();
    const isNoSQL = sourceConnection?.dbType === 'mongodb' || sourceConnection?.dbType === 'nedb';
    const dbType = sourceConnection?.dbType;

    // Get properly quoted table name for SQL databases
    let fullTableName = `${targetSchema}.${targetTableName}`;
    if (!isNoSQL && dbType !== 'sqlite') {
      const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
        dbType,
        targetTableName,
        targetSchema,
        sourceConnection?.dbConfig,
        sourceConnection?.id
      );
      fullTableName = quotedResult.quotedIdentifier;
    }

    // Build chat history for AI context
    const chatHistory = chat.slice(0, -1).map(msg => ({
      sender: msg.sender,
      text: msg.text
    }));

    try {
      // Get properly quoted source table name with schema (for SQL databases)
      const sourceSchema = sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema;
      let sourceFullTableName = sourceTableSchema.tableName;

      if (!isNoSQL && dbType !== 'sqlite' && sourceSchema) {
        const quotedSourceResult = await window.electronAPI.dbConnect.quoteIdentifier(
          dbType,
          sourceTableSchema.tableName,
          sourceSchema,
          sourceConnection?.dbConfig,
          sourceConnection?.id
        );
        sourceFullTableName = quotedSourceResult.quotedIdentifier;
      } else if (sourceSchema && !isNoSQL) {
        sourceFullTableName = `${sourceSchema}.${sourceTableSchema.tableName}`;
      }

      // Build source table information
      const sourceTableInfo = `
Source: ${sourceTableSchema.sourceNodeLabel}
- Table/Collection name: ${sourceFullTableName}
- Columns/Fields: ${JSON.stringify(sourceTableSchema.columns || [])}
- Sample data (first 5 rows/documents): ${JSON.stringify(sourceTableSchema.sampleData || [])}
      `;

      // Build transformation settings context
      const settingsContext = `
Transformation Settings:
- Operation Mode: ${settings.operationMode === 'in_place' ? 'Source table (In-Place) Update/Delete' : 'Create New Table' }
- Storage Location: ${settings.storageLocation === 'database' ? 'Database (store and process in database)' : 'Local (store and process locally)'}
      `;

      let transformationPrompt;

      if (isNoSQL) {
        // For local NoSQL (NeDB), use ChatPrompts. For remote NoSQL, fetch from plugin.
        if (dbType === 'nedb') {
          if (settings.operationMode === 'in_place') {
            transformationPrompt = ChatPrompts.transfomer.nedbTransformationInPlace(settings, sourceTableInfo, settingsContext, sourceTableSchema);
          } else {
            transformationPrompt = ChatPrompts.transfomer.nedbTransformationNewTable(settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName);
          }
        } else {
          // Generate prompt from plugin (e.g., MongoDB)
          const sourceSchema = sourceConnection?.dbConfig?.database;
          const sourceFullTableName = sourceTableSchema.tableName;

          const promptResult = await window.electronAPI.dbConnect.generateTransformPrompt(
            dbType,
            settings.operationMode,
            settings,
            sourceTableInfo,
            settingsContext,
            sourceTableSchema,
            targetTableName,
            sourceConnection,
            targetSchema,
            fullTableName,
            sourceSchema,
            sourceFullTableName
          );
          if (promptResult.success) {
            transformationPrompt = promptResult.prompt;
          } else {
            throw new Error(`Failed to generate transformation prompt for ${dbType}: ${promptResult.message}`);
          }
        }
      } else {
        // For SQL databases
        if (dbType === 'sqlite') {
          // Use SQLite prompts only for local SQLite files
          if (settings.operationMode === 'in_place') {
            transformationPrompt = ChatPrompts.transfomer.sqliteTransformationInPlace(settings, sourceTableInfo, settingsContext, sourceTableSchema);
          } else {
            transformationPrompt = ChatPrompts.transfomer.sqliteTransformationNewTable(settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName);
          }
        } else {
          // Generate prompt from plugin for all other cases (database storage or remote DB to local)
          // sourceFullTableName is already defined and quoted above (before sourceTableInfo)

          const promptResult = await window.electronAPI.dbConnect.generateTransformPrompt(
            dbType,
            settings.operationMode,
            settings,
            sourceTableInfo,
            settingsContext,
            sourceTableSchema,
            targetTableName,
            sourceConnection,
            targetSchema,
            fullTableName,
            sourceSchema,
            sourceFullTableName
          );
          if (promptResult.success) {
            transformationPrompt = promptResult.prompt;
          } else {
            throw new Error(`Failed to get transformation prompts for ${dbType}`);
          }
        }
      }
      console.log('transformationPrompt: ', transformationPrompt)
      const response = await getWorkflowAssistance('transformer', transformationPrompt, {
        sourceTable: sourceTableSchema.tableName,
        sourceSchema: sourceTableSchema,
        targetTable: fullTableName,
        dbType: sourceConnection.dbType,
        transformationSettings: settings
      }, chatHistory);

      // console.log('Transformation AI response:', response);

      // Parse JSON response
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(response);
      } catch (e) {
        console.log('ERROR: ', e);
        parsedResponse = {
          explanation: response,
          ddl: '',
          sql: ''
        };
      }
      console.log('parsedResponse:', parsedResponse);

      // Apply the transformation result using consolidated helper
      const success = await applyTransformationResult(parsedResponse, settings, settings.userRequest, false);

      if (success) {
        addBotMessage(
          'You can ask follow-up questions to refine this transformation, or click Run & Save Configuration when ready.',
          true,
          'text',
          'chatContinue',
          'Ask a follow-up question or request changes…'
        );
      }

    } catch (error) {
      console.error('Transformation generation error:', error);
      addBotMessage('Failed to generate transformation. Please try again.', false);
    } finally {
      setAiLoading(false);
      setLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Fix Execution Error
  // ─────────────────────────────────────────────────────────────────────────

  const handleFixError = async () => {
    if (!executionError) return;

    setAiLoading(true);
    setLoading(true);
    setExecutionError(null); // Clear error state
    setPendingChoices([]); // Clear the fix button

    const { error, transformation } = executionError;
    const isNoSQL = sourceConnection?.dbType === 'mongodb' || sourceConnection?.dbType === 'nedb';
    const dbType = sourceConnection?.dbType;

    try {
      // Build error context for LLM
      const errorContext = `
Previous transformation attempt FAILED with error:
${error}

Original transformation that failed:
${isNoSQL ? `
Operation Type: ${transformation.operationType}
Operation: ${transformation.nosqlOperation}
${transformation.transformFunction ? `Transform Function: ${transformation.transformFunction}` : ''}
` : `
DDL: ${transformation.ddl || 'N/A'}
SQL: ${transformation.sql}
`}
`;

      // Get properly quoted source table name with schema (for SQL databases)
      const sourceSchema = sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema;
      let sourceFullTableName = sourceTableSchema.tableName;

      if (!isNoSQL && dbType !== 'sqlite' && sourceSchema) {
        const quotedSourceResult = await window.electronAPI.dbConnect.quoteIdentifier(
          dbType,
          sourceTableSchema.tableName,
          sourceSchema,
          sourceConnection?.dbConfig,
          sourceConnection?.id
        );
        sourceFullTableName = quotedSourceResult.quotedIdentifier;
      } else if (sourceSchema && !isNoSQL) {
        sourceFullTableName = `${sourceSchema}.${sourceTableSchema.tableName}`;
      }

      // Build source table information
      const sourceTableInfo = `
Source: ${sourceTableSchema.sourceNodeLabel}
- Table/Collection name: ${sourceFullTableName}
- Columns/Fields: ${JSON.stringify(sourceTableSchema.columns || [])}
- Sample data (first 5 rows/documents): ${JSON.stringify(sourceTableSchema.sampleData || [])}
      `;

      // Build transformation settings context
      const settingsContext = `
Transformation Settings:
- Operation Mode: ${transformationSettings.operationMode === 'in_place' ? 'Source table (In-Place) Update/Delete' : 'Create New Table'}
- Storage Location: ${transformationSettings.storageLocation === 'database' ? 'Database (store and process in database)' : 'Local (store and process locally)'}
      `;

      const targetTableName = transformationSettings.tableName || node.id.replace('-', '_').toLowerCase();
      const targetSchema = sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema;

      // Get properly quoted table name for SQL databases
      let fullTableName = `${targetSchema}.${targetTableName}`;
      if (!isNoSQL && dbType !== 'sqlite') {
        const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
          dbType,
          targetTableName,
          targetSchema,
          sourceConnection?.dbConfig,
          sourceConnection?.id
        );
        fullTableName = quotedResult.quotedIdentifier;
      }

      // Build fix prompt
      let fixPrompt;
      if (isNoSQL) {
        // For local NoSQL (NeDB), use ChatPrompts. For remote NoSQL, fetch from plugin.
        if (dbType === 'nedb') {
          if (transformationSettings.operationMode === 'in_place') {
            fixPrompt = ChatPrompts.transfomer.nedbTransformationInPlace(
              transformationSettings,
              sourceTableInfo,
              settingsContext,
              sourceTableSchema
            );
          } else {
            fixPrompt = ChatPrompts.transfomer.nedbTransformationNewTable(
              transformationSettings,
              sourceTableInfo,
              settingsContext,
              sourceTableSchema,
              targetTableName
            );
          }
        } else {
          // Generate prompt from plugin (e.g., MongoDB)
          const sourceSchema = sourceConnection?.dbConfig?.database;
          const sourceFullTableName = sourceTableSchema.tableName;

          const promptResult = await window.electronAPI.dbConnect.generateTransformPrompt(
            dbType,
            transformationSettings.operationMode,
            transformationSettings,
            sourceTableInfo,
            settingsContext,
            sourceTableSchema,
            targetTableName,
            sourceConnection,
            targetSchema,
            fullTableName,
            sourceSchema,
            sourceFullTableName
          );
          if (promptResult.success) {
            fixPrompt = promptResult.prompt;
          } else {
            throw new Error(`Failed to get transformation prompts for ${dbType}`);
          }
        }
      } else {
        // For SQL databases
        if (dbType === 'sqlite' && transformationSettings.storageLocation === 'local') {
          // Use SQLite prompts only for local SQLite files
          if (transformationSettings.operationMode === 'in_place') {
            fixPrompt = ChatPrompts.transfomer.sqliteTransformationInPlace(
              transformationSettings,
              sourceTableInfo,
              settingsContext,
              sourceTableSchema
            );
          } else {
            fixPrompt = ChatPrompts.transfomer.sqliteTransformationNewTable(
              transformationSettings,
              sourceTableInfo,
              settingsContext,
              sourceTableSchema,
              targetTableName
            );
          }
        } else {
          // Generate prompt from plugin for all other cases (database storage or remote DB to local)
          // sourceFullTableName is already defined and quoted above (before sourceTableInfo)

          const promptResult = await window.electronAPI.dbConnect.generateTransformPrompt(
            dbType,
            transformationSettings.operationMode,
            transformationSettings,
            sourceTableInfo,
            settingsContext,
            sourceTableSchema,
            targetTableName,
            sourceConnection,
            targetSchema,
            fullTableName,
            sourceSchema,
            sourceFullTableName
          );
          if (promptResult.success) {
            fixPrompt = promptResult.prompt;
          } else {
            throw new Error(`Failed to generate transformation prompt for ${dbType}: ${promptResult.message}`);
          }
        }
      }

      // Prepend error context to the prompt
      const fullPrompt = `${errorContext}\n\n Fix the transformation to resolve the error above.\n\n${fixPrompt}`;

      // Build chat history
      const chatHistory = chat.slice(0, -2).map(msg => ({
        sender: msg.sender,
        text: msg.text
      }));

      addBotMessage('Analyzing the error and generating a fix...', false);

      const response = await getWorkflowAssistance('transformer', fullPrompt, {
        sourceTable: sourceTableSchema.tableName,
        sourceSchema: sourceTableSchema,
        targetTable: fullTableName,
        dbType: sourceConnection.dbType,
        transformationSettings: transformationSettings,
        error: error
      }, chatHistory);

      // Parse JSON response
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(response);
      } catch (e) {
        console.log('ERROR parsing fix response:', e);
        parsedResponse = {
          explanation: response,
          ddl: '',
          sql: ''
        };
      }

      console.log('Fixed transformation:', parsedResponse);

      // Apply the fixed transformation result
      const success = await applyTransformationResult(
        parsedResponse,
        transformationSettings,
        transformationSettings.userRequest,
        false
      );

      if (success) {
        addBotMessage(
          'Error fixed! You can now try running the transformation again, or continue refining.',
          true,
          'text',
          'chatContinue',
          'Ask a follow-up question or request changes…'
        );
      }
    } catch (error) {
      console.error('Error fixing transformation:', error);
      addBotMessage('Failed to fix the error. Please try refining your request manually.', false);
      // Restore the error state so user can try again
      setExecutionError(executionError);
    } finally {
      setAiLoading(false);
      setLoading(false);
    }
  };


  // ─────────────────────────────────────────────────────────────────────────
  // Build Configuration
  // ─────────────────────────────────────────────────────────────────────────

  const buildConfig = async () => {
    if (!sourceConnection) return {};

    const sourceConfig = sourceNode?.data?.config || {};
    const isNoSQL = ['mongodb', 'nedb'].includes(sourceConnection.dbType);
    const isInPlace = transformationSettings.operationMode === 'in_place';
    const isLocalStorage = transformationSettings.storageLocation === 'local';

    // ============================================================================
    // 1. Base Configuration
    // ============================================================================
    const config = {
      nodeType: 'transformer',
      sourceNodeId: sourceNode?.id,
      sourceNodeLabel: sourceNode?.data?.label,
      sourceConnectionId: sourceConnection.id,
      sourceConnectionName: sourceConnection.name,
      sourceConnectionType: sourceConnection.connectionType,
      sourceDbType: sourceConnection.dbType,
      sourceDbConfig: sourceConnection.dbConfig,
      sourceType: sourceConnection.dbType,
      sourceLocalPath: sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath,
      sourceTableName: sourceConfig.targetTableName || sourceConfig.sourceTableName,
      sourceCollection: sourceConfig.targetCollection || sourceConfig.sourceCollection,
      sourceSchema: sourceConfig.targetSchema || sourceConfig.sourceSchema,
      sourceTableSchema: sourceConfig.targetTableSchema || sourceConfig.sourceTableSchema,
      sourceDataset: sourceConfig.targetDataset || sourceConfig.sourceDataset,
      sourcePreviewSql: sourceConfig.targetPreviewSql || sourceConfig.sourcePreviewSql
    };


    if (!latestWithSQL) return config;

    // ============================================================================
    // 2. Transformation Settings
    // ============================================================================
    config.transformationRequest = latestWithSQL.transformationRequest || '';
    config.targetSqlExplanation = latestWithSQL.explanation || '';
    if (latestWithSQL.transformationSettings) {
      config.transformationSettings = latestWithSQL.transformationSettings;
    }

    // ============================================================================
    // 3. Target Connection Configuration
    // ============================================================================
    if (isInPlace) {
      // In-place: target is same as source
      config.targetConnectionId = config.sourceConnectionId;
      config.targetConnectionName = config.sourceConnectionName;
      config.targetConnectionType = config.sourceConnectionType;
      config.targetDbType = config.sourceDbType;
      config.targetDbConfig = config.sourceDbConfig;
    } else if (isLocalStorage) {
      // New table with local storage: use local SQLite or NeDB
      const localDbType = isNoSQL ? 'nedb' : 'sqlite';
      const localDbName = localDbType === 'nedb' ? 'Local NeDB' : 'Local SQLite';

      config.targetConnectionId = `local-${localDbType}`;
      config.targetConnectionName = localDbName;
      config.targetConnectionType = 'file';
      config.targetDbType = localDbType;
      config.targetDbConfig = {};
    } else {
      // New table with database storage: same as source
      config.targetConnectionId = config.sourceConnectionId;
      config.targetConnectionName = config.sourceConnectionName;
      config.targetConnectionType = config.sourceConnectionType;
      config.targetDbType = latestWithSQL.targetDbType || config.sourceDbType;
      config.targetDbConfig = config.sourceDbConfig;
    }

    // ============================================================================
    // 5. NoSQL-specific Configuration
    // ============================================================================
    if (isNoSQL && latestWithSQL.operationType) {
      config.operationType = latestWithSQL.operationType;
      config.nosqlOperation = latestWithSQL.nosqlOperation;
      config.transformFunction = latestWithSQL.transformFunction;

      // Target collection name
      if (isInPlace) {
        config.targetCollection = sourceConfig.targetCollection || sourceConfig.sourceCollection || latestWithSQL.sourceCollection;
      } else {
        config.targetCollection = latestWithSQL.targetCollection;
      }

      // Local path for NeDB
      if (isLocalStorage || sourceConnection.dbType === 'nedb') {
        config.targetLocalPath = latestWithSQL.localPath || sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
      }

      // Preview query (JSON format for NoSQL)
      config.targetPreviewSql = JSON.stringify({
        collection: config.targetCollection,
        filter: {},
        limit: 100
      });
    }
    // ============================================================================
    // 6. SQL-specific Configuration
    // ============================================================================
    else {
      config.targetDdl = latestWithSQL.ddl || '';
      config.targetSql = latestWithSQL.sql;
      config.targetInsertSql = latestWithSQL.insertSql || null;

      config.targetSchema = isLocalStorage ? null : sourceConfig.targetSchema || sourceConfig.sourceSchema || sourceConnection.dbConfig?.schema;
      

      // Target table name
      if (isInPlace) {
        config.targetTableName = sourceConfig.targetTableName || sourceConfig.sourceTableName || sourceTableSchema.tableName;
      } else {
        config.targetTableName = transformationSettings.tableName || node.id.replace('-', '_').toLowerCase();
      }

      // Local path for SQLite
      if (isLocalStorage) {
        config.targetLocalPath = latestWithSQL.localPath || sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
      } else if (isInPlace && sourceConfig.targetLocalPath) {
        config.targetLocalPath = sourceConfig.targetLocalPath;
      }

      // Preview SQL
      if (isLocalStorage || config.targetLocalPath) {
        // Local SQLite storage
        const previewResult = await window.electronAPI.dbConnect.getPreviewQuery('sqlite', config.targetTableName, 100);
        config.targetPreviewSql = latestWithSQL.previewSql || previewResult.previewQuery;
      } else {
        const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
          sourceConnection.dbType,
          config.targetTableName,
          config.targetSchema,
          sourceConnection.dbConfig,
          sourceConnection.id
        );
        const fullTableName = quotedResult.quotedIdentifier;

        // Use database-specific preview query
        const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
          sourceConnection.dbType,
          fullTableName,
          100
        );
        config.targetPreviewSql = latestWithSQL.previewSql || previewResult.previewQuery;
      }
    }

    return config;
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
  
  const handleSave = async () => {
    setSaveState(false)
    setExecutionError(null); // Clear any previous error state
    let localPathFromResult = null;

    // Check if this is a NoSQL transformation (MongoDB or NeDB)
    const isNoSQL = sourceConnection?.dbType === 'mongodb' || sourceConnection?.dbType === 'nedb';
    const isNeDB = sourceConnection?.dbType === 'nedb';
    console.log('latestWithSQL: ', latestWithSQL)

    if (isNoSQL && latestWithSQL?.operationType) {
      // Get source local path for NeDB
      const sourceLocalPath = isNeDB ? getSourceLocalPath(node) : null;

      if (isNeDB && !sourceLocalPath) {
        executingInd(false);
        addBotMessage('✗ Source NeDB file path not found', false);
        return;
      }
      const result = await executeTransformation({
        connectionConfig: {
          dbType: sourceConnection.dbType,
          dbConfig: sourceConnection.dbConfig
        },
        connectionId: sourceConnection.id,
        sourceLocalPath,
        sourceCollection: latestWithSQL.sourceCollection,
        targetCollection: latestWithSQL.targetCollection,
        operationType: latestWithSQL.operationType,
        nosqlOperation: latestWithSQL.nosqlOperation,
        transformFunction: latestWithSQL.transformFunction,
        storageLocation: transformationSettings.storageLocation,
        operationMode: transformationSettings.operationMode,
        setExecutingFn: executingInd,
        onSuccess: (res) => {
          addBotMessage(`✓ ${res.message}`, false);
          if (res.localPath) {
            addBotMessage(`📁 Local collection saved at: ${res.localPath}`, false);
            localPathFromResult = res.localPath;
            setLatestWithSQL(prev => ({ ...prev, localPath: res.localPath }));
          } else {
            setLatestWithSQL(prev => {
              const { localPath, ...rest } = prev || {};
              return rest;
            });
          }
        },
        onError: (err) => {
          addBotMessage(`✗ Transformation failed: ${err.error || err.message}`, false);
          setExecutionError({
            error: err.error || err.message || 'Unknown error',
            transformation: {
              operationType: latestWithSQL.operationType,
              nosqlOperation: latestWithSQL.nosqlOperation,
              transformFunction: latestWithSQL.transformFunction
            }
          });
        }
      });

      if (!result.success) return;

    } else if (latestWithSQL?.sql) {
      // SQL transformation - use executeTransformation
      const targetTableName = transformationSettings.tableName || node.id.replace('-', '_').toLowerCase();

      // Get source local path for local SQLite storage
      let sourceLocalPath = null;
      if (transformationSettings.storageLocation === 'local' || transformationSettings.operationMode === 'in_place') {
        sourceLocalPath = getSourceLocalPath(node);
      }

      const result = await executeTransformation({
        connectionConfig: {
          dbType: sourceConnection.dbType,
          dbConfig: sourceConnection.dbConfig
        },
        connectionId: sourceConnection.id,
        ddl: latestWithSQL.ddl,
        sql: latestWithSQL.sql,
        insertSql: latestWithSQL.insertSql,
        previewSql: latestWithSQL.previewSql,
        targetTableName: targetTableName,
        sourceLocalPath: sourceLocalPath,
        storageLocation: transformationSettings.storageLocation,
        operationMode: transformationSettings.operationMode,
        setExecutingFn: executingInd,
        onSuccess: (res) => {
          addBotMessage(`✓ ${res.message}`, false);
          if (res.localPath) {
            addBotMessage(`📁 Local SQLite database saved at: ${res.localPath}`, false);
            localPathFromResult = res.localPath;
            setLatestWithSQL(prev => ({ ...prev, localPath: res.localPath }));
          } else {
            setLatestWithSQL(prev => {
              const { localPath, ...rest } = prev || {};
              return rest;
            });
          }
        },
        onError: (err) => {
          addBotMessage(`✗ Transformation failed: ${err.error || err.message}`, false);
          setExecutionError({
            error: err.error || err.message || 'Unknown error',
            transformation: {
              ddl: latestWithSQL.ddl,
              sql: latestWithSQL.sql
            }
          });
        }
      });

      if (!result.success) return;
    }

    // Fetch transformed table schema after successful execution
    let transformedSchema = null;
    try {
      const isNoSQL = sourceConnection?.dbType === 'mongodb' || sourceConnection?.dbType === 'nedb';
      const isInPlace = transformationSettings.operationMode === 'in_place';

      if (isNoSQL) {
        // NoSQL transformation (MongoDB or NeDB)
        const targetCollection = isInPlace
          ? (sourceNode?.data?.config?.targetCollection || sourceNode?.data?.config?.sourceCollection || latestWithSQL.sourceCollection)
          : latestWithSQL.targetCollection;

        // Determine local path for schema fetching
        let schemaLocalPath = null;
        if (sourceConnection?.dbType === 'nedb') {
          if (isInPlace) {
            // For in_place, use parent's target or source local path
            schemaLocalPath = isFileLocal();
          } else {
            // For new_table, use result local path
            schemaLocalPath = localPathFromResult;
          }
        } else if (transformationSettings.storageLocation === 'local') {
          // MongoDB stored locally
          schemaLocalPath = localPathFromResult;
        }

        transformedSchema = await loadTableSchema({
          connection: sourceConnection,
          tableName: targetCollection,
          localPath: schemaLocalPath
        });
      } else {
        // SQL transformation
        const targetTableName = isInPlace
          ? (sourceNode?.data?.config?.targetTableName || sourceNode?.data?.config?.sourceTableName || sourceTableSchema.tableName)
          : (transformationSettings.tableName || node.id.replace('-', '_').toLowerCase());

        // Determine schema and local path based on storage location
        let schemaLocalPath = null;
        let targetSchema = null;

        if (transformationSettings.storageLocation === 'local') {
          // For local SQLite storage
          if (isInPlace) {
            // For in-place, use parent's local path
            schemaLocalPath = localPathFromResult || isFileLocal();
          } else {
            // For new_table, use result local path
            schemaLocalPath = localPathFromResult;
          }
          targetSchema = null; // SQLite doesn't use schemas
        } else {
          // For database storage
          targetSchema = isInPlace
            ? (sourceNode?.data?.config?.targetSchema || sourceNode?.data?.config?.sourceSchema || sourceConnection.dbConfig?.schema)
            : (sourceConnection.dbConfig?.schema);
        }

        console.log('transformedSchema_input: ', {
          connection: transformationSettings.storageLocation === 'local' && schemaLocalPath
            ? { dbType: 'sqlite', dbConfig: {} } // Use SQLite connection for local
            : sourceConnection,
          tableName: targetTableName,
          tableSchema: targetSchema,
          localPath: schemaLocalPath
        })

        transformedSchema = await loadTableSchema({
          connection: transformationSettings.storageLocation === 'local' && schemaLocalPath
            ? { dbType: 'sqlite', dbConfig: {} } // Use SQLite connection for local
            : sourceConnection,
          tableName: targetTableName,
          tableSchema: targetSchema,
          localPath: schemaLocalPath
        });
        console.log('transformedSchema: ', transformedSchema)
      }
    } catch (error) {
      console.error('Failed to fetch transformed schema:', error);
    }

    setSaveState(false);
    // Save configuration
    const config = await buildConfig();

    // Clean up config based on storage location
    if (transformationSettings.storageLocation === 'database') {
      // Remove targetLocalPath if storing in database
      config.targetLocalPath = null;
    } else if (transformationSettings.storageLocation === 'local') {
      // Add targetLocalPath to config if it was returned from the transformation
      if (localPathFromResult) {
        config.targetLocalPath = localPathFromResult;
      }
    }

    // Add table schema to config (this is the target/output schema)
    if (transformedSchema) {
      config.targetTableSchema = transformedSchema;
    }

    console.log('config: ', config)
    onSave(config, chat);
  };

  const displayChoices = () => {
    // Don't show choices while loading
    if (loading || aiLoading || executing) return [];

    // If there are pending choices (for multi-step questions), show them
    if (pendingChoices.length > 0) {
      return pendingChoices;
    }

    // Show "Fix Error" button if there's an execution error
    if (executionError) {
      return [{
        label: '🔧 Ask AI to Fix Error',
        value: 'fix_error',
        variant: 'outlined',
        fullWidth: true
      }];
    }

    // For database connections with SQL, show Run & Execute Configuration
    if (sourceConnection?.connectionType === 'database' && latestWithSQL?.sql && latestWithSQL?.ddl && saveState) {
      return [{ label: 'Run & Save Configuration', value: 'save', variant: 'contained', fullWidth: true }];
    }

    // For non-database connections, show Save when ready
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
      handleFixError();
      return;
    }

    // Find the current question ref
    const currentQ = getCurrentQuestion();
    if (!currentQ) return;

    // Handle choice selection based on the current question ref
    handleUserResponse(
      choice.label,
      currentQ.ref,
      choice.value,
      null
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

export default TransformerNodeChat;
