import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card, Tabs, Table, Typography, Spin, Empty, Button, Space, message, Tooltip, Collapse } from 'antd';
import {
  EyeOutlined,
  SwapOutlined,
  DatabaseOutlined,
  PlayCircleOutlined,
  ExpandOutlined,
  CompressOutlined,
  DownloadOutlined,
  RightOutlined,
  ProfileOutlined,
  CloseOutlined
} from '@ant-design/icons';
import axios from 'axios';
import Editor from '@monaco-editor/react';
import { nodeDisplayName } from './nodes/nodeCardShared';

const { Title, Text } = Typography;
const { TabPane } = Tabs;
const { Panel } = Collapse;

// Node types whose output is created by running them: until then their target
// table/collection is a name in the config and nothing else. `config.executed`
// records whether the run has happened — set false when the node is built or
// reconfigured, true by the executor (NodeExecution/workflowExecutionHelpers
// markNodeExecuted, which also writes it to the saved workflow).
const EXECUTED_FLAG_NODE_TYPES = new Set(['transformer', 'join', 'output']);

/**
 * Would reading this node's output query something that isn't there yet?
 *
 * Only an explicit `false` counts. Nodes saved before the flag existed have no
 * `executed` at all, and those may well have been run — refusing to preview
 * them would break working workflows, so they fall through to the query (and,
 * if the table really is missing, to the pending-execution state below).
 */
const awaitsExecution = (node) =>
  !!node &&
  EXECUTED_FLAG_NODE_TYPES.has(node.type) &&
  node.data?.config?.executed === false;

// The shape renderDataTable shows as "runs first, previews after".
const pendingExecutionResult = () => ({
  headers: [],
  data: [],
  metadata: { rowCount: 0, pendingExecution: true },
  pendingExecution: true,
});

