import React, { useState, useCallback, useRef, useEffect } from 'react';
import { debounce } from 'lodash';
import ReactFlow, {
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  MiniMap,
  Background,
  useReactFlow,
  Panel,
} from 'reactflow';
import { Button, Space, Input, message, Typography, Modal, Spin, Dropdown, Menu } from 'antd';
import { SaveOutlined, UndoOutlined, CloudUploadOutlined, SettingOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined, ExportOutlined, MoreOutlined } from '@ant-design/icons';
import 'reactflow/dist/style.css';

import StartNode from './nodes/StartNode';
import DataSourceNode from './nodes/DataSourceNode';
import TransformerNode from './nodes/TransformerNode';
import JoinNode from './nodes/JoinNode';
import OutputNode from './nodes/OutputNode';
import NodeTypePanel from './NodeTypePanel';
import NodeChatPanel from './NodeChatPanel';
import LocalFileConnectionForm from './connections/LocalFileConnectionForm';
import DataPreview from './DataPreview';
import WorkflowStepsEditor from './WorkflowStepsEditor';
import { generateStepsFromNodes } from '../../utils/workflowUtils';
import { connectionsDb } from '../../utils/localDb';
import axios from 'axios';

const { Title } = Typography;

const nodeTypes = {
  start: StartNode,
  dataSource: DataSourceNode,
  transformer: TransformerNode,
  join: JoinNode,
  output: OutputNode,
};

// Strip non-structured-cloneable values (class instances like Apache Arrow
// Vectors, functions, circular refs) before sending workflow data through
// Electron IPC. Throws with a clearer message than the IPC bridge does.
const toCloneable = (value, label = 'workflow') => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    throw new Error(`Cannot serialize ${label} for save: ${err.message}`);
  }
};

const initialNodes = [];
const initialEdges = [];

// File validation constants
const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];
const ALLOWED_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv'
];

// Helper function to validate dropped files
const isValidFile = (file) => {
  const fileExtension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  
  if (!ALLOWED_EXTENSIONS.includes(fileExtension)) {
    return false;
  }
  
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return false;
  }
  
  if (file.size > 50 * 1024 * 1024 * 1024) { // 50GB limit
    return false;
  }
  
  return true;
};

