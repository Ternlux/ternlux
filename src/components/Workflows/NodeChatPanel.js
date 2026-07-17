import React, { useState, useEffect } from 'react';
import { Button, message as antMessage } from 'antd';
import {
  CloseOutlined, DatabaseOutlined, SettingOutlined,
  MergeOutlined, ExportOutlined, PlayCircleOutlined,
  ReloadOutlined, CaretRightOutlined, LoadingOutlined,
  BranchesOutlined,
} from '@ant-design/icons';

// Import node-specific chat components
import StartNodeChat from './NodeChats/StartNodeChat';
import DataSourceNodeChat from './NodeChats/DataSourceNodeChat';
import TransformerNodeChat from './NodeChats/TransformerNodeChat';
import JoinNodeChat from './NodeChats/JoinNodeChat';
import OutputNodeChat from './NodeChats/OutputNodeChat';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Utilities
// ─────────────────────────────────────────────────────────────────────────────

const NODE_COLORS = {
  start: '#2563eb',
  dataSource: '#0891b2',
  transformer: '#7c3aed',
  join: '#d97706',
  branch: '#059669',
  output: '#db2777',
};

const NODE_LABELS = {
  start: 'START',
  dataSource: 'DATA SOURCE',
  transformer: 'TRANSFORM',
  join: 'JOIN',
  branch: 'BRANCH',
  output: 'OUTPUT',
};

const NODE_ICON = {
  start: (color) => <PlayCircleOutlined style={{ color, fontSize: 14 }} />,
  dataSource: (color) => <DatabaseOutlined style={{ color, fontSize: 14 }} />,
  transformer: (color) => <SettingOutlined style={{ color, fontSize: 14 }} />,
  join: (color) => <MergeOutlined style={{ color, fontSize: 14 }} />,
  branch: (color) => <BranchesOutlined style={{ color, fontSize: 14 }} />,
  output: (color) => <ExportOutlined style={{ color, fontSize: 14 }} />,
};

const MONO = "'JetBrains Mono', monospace";
const SANS = "'Inter',-apple-system,sans-serif";

// ─────────────────────────────────────────────────────────────────────────────
// Main NodeChatPanel Component
// Routes to specific node type components
// ─────────────────────────────────────────────────────────────────────────────

