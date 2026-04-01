import React, { useState, useEffect } from 'react';
import { Button, message as antMessage } from 'antd';
import {
  CloseOutlined, DatabaseOutlined, SettingOutlined,
  MergeOutlined, ExportOutlined, PlayCircleOutlined,
  ReloadOutlined, CaretRightOutlined, LoadingOutlined,
} from '@ant-design/icons';

// Import node-specific chat components
import DataSourceNodeChat from './NodeChats/DataSourceNodeChat';
import TransformerNodeChat from './NodeChats/TransformerNodeChat';
import JoinNodeChat from './NodeChats/JoinNodeChat';
import OutputNodeChat from './NodeChats/OutputNodeChat';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Utilities
// ─────────────────────────────────────────────────────────────────────────────

const NODE_ICON = {
  start: <PlayCircleOutlined style={{ color: '#1890ff', fontSize: 16 }} />,
  dataSource: <DatabaseOutlined style={{ color: '#52c41a', fontSize: 16 }} />,
  transformer: <SettingOutlined style={{ color: '#1890ff', fontSize: 16 }} />,
  join: <MergeOutlined style={{ color: '#fa8c16', fontSize: 16 }} />,
  output: <ExportOutlined style={{ color: '#722ed1', fontSize: 16 }} />,
};

// ─────────────────────────────────────────────────────────────────────────────
// Main NodeChatPanel Component
// Routes to specific node type components
// ─────────────────────────────────────────────────────────────────────────────

const NodeChatPanel = ({ isOpen, node, nodes, edges, onClose, onConfigUpdate, onPreviewConfigUpdate, onLoadDatabaseTables, onDataPreviewRefresh }) => {
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
        setExecuting(false);
        const errorResult = { success: false, error: error.message };
        if (onError) onError(errorResult);
        return errorResult;
      }
    }

    // SQL transformation
    if (!sql && !ddl) {
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
        targetTableName,
        sourceLocalPath,
        insertSql
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

    // Handle transformer nodes
    const isNoSQL = config.dbType === 'mongodb' || config.dbType === 'nedb';
    const isNeDB = config.dbType === 'nedb';
    const isLocalStorage = config.transformationSettings?.storageLocation === 'local';
    const isInPlace = config.transformationSettings?.operationMode === 'in_place';

    // Get source local path if needed (for NeDB or local SQLite operations)
    const sourceLocalPath = (isNeDB || isLocalStorage || isInPlace) ? getSourceLocalPath(node) : null;

    const result = await executeTransformation({
      connectionConfig: {
        dbType: config.dbType,
        dbConfig: config.dbConfig
      },
      connectionId: config.connectionId,

      // SQL params
      ddl: config.ddl,
      sql: config.sql,
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
    });

    if (result.success) {
      antMessage.success(result.message || 'Execution successful!');
    } else {
      antMessage.error(result.error || result.message || 'Execution failed');
    }
  };

  const executingInd = async (execute) => setExecuting(execute)

  const handleExecute = async (connectionConfig, ddl, sql, connectionId, nosqlConfig = null) => {
    return executeTransformation({
      connectionConfig,
      connectionId,
      ddl,
      sql,
      ...(nosqlConfig || {})
    });
  };

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
            onExecute={handleExecute}
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
            onExecute={handleExecute}
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
            onExecute={handleExecute}
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
            executeOutput={executeOutput}
            executingInd={executingInd}
            executing={executing}
          />
        );

      case 'start':
      default:
        return (
          <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>
            This is the Start node — no configuration needed.
          </div>
        );
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed', right: 0, top: 48, bottom: 0, width: 420, zIndex: 1010,
        background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.13)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 16px', borderBottom: '1px solid #f0f0f0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: '#fafafa', flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {NODE_ICON[node.type]}
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>
              Configure {node.data?.label || node.type}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 1, textTransform: 'capitalize' }}>
              {node.type} node
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* Show run button for dataSource, transformer, and join nodes with SQL/DDL */}
          {(
            (node.type === 'dataSource' && node.data?.config?.sql && node.data?.config?.ddl && node.data?.config?.connectionType === 'database') ||
            (node.type === 'transformer' && node.data?.config?.sql || node.data?.config?.ddl || node.data?.config?.nosqlOperation) ||
            (node.type === 'join' && node.data?.config?.targetConnectionType)
          ) && (
            <Button
              type="text"
              icon={executing ? <LoadingOutlined /> : <CaretRightOutlined />}
              onClick={handleHeaderExecute}
              size="small"
              title="Execute SQL"
              disabled={executing}
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
          />
          <Button type="text" icon={<CloseOutlined />} onClick={onClose} size="small" />
        </div>
      </div>

      {/* Child component renders here */}
      {renderNodeChat()}
    </div>
  );
};

export default NodeChatPanel;