const WorkflowEditor = ({ workflow, onSave, onAutoSave, onCancel, onCloseRequest, onSidebarOpenChange }) => {
  const reactFlowWrapper = useRef(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [droppedFile, setDroppedFile] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [initialWorkflowState, setInitialWorkflowState] = useState(null);
  const [isStepsEditorOpen, setIsStepsEditorOpen] = useState(false);
  const [executionSteps, setExecutionSteps] = useState([]);
  const [triggerSidebarSave, setTriggerSidebarSave] = useState(false);
  const [currentWorkflowId, setCurrentWorkflowId] = useState(workflow?.id || null);
  const [editorLoading, setEditorLoading] = useState(!!workflow?.id);
  const [saveAfterStepsEditor, setSaveAfterStepsEditor] = useState(false);

  // Latest signals the on-disk code watcher reads to decide whether a
  // 'workflow:codeChanged' event should reload the canvas. `suppressUntil`
  // ignores the file writes our own auto-save makes (which would otherwise
  // trigger a reload loop).
  const reloadGuardRef = useRef({ saving: false, hasUnsavedChanges: false, suppressUntil: 0 });

  // Database schema state (shared between chat and preview)
  const [dbTables, setDbTables] = useState([]); // Full table objects with schema info
  const [activeConnection, setActiveConnection] = useState(null); // Current database connection
  const [dataPreviewRefreshTrigger, setDataPreviewRefreshTrigger] = useState(0); // Increment to trigger DataPreview refresh

  // Context menu state
  const [contextMenu, setContextMenu] = useState(null);
  const [contextMenuNode, setContextMenuNode] = useState(null);

  // Execution state
  const [isExecuting, setIsExecuting] = useState(false);

  // Close context menu when clicking anywhere in the document
  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu) {
        setContextMenu(null);
        setContextMenuNode(null);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [contextMenu]);

  // Clear dbTables when selected node changes or is not a database
  useEffect(() => {
    if (!selectedNode ||
        selectedNode.type !== 'dataSource' ||
        selectedNode.data?.config?.connectionType !== 'database') {
      setDbTables([]);
      setActiveConnection(null);
    }
  }, [selectedNode?.id, selectedNode?.type, selectedNode?.data?.config?.connectionType]);

  // Bubble the node-chat panel's open state up so the top-level
  // ChatAssistant can hide itself while a node chat is active (they share
  // the same screen corner).
  useEffect(() => {
    if (typeof onSidebarOpenChange === 'function') onSidebarOpenChange(isSidebarOpen);
    return () => {
      if (typeof onSidebarOpenChange === 'function') onSidebarOpenChange(false);
    };
  }, [isSidebarOpen, onSidebarOpenChange]);

  // Fetch a saved workflow from the local database and hydrate the editor.
  // Reused for the initial load and for live reloads when the workflow's
  // externalized code files change on disk (see the code-watcher effect).
  const loadWorkflowFromDb = useCallback(async (id, { isReload = false } = {}) => {
    if (!isReload) setEditorLoading(true);
    try {
      // User is not logged in - fetch from local database
      const { workflowsDb } = await import('../../utils/localDb');
      const fullWorkflow = await workflowsDb.getById(id);

      if (!fullWorkflow) {
        if (!isReload) message.error('Failed to load workflow details');
        return;
      }

      // Set workflow data
      setWorkflowName(fullWorkflow.name || '');
      setWorkflowDescription(fullWorkflow.description || '');
      setCurrentWorkflowId(fullWorkflow.id || null);

      const workflowNodes = Array.isArray(fullWorkflow.nodes) ? fullWorkflow.nodes : [];
      const workflowEdges = Array.isArray(fullWorkflow.edges) ? fullWorkflow.edges : [];

      setNodes(workflowNodes);
      setEdges(workflowEdges);
      setExecutionSteps(fullWorkflow.executionSteps || []);

      setInitialWorkflowState({
        name: fullWorkflow.name || '',
        description: fullWorkflow.description || '',
        nodes: workflowNodes,
        edges: workflowEdges
      });

      if (isReload) message.info('Workflow code changed on disk — canvas reloaded');
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 204 ||
          error.response?.status === 400) {
        localStorage.removeItem('auth-token');
        message.error('Session expired. Please log in again.');
        window.location.href = '/login';
        return;
      }
      console.error('Error loading workflow:', error);
      if (!isReload) message.error('Failed to load workflow details');
    } finally {
      if (!isReload) setEditorLoading(false);
    }
  }, [setNodes, setEdges]);

  // Initialize workflow data
  useEffect(() => {
    if (workflow?.id) {
      loadWorkflowFromDb(workflow.id);
    } else if (workflow?.nodes) {
      // Pre-loaded imported workflow (has nodes/edges but no saved id yet)
      const workflowNodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
      const workflowEdges = Array.isArray(workflow.edges) ? workflow.edges : [];
      setWorkflowName(workflow.name || '');
      setWorkflowDescription(workflow.description || '');
      setNodes(workflowNodes);
      setEdges(workflowEdges);
      setExecutionSteps(workflow.executionSteps || []);
      setCurrentWorkflowId(null);
      setInitialWorkflowState({
        name: workflow.name || '',
        description: workflow.description || '',
        nodes: workflowNodes,
        edges: workflowEdges,
      });
    } else {
      // Create new workflow with start node
      const startNode = {
        id: 'start-node',
        type: 'start',
        position: { x: 100, y: 200 },
        data: {
          label: 'Start',
          config: {
            triggerType: 'manual',
            undeletable: true
          }
        },
        deletable: false,
        draggable: true
      };

      setNodes([startNode]);
      setEdges([]);
      setWorkflowName('');
      setWorkflowDescription('');
      setExecutionSteps([]);
      setCurrentWorkflowId(null);

      setInitialWorkflowState({
        name: '',
        description: '',
        nodes: [startNode],
        edges: []
      });
      setEditorLoading(false);
    }
  }, [workflow, setNodes, setEdges, loadWorkflowFromDb]);

  // Watch the open workflow's externalized-code folder on disk. When a code
  // file is edited externally (e.g. in an IDE or by an AI tool), reload the
  // canvas so the editor and {userData}/workflow-code/{workflow} stay in sync.
  // Reloads are skipped while saving / shortly after a save (our own writes)
  // and when there are unsaved canvas edits (to avoid clobbering them).
  useEffect(() => {
    const api = window.electronAPI?.workflow;
    if (!api?.watchCode || !api?.onCodeChanged || !currentWorkflowId) return;
    const wfId = currentWorkflowId;

    api.watchCode(wfId);
    const unsubscribe = api.onCodeChanged(({ workflowId }) => {
      if (workflowId !== wfId) return;
      const guard = reloadGuardRef.current;
      if (guard.saving || Date.now() < guard.suppressUntil) return;
      if (guard.hasUnsavedChanges) {
        message.warning('Workflow code changed on disk, but you have unsaved canvas edits — not reloaded.');
        return;
      }
      loadWorkflowFromDb(wfId, { isReload: true });
    });

    return () => {
      unsubscribe();
      api.unwatchCode(wfId);
    };
  }, [currentWorkflowId, loadWorkflowFromDb]);

  // Mirror save state into the code-watcher guard so externally-detected file
  // changes can tell our own auto-save writes apart from real edits.
  useEffect(() => { reloadGuardRef.current.saving = saving; }, [saving]);
  useEffect(() => { reloadGuardRef.current.hasUnsavedChanges = hasUnsavedChanges; }, [hasUnsavedChanges]);

  // Track changes to detect unsaved modifications (for UI display only, not auto-save)
  useEffect(() => {
    if (!initialWorkflowState) return;

    const currentState = {
      name: workflowName,
      description: workflowDescription,
      nodes,
      edges
    };

    // ReactFlow mutates transient UI/layout fields (selection, drag state,
    // measured width/height, absolute position) on every click, drag, and
    // render. Those are not user content, so strip them before comparing —
    // otherwise selecting a node after a save would re-flag "unsaved changes"
    // and the close confirmation would pop up even though nothing was edited.
    const NODE_TRANSIENT_KEYS = [
      'position', 'positionAbsolute', 'selected', 'dragging',
      'resizing', 'width', 'height',
    ];
    const EDGE_TRANSIENT_KEYS = ['selected'];

    const stripKeys = (obj, keys) => {
      const out = { ...obj };
      for (const k of keys) delete out[k];
      return out;
    };

    const compareNodesWithoutPosition = (nodes1, nodes2) => {
      if (nodes1.length !== nodes2.length) return false;
      const norm = (list) => list.map((node) => stripKeys(node, NODE_TRANSIENT_KEYS));
      return JSON.stringify(norm(nodes1)) === JSON.stringify(norm(nodes2));
    };

    const compareEdges = (edges1, edges2) => {
      const norm = (list) => (list || []).map((edge) => stripKeys(edge, EDGE_TRANSIENT_KEYS));
      return JSON.stringify(norm(edges1)) === JSON.stringify(norm(edges2));
    };

    const hasChanges = (
      currentState.name !== initialWorkflowState.name ||
      currentState.description !== initialWorkflowState.description ||
      !compareNodesWithoutPosition(currentState.nodes, initialWorkflowState.nodes) ||
      !compareEdges(currentState.edges, initialWorkflowState.edges)
    );

    setHasUnsavedChanges(hasChanges);
  }, [workflowName, workflowDescription, nodes, edges, initialWorkflowState]);

  const handleCancel = useCallback(() => {
    if (hasUnsavedChanges) {
      Modal.confirm({
        title: 'Unsaved Changes',
        content: 'You have unsaved changes. Are you sure you want to close without saving?',
        okText: 'Yes, close',
        cancelText: 'Stay',
        onOk: () => {
          onCancel();
        }
      });
    } else {
      onCancel();
    }
  }, [hasUnsavedChanges, onCancel]);

  // Register close request handler with parent
  useEffect(() => {
    if (onCloseRequest) {
      onCloseRequest(handleCancel);
    }
  }, [onCloseRequest, handleCancel]);

  const onConnect = useCallback((params) => {
    // Get the source and target nodes
    const sourceNode = nodes.find(node => node.id === params.source);
    const targetNode = nodes.find(node => node.id === params.target);
    
    if (!sourceNode || !targetNode) {
      message.error('Invalid connection attempt');
      return;
    }
    
    // Enforce connection rules
    if (sourceNode.type === 'start') {
      // Start nodes can only connect to data source nodes
      if (targetNode.type !== 'dataSource') {
        message.error('Start nodes can only connect to Data Source nodes');
        return;
      }
      
      // Start nodes can have multiple connections to different data sources
      // Check if already connected to this specific data source
      const existingConnection = edges.find(edge => edge.source === sourceNode.id && edge.target === targetNode.id);
      if (existingConnection) {
        message.error('This data source is already connected to the start node');
        return;
      }
    }
    
    if (targetNode.type === 'dataSource') {
      // Data source nodes can only receive connections from start nodes
      if (sourceNode.type !== 'start') {
        message.error('Data Source nodes can only receive connections from Start nodes');
        return;
      }
      
      // Check if data source already has an incoming connection
      const existingConnection = edges.find(edge => edge.target === targetNode.id);
      if (existingConnection) {
        message.error('Data Source nodes can only have one incoming connection');
        return;
      }
    }
    
    if (sourceNode.type === 'dataSource') {
      // Data source nodes can connect to transformer, join, or output nodes
      if (!['transformer', 'join', 'output'].includes(targetNode.type)) {
        message.error('Data Source nodes can only connect to Transformer, Join, or Output nodes');
        return;
      }
    }
    
    if (targetNode.type === 'output') {
      // Output (Data Export) nodes can only have one incoming connection
      const existingConnection = edges.find(edge => edge.target === targetNode.id);
      if (existingConnection) {
        message.error('Data Export nodes can only have one incoming connection');
        return;
      }
    }
    
    // Allow the connection if all rules pass
    setEdges((eds) => addEdge(params, eds));
  }, [setEdges, nodes, edges]);

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    
    // Check if files are being dragged
    const hasFiles = event.dataTransfer.types.includes('Files');
    if (hasFiles) {
      event.dataTransfer.dropEffect = 'copy';
      setIsDragOver(true);
    } else {
      event.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const onDragLeave = useCallback((event) => {
    event.preventDefault();
    // Only set dragOver to false if we're leaving the main container
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setIsDragOver(false);
    }
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      setIsDragOver(false);

      // Check if files were dropped
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) {
        const file = files[0];
        
        if (!isValidFile(file)) {
          message.error('Only Excel (.xlsx, .xls) and CSV (.csv) files are allowed, up to 50GB');
          return;
        }
        
        // Store the dropped file and open upload modal
        setDroppedFile(file);
        setIsUploadModalOpen(true);
        return;
      }

      // Handle node drops (existing functionality)
      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      const type = event.dataTransfer.getData('application/reactflow');

      if (typeof type === 'undefined' || !type) {
        return;
      }

      const position = reactFlowInstance.project({
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      });


      const newNode = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: { 
          label: getNodeLabel(type),
          config: getDefaultNodeConfig(type)
        },
      };

      // Auto-connect data source nodes to start node BEFORE adding to nodes
      if (type === 'dataSource') {
        // Find the start node in current nodes state
        const startNode = nodes.find(node => node.type === 'start' && node.id === 'start-node');
        console.log('DEBUG - Auto-connection:', { startNode, newNodeId: newNode.id });
        
        if (startNode) {
          // Check if start node is already connected to this specific data source
          const existingConnection = edges.find(edge => edge.source === startNode.id && edge.target === newNode.id);
          
          if (existingConnection) {
            message.warning('This data source is already connected to the start node.');
            return; // Don't add the node if already connected
          }
          
          const newEdge = {
            id: `edge-${startNode.id}-${newNode.id}`,
            source: startNode.id,
            target: newNode.id,
            type: 'default'
          };
          console.log('DEBUG - Creating auto-connection edge:', newEdge);
          
          // Add both node and edge together
          setNodes((nds) => nds.concat(newNode));
          setEdges((eds) => [...eds, newEdge]);
        } else {
          console.log('DEBUG - No start node found for auto-connection');
          setNodes((nds) => nds.concat(newNode));
        }
      } else {
        // For non-data source nodes, just add the node
        setNodes((nds) => nds.concat(newNode));
      }
    },
    [reactFlowInstance, setNodes, setEdges, nodes]
  );

  const getNodeLabel = (type) => {
    switch (type) {
      case 'start':
        return 'Start';
      case 'dataSource':
        return 'Data Source'; // This will be overridden by the component based on configuration
      case 'transformer':
        return 'Transformer';
      case 'join':
        return 'Join';
      case 'branch':
        return 'Branch';
      case 'output':
        return 'Output';
      default:
        return 'Node';
    }
  };

  const getDefaultNodeConfig = (type) => {
    switch (type) {
      case 'start':
        return { triggerType: 'manual', scheduleType: 'interval', interval: 5, intervalUnit: 'minutes' };
      case 'dataSource':
        return { connectionId: null, table: '', query: '' };
      case 'transformer':
        return { operation: '', config: {} };
      case 'join':
        return { joinType: 'inner', condition: '' };
      case 'branch':
        return { steps: [], validationFunction: null };
      case 'output':
        return { destination: '', format: 'table' };
      default:
        return {};
    }
  };

  const onNodeClick = useCallback((event, node) => {
    // Close context menu if open
    setContextMenu(null);
    setContextMenuNode(null);

    // Check if node has required inputs for sidebar to open
    const canOpenSidebar = canNodeOpenSidebar(node, nodes, edges);

    if (canOpenSidebar) {
      setSelectedNode(node);
      setIsSidebarOpen(true);
    } else {
      message.warning(getNodeRequirementMessage(node));
    }
  }, [nodes, edges]);

  // Handle node context menu (right-click)
  const onNodeContextMenu = useCallback((event, node) => {
    event.preventDefault();

    setContextMenuNode(node);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  // Handle Edit from context menu
  const handleEditNode = useCallback(() => {
    if (contextMenuNode) {
      setContextMenu(null);
      const canOpenSidebar = canNodeOpenSidebar(contextMenuNode, nodes, edges);

      if (canOpenSidebar) {
        setSelectedNode(contextMenuNode);
        setIsSidebarOpen(true);
      } else {
        message.warning(getNodeRequirementMessage(contextMenuNode));
      }
      setContextMenuNode(null);
    }
  }, [contextMenuNode, nodes, edges]);

  // Handle Delete from context menu
  const handleDeleteNode = useCallback(() => {
    if (contextMenuNode) {
      setContextMenu(null);

      // Remove the node
      setNodes((nds) => nds.filter((n) => n.id !== contextMenuNode.id));

      // Remove connected edges
      setEdges((eds) => eds.filter(
        (edge) => edge.source !== contextMenuNode.id && edge.target !== contextMenuNode.id
      ));

      message.success(`Node deleted successfully`);
      setContextMenuNode(null);

      // Close sidebar if deleted node was selected
      if (selectedNode?.id === contextMenuNode.id) {
        setIsSidebarOpen(false);
        setSelectedNode(null);
      }
    }
  }, [contextMenuNode, selectedNode, setNodes, setEdges]);

  // Close context menu when clicking anywhere
  const handlePaneClick = useCallback(() => {
    setContextMenu(null);
    setContextMenuNode(null);
  }, []);
  // console.log('nodes: ', selectedNode)
  // Handle node configuration updates
  const onNodeConfigUpdate = useCallback((nodeId, config) => {
    console.log('config: ', config)
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === nodeId) {
          return {
            ...node,
            data: {
              ...node.data,
              config: {
                ...node.data.config,
                ...config
              }
            }
          };
        }
        return node;
      })
    );

    // Trigger auto-save flag for sidebar changes
    setTriggerSidebarSave(true);
  }, [setNodes]);

  // Update only the selectedNode for preview purposes (doesn't save to workflow)
  const onPreviewConfigUpdate = useCallback((nodeId, config) => {
    // console.log('onPreviewConfigUpdate: ', selectedNode, nodeId, config)
    if (selectedNode && selectedNode.id === nodeId) {
      setSelectedNode(prev => ({
        ...prev,
        data: {
          ...prev.data,
          config: {
            ...prev.data.config,
            ...config
          }
        }
      }));
    }
  }, [selectedNode]);

  // Refresh DataPreview (called after execution completes)
  const handleDataPreviewRefresh = useCallback(() => {
    setDataPreviewRefreshTrigger(prev => prev + 1);
  }, []);

  // Load database tables (called from DataSourceNodeChat)
  const loadDatabaseTables = useCallback(async (connection) => {
    try {
      console.log('connection: ', connection)
      // Store the connection for use in DataPreview
      setActiveConnection(connection);

      // Handle file-based connections (local SQLite/NeDB files)
      if (connection.connectionType === 'file') {
        const filePath = connection.fileInfo?.filePath;
        if (!filePath) {
          console.error('File path not found in connection');
          return { success: false, tables: [] };
        }

        if (connection.dbType === 'sqlite') {
          // For spreadsheet imports, use the stored table list
          if (connection.fileType === 'spreadsheet' && connection.fileInfo?.tables) {
            const tableList = connection.fileInfo.tables.map(tableName => ({ name: tableName }));

            const tableObjects = tableList.map(t => ({
              name: t.name || String(t),
              schema: t.schema || null
            }));

            setDbTables(tableObjects);
            return { success: true, tables: tableList };
          }

          // For direct SQLite files, read from local file to get table names
          if (!window.electronAPI?.db?.readLocalCollection) {
            console.error('Local database API not available');
            return { success: false, tables: [] };
          }

          const result = await window.electronAPI.db.readLocalCollection(
            filePath,
            1000,
            'sqlite',
            null,
            null
          );

          if (result.success && result.tables) {
            const tableList = result.tables.map(tableName => ({ name: tableName }));

            const tableObjects = tableList.map(t => ({
              name: t.name || String(t),
              schema: t.schema || null
            }));

            setDbTables(tableObjects);
            return { success: true, tables: tableList };
          }

          return { success: false, tables: [] };
        } else if (connection.dbType === 'nedb') {
          // For NeDB, there's only one collection per file
          const collectionName = connection.fileInfo?.originalName?.replace(/\.[^/.]+$/, '') || 'collection';
          const tableList = [{ name: collectionName }];

          const tableObjects = tableList.map(t => ({
            name: t.name || String(t),
            schema: t.schema || null
          }));

          setDbTables(tableObjects);
          return { success: true, tables: tableList };
        }

        return { success: false, tables: [] };
      }

      // Handle database connections (remote databases)
      if (!window.electronAPI?.dbConnect) {
        console.error('Database API not available');
        return { success: false, tables: [] };
      }

      const result = await window.electronAPI.dbConnect.getTables(
        connection.dbType,
        connection.dbConfig,
        connection.id
      );

      if (result.success) {
        const tableList = result.tables || [];

        // Store full table objects with schema information
        const tableObjects = tableList.map(t => ({
          name: t.name || String(t),
          schema: t.schema || null
        }));

        setDbTables(tableObjects);
        return { success: true, tables: tableList };
      }

      return { success: false, tables: [] };
    } catch (error) {
      console.error('Failed to load database tables:', error);
      return { success: false, tables: [], error: error.message };
    }
  }, []);

  const canNodeOpenSidebar = (node, allNodes, allEdges) => {
    switch (node.type) {
      case 'start':
        return true; // Start node can always be configured
      case 'dataSource':
        return true; // Data source can always open
      case 'transformer':
        // Needs one input connection
        return allEdges.some(edge => edge.target === node.id);
      case 'join':
        // Needs two input connections
        const inputConnections = allEdges.filter(edge => edge.target === node.id);
        return inputConnections.length >= 2;
      case 'branch':
        // Needs at least one input connection
        return allEdges.some(edge => edge.target === node.id);
      case 'output':
        // Needs one input connection
        return allEdges.some(edge => edge.target === node.id);
      default:
        return true;
    }
  };

  const getNodeRequirementMessage = (node) => {
    switch (node.type) {
      case 'transformer':
        return 'Transformer node requires a source connection to configure';
      case 'join':
        return 'Join node requires two input connections to configure';
      case 'branch':
        return 'Branch node requires at least one input connection to configure';
      case 'output':
        return 'Output node requires an input connection to configure';
      default:
        return 'Node cannot be configured';
    }
  };


  const onCloseSidebar = () => {
    setIsSidebarOpen(false);
    setSelectedNode(null);
  };

  const validateWorkflow = () => {
    if (!workflowName.trim()) {
      message.error('Please enter a workflow name');
      return false;
    }

    if (nodes.length === 0) {
      message.error('Workflow must contain at least one node');
      return false;
    }

    // Check if there's a start node
    const hasStart = nodes.some(node => node.type === 'start');
    if (!hasStart) {
      message.error('Workflow must contain a start node');
      return false;
    }

    // Check if there's at least one data source node
    const hasDataSource = nodes.some(node => node.type === 'dataSource');
    if (!hasDataSource) {
      message.error('Workflow must contain at least one data source node');
      return false;
    }

    // Check if start node is connected to at least one data source
    const startNode = nodes.find(node => node.type === 'start');
    if (startNode) {
      const startConnections = edges.filter(edge => edge.source === startNode.id);
      if (startConnections.length === 0) {
        message.error('Start node must be connected to at least one data source');
        return false;
      }
      
      // Verify all connections from start are to data sources
      for (const connection of startConnections) {
        const connectedNode = nodes.find(node => node.id === connection.target);
        if (!connectedNode || connectedNode.type !== 'dataSource') {
          message.error('Start node can only connect to data source nodes');
          return false;
        }
      }
    }

    // Check if all nodes are properly configured
    for (const node of nodes) {
      if (!canNodeOpenSidebar(node, nodes, edges)) {
        message.error(`Node "${node.data.label}" is not properly connected`);
        return false;
      }
    }

    return true;
  };

  const handleSave = async (providedExecutionSteps = null) => {
    if (!validateWorkflow()) {
      return;
    }

    setSaving(true);
    try {
      // Extract final_dataset s3key from Data Export node's connected source
      const outputNode = nodes.find(node => node.type === 'output');
      let finalDatasetS3Key = null;

      if (outputNode) {
        // Find the edge that connects to the output node
        const outputConnection = edges.find(edge => edge.target === outputNode.id);
        if (outputConnection) {
          // Find the source node that connects to output
          const sourceNode = nodes.find(node => node.id === outputConnection.source);
          if (sourceNode && sourceNode.data?.config) {
            // Extract s3key based on source node type
            if (sourceNode.type === 'join') {
              finalDatasetS3Key = {...sourceNode.data.config, connectionName: sourceNode.id};
            } else if (sourceNode.type === 'transformer') {
              finalDatasetS3Key = {...sourceNode.data.config, connectionName: sourceNode.id};
            } else if (sourceNode.type === 'dataSource') {
              // For direct data source connections, use the connection's s3key
              finalDatasetS3Key = sourceNode.data.config;
            }
          }
        }
      }

      // Use provided execution steps, stored execution steps, or auto-generate if none exist
      let finalExecutionSteps = providedExecutionSteps || executionSteps;
      if (!finalExecutionSteps.length && nodes.length > 0) {
        // Auto-generate execution steps using shared utility function
        finalExecutionSteps = generateStepsFromNodes(nodes, edges);
      }

      const workflowData = {
        name: workflowName,
        description: workflowDescription,
        nodes: toCloneable(nodes, 'nodes'),
        edges: toCloneable(edges, 'edges'),
        nodeCount: nodes.length,
        type: 'Custom',
        final_dataset: toCloneable(finalDatasetS3Key, 'final_dataset'),
        executionSteps: finalExecutionSteps || []
      };

      // Let the parent component handle the API call to avoid duplication
      await onSave(workflowData);

      // Update initial state to current state after successful save
      setInitialWorkflowState({
        name: workflowName,
        description: workflowDescription,
        nodes,
        edges
      });
      setHasUnsavedChanges(false);

    } catch (error) {
      console.error('Error saving workflow:', error);

      // Handle authentication errors
      if (error.response?.status === 401 || error.response?.status === 204 ||
          (error.response?.status === 400)) {
        localStorage.removeItem('auth-token');
        message.error('Session expired. Please log in again.');
        window.location.href = '/login';
        return;
      }

      message.error('Failed to save workflow');
    } finally {
      setSaving(false);
    }
  };

  // Auto-save with debouncing to avoid excessive API calls
  const autoSave = useCallback(async () => {
    if (saving) {
      // Don't auto-save if already saving
      return;
    }

    if (!workflowName.trim()) {
      // Don't auto-save if workflow doesn't have a name
      message.warning('Cannot save: Please enter a workflow name');
      return;
    }

    // Custom validation for auto-save with error messages
    if (nodes.length === 0) {
      message.warning('Cannot save: Workflow must have at least one node');
      return;
    }

    // Check if there's a start node
    const hasStart = nodes.some(node => node.type === 'start');
    if (!hasStart) {
      message.warning('Cannot save: Workflow must have a Start node');
      return;
    }

    // Check if there's at least one data source node
    const hasDataSource = nodes.some(node => node.type === 'dataSource');
    if (!hasDataSource) {
      message.warning('Cannot save: Workflow must have at least one Data Source node');
      return;
    }
    
    // Check if start node is connected to at least one data source
    const startNode = nodes.find(node => node.type === 'start');
    if (startNode) {
      const startConnections = edges.filter(edge => edge.source === startNode.id);
      if (startConnections.length === 0) {
        message.warning('Cannot save: Start node must be connected to at least one Data Source');
        return;
      }
    }



    
    setSaving(true);
    try {
      // Extract final_dataset from Data Export node's connected source
      const outputNodeForSave = nodes.find(node => node.type === 'output');
      let finalDatasetS3Key = null;
      if (outputNodeForSave) {
        const outputConnection = edges.find(edge => edge.target === outputNodeForSave.id);
        if (outputConnection) {
          const sourceNode = nodes.find(node => node.id === outputConnection.source);
          if (sourceNode?.data?.config) {
            if (sourceNode.type === 'join' || sourceNode.type === 'transformer') {
              finalDatasetS3Key = { ...sourceNode.data.config, connectionName: sourceNode.id };
            } else if (sourceNode.type === 'dataSource') {
              finalDatasetS3Key = sourceNode.data.config;
            }
          }
        }
      }

      let finalExecutionSteps = executionSteps;
      if (!finalExecutionSteps.length && nodes.length > 0) {
        finalExecutionSteps = generateStepsFromNodes(nodes, edges);
      }
      
      const workflowData = {
        name: workflowName,
        description: workflowDescription,
        nodes: toCloneable(nodes, 'nodes'),
        edges: toCloneable(edges, 'edges'),
        nodeCount: nodes.length,
        type: 'Custom',
        final_dataset: toCloneable(finalDatasetS3Key, 'final_dataset'),
        executionSteps: finalExecutionSteps || [],
      };

      const savedId = await onAutoSave(workflowData, currentWorkflowId);
      if (savedId && !currentWorkflowId) {
        setCurrentWorkflowId(savedId);
      }

      setInitialWorkflowState({ name: workflowName, description: workflowDescription, nodes, edges });
      setHasUnsavedChanges(false);
      // Auto-save just rewrote this workflow's externalized code files, which
      // the on-disk watcher will see. Suppress the resulting reload so we don't
      // bounce the canvas right after saving.
      reloadGuardRef.current.suppressUntil = Date.now() + 3000;
    } catch (error) {
      console.error('Auto-save failed:', error, );
      if (error.message === 'Duplicate workflow name') {
        // message already shown by WorkflowsTab
      } else if (error.response?.status === 404) {
        message.error('Cannot save: Workflow not found. It may have been deleted.');
        setCurrentWorkflowId(null);
      } else if (error.message !== 'Network Error' && error.response) {
        message.error(`Cannot save: ${error.response?.data?.error || error.message || 'Unknown error'}`);
      } else {
        message.error('Cannot save: Network error. Please check your connection.');
      }
      setHasUnsavedChanges(false);
    } finally {
      setSaving(false);
    }
  }, [workflowName, nodes, edges, executionSteps, workflowDescription, currentWorkflowId, saving, onAutoSave]);

  // Debounced auto-save (2 seconds delay)
  // Use ref to store the latest autoSave function
  const autoSaveRef = useRef(autoSave);

  useEffect(() => {
    autoSaveRef.current = autoSave;
  }, [autoSave]);

  // Create a stable debounced function that always calls the latest autoSave
  const debouncedAutoSave = useRef(
    debounce(() => {
      autoSaveRef.current();
    }, 2000)
  ).current;

  // Auto-save when nodes array size changes (nodes added/deleted)
  useEffect(() => {
    if (initialWorkflowState && workflowName.trim()) {
      const currentNodeCount = nodes.length;
      const initialNodeCount = initialWorkflowState.nodes.length;

      if (currentNodeCount !== initialNodeCount) {
        debouncedAutoSave.cancel();
        debouncedAutoSave();
      }
    }
  }, [nodes.length, initialWorkflowState, workflowName]);

  // Auto-save when edges are modified
  useEffect(() => {
    if (initialWorkflowState && workflowName.trim()) {
      const currentEdges = JSON.stringify(edges);
      const initialEdges = JSON.stringify(initialWorkflowState.edges);

      if (currentEdges !== initialEdges) {
        debouncedAutoSave.cancel();
        debouncedAutoSave();
      }
    }
  }, [edges, initialWorkflowState, workflowName]);

  // Auto-save when workflow name or description changes
  useEffect(() => {
    if (initialWorkflowState && workflowName.trim()) {
      const hasNameDescChange = (
        workflowName !== initialWorkflowState.name ||
        workflowDescription !== initialWorkflowState.description
      );

      if (hasNameDescChange) {
        debouncedAutoSave.cancel();
        debouncedAutoSave();
      }
    }
  }, [workflowName, workflowDescription, initialWorkflowState]);

  // Auto-save when sidebar trigger is set
  useEffect(() => {
    if (triggerSidebarSave && workflowName.trim()) {
      setTriggerSidebarSave(false); // Reset the trigger
      debouncedAutoSave.cancel();
      debouncedAutoSave();
    }
  }, [triggerSidebarSave, workflowName]);


  const handleSaveDroppedConnection = async (connectionData) => {
    // Persist the local file connection (same path ConnectionsTab uses for file
    // connections) so we get a connection with an id to reference from the node.
    let saved;
    try {
      saved = await connectionsDb.save(connectionData);
    } catch (error) {
      console.error('Error saving dropped data source:', error);
      message.error('Failed to create data source.');
      return;
    }

    // Close the upload modal
    setIsUploadModalOpen(false);
    setDroppedFile(null);

    // Show success message
    message.success('Data source created successfully! You can now add it to your workflow.');

    // Optionally create a data source node automatically
    if (reactFlowInstance) {
      const newNode = {
        id: `dataSource-${Date.now()}`,
        type: 'dataSource',
        position: { x: 100, y: 100 },
        data: {
          label: 'Data Source',
          config: {
            connectionId: saved.id,
            connectionName: saved.name
          }
        },
      };
      // Auto-connect to start node (same logic as drag-and-drop)
      const startNode = nodes.find(node => node.type === 'start' && node.id === 'start-node');
      console.log('DEBUG - Auto-connection after upload:', { startNode, newNodeId: newNode.id });
      
      if (startNode) {
        // Check if start node is already connected to this specific data source
        const existingConnection = edges.find(edge => edge.source === startNode.id && edge.target === newNode.id);
        
        if (existingConnection) {
          message.warning('This data source is already connected to the start node.');
          return; // Don't add the node if already connected
        }
        
        const newEdge = {
          id: `edge-${startNode.id}-${newNode.id}`,
          source: startNode.id,
          target: newNode.id,
          type: 'default'
        };
        console.log('DEBUG - Creating auto-connection edge after upload:', newEdge);
        
        // Add both node and edge together
        setNodes((nds) => nds.concat(newNode));
        setEdges((eds) => [...eds, newEdge]);
      } else {
        console.log('DEBUG - No start node found for auto-connection after upload');
        setNodes((nds) => nds.concat(newNode));
      }
    }
  };

  const handleUploadCancel = () => {
    setIsUploadModalOpen(false);
    setDroppedFile(null);
  };


  const handleOpenStepsEditor = () => {
    setSaveAfterStepsEditor(false);
    setIsStepsEditorOpen(true);
  };

  const handleSaveWorkflow = () => {
    if (!validateWorkflow()) {
      return;
    }
    // Open steps editor first, then save after steps are saved
    setSaveAfterStepsEditor(true);
    setIsStepsEditorOpen(true);
  };

  const handleExportJSON = () => {
    const workflowData = {
      name: workflowName,
      description: workflowDescription,
      nodes,
      edges,
      nodeCount: nodes.length,
      type: 'Custom',
      executionSteps: executionSteps || [],
      exportedAt: new Date().toISOString(),
    };

    const safeName = (workflowName || 'workflow').replace(/[^a-z0-9-_]+/gi, '_').toLowerCase();
    const blob = new Blob([JSON.stringify(workflowData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    message.success('Workflow exported as JSON');
  };

  const handleStepsEditorClose = () => {
    setIsStepsEditorOpen(false);
    setSaveAfterStepsEditor(false);
  };

  const handleStepsEditorSave = async (savedExecutionSteps) => {
    // Update the workflow state to include execution steps
    setExecutionSteps(savedExecutionSteps);
    setHasUnsavedChanges(true);

    console.log('Execution steps saved to workflow state:', savedExecutionSteps);

    // If Save button was clicked, trigger autoSave instead of calling handleSave directly
    if (saveAfterStepsEditor) {
      setSaveAfterStepsEditor(false);
      // Trigger immediate autoSave using the sidebar save mechanism
      setTriggerSidebarSave(true);

      // Show message that steps are updated (autoSave will handle the actual save)
      message.success('Execution steps updated. Auto-saving workflow...');
    }
  };

  /**
   * Execute the entire workflow
   * Iterates through nodes in order and executes each one
   */
  const handleExecuteWorkflow = async () => {
    if (!nodes || nodes.length === 0) {
      message.warning('No nodes to execute');
      return;
    }

    if (!window.electronAPI?.workflow?.executeWorkflow) {
      message.error('Workflow execution not available');
      return;
    }

    setIsExecuting(true);

    try {
      // Use stored execution steps or auto-generate if none exist
      let finalExecutionSteps = executionSteps;
      if (!finalExecutionSteps || finalExecutionSteps.length === 0) {
        finalExecutionSteps = generateStepsFromNodes(nodes, edges);
      }

      // Send notification that workflow is running
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Ternlux', {
          body: `Workflow "${workflowName || 'Untitled Workflow'}" is now running...`,
          // icon: '/image/ternlux.png'
        });
      } else if (window.Notification && Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            new Notification('Ternlux', {
              body: `Workflow "${workflowName || 'Untitled Workflow'}" is now running...`,
              // icon: '/image/ternlux.png'
            });
          }
        });
      }

      // Start execution
      const result = await window.electronAPI.workflow.executeWorkflow({
        workflowId: currentWorkflowId,
        workflowName: workflowName || 'Untitled Workflow',
        nodes,
        edges,
        executionSteps: finalExecutionSteps
      });

      if (result.success) {
        message.success(`Workflow executed successfully! Execution ID: ${result.executionId}`);

        // Send success notification
        if (window.Notification && Notification.permission === 'granted') {
          new Notification('Ternlux - Workflow Completed', {
            body: `Workflow "${workflowName || 'Untitled Workflow'}" executed successfully!`,
            // icon: '/image/ternlux.png'
          });
        }

        // Refresh data preview if available
        if (handleDataPreviewRefresh) {
          handleDataPreviewRefresh();
        }
      } else {
        message.error(`Workflow execution failed: ${result.message || 'Unknown error'}`);

        // Send failure notification
        if (window.Notification && Notification.permission === 'granted') {
          new Notification('Ternlux - Workflow Failed', {
            body: `Workflow "${workflowName || 'Untitled Workflow'}" failed: ${result.message || 'Unknown error'}`,
            // icon: '/image/ternlux.png'
          });
        }
      }
    } catch (error) {
      console.error('Execute workflow error:', error);
      message.error(`Execution error: ${error.message}`);

      // Send error notification
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Ternlux - Workflow Error', {
          body: `Workflow "${workflowName || 'Untitled Workflow'}" encountered an error: ${error.message}`,
          // icon: '/image/ternlux.png'
        });
      }
    } finally {
      setIsExecuting(false);
    }
  };

  if (editorLoading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="Loading workflow..." />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: "'Inter',-apple-system,sans-serif" }}>
      {/* Header */}
      <div style={{
        padding: '10px 16px 10px 0px',
        borderBottom: '1px solid #e2e6eb',
        background: '#fff',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Input
            placeholder="Enter workflow name"
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: '#111827',
              padding: '2px 0px',
              letterSpacing: '-0.01em',
            }}
            bordered={false}
          />
          <Input.TextArea
            placeholder="Enter workflow description"
            value={workflowDescription}
            onChange={(e) => setWorkflowDescription(e.target.value)}
            rows={1}
            style={{
              fontSize: 11,
              padding: 0,
              marginTop: 6,
              color: '#5a6678',
              resize: 'none',
            }}
            bordered={false}
          />
        </div>
        <Space size={6}>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleExecuteWorkflow}
            disabled={!nodes || nodes.length === 0 || isExecuting}
            loading={isExecuting}
            title="Execute workflow"
            size="small"
            style={{
              borderRadius: 4,
              background: '#2563eb',
              borderColor: '#2563eb',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Execute
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSaveWorkflow}
            disabled={!workflowName.trim() || saving}
            loading={saving}
            title="Save workflow"
            size="small"
            className="workflow-save-button"
          >
            Save
          </Button>
          <Dropdown
            overlay={
              <Menu>
                <Menu.Item
                  key="edit-steps"
                  icon={<SettingOutlined />}
                  disabled={!nodes || nodes.length === 0}
                  onClick={handleOpenStepsEditor}
                >
                  Edit Steps
                </Menu.Item>
                <Menu.Item
                  key="export-json"
                  icon={<ExportOutlined />}
                  disabled={!nodes || nodes.length === 0}
                  onClick={handleExportJSON}
                >
                  Export Workflow
                </Menu.Item>
              </Menu>
            }
            trigger={['click']}
            placement="bottomRight"
          >
            <Button
              size="small"
              icon={<MoreOutlined />}
              style={{ borderRadius: 4, borderColor: '#e2e6eb', color: '#5a6678' }}
            />
          </Dropdown>
          {saving && (
            <span style={{ color: '#2563eb', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
              Auto-saving…
            </span>
          )}
        </Space>
      </div>

      {/* Workflow Editor */}
      <div style={{ flex: 1, position: 'relative' }}>
        <ReactFlowProvider>
          <div className="react-flow-wrapper" ref={reactFlowWrapper} style={{ height: '100%' }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onInit={setReactFlowInstance}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onNodeClick={onNodeClick}
              onNodeContextMenu={onNodeContextMenu}
              onPaneClick={handlePaneClick}
              nodeTypes={nodeTypes}
              fitView
              attributionPosition="top-right"
            >
              <Controls />
              <MiniMap
                style={{
                  background: 'rgba(255,255,255,0.92)',
                  border: '1px solid #e2e6eb',
                  borderRadius: 5,
                }}
                maskColor="rgba(247,249,252,0.6)"
                nodeColor={(n) => {
                  const map = {
                    start: '#2563eb',
                    dataSource: '#0891b2',
                    transformer: '#7c3aed',
                    join: '#d97706',
                    branch: '#059669',
                    output: '#db2777',
                  };
                  return map[n.type] || '#cdd2db';
                }}
              />
              <Background variant="dots" gap={16} size={1.4} color="#cdd2db" />

              {/* Node Types Panel */}
              <Panel position="top-right">
                <NodeTypePanel />
              </Panel>

              {/* Workflow Info */}
              <Panel position="top-left">
                <div className="workflow-toolbar">
                  {nodes.length} nodes · {edges.length} connections
                </div>
              </Panel>
            </ReactFlow>
          </div>
        </ReactFlowProvider>

        {/* Context Menu */}
        {contextMenu && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: contextMenu.y,
              left: contextMenu.x,
              zIndex: 10000,
              backgroundColor: '#fff',
              border: '1px solid #e2e6eb',
              borderRadius: 6,
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
              minWidth: 150,
              overflow: 'hidden',
              fontFamily: "'Inter',-apple-system,sans-serif",
            }}
          >
            <div
              onClick={handleEditNode}
              style={{
                padding: '7px 12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: '#111827',
                transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f7f9fc'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              <EditOutlined style={{ fontSize: 12, color: '#2563eb' }} />
              <span>Edit</span>
            </div>
            <div
              onClick={handleDeleteNode}
              style={{
                padding: '7px 12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#fef2f2'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              <DeleteOutlined style={{ fontSize: 12, color: '#dc2626' }} />
              <span style={{ color: '#dc2626' }}>Delete</span>
            </div>
          </div>
        )}

        {/* Node Configuration Chat Panel */}
        <NodeChatPanel
          isOpen={isSidebarOpen}
          node={selectedNode}
          nodes={nodes}
          edges={edges}
          currentWorkflowId={currentWorkflowId}
          onClose={onCloseSidebar}
          onConfigUpdate={onNodeConfigUpdate}
          onPreviewConfigUpdate={onPreviewConfigUpdate}
          onLoadDatabaseTables={loadDatabaseTables}
          onDataPreviewRefresh={handleDataPreviewRefresh}
        />

        {/* Data Preview Component */}
        <DataPreview
          selectedNode={selectedNode}
          nodes={nodes}
          edges={edges}
          isNodeSidebarOpen={isSidebarOpen}
          onNodeUpdate={onNodeConfigUpdate}
          dbTables={dbTables}
          activeConnection={activeConnection}
          refreshTrigger={dataPreviewRefreshTrigger}
        />

        {/* File Drop Overlay */}
        {isDragOver && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(37, 99, 235, 0.08)',
            border: '2px dashed #2563eb',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            fontFamily: "'Inter',-apple-system,sans-serif",
          }}>
            <div style={{
              textAlign: 'center',
              backgroundColor: '#fff',
              padding: 28,
              border: '1px solid #e2e6eb',
              borderRadius: 8,
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12)'
            }}>
              <CloudUploadOutlined style={{
                fontSize: 48,
                color: '#2563eb',
                marginBottom: 12
              }} />
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: '#111827',
                marginBottom: 6,
                letterSpacing: '-0.01em',
              }}>
                Drop your Excel or CSV file here
              </div>
              <div style={{
                fontSize: 11,
                color: '#5a6678',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                A new data source connection will be created
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Data Source Upload Modal */}
      <Modal
        title="Create Data Source from File"
        open={isUploadModalOpen}
        onCancel={handleUploadCancel}
        footer={null}
        width={640}
        destroyOnClose
      >
        <LocalFileConnectionForm
          fileType="spreadsheet"
          initialFile={droppedFile}
          onSave={handleSaveDroppedConnection}
          onCancel={handleUploadCancel}
        />
      </Modal>

      {/* Workflow Steps Editor */}
      <WorkflowStepsEditor
        open={isStepsEditorOpen}
        onClose={handleStepsEditorClose}
        onSave={handleStepsEditorSave}
        workflow={workflow}
        nodes={nodes}
        edges={edges}
      />
    </div>
  );
};

export default WorkflowEditor;