const NodeChatPanel = ({ isOpen, node, nodes, edges, currentWorkflowId, onClose, onConfigUpdate, onPreviewConfigUpdate, onLoadDatabaseTables, onDataPreviewRefresh }) => {
  console.log('NodeChatPanel: ', nodes, edges)
  const [resetKey, setResetKey] = useState(0);
  const [executing, setExecuting] = useState(false);

  // Reset the resetKey when node changes or panel closes
  useEffect(() => {
    // if (!isOpen || !node) {
      setResetKey(0);
    // }
  }, [isOpen, node?.id]);

  if (!isOpen || !node) return null;
  // console.log('node?.id: ', node?.id)

  // Use empty chat when reset, otherwise use saved chat
  const initialChat = resetKey > 0 ? [] : (node.data?.config?.chat || []);
  // console.log('resetKey: ', resetKey)
  // ─────────────────────────────────────────────────────────────────────────
  // Shared Helper: Get source local path for NeDB
  // ─────────────────────────────────────────────────────────────────────────

  const getSourceLocalPath = (targetNode) => {
    const sourceEdge = edges.find(e => e.target === targetNode.id);
    if (!sourceEdge) return null;

    const sourceNode = nodes.find(n => n.id === sourceEdge.source);
    if (!sourceNode?.data?.config) return null;

    const sourceConfig = sourceNode.data.config;
    // const isSourceTransformer = sourceNode.type === 'transformer';

    return sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Consolidated Execution Function
  // ─────────────────────────────────────────────────────────────────────────

  const executeTransformation = async ({
    // Required
    connectionConfig,
    connectionId,

    // SQL params
    targetSchema = null,
    ddl = null,
    sql = null,
    previewSql = null,
    targetTableName = null,
    insertSql = null,

    // NoSQL params
    sourceLocalPath = null,
    sourceCollection = null,
    targetCollection = null,
    operationType = null,
    nosqlOperation = null,
    transformFunction = null,
    storageLocation = null,
    operationMode = null,
    targetLocalPath = null,

    // Optional callbacks
    onSuccess = null,
    onError = null
  }) => {
    const isNoSQL = connectionConfig.dbType === 'mongodb' || connectionConfig.dbType === 'nedb';

    if (isNoSQL && operationType) {
      // NoSQL transformation
      if (!window.electronAPI?.dbConnect) {
        const result = { success: false, error: 'Database connection not available' };
        if (onError) onError(result);
        return result;
      }

      setExecuting(true);

      try {
        const result = await window.electronAPI.dbConnect.transformNoSQL(
          connectionConfig.dbType,
          connectionConfig.dbConfig,
          connectionId,
          sourceLocalPath,
          sourceCollection,
          targetCollection,
          operationType,
          nosqlOperation,
          transformFunction,
          storageLocation,
          operationMode,
          targetLocalPath
        );

        if (result.success && onDataPreviewRefresh) {
          onDataPreviewRefresh();
        }

        setExecuting(false);

        if (result.success && onSuccess) {
          onSuccess(result);
        } else if (!result.success && onError) {
          onError(result);
        }

        return result;
      } catch (error) {
        setExecuting(false);
        const errorResult = { success: false, error: error.message };
        if (onError) onError(errorResult);
        return errorResult;
      }
    }

    // SQL transformation
    if (!sql && !ddl && !transformFunction) {
      const result = { success: false, error: 'No SQL to execute' };
      if (onError) onError(result);
      return result;
    }

    if (!window.electronAPI?.dbConnect) {
      const result = { success: false, error: 'Database connection not available' };
      if (onError) onError(result);
      return result;
    }

    setExecuting(true);

    try {
      const result = await window.electronAPI.dbConnect.transformSQL(
        connectionConfig.dbType,
        connectionConfig.dbConfig,
        connectionId,
        ddl,
        sql,
        previewSql,
        storageLocation,
        operationMode,
        targetSchema,
        targetTableName,
        sourceLocalPath,
        insertSql
      );
      console.log('result: ', result)
      if (result.success && onDataPreviewRefresh) {
        onDataPreviewRefresh();
      }

      setExecuting(false);

      if (result.success && onSuccess) {
        onSuccess(result);
      } else if (!result.success && onError) {
        onError(result);
      }

      return result;
    } catch (error) {
      console.error('Execute error:', error);
      setExecuting(false);
      const errorResult = { success: false, error: error.message || 'Failed to execute SQL' };
      if (onError) onError(errorResult);
      return errorResult;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Handle save from child components
  // ─────────────────────────────────────────────────────────────────────────

  const handleSave = (config, chat) => {
    // Build summary message with metadata for DDL/SQL
    let summaryText = '';
    let metadata = null;
    console.log('config: ', config)
    switch (node.type) {
      case 'dataSource':
        // Text: only description and basic info
        const dsLines = ['Configuration saved!\n'];
        if(config.connectionName)
        dsLines.push(`**Connection:** ${config.connectionName}`);
        if (config.dataset) dsLines.push(`**Dataset:** ${config.dataset}`);
        if (config.dbType) dsLines.push(`**Database:** ${config.dbType.toUpperCase()}`);

        // Add SQL explanation to text
        if (config.explanation || config.sqlExplanation) {
          const explanation = config.explanation || config.sqlExplanation;
          dsLines.push(`\n${explanation}`);
        }

        summaryText = dsLines.join('\n');

        // Metadata: DDL and SQL for dropdown
        if (config.ddl || config.sql) {
          metadata = {
            ddl: config.ddl || '',
            sql: config.sql || '',
            previewSql: config.previewSql || ''
          };
        }
        break;

      case 'transformer':
        // Text: only description and basic info
        const tfLines = ['Configuration saved!\n'];
        if (config.sourceNodeLabel) tfLines.push(`**Source:** ${config.sourceNodeLabel}`);

        // Add transformation request
        if (config.transformationRequest) {
          tfLines.push(`**Transformation:** ${config.transformationRequest}`);
        }

        // Add SQL explanation to text
        if (config.explanation || config.sqlExplanation) {
          const explanation = config.explanation || config.sqlExplanation;
          tfLines.push(`\n${explanation}`);
        }

        summaryText = tfLines.join('\n');

        // Metadata: DDL and SQL for dropdown
        if (config.ddl || config.sql) {
          metadata = {
            ddl: config.ddl || '',
            sql: config.sql || '',
            previewSql: config.previewSql || ''
          };
        }
        break;

      case 'join':
        // console.log('config: ', config)
        summaryText = `Configuration saved!${config.targetTableName ? `\n\n**Table Name:** ${config.targetTableName}` : ''}`;
        if (config.joinDescription) {
          summaryText += `\n**Join:** ${config.joinDescription}`;
        }
        break;

      case 'output':
        summaryText = `Configuration saved!\n\n**Type:** ${config.outputSettings.format}`;
        if (config.analysisPrompt) summaryText += `\n**Prompt:** ${config.analysisPrompt}`;
        if (config.emailAddress) summaryText += `\n**Email:** ${config.emailAddress}`;
        break;

      case 'branch': {
        const routeTrue = config.outputRoutes?.true || 'valid';
        const routeFalse = config.outputRoutes?.false || 'invalid';
        summaryText = 'Configuration saved!\n';
        if (config.branchRequest) summaryText += `\n**Rule:** ${config.branchRequest}`;
        if (config.explanation) summaryText += `\n${config.explanation}`;
        summaryText += `\n\n**Routes:** true → ${routeTrue} · false → ${routeFalse}`;
        if (Array.isArray(config.steps)) {
          metadata = { branchSteps: config.steps, validationFunction: config.validationFunction };
        }
        break;
      }

      case 'start':
        summaryText = 'Configuration saved!\n';
        if (config.triggerType === 'manual') {
          summaryText += '\n**Trigger:** Manual';
        } else if (config.triggerType === 'time') {
          summaryText += `\n**Trigger:** Time-based\n**Schedule:** ${config.description || 'Not configured'}`;
        } else if (config.triggerType === 'file') {
          summaryText += `\n**Trigger:** File Watch\n**Path:** ${config.fileWatchConfig?.path || 'Not configured'}`;
          if (config.fileWatchConfig?.events) {
            const eventNames = config.fileWatchConfig.events.map(e => {
              const map = { add: 'File Added', change: 'File Changed', unlink: 'File Deleted', addDir: 'Directory Added', unlinkDir: 'Directory Deleted' };
              return map[e];
            });
            summaryText += `\n**Events:** ${eventNames.join(', ')}`;
          }
        }
        break;

      default:
        summaryText = 'Configuration saved!';
        break;
    }

    const summaryMsg = {
      id: `bot-${Date.now()}-${Math.random()}`,
      sender: 'bot',
      text: summaryText,
      timestamp: new Date(),
      responseRequired: false,
      metadata: metadata,
    };

    const finalChat = [...chat, summaryMsg];

    onConfigUpdate(node.id, { ...config, chat: finalChat });

    // Also update the selectedNode so DataPreview can show the new data
    onPreviewConfigUpdate(node.id, { ...config, chat: finalChat });

    antMessage.success('Configuration saved! Check the Data Preview below.');
  };

  const handleReset = () => {
    // Increment reset key to force child component to remount with empty chat
    setResetKey(prev => prev + 1);
  };

  const handleHeaderExecute = async () => {
    if (!node.data?.config) return;

    const config = node.data.config;

    // Handle join nodes differently
    if (node.type === 'join') {
      const destinationConnection = {
        id: config.targetConnectionId,
        dbType: config.targetDbType,
        dbConfig: config.targetDbConfig || {}
      };

      const joinConfig = {
        sourcesConfig: config.sourcesConfig,
        joinSql: config.joinSql,
        targetDdl: config.targetDdl,
        transformFunction: config.transformFunction,
        targetTableName: config.targetTableName,
        targetSchema: config.targetSchema,
        targetCollection: config.targetCollection
      };

      const result = await executeJoin({
        destinationConnection: destinationConnection,
        joinConfig: joinConfig,
        operationMode: config.joinSettings?.operationMode || 'new_table'
      });

      if (result.success) {
        antMessage.success(result.message || 'Join execution successful!');
      } else {
        antMessage.error(result.error || result.message || 'Join execution failed');
      }

      return;
    }

    // Skill-based transformations bypass the SQL/NoSQL branches and dispatch
    // through skills:execute so the skill (javascript-executor, python-executor,
    // vector-db-executor) gets the helpers bundle that electron injects.
    if (config.usesSkill && config.skillId) {
      setExecuting(true);
      try {
        const skillResult = await window.electronAPI.skills.execute({
          skillId: config.skillId,
          params: {
            sourceConnection: {
              id: config.sourceConnectionId,
              name: config.sourceConnectionName,
              dbType: config.sourceDbType,
              dbConfig: config.sourceDbConfig,
              localPath: config.sourceLocalPath,
              connectionType: config.sourceConnectionType,
              dbCategory: config.sourceDbCategory,
              indexName: config.sourceIndexName
            },
            sourceTableSchema: config.sourceTableSchema,
            operationType: config.operationType,             // python-executor
            transformFunction: config.transformFunction,     // javascript-executor / vector-db-executor
            outputType: config.targetDbType,                 // javascript-executor: nedb | lancedb
            targetLocalPath: config.targetLocalPath,
            storageLocation: config.transformationSettings?.storageLocation || config.storageLocation,
            operationMode: config.transformationSettings?.operationMode || config.operationMode,
            nodeId: node.id,
            sourceNodeId: config.sourceNodeId,
            sourceNodeLabel: config.sourceNodeLabel,
            sourceConnectionName: config.sourceConnectionName,
            sourceConnectionType: config.sourceConnectionType,
            userRequest: config.transformationRequest,
            // vector-db-executor specific
            vectorDbType: config.targetDbType,
            targetConnectionId: config.targetConnectionId,
            // python-executor specific
            pythonCode: config.pythonCode
          }
        });
        setExecuting(false);
        if (skillResult?.success) {
          antMessage.success(skillResult.message || 'Execution successful!');
          if (onDataPreviewRefresh) onDataPreviewRefresh();
        } else {
          antMessage.error(skillResult?.error || skillResult?.message || 'Execution failed');
        }
      } catch (err) {
        setExecuting(false);
        console.error('Skill execute error:', err);
        antMessage.error(err.message || 'Failed to execute skill');
      }
      return;
    }

    // Handle transformer nodes
    const isNoSQL = config.dbType === 'mongodb' || config.dbType === 'nedb';
    const isNeDB = config.dbType === 'nedb';
    const isLocalStorage = config.transformationSettings?.storageLocation === 'local';
    const isInPlace = config.transformationSettings?.operationMode === 'in_place';

    // Get source local path if needed (for NeDB or local SQLite operations)
    const sourceLocalPath = (isNeDB || isLocalStorage || isInPlace) ? getSourceLocalPath(node) : null;

    const result = await executeTransformation({
      connectionConfig: {
        dbType: config.targetDbType,
        dbConfig: config.dbConfig
      },
      connectionId: config.targetConnectionId,

      // SQL params
      targetSchema: config.targetSchema,
      ddl: config.targetDdl,
      sql: config.targetSql,
      previewSql: config.previewSql,
      targetTableName: config.targetTableName || config.targetCollection,
      insertSql: config.insertSql,
      sourceLocalPath: sourceLocalPath,

      // NoSQL params
      sourceCollection: config.sourceCollection,
      targetCollection: config.targetCollection,
      operationType: config.operationType,
      nosqlOperation: config.nosqlOperation,
      transformFunction: config.transformFunction,
      storageLocation: config.transformationSettings?.storageLocation,
      operationMode: config.transformationSettings?.operationMode,
      targetLocalPath: config.targetLocalPath,
    });

    if (result.success) {
      antMessage.success(result.message || 'Execution successful!');
    } else {
      antMessage.error(result.error || result.message || 'Execution failed');
    }
  };

  const executingInd = async (execute) => setExecuting(execute)

  /**
   * Execute Join Operation
   * Handles joining multiple sources with SQL or NoSQL destinations
   */
  const executeJoin = async ({
    destinationConnection,
    joinConfig,
    operationMode = 'new_table',
    onSuccess = null,
    onError = null
  }) => {
    if (!window.electronAPI?.dbConnect) {
      const result = { success: false, error: 'Database connection not available' };
      if (onError) onError(result);
      return result;
    }

    setExecuting(true);

    try {
      const result = await window.electronAPI.dbConnect.executeJoin(
        destinationConnection,
        joinConfig,
        operationMode
      );

      if (result.success && onDataPreviewRefresh) {
        onDataPreviewRefresh();
      }

      setExecuting(false);

      if (result.success && onSuccess) {
        onSuccess(result);
      } else if (!result.success && onError) {
        onError(result);
      }

      return result;
    } catch (error) {
      console.error('Execute join error:', error);
      setExecuting(false);
      const errorResult = { success: false, error: error.message || 'Failed to execute join' };
      if (onError) onError(errorResult);
      return errorResult;
    }
  };

  /**
   * Execute Output Operation
   * Handles exporting data to local files or database connections
   */
  const executeOutput = async ({
    sourceConnection,
    sourceTableSchema,
    outputSettings,
    onSuccess = null,
    onError = null
  }) => {
    if (!window.electronAPI?.dbConnect) {
      const result = { success: false, error: 'Database connection not available' };
      if (onError) onError(result);
      return result;
    }

    setExecuting(true);

    try {
      const result = await window.electronAPI.dbConnect.executeOutput(
        sourceConnection,
        sourceTableSchema,
        outputSettings
      );

      if (result.success && onDataPreviewRefresh) {
        onDataPreviewRefresh();
      }

      setExecuting(false);

      if (result.success && onSuccess) {
        onSuccess(result);
      } else if (!result.success && onError) {
        onError(result);
      }

      return result;
    } catch (error) {
      console.error('Execute output error:', error);
      setExecuting(false);
      const errorResult = { success: false, error: error.message || 'Failed to execute output' };
      if (onError) onError(errorResult);
      return errorResult;
    }
  };

  /**
   * Execute Branch Validation
   * Runs each plan step against its source, feeds the results into the
   * validationFunction, and returns { success, result:boolean, route, stepResults }.
   */
  const executeBranch = async ({
    sources,
    steps,
    validationFunction,
    outputRoutes,
    onSuccess = null,
    onError = null,
  }) => {
    if (!window.electronAPI?.dbConnect?.executeBranch) {
      const result = { success: false, error: 'Branch execution not available' };
      if (onError) onError(result);
      return result;
    }

    setExecuting(true);
    try {
      const result = await window.electronAPI.dbConnect.executeBranch({
        sources,
        steps,
        validationFunction,
        outputRoutes,
      });

      if (result.success && onDataPreviewRefresh) {
        onDataPreviewRefresh();
      }

      setExecuting(false);

      if (result.success && onSuccess) {
        onSuccess(result);
      } else if (!result.success && onError) {
        onError(result);
      }

      return result;
    } catch (error) {
      console.error('Execute branch error:', error);
      setExecuting(false);
      const errorResult = { success: false, error: error.message || 'Failed to execute branch' };
      if (onError) onError(errorResult);
      return errorResult;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render child component based on node type
  // ─────────────────────────────────────────────────────────────────────────

  const renderNodeChat = () => {
    switch (node.type) {
      case 'dataSource':
        return (
          <DataSourceNodeChat
            key={`${node.id}-${resetKey}`}
            node={node}
            initialChat={initialChat}
            onSave={handleSave}
            onLoadDatabaseTables={onLoadDatabaseTables}
            onConfigUpdate={onConfigUpdate}
            onPreviewConfigUpdate={onPreviewConfigUpdate}
            executing={executing}
          />
        );

      case 'transformer':
        return (
          <TransformerNodeChat
            key={`${node.id}-${resetKey}`}
            node={node}
            nodes={nodes}
            edges={edges}
            initialChat={initialChat}
            onSave={handleSave}
            onConfigUpdate={onConfigUpdate}
            onPreviewConfigUpdate={onPreviewConfigUpdate}
            executeTransformation={executeTransformation}
            getSourceLocalPath={getSourceLocalPath}
            executingInd={executingInd}
            executing={executing}
          />
        );

      case 'join':
        return (
          <JoinNodeChat
            key={`${node.id}-${resetKey}`}
            node={node}
            nodes={nodes}
            edges={edges}
            initialChat={initialChat}
            onSave={handleSave}
            onLoadDatabaseTables={onLoadDatabaseTables}
            onConfigUpdate={onConfigUpdate}
            onPreviewConfigUpdate={onPreviewConfigUpdate}
            executeJoin={executeJoin}
            executingInd={executingInd}
            executing={executing}
          />
        );

      case 'output':
        return (
          <OutputNodeChat
            key={`${node.id}-${resetKey}`}
            node={node}
            nodes={nodes}
            edges={edges}
            initialChat={initialChat}
            onSave={handleSave}
            onConfigUpdate={onConfigUpdate}
            executeOutput={executeOutput}
            executingInd={executingInd}
            executing={executing}
          />
        );

      case 'start':
        return (
          <StartNodeChat
            key={`${node.id}-${resetKey}`}
            currentWorkflowId={currentWorkflowId}
            node={node}
            initialChat={initialChat}
            onSave={handleSave}
            onConfigUpdate={onConfigUpdate}
          />
        );

      default:
        return (
          <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>
            No configuration available for this node type.
          </div>
        );
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const nodeColor = NODE_COLORS[node.type] || '#2563eb';
  const nodeLabel = NODE_LABELS[node.type] || node.type.toUpperCase();
  const iconFn = NODE_ICON[node.type] || (() => null);

  return (
    <div
      style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 420, zIndex: 1030,
        background: '#fff', borderLeft: '1px solid #e2e6eb',
        boxShadow: '-6px 0 24px rgba(0,0,0,0.08)',
        display: 'flex', flexDirection: 'column',
        fontFamily: SANS,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 14px', borderBottom: '1px solid #e2e6eb',
          display: 'flex', alignItems: 'center', gap: 10,
          background: '#fff', flexShrink: 0,
        }}
      >
        <div style={{
          width: 28, height: 28, borderRadius: 5,
          background: nodeColor + '18',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          {iconFn(nodeColor)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 9, fontFamily: MONO, fontWeight: 700,
            letterSpacing: '0.1em', color: nodeColor, textTransform: 'uppercase',
          }}>
            {nodeLabel}
          </div>
          <div style={{
            fontSize: 13, fontWeight: 600, color: '#111827', marginTop: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {node.data?.label || `Configure ${node.type}`}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* Show run button for dataSource, transformer, and join nodes with SQL/DDL */}
          {(
            (node.type === 'dataSource' && node.data?.config?.sql && node.data?.config?.ddl && node.data?.config?.connectionType === 'database') ||
            (node.type === 'transformer' && node.data?.config?.targetSql || node.data?.config?.targetDdl || node.data?.config?.transformFunction || node.data?.config?.nosqlOperation) ||
            (node.type === 'join' && node.data?.config?.targetConnectionType)
          ) && (
            <Button
              type="text"
              icon={executing ? <LoadingOutlined /> : <CaretRightOutlined />}
              onClick={handleHeaderExecute}
              size="small"
              title="Execute SQL"
              disabled={executing}
              style={{ color: nodeColor, fontSize: 11 }}
            >
              {executing && 'Running'}
            </Button>
          )}
          <Button
            type="text"
            icon={<ReloadOutlined />}
            onClick={handleReset}
            size="small"
            title="Start over"
            style={{ color: '#5a6678' }}
          />
          <Button
            type="text"
            icon={<CloseOutlined />}
            onClick={onClose}
            size="small"
            style={{ color: '#5a6678' }}
          />
        </div>
      </div>

      {/* Child component renders here */}
      {renderNodeChat()}
    </div>
  );
};

export default NodeChatPanel;