const DataPreview = ({
  selectedNode,
  nodes,
  edges,
  isNodeSidebarOpen,
  onNodeUpdate,
  dbTables = [],
  activeConnection = null,
  refreshTrigger = 0,
  onClose = null
}) => {
  // Component state
  const [isExpanded, setIsExpanded] = useState(false);
  const [height, setHeight] = useState(300);
  const [activeTab, setActiveTab] = useState('preview');
  const [previewData, setPreviewData] = useState(null);
  const [previewDataBySource, setPreviewDataBySource] = useState({});
  const [activePreviewTab, setActivePreviewTab] = useState('0');
  const [transformedData, setTransformedData] = useState(null);
  const [transformedDataBySource, setTransformedDataBySource] = useState({});
  const [activeTransformedTab, setActiveTransformedTab] = useState('0');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingTransformed, setLoadingTransformed] = useState(false);
  const [connectedDataSources, setConnectedDataSources] = useState([]);
  // A REST API source is picked in the form but described in the chat; until
  // its fetch has run there is nothing to preview.
  const [awaitingApiConfig, setAwaitingApiConfig] = useState(false);

  // Schema Explorer state (for database connections)
  const [dbSchema, setDbSchema] = useState({});
  const [loadingSchema, setLoadingSchema] = useState(false);

  // Refs for resizing
  const containerRef = useRef(null);
  const isDragging = useRef(false);
  // Two separate effects watch the node config and both call fetchPreviewData,
  // so one selection change used to fire two identical queries — enough to race
  // a connection that was being torn down ("connection is in closed state").
  // This holds the descriptor of the last fetch issued; a repeat is ignored.
  const inFlightFetchKey = useRef(null);
  // Monotonic id for preview fetches, so a slow one that resolves after the
  // user has already picked a different table is discarded instead of
  // overwriting the newer selection.
  const previewRequestSeq = useRef(0);

  // A REST API source is not a browsable store: it has no schema to explore and
  // nothing to "transform" — its Details tab carries the endpoint instead.
  const isApiDataSource = selectedNode?.type === 'dataSource' && (
    selectedNode?.data?.config?.sourceDbCategory === 'API' ||
    selectedNode?.data?.config?.sourceConnectionType === 'api' ||
    selectedNode?.data?.config?.sourceDbType === 'rest-api'
  );

  // Authentication error handler
  const handleAuthError = (error) => {
    if (error.response?.status === 401 || error.response?.status === 204 ||
        (error.response?.status === 400)) {
      localStorage.removeItem('auth-token');
      message.error('Session expired. Please log in again.');
      window.location.href = '/login';
      return true;
    }
    return false;
  };

  // Helper to check if user is logged in
  const isLoggedIn = () => Boolean(localStorage.getItem('auth-token'));

  // Fetch local data for offline/guest users
  const fetchLocalData = async (config, connection) => {
    // console.log('config: ', config)
    if (!window.electronAPI) {
      message.warning('Local data access requires the desktop app.');
      return null;
    }

    try {
      // Handle SQLite/NeDB databases (including imported spreadsheets)
      // Check if this is a SQLite or NeDB connection first
      const dbType = connection.targetDbType || config.targetDbType || config.sourceDbType;
      
      // Handle vector databases (LanceDB, Pinecone)
      if (dbType === 'lancedb' || dbType === 'pinecone') {
        console.log('config: ', config)
        // For Pinecone, use indexName; for LanceDB, use tableName
        const tableName = dbType === 'pinecone'
          ? (config.sourceIndexName || config.targetIndexName || config.targetTableName || config.sourceTableName)
          : (config.targetTableName || config.sourceTableName);
        const namespace = config.namespace || config.targetTableSchema?.schema || '';

        if (!tableName) {
          message.error('Vector database table/index name not found');
          return null;
        }

        const result = await window.electronAPI.skills.queryVectorPreview({
          vectorDbType: dbType,
          tableName: tableName,
          namespace: namespace,
          dbConfig: config.targetDbConfig || config.sourceDbConfig,
          connectionId: config.targetConnectionId || config.sourceConnectionId,
          targetLocalPath: config.targetLocalPath || config.sourceLocalPath
        });

        if (!result.success) {
          message.error(`Failed to query vector database: ${result.message}`);
          return null;
        }

        return {
          headers: [],
          data: result.data || [],
          metadata: { rowCount: result.recordCount || 0 },
          isJson: true,
          storageType: result.storageType || dbType
        };
      }

      if (dbType === 'sqlite' || dbType === 'nedb' || dbType === 'duckdb') {
        // Use sourceLocalPath for data source nodes, fallback to connection fileInfo
        const localPath = config.sourceLocalPath || connection.fileInfo?.filePath;

        if (!localPath || !window.electronAPI.db?.readLocalCollection) {
          message.error('Database path not found');
          return null;
        }

        // Determine storage type from connection dbType
        const storageType = dbType === 'sqlite' ? 'sqlite' : dbType === 'duckdb' ? 'duckdb' : 'nedb';
        // SQL stores take a preview statement; NeDB has none.
        const isSqlStore = storageType === 'sqlite' || storageType === 'duckdb';
        const sqlPreview = isSqlStore ? config.targetPreviewSql || config.sourcePreviewSql : null;
        // Get table name for SQL queries
        const tableName = isSqlStore ? (config.targetTableName || config.sourceTableName || config.table) : null;
        // console.log('sqlPreview: ', sqlPreview)
        const result = await window.electronAPI.db.readLocalCollection(localPath, 1000, storageType, sqlPreview, tableName);
        // console.log('result: ', result)
        if (!result.success) {
          message.error('Failed to read local collection: ' + result.message);
          return null;
        }

        const rows = result.rows || [];

        // Check if this is SQLite (json: false) or NeDB (json: true)
        if (result.json) {
          // NeDB/MongoDB data - return as JSON
          return {
            headers: [],
            data: rows,
            metadata: { rowCount: rows.length },
            isJson: true,
            storageType: 'NeDB'
          };
        } else {
          // Tabular data (SQLite / DuckDB) - format as table. DuckDB reports
          // its columns, so an empty result still shows the right headers.
          const label = storageType === 'duckdb' ? 'DuckDB' : 'SQLite';
          const declaredHeaders = (result.columns || []).map((c) => (typeof c === 'string' ? c : c.name));

          if (rows.length === 0) {
            return {
              headers: declaredHeaders,
              data: [],
              metadata: { rowCount: 0 },
              isJson: false,
              storageType: label,
              tables: result.tables || [],
              currentTable: result.currentTable || null
            };
          }

          const headers = declaredHeaders.length > 0 ? declaredHeaders : Object.keys(rows[0]);
          const formattedRows = rows.map(row =>
            headers.map(header => {
              const value = row[header];
              if (value === null || value === undefined || value === 'null') return '';
              // DuckDB returns real objects/arrays for STRUCT and LIST columns.
              return typeof value === 'object' ? JSON.stringify(value) : String(value);
            })
          );

          return {
            headers,
            data: formattedRows,
            metadata: { rowCount: formattedRows.length },
            isJson: false,
            storageType: label,
            tables: result.tables || [],
            currentTable: result.currentTable || null
          };
        }
      }

      // Handle file-based connections (CSV, Excel)
      if (connection.connectionType === 'file') {
        if (!window.electronAPI.fileReader) {
          message.warning('File reading requires the desktop app.');
          return null;
        }

        let filePath = connection.fileInfo?.filePath;

        // Path missing — let user re-pick
        if (!filePath) {
          const dialogResult = await window.electronAPI.openFileDialog();
          if (dialogResult.canceled || !dialogResult.filePaths?.length) return null;
          filePath = dialogResult.filePaths[0];
        }

        const result = await window.electronAPI.fileReader.readRows(filePath, 1000);
        if (!result.success) {
          message.error('Failed to read file: ' + result.message);
          return null;
        }

        // Get data from the specified sheet/tab or first sheet
        const sheetName = config.table || result.sheets[0];
        const sheetData = result.data[sheetName];

        if (!sheetData) {
          message.error('Sheet not found: ' + sheetName);
          return null;
        }

        const headers = sheetData.columns || [];
        const rows = sheetData.rows.map(row =>
          headers.map(header => {
            const value = row[header];
            if (value === null || value === undefined || value === 'null') return '';
            return String(value);
          })
        );

        return {
          headers,
          data: rows,
          metadata: { rowCount: rows.length }
        };
      }

      // Handle database connections
      if (connection.connectionType === 'database') {
        if (!window.electronAPI.dbConnect) {
          message.warning('Database access requires the desktop app.');
          return null;
        }

        // Use the preview SQL from config (with LIMIT 100), fallback to regular SQL
        const query = config.targetPreviewSql || config.previewSql || config.sourcePreviewSql;
        // console.log('query: ',query)
        if (!query) {
          message.error('No SQL query found in node configuration');
          return null;
        }

        // Try to parse as JSON first (for NoSQL/Google Sheets queries)
        // If it fails, treat as SQL string and wrap in {query}
        let queryObj;
        try {
          queryObj = typeof query === 'string' ? JSON.parse(query) : query;
        } catch (e) {
          // Not JSON, must be SQL string
          queryObj = { query };
        }

        const result = await window.electronAPI.dbConnect.runQuery(
          connection.dbType,
          connection.dbConfig,
          queryObj,
          connection.id
        );

        if (!result.success) {
          // A transformer/join target table only exists after the node runs.
          // Before that, the preview query fails with "no such table" — show a
          // neutral pre-execution state instead of leaking the raw SQL error.
          const isMissingTable = /no such table|doesn'?t exist|does not exist|not found/i.test(String(result.message || ''));
          const isTargetPreview = query === config.targetPreviewSql;
          if (isMissingTable && isTargetPreview) {
            return pendingExecutionResult();
          }
          message.error('Database query failed: ' + result.message);
          return null;
        }

        // Format database results
        const rows = result.rows || [];
        if (rows.length === 0) {
          return {
            headers: result.columns || [],
            data: [],
            metadata: { rowCount: 0 },
            isJson: result.json || false
          };
        }

        // For MongoDB (JSON data), return raw rows
        if (result.json) {
          return {
            headers: [],
            data: rows,
            metadata: { rowCount: rows.length },
            isJson: true
          };
        }

        // For SQL databases, format as table
        const headers = Object.keys(rows[0]);
        const formattedRows = rows.map(row =>
          headers.map(header => {
            const value = row[header];
            if (value === null || value === undefined || value === 'null') return '';
            return String(value);
          })
        );

        return {
          headers,
          data: formattedRows,
          metadata: { rowCount: formattedRows.length },
          isJson: false
        };
      }

      return null;
    } catch (error) {
      console.error('Error fetching local data:', error);
      message.error('Failed to load local data: ' + error.message);
      return null;
    }
  };

  // Get connected data sources for the selected node
  useEffect(() => {
    if (!selectedNode) {
      setConnectedDataSources([]);
      return;
    }

    const inputEdges = edges.filter(edge => edge.target === selectedNode.id);
    const connectedNodes = inputEdges.map(edge => {
      const sourceNode = nodes.find(node => node.id === edge.source);
      return sourceNode;
    }).filter(Boolean);

    setConnectedDataSources(connectedNodes);
  }, [selectedNode?.id, edges]);

  // Moving to another node (or closing the panel) clears the per-node preview
  // guards, so its data is always fetched fresh rather than being mistaken for
  // a duplicate. The visible table is dropped too: whatever loads next belongs
  // to the new node, and leaving the old rows up meant selecting an unconfigured
  // node — which fetches nothing — kept showing the previous node's data. Both
  // the direct data and the per-source caches (read by the join/transformer
  // render paths) are wiped so no stale rows survive the switch.
  useEffect(() => {
    inFlightFetchKey.current = null;
    previewRequestSeq.current += 1; // orphan any in-flight fetch for the old node
    setPreviewData(null);
    setPreviewDataBySource({});
    setTransformedData(null);
    setTransformedDataBySource({});
    setLoadingPreview(false);
    setLoadingTransformed(false);
    setDbSchema({});
    setActivePreviewTab('0');
    setActiveTransformedTab('0');
  }, [selectedNode?.id]);

  // An API source with no materialised collection has nothing to show, and
  // fetchPreviewData may never even run for it (an unsaved node has no
  // sourceConnectionId to fetch by), so the waiting state is derived here
  // rather than only inside the fetch. Re-evaluates when the chat's fetch
  // lands and sourceLocalPath appears.
  useEffect(() => {
    const cfg = selectedNode?.data?.config;
    setAwaitingApiConfig(!!isApiDataSource && (!cfg?.sourceLocalPath || !cfg?.apiFetchCode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isApiDataSource,
    selectedNode?.data?.config?.sourceLocalPath,
    selectedNode?.data?.config?.apiFetchCode,
  ]);

  useEffect(() => {
    if (dbTables.length > 0){
      setActiveTab('schema');
    }
  }, [dbTables])
  // Fetch preview data when node or connections change (with debounce)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (selectedNode) {
        console.log('activeTab: ', activeTab)

        // Default tab when a node is selected. Transformer/Join lead with the
        // Details tab (their logic lives in config, not a live preview);
        // data sources keep their schema/preview default.
        const apiSource = selectedNode.type === 'dataSource' && (
          selectedNode.data?.config?.sourceDbCategory === 'API' ||
          selectedNode.data?.config?.sourceConnectionType === 'api' ||
          selectedNode.data?.config?.sourceDbType === 'rest-api'
        );
        if (selectedNode.type === 'transformer' || selectedNode.type === 'join') {
          setActiveTab('details');
        } else if (apiSource) {
          // No Schema tab for an API source, and nothing to preview until its
          // fetch has run — the endpoint details are the useful view.
          setActiveTab('details');
        } else if (dbTables.length > 0){
          setActiveTab('schema');
        }else{
          setActiveTab('preview');
        }

        // // Only fetch preview data if we're on preview or schema tab (not transformed)
        // if (activeTab === 'transformed') {
        //   return;
        // }

        // console.log('useEffect: ', selectedNode.type)
        if (selectedNode.type === 'dataSource') {
          // For data sources, use the node's own config
          const config = selectedNode.data?.config;
          // DataSource nodes use sourceConnectionId
          if (config && config.sourceConnectionId) {
            fetchPreviewData(config);
          }
        } else if (selectedNode.type === 'transformer' || selectedNode.type === 'join') {
          // For transformers/joins, ALWAYS show source data in Preview tab
          // The Transformed tab will show the transformed data
          // console.log('connectedDataSources: ', connectedDataSources)
          if (connectedDataSources.length > 0) {
            fetchSourceNodePreview(connectedDataSources[0]);
          }
        } 

      } else {
        setPreviewData(null);
        setPreviewDataBySource({});
        setTransformedData(null);
        setTransformedDataBySource({});
      }
    }, 300); // 300ms debounce

    return () => clearTimeout(timeoutId);
  }, [selectedNode?.id, connectedDataSources]);

  // Helper function to clear cache and refresh data
  const refreshNodeData = useCallback((forceRefresh = false) => {
    if (!selectedNode) return;

    const nodeConfig = selectedNode.data?.config;
    if (!nodeConfig) return;

    // Clear cache helper
    const clearCache = (keysToDelete) => {
      setPreviewDataBySource(prev => {
        const newCache = { ...prev };
        keysToDelete.forEach(key => delete newCache[key]);
        return newCache;
      });
    };
    console.log('refreshNodeData: ', selectedNode.type)
    // Handle different node types
    if (selectedNode.type === 'dataSource') {
      // Data source: clear its own cache (use sourceConnectionId for data sources)
      const connectionId = nodeConfig.sourceConnectionId || nodeConfig.connectionId;
      const sourceIdentifier = nodeConfig.sourceDataset || nodeConfig.dataset || nodeConfig.table || '';
      const cacheKey = connectionId + sourceIdentifier;
      clearCache([cacheKey]);

      if (forceRefresh || activeTab === 'preview') {
        fetchPreviewData(nodeConfig);
      }
    }
    else if (selectedNode.type === 'transformer' || selectedNode.type === 'join') {
      // Transformer/Join: clear transformed cache using target connection name
      const transformedCacheKey = selectedNode.id + (nodeConfig.targetConnectionName || '');
      clearCache([transformedCacheKey]);
      setTransformedData(null);

      // Refetch source data for preview tab
      if (connectedDataSources.length > 0) {
        const sourceNode = connectedDataSources[0];
        const sourceConfig = sourceNode.data?.config;

        if (sourceConfig) {
          const sourceConnectionId = sourceConfig.sourceConnectionId || sourceConfig.connectionId;
          const sourceIdentifier = sourceConfig.sourceDataset || sourceConfig.dataset || sourceConfig.table || '';
          const sourceCacheKey = sourceConnectionId + sourceIdentifier;
          clearCache([sourceCacheKey]);

          if (forceRefresh || activeTab === 'preview') {
            fetchSourceNodePreview(sourceNode);
          }
        }
      }

      // Always refetch transformed data after execution so the cached
      // transformed tab reflects the new output, even if the user is
      // currently viewing a different tab.
      if (forceRefresh && isTransformedTabEnabled()) {
        fetchTransformedData();
      }
    }
    else {
      // Other nodes: clear connected sources cache
      if (connectedDataSources.length > 0) {
        const keysToDelete = connectedDataSources.map(source => {
          const config = source.data?.config;
          const connectionId = config?.sourceConnectionId || config?.connectionId;
          const sourceIdentifier = config?.sourceDataset || config?.dataset || config?.table || '';
          return connectionId + sourceIdentifier;
        });
        clearCache(keysToDelete);

        if (forceRefresh || activeTab === 'preview') {
          fetchSourceNodePreview(connectedDataSources[0]);
        }
      }
    }
  }, [selectedNode, connectedDataSources, activeTab]);

  // Refresh when config changes (save/update)
  useEffect(() => {
    refreshNodeData(true); // Don't force refetch, only clear cache
  }, [
    selectedNode?.data?.config?.sourceConnectionId,
    selectedNode?.data?.config?.targetConnectionId,
    selectedNode?.data?.config?.sourcePreviewSql,
    selectedNode?.data?.config?.targetPreviewSql,
    selectedNode?.data?.config?.sourceLocalPath,
    selectedNode?.data?.config?.targetLocalPath,
  ]);

  // Refresh when execution completes
  useEffect(() => {
    if (refreshTrigger > 0) {
      console.log('refreshTrigger: ', refreshTrigger)
      // The config descriptor is unchanged but the DATA moved, so drop the
      // de-dupe guard and let the query run again.
      inFlightFetchKey.current = null;
      refreshNodeData(true); // Force refetch
    }
  }, [refreshTrigger, refreshNodeData]);

  const fetchPreviewData = async (config) => {
    console.log('fetchPreviewData: ', config)
    if (!selectedNode || !config) return;

    // For data source nodes, we don't need connected sources
    if (selectedNode.type === 'dataSource') {
      // Continue with fetch
    } else if (connectedDataSources.length === 0) {
      // For non-data source nodes, we need connected sources
      return;
    }

    // Get the connection ID - use source prefix for data sources
    const connectionId = config.targetConnectionId || config.sourceConnectionId || config.connectionId;

    if (!config || !connectionId) {
      // message.warning('Data source not configured');
      return;
    }

    // A REST API source has no data until its fetch function has been written
    // (in the chat) and run. Reading the NeDB collection before that hits an
    // empty / not-yet-materialised file and reports it as corrupt, so wait.
    // Both conditions matter: no fetch function means nothing was ever written,
    // and a stale sourceLocalPath can point at another node's file.
    const isApiSource = config.sourceDbCategory === 'API' || config.sourceConnectionType === 'api';
    if (isApiSource && (!config.sourceLocalPath || !config.apiFetchCode)) {
      setPreviewData(null);
      setLoadingPreview(false);
      setAwaitingApiConfig(true);
      return;
    }
    setAwaitingApiConfig(false);

    // Collapse the duplicate fetches the two config-watching effects above
    // would otherwise fire for a single selection change.
    const fetchKey = JSON.stringify([
      connectionId,
      config.sourceDbType || config.targetDbType,
      config.sourceTableName || config.targetTableName,
      config.sourceCollection || config.targetCollection,
      config.sourceIndexName,
      config.sourcePreviewSql || config.targetPreviewSql,
      config.sourceLocalPath || config.targetLocalPath,
    ]);
    if (inFlightFetchKey.current === fetchKey) return;
    inFlightFetchKey.current = fetchKey;

    // Sequence number for this request. A slow query for the table the user has
    // since navigated away from must not paint over the one they picked next,
    // so a result is only applied if it is still the newest request.
    const requestId = ++previewRequestSeq.current;
    const isStale = () => requestId !== previewRequestSeq.current;

    setLoadingPreview(true);

    // Check if user is logged in - if not, use local data fetching
    // if (!isLoggedIn()) {
      try {
        let connection;

        // Check if this is a local storage placeholder ID (local-duckdb)
        const isLocalPlaceholder = connectionId?.startsWith('local-');

        if (isLocalPlaceholder) {
          // Create a synthetic connection object for local storage
          const dbType = config.sourceDbType || config.targetDbType;
          const localPath = config.sourceLocalPath || config.targetLocalPath;

          connection = {
            id: connectionId,
            name: config.sourceConnectionName || config.targetConnectionName || 'Local Storage',
            connectionType: 'file',
            dbType: dbType,
            dbConfig: config.sourceDbConfig || config.targetDbConfig || {},
            fileInfo: {
              filePath: localPath
            }
          };
        } else {
          // Fetch real connection from local database
          const { connectionsDb } = await import('../../utils/localDb');
          connection = await connectionsDb.getById(connectionId);

          if (!connection) {
            if (isStale()) return;
            message.error('Connection not found');
            setLoadingPreview(false);
            return;
          }
        }

        // Fetch local data
        const localData = await fetchLocalData(config, connection);

        // The user moved on while this was in flight — cache the result under
        // its own key but leave the visible table alone.
        const connectionSourceIdentifier = config?.targetTableName || config?.sourceTableName || config?.targetCollection || config.sourceCollection;
        if (localData) {
          setPreviewDataBySource(prev => ({
            ...prev,
            [connectionId + connectionSourceIdentifier]: localData
          }));
          if (!isStale()) setPreviewData(localData);
        }

        if (!isStale()) setLoadingPreview(false);
        return;
      } catch (error) {
        console.error('Error fetching local data:', error);
        if (isStale()) return;
        message.error('Failed to load local data');
        setLoadingPreview(false);
        return;
      }
    // }

    // User is logged in - use API
    // try {
    //   console.log("selectedNode: ", config)

    //   const connectionSourceIdentifier = config?.targetTableName || config?.sourceTableName || config?.targetCollection || config.sourceCollection;
    //   const response = await axios.post('/workflow/sample-data', {
    //     connectionId: connectionId,
    //     sourceIdentifier: connectionSourceIdentifier,
    //     limit: 1000 // Limit for preview
    //   }, {
    //     headers: {
    //       'auth-token': localStorage.getItem('auth-token')
    //     }
    //   });

    //   if (response.data.success) {
    //     // Convert sample data format to preview data format
    //     const sampleData = response.data.data;
    //     const headers = sampleData.columnMappings?.map(col => col.name) || [];
    //     const rows = sampleData.sampleRows?.map(row =>
    //       headers.map(header => {
    //         const value = row.data[header];
    //         // Handle null, undefined, and string 'null' values
    //         if (value === null || value === undefined || value === 'null' || value === 'true') {
    //           return '';
    //         }
    //         return String(value);
    //       })
    //     ) || [];

    //     const formattedData = {
    //       headers: headers,
    //       data: rows,
    //       metadata: sampleData.metadata
    //     };
    //     setPreviewDataBySource(prev => ({
    //       ...prev,
    //       [connectionId + connectionSourceIdentifier]: formattedData
    //     }));
    //     setPreviewData(formattedData);

    //   } else {
    //     message.error('Failed to load preview data');
    //   }
    // } catch (error) {
    //   if (handleAuthError(error)) return;
    //   console.error('Error fetching preview data:', error);
    //   message.error('Failed to load preview data');
    // } finally {
    //   setLoadingPreview(false);
    // }
  };

  // Cache key for one source's preview rows. Mirrors the key the join tabs read
  // in renderDataSourceTabs — the two have to agree or the tab shows nothing.
  const previewCacheKey = (config) => {
    const connectionId = config?.targetConnectionId || config?.sourceConnectionId || config?.connectionId;
    const identifier = config?.targetTableName || config?.sourceTableName ||
                       config?.targetCollection || config?.sourceCollection ||
                       config?.sourceDataset || config?.dataset || config?.table;
    return connectionId ? connectionId + identifier : null;
  };

  /**
   * Preview an UPSTREAM node's output.
   *
   * What a transformer/join/output shows in its Preview tab is its parent's
   * output, so this reads the parent's config — and when that parent is itself a
   * transformer or a join, the table it reads is the one the parent WRITES.
   * That table exists only after the parent has run, which is what
   * `config.executed` records. Without this check the preview queries it anyway
   * and a freshly built workflow greets the user with "Table
   * 'db.some_table' doesn't exist" when nothing is actually wrong — it just
   * hasn't been executed yet.
   */
  const fetchSourceNodePreview = (sourceNode) => {
    const sourceConfig = sourceNode?.data?.config;
    if (!sourceConfig) return;

    if (awaitsExecution(sourceNode)) {
      const pending = pendingExecutionResult();
      setPreviewData(pending);
      setLoadingPreview(false);
      // Cached under the same key a fetch would have used, so the join tabs
      // (which render from the cache) show the state too.
      const cacheKey = previewCacheKey(sourceConfig);
      if (cacheKey) setPreviewDataBySource(prev => ({ ...prev, [cacheKey]: pending }));
      return;
    }

    fetchPreviewData(sourceConfig);
  };

  // Handle tab change in preview section
  const handlePreviewTabChange = (tabKey) => {
    console.log('handlePreviewTabChange: ', tabKey)
    setActivePreviewTab(tabKey);
    const sourceIndex = parseInt(tabKey);

    // Get the source config and create cache key
    const sourceToFetch = connectedDataSources[sourceIndex];
    const config = sourceToFetch?.data?.config;

    if (!config) return;

    const connectionId = config?.targetConnectionId || config?.sourceConnectionId || config?.connectionId;
    const connectionSourceIdentifier = config?.targetTableName || config?.sourceTableName ||
                                       config?.targetCollection || config?.sourceCollection ||
                                       config?.sourceDataset || config?.dataset || config?.table;
    const cacheKey = connectionId + connectionSourceIdentifier;
    // Check if data for this source is already loaded
    if (!previewDataBySource[cacheKey]) {
      // Data not cached, fetch it — unless this source hasn't run yet, in which
      // case there is no table behind the config to fetch from.
      fetchSourceNodePreview(sourceToFetch);
    } else {
      // Data is cached, update previewData to show it
      setPreviewData(previewDataBySource[cacheKey]);
    }
  };




  // Resize functionality
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    isDragging.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!isDragging.current) return;
    
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const newHeight = window.innerHeight - e.clientY;
    
    // Constrain height between 200px and 80% of window height
    const minHeight = 200;
    const maxHeight = window.innerHeight * 0.8;
    const constrainedHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));
    
    setHeight(constrainedHeight);
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  const toggleExpanded = () => {
    if (isExpanded) {
      setHeight(300);
    } else {
      setHeight(window.innerHeight * 0.7);
    }
    setIsExpanded(!isExpanded);
  };

  // Render data table
  const renderDataTable = (data, loading) => {
    if (loading) {
      return (
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <Spin size="large" />
          <div style={{ marginTop: '16px' }}>Loading data...</div>
        </div>
      );
    }

    // A REST API source is configured in two steps: pick the connection in the
    // form, then describe the request in the chat. Between those there is
    // genuinely nothing to read yet.
    if (awaitingApiConfig) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Describe the request in the chat to configure this API source. Its data appears here once the fetch has run."
        />
      );
    }

    if (!data || !data.data) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No data available"
        />
      );
    }

    // Transformer/join output that hasn't been materialized yet — the target
    // table only exists after the node runs. Show a neutral pre-execution
    // state instead of a raw "no such table" SQL error (TLX-007).
    if (data.pendingExecution) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Preview available after this node runs. Execute the workflow to generate its output."
        />
      );
    }

    // Render JSON view for MongoDB data
    if (data.isJson) {
      return (
        <div style={{ height: height - 120, backgroundColor: '#fff' }}>
          <Editor
            height="100%"
            language="json"
            value={JSON.stringify(data.data, null, 2)}
            beforeMount={(monaco) => {
              monaco.editor.defineTheme('ternlux-light', {
                base: 'vs',
                inherit: true,
                rules: [],
                colors: {
                  'editor.background': '#ffffff',
                  'editor.foreground': '#111827',
                  'editorLineNumber.foreground': '#9ca3af',
                  'editorLineNumber.activeForeground': '#5a6678',
                  'editor.selectionBackground': '#dbeafe',
                  'editor.inactiveSelectionBackground': '#eef1f6',
                  'editor.lineHighlightBackground': '#f7f9fc',
                  'editorCursor.foreground': '#2563eb',
                  'editorIndentGuide.background': '#eef1f6',
                  'editorIndentGuide.activeBackground': '#cdd2db',
                  'editorWhitespace.foreground': '#e2e6eb',
                  'editorWidget.background': '#ffffff',
                  'editorWidget.border': '#e2e6eb',
                  'editorGutter.background': '#ffffff',
                  'scrollbarSlider.background': '#e2e6eb88',
                  'scrollbarSlider.hoverBackground': '#cdd2dbcc',
                  'scrollbarSlider.activeBackground': '#5a667888',
                  'minimap.background': '#f7f9fc',
                },
              });
            }}
            theme="ternlux-light"
            options={{
              readOnly: true,
              minimap: { enabled: true },
              fontSize: 13,
              fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              tabSize: 2,
              renderWhitespace: 'selection',
              padding: { top: 12, bottom: 12 },
            }}
          />
        </div>
      );
    }

    // Render table view for SQL data
    if (!data.headers || data.headers.length === 0) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No data available"
        />
      );
    }

    const columns = data.headers.map((header, index) => ({
      title: header,
      dataIndex: index.toString(),
      key: index.toString(),
      ellipsis: true,
      width: 150,
      align: 'left'
    }));

    const dataSource = data.data.map((row, index) => {
      const record = { key: index };
      row.forEach((cell, cellIndex) => {
        record[cellIndex.toString()] = cell;
      });
      return record;
    });

    return (
      <Table
        columns={columns}
        dataSource={dataSource}
        size="small"
        scroll={{ x: true, y: height - 120 }}
        locale={{
          emptyText: dataSource.length === 0 && columns.length > 0
            ? 'Table is empty (no rows)'
            : 'No data available'
        }}
        pagination={{
          pageSize: 50,
          showSizeChanger: false,
          showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} rows`
        }}
      />
    );
  };

  // Render tabs for multiple data sources (joins) or single data table
  const renderDataSourceTabs = () => {
    // console.log('previewData: ', previewData)
    // For data source nodes, just show the single data table
    if (selectedNode?.type === 'dataSource') {
      return renderDataTable(previewData, loadingPreview);
    }

    // For joins with multiple connected sources, show tabs
    if (selectedNode?.type === 'join' && connectedDataSources.length > 1) {
      const tabNames = connectedDataSources.map((e) => {
        const config = e.data.config
        let name = config.node_name || config.sourceConnectionName || config.connectionName || 'Source'

        // Show table/collection name - same logic as cache key
        const tableIdentifier = config.targetTableName || config.sourceTableName ||
                                config.targetCollection || config.sourceCollection ||
                                config.sourceDataset || config.dataset;

        if(tableIdentifier){
          name +=  ` - ${tableIdentifier}`
        }
        return name
      })

      return (
        <Tabs
          size="small"
          activeKey={activePreviewTab}
          onChange={handlePreviewTabChange}
        >
          {tabNames.map((source, index) => {
            // Create cache key for this source (must match the key in handlePreviewTabChange)
            const sourceConfig = connectedDataSources[index]?.data?.config;
            const connectionId = sourceConfig?.targetConnectionId || sourceConfig?.sourceConnectionId || sourceConfig?.connectionId;
            const connectionSourceIdentifier = sourceConfig?.targetTableName || sourceConfig?.sourceTableName ||
                                               sourceConfig?.targetCollection || sourceConfig?.sourceCollection ||
                                               sourceConfig?.sourceDataset || sourceConfig?.dataset || sourceConfig?.table;
            const cacheKey = connectionId + connectionSourceIdentifier;
            const sourceData = previewDataBySource[cacheKey];
            const isLoadingThisSource = loadingPreview && activePreviewTab === index.toString();

            return (
              <TabPane
                tab={source}
                key={index.toString()}
              >
                {renderDataTable(sourceData, isLoadingThisSource)}
              </TabPane>
            );
          })}
        </Tabs>
      );
    }

    // For transformers or single-source scenarios
    return renderDataTable(previewData, loadingPreview);
  };


  // Check if transformed tab should be enabled
  const isTransformedTabEnabled = () => {
    const nodeConfig = selectedNode?.data?.config;
    // console.log('selectedNode: ', selectedNode, nodeConfig)

    // For transformer/join nodes, check if they have executed transformation
    // Use target* prefixes since transformed data is the output
    if (selectedNode?.type === 'transformer' || selectedNode?.type === 'join') {
      // For vector databases, check dbType and connectionId instead of SQL
      const isVectorDb = nodeConfig?.targetDbType === 'lancedb' ||
                         nodeConfig?.targetDbType === 'pinecone';

      if (isVectorDb) {
        return nodeConfig?.targetConnectionId && nodeConfig?.targetTableName;
      }

      // For SQL/NoSQL databases, check for SQL and connectionId
      return nodeConfig?.targetPreviewSql && nodeConfig?.targetConnectionId;
    }

    // For other nodes, use the old logic
    return nodeConfig?.connectionName || nodeConfig?.isProcessed;
  };

  const changeTab = (tabName) => {
    console.log('tabName: ', tabName)
    setActiveTab(tabName)

    if(tabName === 'transformed' && isTransformedTabEnabled()){
      // Check if transformed data is already cached
      const nodeConfig = selectedNode?.data?.config;
      // Use target connection name for transformed data cache key
      const cacheKey = selectedNode.id + (nodeConfig?.targetConnectionName || '');

      if (!previewDataBySource[cacheKey]) {
        // Fetch transformed data using node's target configuration
        fetchTransformedData();
      } else {
        // Use cached transformed data
        setTransformedData(previewDataBySource[cacheKey]);
      }
    }
  }

  const fetchTransformedData = async () => {
    if (!selectedNode) return;

    // The transformed rows ARE this node's output table. Configured is not the
    // same as created: until the node has run there is nothing to select from,
    // so show the pre-execution state rather than querying a table that the
    // engine will (correctly) say does not exist.
    if (awaitsExecution(selectedNode)) {
      setTransformedData(pendingExecutionResult());
      setLoadingTransformed(false);
      return;
    }

    // Check if node is saved/processed
    const nodeConfig = selectedNode?.data?.config;

    // Check if vector database
    const isVectorDb = nodeConfig?.targetDbType === 'lancedb' ||
                       nodeConfig?.targetDbType === 'pinecone';

    // Use target* prefixes for transformed data (output of transformation)
    // For vector databases, only check targetConnectionId (no SQL needed)
    // For SQL/NoSQL databases, check both targetPreviewSql and targetConnectionId
    if (!nodeConfig?.targetConnectionId || (!isVectorDb && !nodeConfig?.targetPreviewSql)) {
      message.warning('Node must be executed first to see transformed data');
      return;
    }
    console.log('fetchTransformedData:', nodeConfig);
    setLoadingTransformed(true);

    try {
      // Use local data fetching for transformed data
      // if (!isLoggedIn()) {
        let connection;

        // Check if this is a local storage placeholder ID (local-duckdb)
        const isLocalPlaceholder = nodeConfig.targetConnectionId?.startsWith('local-');

        if (isLocalPlaceholder) {
          // Create a synthetic connection object for local storage
          connection = {
            id: nodeConfig.targetConnectionId,
            name: nodeConfig.targetConnectionName || 'Local Storage',
            connectionType: 'file',
            dbType: nodeConfig.targetDbType,
            dbConfig: nodeConfig.targetDbConfig || {},
            fileInfo: {
              filePath: nodeConfig.targetLocalPath
            }
          };
        } else {
          // Fetch real connection from local database
          const { connectionsDb } = await import('../../utils/localDb');
          connection = await connectionsDb.getById(nodeConfig.targetConnectionId);

          if (!connection) {
            message.error('Connection not found');
            setLoadingTransformed(false);
            return;
          }
        }

        // console.log("connection: ", connection)
        // Create a config object with target* values for fetching transformed data
        const transformedConfig = {
          sourceDbType: nodeConfig.targetDbType,
          sourceLocalPath: nodeConfig.targetLocalPath,
          sourcePreviewSql: nodeConfig.targetPreviewSql,
          sourceTableName: nodeConfig.targetTableName,
          sourceCollection: nodeConfig.targetCollection,
          sourceConnectionId: nodeConfig.targetConnectionId,
          sourceIndexName: nodeConfig.targetIndexName
        };

        // Fetch local data using the transformed table's configuration
        const localData = await fetchLocalData(transformedConfig, connection);

        if (localData) {
          const cacheKey = selectedNode.id + (nodeConfig?.targetConnectionName || '');
          setPreviewDataBySource(prev => ({
            ...prev,
            [cacheKey]: localData
          }));
          setTransformedData(localData);
        }
      // } else {
      //   // For logged-in users, query the database directly
      //   const response = await axios.post('/workflow/sample-data', {
      //     connectionId: nodeConfig.targetConnectionId,
      //     query: nodeConfig.targetPreviewSql, // Use the targetPreviewSql to query the transformed table
      //     limit: 1000
      //   }, {
      //     headers: {
      //       'auth-token': localStorage.getItem('auth-token')
      //     }
      //   });

      //   if (response.data.success) {
      //     const sampleData = response.data.data;
      //     const headers = sampleData.columnMappings?.map(col => col.name) || [];
      //     const rows = sampleData.sampleRows?.map(row =>
      //       headers.map(header => {
      //         const value = row.data[header];
      //         // Handle null, undefined, and string 'null' values
      //         if (value === null || value === undefined || value === 'null' || value === 'true') {
      //           return '';
      //         }
      //         return String(value);
      //       })
      //     ) || [];

      //     const formattedData = {
      //       headers: headers,
      //       data: rows,
      //       metadata: sampleData.metadata
      //     };

      //     // Cache the transformed data using target connection name
      //     const cacheKey = selectedNode.id + (nodeConfig?.targetConnectionName || '');
      //     setPreviewDataBySource(prev => ({
      //       ...prev,
      //       [cacheKey]: formattedData
      //     }));

      //     setTransformedData(formattedData);
      //   } else {
      //     message.error('Failed to load transformed data');
      //   }
      // }
    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Error fetching transformed data:', error);
      message.error('Failed to load transformed data');
    } finally {
      setLoadingTransformed(false);
    }
  };

  // Initialize schema state when dbTables changes
  useEffect(() => {
    if (dbTables && dbTables.length > 0) {
      const init = {};
      // console.log('dbTables: ', dbTables)
      dbTables.forEach(table => {
        const tableName = typeof table === 'string' ? table : table.name;
        const tableSchema = typeof table === 'string' ? null : table.schema;

        init[tableName] = {
          columns: null,
          loading: false,
          expanded: false,
          tableSchema: tableSchema
        };
      });
      setDbSchema(init);

      // Auto-switch to schema tab when schema is loaded and no SQL query exists yet
      if (selectedNode?.type === 'dataSource' &&
          selectedNode?.data?.config?.connectionType === 'database' &&
          !selectedNode?.data?.config?.sql) {
        setActiveTab('schema');
      }
    } else {
      // No tables — the node is unconfigured or the panel was closed (the parent
      // wipes dbTables in both cases). Drop the previous node's schema so the
      // Schema tab doesn't keep showing stale columns.
      setDbSchema({});
    }
  }, [dbTables, selectedNode]);

  const loadTableSchema = async (tableName) => {
    // Use activeConnection if available (during configuration), otherwise fall back to saved config
    const connection = activeConnection || selectedNode?.data?.config;

    if (!connection) {
      console.error('Missing connection');
      return;
    }

    // Check if columns already loaded
    if (dbSchema[tableName]?.columns) {
      return;
    }

    setDbSchema(prev => ({
      ...prev,
      [tableName]: { ...prev[tableName], loading: true }
    }));

    try {
      // Handle file-based connections (local SQLite/NeDB)
      if (connection.connectionType === 'file') {
        const localPath = connection.fileInfo?.filePath || connection.localPath;

        if (!localPath || !window.electronAPI?.db?.readLocalCollection) {
          console.error('Missing local path or local DB API');
          setDbSchema(prev => ({
            ...prev,
            [tableName]: { ...prev[tableName], columns: [], loading: false }
          }));
          return;
        }

        if (connection.dbType === 'duckdb') {
          // DuckDB reports column types with the rows, so one read is enough.
          const result = await window.electronAPI.db.readLocalCollection(
            localPath,
            1,
            'duckdb',
            null,
            tableName
          );

          const columns = (result.columns || []).map(({ name, type }) => ({
            name,
            type: type || 'unknown',
            nullable: true,
            isPrimary: false
          }));

          setDbSchema(prev => ({
            ...prev,
            [tableName]: { ...prev[tableName], columns, loading: false }
          }));
        } else if (connection.dbType === 'sqlite') {
          // For SQLite, use PRAGMA table_info to get column information
          const pragmaQuery = `PRAGMA table_info("${tableName}")`;
          const result = await window.electronAPI.db.readLocalCollection(
            localPath,
            1000,
            'sqlite',
            pragmaQuery,
            tableName
          );

          if (result.success && result.rows) {
            // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
            const columns = result.rows.map(row => ({
              name: row.name,
              type: row.type || 'TEXT',
              nullable: row.notnull === 0,
              isPrimary: row.pk === 1
            }));

            setDbSchema(prev => ({
              ...prev,
              [tableName]: {
                ...prev[tableName],
                columns: columns,
                loading: false
              }
            }));
          } 
        } else if (connection.dbType === 'nedb') {
          // For NeDB, infer columns from sample data
          const result = await window.electronAPI.db.readLocalCollection(
            localPath,
            1,
            'nedb',
            null,
            null
          );

          if (result.success && result.rows && result.rows.length > 0) {
            const columns = Object.keys(result.rows[0]).map(name => ({
              name,
              type: 'unknown',
              nullable: true,
              isPrimary: name === '_id'
            }));

            setDbSchema(prev => ({
              ...prev,
              [tableName]: {
                ...prev[tableName],
                columns: columns,
                loading: false
              }
            }));
          } else {
            setDbSchema(prev => ({
              ...prev,
              [tableName]: { ...prev[tableName], columns: [], loading: false }
            }));
          }
        }
        return;
      }

      // Handle database connections (remote databases)
      if (!window.electronAPI?.dbConnect) {
        console.error('Database API not available');
        setDbSchema(prev => ({
          ...prev,
          [tableName]: { ...prev[tableName], columns: [], loading: false }
        }));
        return;
      }

      const tableInfo = dbSchema[tableName] || {};
      console.log('Loading columns for:', tableName, 'schema:', tableInfo.tableSchema);
      console.log('connection: ', connection)

      // Use dbType and dbConfig from the active connection, and schema from table info
      const result = await window.electronAPI.dbConnect.getColumns(
        connection.dbType,
        connection.dbConfig,
        tableInfo.tableSchema,
        tableName,
        connection.id
      );

      console.log('Column result for', tableName, ':', result);

      setDbSchema(prev => ({
        ...prev,
        [tableName]: {
          ...prev[tableName],
          columns: result.success ? result.columns : [],
          loading: false
        }
      }));
    } catch (err) {
      console.error(`Failed to load schema for ${tableName}:`, err);
      message.error(`Failed to load columns for ${tableName}`);
      setDbSchema(prev => ({
        ...prev,
        [tableName]: { ...prev[tableName], columns: [], loading: false }
      }));
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Details tab — all node configuration in one place. Reads the same
  // node.data.config that each NodeChat's buildConfig() persists. Purely a
  // read-only view; other tabs (Preview/Schema/Transformed) are unchanged.
  // ─────────────────────────────────────────────────────────────────────────
  const renderNodeDetails = () => {
    if (!selectedNode) {
      return (
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Select a node to view its details" />
        </div>
      );
    }
    const type = selectedNode.type;
    const config = selectedNode.data?.config || {};
    const label = nodeDisplayName(type, selectedNode.data, type);

    const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const TYPE_LABEL = { start: 'Start', dataSource: 'Data Source', transformer: 'Transformer', join: 'Join', output: 'Output', branch: 'Branch' };

    // Is a chat-built node (transformer/join) actually configured?
    const isConfigured = (() => {
      if (type === 'transformer') {
        return (config.usesSkill && config.skillId) || nonEmpty(config.targetSql) ||
          nonEmpty(config.targetInsertSql) || nonEmpty(config.nosqlOperation) ||
          nonEmpty(config.transformFunction);
      }
      if (type === 'join') {
        return nonEmpty(config.joinSql) || nonEmpty(config.targetSql) ||
          nonEmpty(config.transformFunction) || nonEmpty(config.aggregationPipeline);
      }
      return Object.keys(config).length > 0;
    })();

    // Build the [label, value] rows per node type, grouped into Source /
    // Target / General buckets. Source and Target render inside collapsible
    // panels (collapsed by default); General rows render flat.
    const sourceRows = [];
    const targetRows = [];
    const pushTo = (bucket, k, v) => { if (nonEmpty(v)) bucket.push([k, String(v)]); };

    if (type === 'transformer') {
      pushTo(sourceRows, 'Source', config.sourceConnectionName);
      pushTo(sourceRows, 'Source type', [config.sourceConnectionType, config.sourceDbType].filter(nonEmpty).join(' · '));
      pushTo(sourceRows, 'Source table', config.sourceTableName || config.sourceCollection);
      pushTo(targetRows, 'Target', config.targetConnectionName);
      pushTo(targetRows, 'Target type', [config.targetConnectionType, config.targetDbType].filter(nonEmpty).join(' · '));
      pushTo(targetRows, 'Target table', config.targetTableName || config.targetCollection);
      pushTo(targetRows, 'Operation mode', config.transformationSettings?.operationMode);
      pushTo(targetRows, 'Storage', config.transformationSettings?.storageLocation);
      if (config.usesSkill) pushTo(targetRows, 'Skill', config.skillId);
    } else if (type === 'join') {
      const srcNames = Array.isArray(config.sources)
        ? config.sources.map((s) => s.sourceConnectionName || s.sourceNodeLabel || s.sourceTableName).filter(nonEmpty).join(', ')
        : '';
      pushTo(sourceRows, 'Sources', srcNames);
      const cols = Array.isArray(config.joinColumns)
        ? config.joinColumns.map((c) => (typeof c === 'string' ? c : (c.left && c.right ? `${c.left} = ${c.right}` : JSON.stringify(c)))).join(', ')
        : '';
      pushTo(sourceRows, 'Join columns', cols);
      pushTo(targetRows, 'Target', config.targetConnectionName);
      pushTo(targetRows, 'Target table', config.targetTableName || config.targetCollection);
      pushTo(targetRows, 'Operation mode', config.joinSettings?.operationMode);
      pushTo(targetRows, 'Storage', config.joinSettings?.storageLocation);
    } else if (type === 'dataSource' && isApiDataSource) {
      // A REST API source has no table or schema to describe — what matters is
      // which endpoint it calls and how it authenticates. Credentials live
      // encrypted on the connection and are never surfaced here, only their
      // presence.
      const api = config.apiConnectionPublicConfig || {};
      const authType = api.authType && api.authType !== 'none' ? api.authType : null;
      const paramKeys = Array.isArray(api.apiParamKeys) ? api.apiParamKeys : [];
      pushTo(sourceRows, 'Connection', config.sourceApiConnectionName || config.sourceConnectionName);
      pushTo(sourceRows, 'Type', 'REST API');
      pushTo(sourceRows, 'Base URL', api.baseUrl);
      // Key names only — values stay encrypted on the connection.
      if (paramKeys.length > 0) {
        pushTo(sourceRows, 'Parameters', `${paramKeys.join(', ')} · values stored encrypted on the connection`);
      } else {
        pushTo(sourceRows, 'Auth', authType ? `${authType} · credentials stored on the connection` : 'None');
      }
      if (nonEmpty(api.apiKeyName)) pushTo(sourceRows, 'API key header', api.apiKeyName);
      if (nonEmpty(api.basicUser)) pushTo(sourceRows, 'Basic auth user', api.basicUser);
      pushTo(sourceRows, 'Request', config.apiFetchPrompt);
      pushTo(sourceRows, 'Cached into', config.sourceCollection);
      pushTo(sourceRows, 'Local path', config.sourceLocalPath);
      if (!nonEmpty(config.apiFetchCode)) {
        pushTo(sourceRows, 'Status', 'Not configured yet — describe the request in the chat');
      }
    } else if (type === 'dataSource') {
      pushTo(sourceRows, 'Connection', config.sourceConnectionName || config.connectionName);
      pushTo(sourceRows, 'Type', [config.sourceConnectionType || config.connectionType, config.sourceDbType || config.dbType].filter(nonEmpty).join(' · '));
      pushTo(sourceRows, 'Table', config.sourceTableName || config.sourceCollection || config.sourceIndexName);
      pushTo(sourceRows, 'Local path', config.sourceLocalPath);
    } else if (type === 'output') {
      pushTo(targetRows, 'Destination', config.targetConnectionName || config.outputType || config.destinationType);
      pushTo(targetRows, 'Format', config.outputFormat || config.format);
      pushTo(targetRows, 'Target table', config.targetTableName);
      pushTo(targetRows, 'Local path', config.targetLocalPath);
    } else if (type === 'start') {
      pushTo(targetRows, 'Trigger', config.triggerType || 'manual');
    }

    const totalRows = sourceRows.length + targetRows.length;

    // Chat transcript that built this node (persisted as config.chat). Shown
    // in a collapsible dropdown in place of the raw "request to build" input.
    const chatMessages = Array.isArray(config.chat)
      ? config.chat.filter((m) => nonEmpty(m?.text))
      : [];

    // The AI's explanation of what this node does. Chat-built SQL/NoSQL nodes
    // store it as targetSqlExplanation; NoSQL joins and skill executors
    // (python / javascript / vector-db) don't set that field and instead
    // carry a descriptive request string — fall back through those so the
    // explanation section is never empty when a description exists.
    const explanation = config.targetSqlExplanation || config.sqlExplanation ||
      config.explanation || config.transformationRequest || config.joinRequest ||
      config.joinDescription || '';

    // Code blocks (SQL / DDL / functions) present on this node.
    const codeBlocks = [];
    const addCode = (title, code, lang) => { if (nonEmpty(code)) codeBlocks.push({ title, code: String(code), lang }); };
    addCode('Generated SQL', config.targetSql || config.joinSql, 'sql');
    addCode('DDL (CREATE TABLE)', config.targetDdl, 'sql');
    addCode('Insert SQL', config.targetInsertSql, 'sql');
    addCode('Source SQL', config.sourceSql || config.sourcePreviewSql, 'sql');
    addCode('JavaScript function', config.transformFunction || config.apiFetchCode, 'javascript');
    if (config.nosqlOperation) addCode('NoSQL operation', typeof config.nosqlOperation === 'string' ? config.nosqlOperation : JSON.stringify(config.nosqlOperation, null, 2), 'json');
    if (config.aggregationPipeline) addCode('Aggregation pipeline', typeof config.aggregationPipeline === 'string' ? config.aggregationPipeline : JSON.stringify(config.aggregationPipeline, null, 2), 'json');

    const rowStyle = { display: 'grid', gridTemplateColumns: '128px 1fr', gap: '2px 12px', padding: '6px 0', borderBottom: '1px solid #f0f2f5' };
    const preStyle = {
      margin: 0, padding: '10px 12px', borderRadius: 6, overflow: 'auto',
      background: '#f7f9fc', border: '1px solid #e2e6eb',
      fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace", fontSize: 11.5, lineHeight: 1.55,
      color: '#111827', whiteSpace: 'pre',
    };
    const groupHeaderStyle = { fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#5a6678' };
    const descBoxStyle = { fontSize: 12, color: '#5a6678', background: '#f7f9fc', border: '1px solid #e2e6eb', borderLeft: '2px solid #2563eb', borderRadius: 6, padding: '9px 11px' };

    // Render a group of [label, value] rows.
    const renderRows = (rowList) => (
      <div>
        {rowList.map(([k, v], i) => (
          <div key={i} style={rowStyle}>
            <Text type="secondary" style={{ fontSize: 12 }}>{k}</Text>
            <Text style={{ fontSize: 12, wordBreak: 'break-word' }}>{v}</Text>
          </div>
        ))}
      </div>
    );

    // JSON blocks render in a Monaco editor for clean, formatted output;
    // SQL / JS stay as a lightweight <pre>.
    const defineCodeTheme = (monaco) => {
      monaco.editor.defineTheme('ternlux-code', {
        base: 'vs', inherit: true, rules: [],
        colors: {
          'editor.background': '#f7f9fc',
          'editorLineNumber.foreground': '#c2c9d4',
          'editorLineNumber.activeForeground': '#5a6678',
          'editorIndentGuide.background': '#e6eaf0',
          'editorGutter.background': '#f7f9fc',
        },
      });
    };
    const renderCode = (b) => {
      if (b.lang === 'json') {
        const editorHeight = Math.min(340, Math.max(96, b.code.split('\n').length * 18 + 20));
        return (
          <div style={{ border: '1px solid #e2e6eb', borderRadius: 6, overflow: 'hidden' }}>
            <Editor
              height={editorHeight}
              language="json"
              value={b.code}
              beforeMount={defineCodeTheme}
              theme="ternlux-code"
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace",
                lineNumbers: 'off',
                folding: false,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: 'on',
                tabSize: 2,
                renderLineHighlight: 'none',
                overviewRulerLanes: 0,
                scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                padding: { top: 8, bottom: 8 },
              }}
            />
          </div>
        );
      }
      return <pre style={preStyle}>{b.code}</pre>;
    };

    // Unconfigured chat node → neutral empty state.
    if ((type === 'transformer' || type === 'join') && !isConfigured) {
      return (
        <div style={{ padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Text strong style={{ fontSize: 14 }}>{label}</Text>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 20, background: '#fdf1e3', color: '#b45309' }}>Not configured</span>
          </div>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`This ${TYPE_LABEL[type] || type} node isn't set up yet. Its logic is built through chat — open the chat to describe what it should do.`}
          />
        </div>
      );
    }

    return (
      <div style={{ padding: '16px', height: height - 100, overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Text strong style={{ fontSize: 14 }}>{label}</Text>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: '#5a6678' }}>
            {TYPE_LABEL[type] || type}
          </span>
          {(type === 'transformer' || type === 'join') && (
            <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 20, background: isConfigured ? '#e7f6ec' : '#fdf1e3', color: isConfigured ? '#16a34a' : '#b45309' }}>
              {isConfigured ? 'Configured' : 'Not configured'}
            </span>
          )}
        </div>

        {/* Explanation — what this node does, at the very top. */}
        {nonEmpty(explanation) && (
          <div style={{ ...descBoxStyle, marginBottom: 14 }}>
            {explanation}
          </div>
        )}

        {/* Build logic — the generated SQL / DDL / functions that define what
            this node does, first panel open. */}
        {codeBlocks.length > 0 && (
          <Collapse ghost className="details-collapse" style={{ marginBottom: 14, borderBottom: '1px solid #f0f2f5' }}>
            {codeBlocks.map((b, i) => (
              <Panel
                key={String(i)}
                header={<span style={groupHeaderStyle}>{b.title}</span>}
              >
                {renderCode(b)}
              </Panel>
            ))}
          </Collapse>
        )}

        {totalRows > 0 ? (
          <Collapse ghost className="details-collapse">
            {sourceRows.length > 0 && (
              <Panel key="source" header={<span style={groupHeaderStyle}>Source details</span>}>
                {renderRows(sourceRows)}
              </Panel>
            )}
            {targetRows.length > 0 && (
              <Panel key="target" header={<span style={groupHeaderStyle}>Target details</span>}>
                {renderRows(targetRows)}
              </Panel>
            )}
          </Collapse>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>No configuration recorded for this node yet.</Text>
        )}

        {/* Chat history dropdown — the conversation that built this node,
            in place of the raw build request. Collapsed by default. */}
        {chatMessages.length > 0 && (
          <Collapse ghost className="details-collapse" style={{ marginTop: 10 }}>
            <Panel
              key="chat"
              header={<span style={groupHeaderStyle}>Chat history ({chatMessages.length})</span>}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflow: 'auto' }}>
                {chatMessages.map((m, i) => {
                  const isUser = m.sender === 'user';
                  return (
                    <div
                      key={m.id || i}
                      style={{
                        alignSelf: isUser ? 'flex-end' : 'flex-start',
                        maxWidth: '88%',
                        background: isUser ? '#eef4ff' : '#f7f9fc',
                        border: '1px solid #e2e6eb',
                        borderRadius: 8,
                        padding: '6px 10px',
                      }}
                    >
                      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#9ca3af', marginBottom: 2 }}>
                        {isUser ? 'You' : 'Assistant'}
                      </div>
                      <div style={{ fontSize: 12, color: '#111827', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </Collapse>
        )}
      </div>
    );
  };

  // Render Schema Explorer for database connections
  const renderSchemaExplorer = () => {
    if (!dbTables || dbTables.length === 0) {
      return (
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Configure the data source to view schema"
          />
        </div>
      );
    }

    return (
      <div style={{ padding: '16px', height: height - 100, overflow: 'auto' }}>
        <Collapse
          onChange={(activeKeys) => {
            console.log("activeKeys: ", activeKeys)
            // Load schema for newly opened panels
            activeKeys.forEach(key => {
              loadTableSchema(key);
            });
          }}
          expandIcon={({ isActive }) => <RightOutlined rotate={isActive ? 90 : 0} />}
          style={{ background: '#fff' }}
        >
          {dbTables.map((table) => {
            const tableName = typeof table === 'string' ? table : table.name;
            const schemaName = typeof table === 'string' ? null : table.schema;
            const info = dbSchema[tableName] || { columns: null, loading: false };

            return (
              <Panel
                key={tableName}
                header={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DatabaseOutlined style={{ color: '#52c41a' }} />
                    {schemaName && (
                      <span style={{ color: '#666', fontSize: 12, fontWeight: 'normal' }}>
                        {schemaName}.
                      </span>
                    )}
                    <span style={{ fontWeight: 500 }}>{tableName}</span>
                    {info.columns && (
                      <span style={{ color: '#999', fontSize: 12, fontWeight: 'normal' }}>
                        ({info.columns.length} column{info.columns.length !== 1 ? 's' : ''})
                      </span>
                    )}
                    {info.loading && <Spin size="small" />}
                  </div>
                }
              >
                {info.loading ? (
                  <div style={{ textAlign: 'center', padding: '20px' }}>
                    <Spin />
                  </div>
                ) : info.columns ? (
                  info.columns.length === 0 ? (
                    <Text type="secondary">No columns found</Text>
                  ) : (
                    <Table
                      size="small"
                      columns={[
                        {
                          title: 'Column Name',
                          dataIndex: 'name',
                          key: 'name',
                          width: '50%',
                          render: (text, record) => (
                            <span style={{ fontWeight: 500 }}>
                              {record.name || record.column_name}
                            </span>
                          )
                        },
                        {
                          title: 'Data Type',
                          dataIndex: 'type',
                          key: 'type',
                          width: '50%',
                          render: (text, record) => (
                            <span style={{
                              background: '#f5f5f5',
                              borderRadius: 3,
                              padding: '2px 8px',
                              fontSize: 11,
                              color: '#666'
                            }}>
                              {record.type || record.data_type || 'unknown'}
                            </span>
                          )
                        }
                      ]}
                      dataSource={info.columns}
                      pagination={false}
                      rowKey={(record, index) => record.name || record.column_name || index}
                      showHeader={true}
                    />
                  )
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>
                    Click to load columns
                  </div>
                )}
              </Panel>
            );
          })}
        </Collapse>
      </div>
    );
  };

  // Resolve which data is currently displayed and a base name for export filenames
  const getCurrentExportData = () => {
    let dataToExport = null;
    let exportName = '';

    if (activeTab === 'preview') {
      if (selectedNode?.type === 'dataSource') {
        dataToExport = previewData;
        exportName = selectedNode.data?.config?.sourceConnectionName || selectedNode.data?.config?.connectionName || 'preview';
      } else if (selectedNode?.type === 'join' && connectedDataSources.length > 1) {
        const sourceIndex = parseInt(activePreviewTab);
        const sourceConfig = connectedDataSources[sourceIndex]?.data?.config;
        const connectionId = sourceConfig?.targetConnectionId || sourceConfig?.sourceConnectionId || sourceConfig?.connectionId;
        const connectionSourceIdentifier = sourceConfig?.targetTableName || sourceConfig?.sourceTableName ||
                                           sourceConfig?.targetCollection || sourceConfig?.sourceCollection ||
                                           sourceConfig?.sourceDataset || sourceConfig?.dataset || sourceConfig?.table;
        const cacheKey = connectionId + connectionSourceIdentifier;
        dataToExport = previewDataBySource[cacheKey] || previewData;
        exportName = sourceConfig?.sourceConnectionName || sourceConfig?.connectionName || `join_preview_${activePreviewTab}`;
      } else {
        dataToExport = previewData;
        exportName = 'preview';
      }
    } else if (activeTab === 'transformed') {
      dataToExport = transformedData;
      exportName = selectedNode.data?.config?.targetConnectionName || 'transformed';
    }

    return { dataToExport, exportName };
  };

  const triggerDownload = (content, mimeType, filename) => {
    const blob = new Blob([content], { type: mimeType });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Export current data as CSV or JSON depending on the data shape
  const handleExport = () => {
    try {
      const { dataToExport, exportName } = getCurrentExportData();

      if (!dataToExport || !dataToExport.data) {
        message.warning('No data available to export');
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

      if (dataToExport.isJson) {
        const jsonContent = JSON.stringify(dataToExport.data, null, 2);
        triggerDownload(jsonContent, 'application/json;charset=utf-8;', `${exportName}_${timestamp}.json`);
        message.success('JSON exported successfully!');
        return;
      }

      if (!dataToExport.headers) {
        message.warning('No data available to export');
        return;
      }

      const csvHeaders = dataToExport.headers.join(',');
      const csvRows = dataToExport.data.map(row => {
        return row.map(value => {
          if (value === null || value === undefined) return '';
          const stringValue = String(value);
          if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
            return `"${stringValue.replace(/"/g, '""')}"`;
          }
          return stringValue;
        }).join(',');
      });
      const csvContent = [csvHeaders, ...csvRows].join('\n');

      triggerDownload(csvContent, 'text/csv;charset=utf-8;', `${exportName}_${timestamp}.csv`);
      message.success('CSV exported successfully!');
    } catch (error) {
      console.error('Error exporting data:', error);
      message.error('Failed to export data');
    }
  };

  const isCurrentDataJson = () => {
    const { dataToExport } = getCurrentExportData();
    return Boolean(dataToExport?.isJson);
  };

  // Don't render if no node is selected
  if (!selectedNode) {
    return null;
  }

  // Don't render for start and output nodes
  if (selectedNode.type === 'start' || selectedNode.type === 'output') {
    return null;
  }

  // For data sources, check if they have configuration
  // if (selectedNode.type === 'dataSource' && !selectedNode.data?.config?.connectionId) {
    // return null;
  // }

  // For database type data sources, check if they have sql field OR schema loaded
  if (selectedNode.type === 'dataSource' && selectedNode.data?.config?.connectionType === 'database') {
    // Show DataPreview if either SQL is configured OR schema/tables are loaded
    if (!selectedNode.data?.config?.sql && (!dbTables || dbTables.length === 0)) {
      return null;
    }
  }

  // For transformers and joins, check if they have connected sources
  if ((selectedNode.type === 'transformer' || selectedNode.type === 'join') && connectedDataSources.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        // The workflow editor lives in an antd modal, which portals to <body>
        // and so escapes the containment that keeps the app's own overlays
        // clear of a pinned assistant. This bar is laid out against the
        // viewport, so it has to step aside for the rail itself — otherwise
        // its right edge runs on underneath the assistant. ChatAssistant
        // publishes --chat-rail-w, which is 0px whenever the rail is not up.
        right: `calc(${isNodeSidebarOpen ? '420px' : '0px'} + var(--chat-rail-w, 0px))`,
        height: `${height}px`,
        backgroundColor: '#fff',
        borderTop: '1px solid #e2e6eb',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Inter',-apple-system,sans-serif",
      }}
    >
      {/* Resize Handle */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          height: 4,
          cursor: 'row-resize',
          backgroundColor: '#e2e6eb',
          flexShrink: 0,
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = '#2563eb'}
        onMouseLeave={(e) => e.currentTarget.style.background = '#e2e6eb'}
      />


      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Table Name Header */}
        {selectedNode?.data?.config && (
          <div style={{
            padding: '7px 14px',
            borderBottom: '1px solid #e2e6eb',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#f7f9fc',
            gap: 8,
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{
                fontSize: 9,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700,
                letterSpacing: '0.1em',
                color: '#9ca3af',
                textTransform: 'uppercase',
              }}>
                Data Preview
              </span>
              <span style={{
                fontSize: 11,
                color: '#5a6678',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {(() => {
                  const config = selectedNode.data.config;
                  if (config.sourceCollection) return `· ${config.sourceCollection}`;
                  if (config.sourceTableName) {
                    const schema = config.sourceSchema ? `${config.sourceSchema}.` : '';
                    return `· ${schema}${config.sourceTableName}`;
                  }
                  if (config.table) return `· ${config.table}`;
                  if (config.dataset) return `· ${config.dataset}`;
                  return null;
                })()}
              </span>
            </div>
            {onClose && (
              <Tooltip title="Close — take this node out of focus">
                <Button
                  size="small"
                  icon={<CloseOutlined />}
                  onClick={onClose}
                  aria-label="Close preview"
                  style={{
                    borderRadius: 4,
                    fontSize: 11,
                    color: '#5a6678',
                    borderColor: '#e2e6eb',
                    background: '#fff',
                  }}
                />
              </Tooltip>
            )}
          </div>
        )}

        <Tabs
          activeKey={activeTab}
          onChange={changeTab}
          size="small"
          style={{ height: '100%', paddingLeft: 12, flex: 1 }}
          tabBarStyle={{ margin: 0, borderBottom: '1px solid #e2e6eb' }}
          tabBarExtraContent={activeTab === 'details' ? undefined : {
            right: (
              <Button
                size="small"
                icon={<DownloadOutlined />}
                onClick={handleExport}
                disabled={
                  (activeTab === 'preview' && (loadingPreview || !previewData)) ||
                  (activeTab === 'transformed' && (loadingTransformed || !transformedData))
                }
                style={{
                  borderRadius: 4,
                  fontSize: 11,
                  color: '#5a6678',
                  borderColor: '#e2e6eb',
                  background: '#fff',
                  marginRight: 8,
                }}
              >
                {isCurrentDataJson() ? 'Export JSON' : 'Export CSV'}
              </Button>
            )
          }}
        >
          {/* Details tab — all node configuration (primary tab) */}
          <TabPane
            tab={
              <span>
                <ProfileOutlined style={{ marginRight: 6 }} />
                Details
              </span>
            }
            key="details"
            style={{ height: '100%' }}
          >
            {renderNodeDetails()}
          </TabPane>
          {(previewData || awaitingApiConfig) &&
          <TabPane
            tab={
              <span>
                <EyeOutlined style={{ marginRight: 6 }} />
                Preview
              </span>
            }
            key="preview"
            style={{ height: '100%', padding: '8px 0px' }}
          >
            {renderDataSourceTabs()}
          </TabPane>
          }
          {/* Schema tab - only for database data sources. A REST API source has
              no browsable schema (it has no tables until its fetch runs), so it
              gets the Details tab only. */}
          {selectedNode?.type === 'dataSource' && !isApiDataSource && (
            <TabPane
              tab={
                <span>
                  <DatabaseOutlined style={{ marginRight: 6 }} />
                  Schema
                  {dbTables.length > 0 && (
                    <span style={{ marginLeft: 4, color: '#999', fontSize: 11 }}>
                      ({dbTables.length})
                    </span>
                  )}
                </span>
              }
              key="schema"
              style={{ height: '100%' }}
            >
              {renderSchemaExplorer()}
            </TabPane>
          )}

          {selectedNode.data.label !== 'Data Source' && !isApiDataSource && <TabPane
            tab={
              <span>
                <SwapOutlined style={{ marginRight: 6 }} />
                Transformed
                {/* The tick means "there are rows here". A node still waiting to
                    run has a placeholder, not an output. */}
                {transformedData && !transformedData.pendingExecution &&
                  <span style={{ marginLeft: 4, color: '#52c41a' }}>✓</span>}
              </span>
            }
            key="transformed"
            disabled={!isTransformedTabEnabled()}
            style={{ height: '100%', padding: '8px 0px' }}
          >
            {!isTransformedTabEnabled() ? (
              <div style={{ textAlign: 'center', padding: '40px' }}>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    (selectedNode?.type === 'transformer' || selectedNode?.type === 'join')
                      ? "Execute the transformation first to see transformed data"
                      : "Node must be saved/processed first"
                  }
                />
              </div>
            ) : (
              renderDataTable(transformedData, loadingTransformed)
            )}
          </TabPane>}
        </Tabs>
      </div>
    </div>
  );
};

export default DataPreview;