import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
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
import { SaveOutlined, UndoOutlined, SettingOutlined, EditOutlined, DeleteOutlined, PlayCircleOutlined, ExportOutlined, MoreOutlined, CloseOutlined } from '@ant-design/icons';
import 'reactflow/dist/style.css';

import StartNode from './nodes/StartNode';
import DataSourceNode from './nodes/DataSourceNode';
import TransformerNode from './nodes/TransformerNode';
import JoinNode from './nodes/JoinNode';
import OutputNode from './nodes/OutputNode';
import NodeTypePanel from './NodeTypePanel';
import NodeChatPanel from './NodeChatPanel';
import LocalFileConnectionForm from './connections/LocalFileConnectionForm';
import {
  detectFileType, collectDroppableFiles, fileDragHandlers, FileDropOverlay,
  LOCAL_FILE_MODAL_TITLES,
} from './connections/localFileDrop';
import DataPreview from './DataPreview';
import WorkflowStepsEditor from './WorkflowStepsEditor';
import { generateStepsFromNodes } from '../../utils/workflowUtils';
import { connectionsDb, executionsDb } from '../../utils/localDb';
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

// Which extensions are droppable, and which import form each one opens, is
// owned by connections/localFileDrop so the canvas accepts exactly the files
// the Connections tab does — and hands each to the form that can actually read
// it. Nodes created from consecutive dropped files are fanned out from the drop
// point by this much so they don't land on top of each other.
const DROP_STACK_OFFSET = 48;

const WorkflowEditor = ({ workflow, onSave, onAutoSave, onCancel, onCloseRequest }) => {
  const reactFlowWrapper = useRef(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [saving, setSaving] = useState(false);
  // Dropped-file import, mirroring the Connections tab: one popup per file,
  // opened for whichever form matches that file's type, with the rest of the
  // drop queued behind it. `activeFileType` doubles as the modal's open flag.
  const [activeFileType, setActiveFileType] = useState(null);
  const [droppedFile, setDroppedFile] = useState(null);
  const [fileQueue, setFileQueue] = useState([]); // remaining dropped files waiting for their popup
  const [isDragOver, setIsDragOver] = useState(false);
  // Where on the canvas the files were dropped, and how many of that batch have
  // already produced a node — together they place each new node near the cursor
  // instead of stacking every one at a fixed spot.
  const dropOriginRef = useRef(null);
  const dropIndexRef = useRef(0);
  // Set true when the user cancels (X / Cancel) so an in-flight import that
  // finishes afterwards doesn't persist the connection or open the next file.
  const importCancelledRef = useRef(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [initialWorkflowState, setInitialWorkflowState] = useState(null);
  const [isStepsEditorOpen, setIsStepsEditorOpen] = useState(false);
  const [executionSteps, setExecutionSteps] = useState([]);
  const [triggerSidebarSave, setTriggerSidebarSave] = useState(false);
  const [currentWorkflowId, setCurrentWorkflowId] = useState(workflow?.id || null);
  // Nodes write files (local NeDB collections) as soon as they execute, which
  // can be well before the workflow is first saved. currentWorkflowId stays
  // null until then — it doubles as the "already persisted?" flag for the save
  // path — so this ref carries an id from the moment the editor opens and is
  // what file scoping keys on. workflowsDb.save honours a supplied id, so the
  // provisional value becomes the real one on first save rather than being
  // replaced (which would orphan anything already written under it).
  const workflowScopeIdRef = useRef(workflow?.id || `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const newScopeId = () => `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // The current graph, readable from window-event handlers that are registered
  // once and would otherwise close over a stale render's nodes/edges.
  const nodesRef = useRef([]);
  const edgesRef = useRef([]);
  const [editorLoading, setEditorLoading] = useState(!!workflow?.id);
  const [saveAfterStepsEditor, setSaveAfterStepsEditor] = useState(false);
  // Temp-state save: auto-save persists work-in-progress but marks the record
  // as "temp" (tempStateSave: true). The user must click Save and verify the
  // Execution Steps to commit a real save (which clears the flag). Execute and
  // Close are gated on this so unverified changes aren't run or lost silently.
  const [tempStateSave, setTempStateSave] = useState(false);
  // Controlled 3-button "unsaved changes" prompt shown on Execute/Close when
  // there are uncommitted changes. intent = 'close' | 'execute'.
  const [unsavedPrompt, setUnsavedPrompt] = useState({ open: false, intent: null });
  // After an explicit save completes (via the steps editor), perform this
  // deferred action: 'close' | 'execute' | null.
  const [pendingAction, setPendingAction] = useState(null);

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
  // A still-running execution for this workflow (detected on open or while a
  // run is in progress), so the editor reflects an in-flight run even after
  // being reopened.
  const [runningExecution, setRunningExecution] = useState(null);

  // Poll for an in-progress execution of the current workflow. This keeps the
  // "running" indicator accurate when the editor is reopened mid-run and clears
  // it (refreshing the preview) once the run finishes.
  useEffect(() => {
    if (!currentWorkflowId) { setRunningExecution(null); return; }
    let cancelled = false;

    const check = async () => {
      try {
        const running = await executionsDb.getRunningByWorkflow(currentWorkflowId);
        if (cancelled) return;
        setRunningExecution(prev => {
          // A run we were tracking just finished — refresh the data preview.
          if (prev && !running) setDataPreviewRefreshTrigger(t => t + 1);
          return running;
        });
      } catch (err) {
        console.error('Error checking for running execution:', err);
      }
    };

    check();
    const interval = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [currentWorkflowId]);

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

  // Clear dbTables when the selected node isn't a configured data source.
  // Both database AND file (local SQLite/NeDB) sources populate the Schema
  // tab, so we must not wipe file sources here — doing so left the Schema tab
  // empty for configured local sources even though Preview worked (TLX-005).
  useEffect(() => {
    const connType = selectedNode?.data?.config?.connectionType;
    const isConfiguredSource =
      selectedNode?.type === 'dataSource' &&
      (connType === 'database' || connType === 'file');
    if (!isConfiguredSource) {
      setDbTables([]);
      setActiveConnection(null);
    }
  }, [selectedNode?.id, selectedNode?.type, selectedNode?.data?.config?.connectionType]);

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
      if (fullWorkflow.id) workflowScopeIdRef.current = fullWorkflow.id;
      setTempStateSave(!!fullWorkflow.tempStateSave);

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
      workflowScopeIdRef.current = newScopeId();
      setTempStateSave(false);
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
      workflowScopeIdRef.current = newScopeId();
      setTempStateSave(false);

      setInitialWorkflowState({
        name: '',
        description: '',
        nodes: [startNode],
        edges: []
      });
      setEditorLoading(false);
    }
  }, [workflow, setNodes, setEdges, loadWorkflowFromDb]);

  // Latest code-change handler, kept in a ref so the watcher-registration
  // effect below can depend ONLY on currentWorkflowId. If the effect also
  // depended on loadWorkflowFromDb (or an inline closure over it), every render
  // that changed that identity would tear the watcher down and re-create it —
  // producing the rapid "Watching / Stopped watching" churn — and each teardown
  // fires racy async unwatch/watch IPC. Routing through a ref means the watcher
  // is registered exactly once per workflow id while still calling the latest
  // logic (fresh loadWorkflowFromDb / guard state) on every event.
  const codeChangedHandlerRef = useRef(() => {});
  codeChangedHandlerRef.current = (workflowId, wfId) => {
    if (workflowId !== wfId) return;
    const guard = reloadGuardRef.current;
    if (guard.saving || Date.now() < guard.suppressUntil) return;
    if (guard.hasUnsavedChanges) {
      message.warning('Workflow code changed on disk, but you have unsaved canvas edits — not reloaded.');
      return;
    }
    loadWorkflowFromDb(wfId, { isReload: true });
  };

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
      codeChangedHandlerRef.current(workflowId, wfId);
    });

    return () => {
      unsubscribe();
      api.unwatchCode(wfId);
    };
  }, [currentWorkflowId]);

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
    // Uncommitted work exists if there are unsaved edits OR the last save was a
    // background temp save the user hasn't committed. Prompt with Save / Don't
    // save / Cancel so the temp state is covered by an explicit save on close.
    if (hasUnsavedChanges || tempStateSave) {
      setUnsavedPrompt({ open: true, intent: 'close' });
    } else {
      onCancel();
    }
  }, [hasUnsavedChanges, tempStateSave, onCancel]);

  // Register close request handler with parent
  useEffect(() => {
    if (onCloseRequest) {
      onCloseRequest(handleCancel);
    }
  }, [onCloseRequest, handleCancel]);

  // A node can only be a parent (the source of a connection) once it has been
  // configured AND run — otherwise it has no output for the child node to
  // consume, and the failure only surfaces later as an opaque downstream error.
  // Checking it here lets us show the user a clear, actionable message instead.
  const isNodeConfiguredAndRun = (node) => {
    const cfg = node?.data?.config || {};
    switch (node?.type) {
      case 'start':
        // Root node — nothing to configure/run before it can feed data sources.
        return true;
      case 'dataSource': {
        const connectionId = cfg.sourceConnectionId || cfg.connectionId;
        const isApiSource = cfg.sourceDbCategory === 'API' || cfg.sourceConnectionType === 'api';
        if (isApiSource) {
          // A REST API source only has data once its fetch function has run.
          return !!(cfg.sourceLocalPath && cfg.apiFetchCode);
        }
        // A regular source is "run" once a connection and a table/collection/
        // query/materialised file are in place.
        const hasOutput = !!(cfg.sourceTableName || cfg.sourceCollection ||
          cfg.sourcePreviewSql || cfg.sourceLocalPath || cfg.sourceIndexName);
        return !!connectionId && hasOutput;
      }
      case 'transformer':
      case 'join':
        // A transform/join has run once its output is materialised. The output
        // location is set the same way regardless of mode — SQL, NoSQL, or a
        // Python/JavaScript/vector-db skill — so check the mode-agnostic target
        // markers rather than SQL-only fields (targetPreviewSql is absent for
        // several of those modes).
        return !!(cfg.targetConnectionId && (
          cfg.targetTableName || cfg.targetCollection ||
          cfg.targetLocalPath || cfg.targetPreviewSql
        ));
      default:
        // Branch and any future types: don't block.
        return true;
    }
  };

  const onConnect = useCallback((params) => {
    // Get the source and target nodes
    const sourceNode = nodes.find(node => node.id === params.source);
    const targetNode = nodes.find(node => node.id === params.target);

    if (!sourceNode || !targetNode) {
      message.error('Invalid connection attempt');
      return;
    }

    // A node with no output yet cannot feed another node. Without this guard the
    // edge forms silently and only errors later, deep in execution.
    if (!isNodeConfiguredAndRun(sourceNode)) {
      message.error('Please configure and run this node before connecting it to another node.');
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

  // While an import popup is open it owns the drop — see fileDragHandlers.
  const dropDisabled = Boolean(activeFileType);
  const { onDragOver, onDragLeave } = useMemo(
    () => fileDragHandlers(setIsDragOver, dropDisabled), [dropDisabled]);

  // Open the import popup for the next queued file, storing the rest so it can
  // be resumed after this one is saved. When the queue is empty everything is
  // closed. The file is only read once its popup mounts (see the
  // LocalFileConnectionForm initialFile effect), so nothing imports early.
  const processNextFile = useCallback((remaining) => {
    if (!remaining || remaining.length === 0) {
      setActiveFileType(null);
      setDroppedFile(null);
      setFileQueue([]);
      return;
    }
    importCancelledRef.current = false; // fresh popup — this file's import is allowed
    const [next, ...rest] = remaining;
    setFileQueue(rest);
    setDroppedFile(next);
    setActiveFileType(detectFileType(next.name));
  }, []);

  const onDrop = useCallback(
    (event) => {
      if (dropDisabled) return;
      event.preventDefault();
      setIsDragOver(false);

      // Files dropped on the canvas become data sources, one popup at a time,
      // exactly as they do on the Connections tab.
      if (event.dataTransfer.files?.length > 0) {
        // The editor is itself inside the Workflows tab's modal, whose own drop
        // target would otherwise see this too and bounce to Connections.
        event.stopPropagation();

        const validFiles = collectDroppableFiles(event);
        if (validFiles.length === 0) return;

        // Remember where they landed so the nodes appear under the cursor.
        const bounds = reactFlowWrapper.current?.getBoundingClientRect();
        dropOriginRef.current = bounds && reactFlowInstance
          ? reactFlowInstance.project({
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          })
          : null;
        dropIndexRef.current = 0;

        processNextFile(validFiles);
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
    [reactFlowInstance, setNodes, setEdges, nodes, edges, processNextFile, dropDisabled]
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
    // Everything the clicked node is carrying — the raw node (position, data)
    // and its full config, chat transcript and schemas included, plus how it
    // is wired. Logged as live objects so the console can expand them.
    console.log('[WorkflowEditor] node clicked:', node );

    // Close context menu if open
    setContextMenu(null);
    setContextMenuNode(null);

    // Check if node has required inputs (transformer needs 1 upstream, join 2).
    const canOpenSidebar = canNodeOpenSidebar(node, nodes, edges);
    if (!canOpenSidebar) {
      message.warning(getNodeRequirementMessage(node));
      return;
    }

    // Transformer/Join are configured through the chat assistant (which targets
    // the focused node), NOT the per-node sidebar. Selecting them shows the
    // DataPreview (Details tab) and focuses the chat via the node-focus effect.
    if (node.type === 'transformer' || node.type === 'join') {
      setSelectedNode(node);
      setIsSidebarOpen(false);
    } else {
      // Data Source / Start / Output — option-picking config in the sidebar.
      setSelectedNode(node);
      setIsSidebarOpen(true);
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

      if (!canOpenSidebar) {
        message.warning(getNodeRequirementMessage(contextMenuNode));
      } else if (contextMenuNode.type === 'transformer' || contextMenuNode.type === 'join') {
        // Chat-configured — select (shows Details + focuses chat), no sidebar.
        setSelectedNode(contextMenuNode);
        setIsSidebarOpen(false);
      } else {
        setSelectedNode(contextMenuNode);
        setIsSidebarOpen(true);
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
    // Clicking empty canvas takes the node out of focus — same as the Data
    // Preview close button (closes the preview and clears the chat's focus).
    setSelectedNode(null);
    setIsSidebarOpen(false);
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

  // ── Chat-assistant node targeting ────────────────────────────────────────
  // Build the payload the ChatAssistant sends to chat:step as `targetNode`, so
  // the main prompt can route to the transformer/join (or REST-API dataSource)
  // builder for THIS node. Only chat-configured node types are targetable.
  const buildTargetNodePayload = useCallback((node) => {
    if (!node) return null;
    const type = node.type;
    const cfg = node.data?.config || {};
    const isApiDS = type === 'dataSource' &&
      (cfg.sourceConnectionType === 'api' || cfg.sourceDbType === 'rest-api' || cfg.dbType === 'rest-api');
    if (type !== 'transformer' && type !== 'join' && !isApiDS) return null;
    try {
      const upstreamNodes = edges
        .filter((e) => e.target === node.id)
        .map((e) => nodes.find((n) => n.id === e.source))
        .filter(Boolean);
      return {
        // The scope id, not currentWorkflowId: a chat build can write files
        // before the workflow has ever been saved.
        workflowId: workflowScopeIdRef.current || currentWorkflowId || null,
        nodeId: node.id,
        type,
        label: node.data?.label || type,
        config: toCloneable(node.data?.config || {}, 'targetNode.config'),
        upstreamNodes: toCloneable(upstreamNodes, 'targetNode.upstream'),
        connectionId: isApiDS ? (cfg.sourceApiConnectionId || cfg.sourceConnectionId || null) : null,
        isApi: !!isApiDS,
      };
    } catch (e) {
      console.warn('[WorkflowEditor] could not build targetNode payload:', e);
      return null;
    }
  }, [nodes, edges, currentWorkflowId]);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // Broadcast the focused node to the ChatAssistant. It re-fires when the
  // node's config changes (e.g. right after a build) so the chat always has
  // the current SQL/JS for refinement. Clears focus when nothing is selected.
  useEffect(() => {
    const payload = selectedNode ? buildTargetNodePayload(selectedNode) : null;
    window.dispatchEvent(new CustomEvent('ternlux:node-focus', { detail: payload }));
    // Fire only when the selection or its config changes (not on every canvas
    // drag/highlight). buildTargetNodePayload is intentionally excluded — it
    // reads the current nodes/edges at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode?.id, selectedNode?.data?.config]);

  // Closing the workflow takes the canvas — and therefore the focused node —
  // away with it. The assistant outlives this editor, so drop the focus on the
  // way out or it keeps offering to edit a node that is no longer on screen.
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('ternlux:node-focus', { detail: null }));
  }, []);

  // Apply a config the ChatAssistant built for a node (via build_transformer /
  // build_join / build_dataSource). Writes it onto the node + the selectedNode
  // snapshot, flags unsaved, and refreshes the preview.
  useEffect(() => {
    const handler = (e) => {
      const nb = e.detail;
      if (!nb || !nb.nodeId || !nb.config) return;
      setNodes((prev) => prev.map((n) => n.id === nb.nodeId
        ? { ...n, data: { ...n.data, config: { ...(n.data?.config || {}), ...nb.config } } }
        : n));
      setSelectedNode((prev) => (prev && prev.id === nb.nodeId
        ? { ...prev, data: { ...prev.data, config: { ...(prev.data?.config || {}), ...nb.config } } }
        : prev));
      setHasUnsavedChanges(true);
      // `partial` = a follow-up chat commit (question/answer only), not a build.
      if (!nb.partial) {
        message.success(`Updated ${nb.nodeType || 'node'} configuration from chat.`);
        if (handleDataPreviewRefresh) handleDataPreviewRefresh();
      }
    };
    window.addEventListener('ternlux:apply-node-config', handler);
    return () => window.removeEventListener('ternlux:apply-node-config', handler);
  }, [setNodes]);

  // Run one node on the chat assistant's behalf. The assistant holds the
  // approval UI but not the graph, so it asks here and we answer through the
  // `resolve` callback the event carries (same renderer — a function in the
  // detail is fine). Nodes are read out of setNodes rather than the closure so
  // a config applied moments ago is already in what we send.
  useEffect(() => {
    const handler = (e) => {
      const { nodeId, resolve } = e.detail || {};
      const done = typeof resolve === 'function' ? resolve : () => {};
      if (!nodeId) { done({ success: false, message: 'No node was named.' }); return; }
      (async () => {
        try {
          if (!window.electronAPI?.workflow?.executeNode) {
            done({ success: false, message: 'Node execution is not available.' });
            return;
          }
          const result = await window.electronAPI.workflow.executeNode({
            workflowId: workflowScopeIdRef.current || currentWorkflowId || null,
            nodeId,
            // Same sanitization the full-run path needs: live nodes carry Arrow
            // vectors and circular refs that cannot cross IPC.
            nodes: toCloneable(nodesRef.current, 'nodes'),
            edges: toCloneable(edgesRef.current, 'edges'),
          });
          if (result?.success && handleDataPreviewRefresh) handleDataPreviewRefresh();
          done(result || { success: false, message: 'No result returned.' });
        } catch (err) {
          done({ success: false, message: err.message || String(err) });
        }
      })();
    };
    window.addEventListener('ternlux:execute-node', handler);
    return () => window.removeEventListener('ternlux:execute-node', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkflowId]);

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

  // A REST API data source has no form fields beyond the connection — once it
  // is saved the request itself is described in the chat. Close the form (the
  // node panel and the assistant share the same corner, so the assistant is
  // hidden while it is open) and open the assistant, which picks this node up
  // through the ternlux:node-focus broadcast below.
  const handleRequestChatHandoff = useCallback((nodeId) => {
    setIsSidebarOpen(false);
    window.dispatchEvent(new CustomEvent('ternlux:open-chat', { detail: { nodeId } }));
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

        if (connection.dbType === 'duckdb') {
          // A local file records its tables when it is added — one per sheet
          // for a workbook, otherwise just the file itself. Nothing to query.
          const tableList = (connection.fileInfo?.tables || [])
            .map((t) => ({ name: typeof t === 'string' ? t : t?.name }))
            .filter((t) => t.name);

          if (tableList.length === 0) {
            console.error('No tables recorded for local file connection', connection.name);
            return { success: false, tables: [] };
          }

          setDbTables(tableList.map((t) => ({ name: t.name, schema: null })));
          return { success: true, tables: tableList };
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
        // Pin the id the editor has been scoping files under, so the first
        // save adopts it instead of minting a different one.
        id: currentWorkflowId || workflowScopeIdRef.current,
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

  // Auto-save with debouncing to avoid excessive API calls.
  // `explicit` = true → a committed save (Save button, after verifying steps):
  //   clears the temp-state flag. `explicit` = false → a background temp save
  //   (marks the record tempStateSave: true). Returns true on success so
  //   callers can perform a deferred action (close/execute) only if it saved.
  const autoSave = useCallback(async ({ explicit = false, executionStepsOverride = null, outputValidation = null } = {}) => {
    if (saving) {
      // Don't auto-save if already saving
      return false;
    }

    if (!workflowName.trim()) {
      // Don't auto-save if workflow doesn't have a name
      message.warning('Cannot save: Please enter a workflow name');
      return false;
    }

    // Custom validation for auto-save with error messages
    if (nodes.length === 0) {
      message.warning('Cannot save: Workflow must have at least one node');
      return false;
    }

    // Check if there's a start node
    const hasStart = nodes.some(node => node.type === 'start');
    if (!hasStart) {
      message.warning('Cannot save: Workflow must have a Start node');
      return false;
    }

    // Check if there's at least one data source node
    const hasDataSource = nodes.some(node => node.type === 'dataSource');
    if (!hasDataSource) {
      message.warning('Cannot save: Workflow must have at least one Data Source node');
      return false;
    }

    // Check if start node is connected to at least one data source
    const startNode = nodes.find(node => node.type === 'start');
    if (startNode) {
      const startConnections = edges.filter(edge => edge.source === startNode.id);
      if (startConnections.length === 0) {
        message.warning('Cannot save: Start node must be connected to at least one Data Source');
        return false;
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

      let finalExecutionSteps = executionStepsOverride || executionSteps;
      if (!finalExecutionSteps.length && nodes.length > 0) {
        finalExecutionSteps = generateStepsFromNodes(nodes, edges);
      }

      const workflowData = {
        // Pin the id the editor has been scoping files under, so the first
        // save adopts it instead of minting a different one.
        id: currentWorkflowId || workflowScopeIdRef.current,
        name: workflowName,
        description: workflowDescription,
        nodes: toCloneable(nodes, 'nodes'),
        edges: toCloneable(edges, 'edges'),
        nodeCount: nodes.length,
        type: 'Custom',
        final_dataset: toCloneable(finalDatasetS3Key, 'final_dataset'),
        executionSteps: finalExecutionSteps || [],
        // A background auto-save is a temporary, unverified snapshot; an
        // explicit Save (after the user verifies Execution Steps) commits it.
        tempStateSave: !explicit,
        // Output-validation toggle/function from the steps editor. Only included
        // when set so the DB $set merge leaves any existing field alone otherwise.
        ...(outputValidation ? { outputValidation } : {}),
      };

      // Arm the reload guard BEFORE the save writes any code files. onAutoSave
      // rewrites this workflow's externalized code on disk, which the watcher
      // sees; arming here (not just after) guarantees the guard is already in
      // place when chokidar emits, so a slow save can't lose the race and bounce
      // the canvas.
      reloadGuardRef.current.suppressUntil = Date.now() + 3000;
      const savedId = await onAutoSave(workflowData, currentWorkflowId);
      if (savedId && !currentWorkflowId) {
        setCurrentWorkflowId(savedId);
      }

      if (executionStepsOverride) setExecutionSteps(finalExecutionSteps);
      setInitialWorkflowState({ name: workflowName, description: workflowDescription, nodes, edges });
      setHasUnsavedChanges(false);
      setTempStateSave(!explicit);
      if (explicit) message.success('Workflow saved');
      // Re-extend the guard past the save's own writes (chokidar's
      // awaitWriteFinish delays emission ~500ms after the last write settles).
      reloadGuardRef.current.suppressUntil = Date.now() + 3000;
      return true;
    } catch (error) {
      console.error('Auto-save failed:', error, );
      if (error.message === 'Duplicate workflow name') {
        // message already shown by WorkflowsTab
      } else if (error.response?.status === 404) {
        message.error('Cannot save: Workflow not found. It may have been deleted.');
        setCurrentWorkflowId(null);
      } else if (error.response) {
        message.error(`Cannot save: ${error.response?.data?.error || error.message || 'Unknown error'}`);
      } else if (error.message === 'Network Error') {
        message.error('Cannot save: Network error. Please check your connection.');
      } else {
        // Local failure (e.g. serialization / IPC error) — surface the real
        // message instead of blaming the network for a local operation.
        message.error(`Cannot save: ${error.message || 'Unknown error'}`);
      }
      setHasUnsavedChanges(false);
      return false;
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

  // Create a stable debounced function that always calls the latest autoSave.
  //
  // AUTO-SAVE DISABLED: background auto-save is commented out so that nothing is
  // persisted until the user explicitly clicks Save. Previously a background
  // auto-save wrote changes to the workflow record, which meant "Don't save" in
  // the unsaved-changes prompt could not truly discard — the state had already
  // been persisted. With auto-save off, "Don't save" really discards, and the
  // only path that writes to the DB is the explicit Save (which calls
  // autoSave({ explicit: true }) directly after the user verifies the steps).
  //
  // The debounce wrapper is kept (as a no-op) so the effects below can still
  // call debouncedAutoSave() / .cancel() without breaking. To re-enable
  // auto-save, restore the `autoSaveRef.current();` call below.
  const debouncedAutoSave = useRef(
    debounce(() => {
      // autoSaveRef.current();  // ← re-enable to turn background auto-save back on
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


  // Cancelling drops the whole batch: this file isn't saved and the queued ones
  // never open. Matches the Connections tab, where ✕ / Cancel exits the
  // multi-file flow rather than advancing through it.
  const handleUploadCancel = () => {
    importCancelledRef.current = true; // stop any in-flight import from advancing
    setActiveFileType(null);
    setDroppedFile(null);
    setFileQueue([]);
    dropOriginRef.current = null;
    dropIndexRef.current = 0;
  };

  // Place a node for a freshly imported file near where the batch was dropped,
  // fanning consecutive files out diagonally so they stay individually clickable.
  const droppedNodePosition = () => {
    const origin = dropOriginRef.current || { x: 100, y: 100 };
    const step = dropIndexRef.current * DROP_STACK_OFFSET;
    dropIndexRef.current += 1;
    return { x: origin.x + step, y: origin.y + step };
  };

  const handleSaveDroppedConnection = async (connectionData) => {
    // The user hit ✕/Cancel while this file's import was still running — abort
    // the whole flow: don't save this connection and don't open the next file.
    // handleUploadCancel already cleared the state; the flag is reset by
    // processNextFile when the next drop opens a popup.
    if (importCancelledRef.current) return;

    // Persist the local file connection (same path ConnectionsTab uses for file
    // connections) so we get a connection with an id to reference from the node.
    let saved;
    try {
      saved = await connectionsDb.save(connectionData);
    } catch (error) {
      console.error('Error saving dropped data source:', error);
      message.error('Failed to create data source.');
      return; // leave the popup open so the user can retry or cancel
    }

    message.success(`Data source "${saved.name}" created.`);

    // Add a data source node for it, wired to the start node the same way a
    // node dragged from the palette is.
    const newNode = {
      id: `dataSource-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'dataSource',
      position: droppedNodePosition(),
      data: {
        label: 'Data Source',
        config: {
          connectionId: saved.id,
          connectionName: saved.name,
        },
      },
    };
    const startNode = nodesRef.current.find(node => node.type === 'start' && node.id === 'start-node');
    if (startNode) {
      setNodes((nds) => nds.concat(newNode));
      setEdges((eds) => [...eds, {
        id: `edge-${startNode.id}-${newNode.id}`,
        source: startNode.id,
        target: newNode.id,
        type: 'default',
      }]);
    } else {
      setNodes((nds) => nds.concat(newNode));
    }

    // Advance to the next dropped file (if any); otherwise this closes the popup.
    processNextFile(fileQueue);
  };


  const handleOpenStepsEditor = () => {
    setSaveAfterStepsEditor(false);
    setIsStepsEditorOpen(true);
  };

  const handleSaveWorkflow = () => {
    // The Save button is always clickable (never silently disabled). Give clear
    // feedback instead of a dead "not-allowed" cursor.
    if (saving) {
      message.warning('A save is already in progress. Please wait…');
      return;
    }
    if (!validateWorkflow()) {
      // validateWorkflow shows a specific message (e.g. "Please enter a
      // workflow name") — nothing more to do.
      return;
    }
    // Open steps editor first, then commit an explicit save after the user
    // verifies the Execution Steps.
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
    // Cancelling the steps editor abandons any deferred close/execute action.
    setPendingAction(null);
  };

  // Lightweight goal-drift check after an explicit save. Only fires when the
  // saved validation function is the SAME one that came in (user didn't
  // regenerate). One cheap AI call (skipped in the backend when structure is
  // unchanged); on drift, offers to regenerate against the just-saved workflow.
  const maybeOfferRevalidation = async (outputValidation, savedExecutionSteps) => {
    try {
      const priorFn = workflow?.outputValidation?.validationFunction || null;
      const savedFn = outputValidation?.validationFunction || null;
      if (!outputValidation?.enabled || !savedFn || savedFn !== priorFn) return;

      const wfId = currentWorkflowId || workflowScopeIdRef.current;
      const savedWorkflow = toCloneable({
        id: wfId,
        nodes,
        edges,
        executionSteps: savedExecutionSteps,
        outputValidation,
      }, 'driftCheck');
      const drift = await window.electronAPI.workflow.checkValidationDrift({ workflow: savedWorkflow });
      if (!drift?.drifted) return;

      Modal.confirm({
        title: 'Validation may be out of date',
        content: drift.reason || 'This workflow changed since its output-validation function was written. Regenerate it to match the current pipeline?',
        okText: 'Regenerate',
        cancelText: 'Keep current',
        onOk: async () => {
          const res = await window.electronAPI.workflow.generateValidation({ workflowId: wfId });
          if (res?.success) message.success('Validation regenerated');
          else message.error(res?.message || 'Failed to regenerate validation');
        },
      });
    } catch (_) {
      // Drift check is best-effort — never block the save on it.
    }
  };

  const handleStepsEditorSave = async (savedExecutionSteps, opts = {}) => {
    // Update the workflow state to include execution steps
    setExecutionSteps(savedExecutionSteps);
    const outputValidation = opts.outputValidation || null;

    console.log('Execution steps saved to workflow state:', savedExecutionSteps);

    if (saveAfterStepsEditor) {
      setSaveAfterStepsEditor(false);
      setIsStepsEditorOpen(false);
      // Commit an EXPLICIT save now that the user has verified the steps. This
      // clears the temp-state flag. Pass the just-saved steps directly to avoid
      // reading stale state.
      const ok = await autoSave({ explicit: true, executionStepsOverride: savedExecutionSteps, outputValidation });
      const action = pendingAction;
      setPendingAction(null);
      if (!ok) return; // save failed/validation — stay in the editor
      // Goal-drift check: if we just saved a PRE-EXISTING validation function the
      // user did not regenerate, verify it still fits the (possibly edited)
      // workflow and offer to regenerate. Non-blocking; the deferred action still
      // proceeds below.
      maybeOfferRevalidation(outputValidation, savedExecutionSteps);
      // Perform any action the user deferred behind the save (close/execute).
      if (action === 'close') {
        onCancel();
      } else if (action === 'execute') {
        doExecuteWorkflow();
      }
    } else {
      // Steps edited without an immediate save request — mark as unsaved so the
      // change is picked up by the next save/close.
      setHasUnsavedChanges(true);
    }
  };

  /**
   * Execute button entry point. Gate on uncommitted changes first: if there are
   * unsaved edits or an uncommitted temp save, prompt the user to save (verify
   * Execution Steps) before running, so a run never executes unverified state.
   */
  const handleExecuteWorkflow = async () => {
    if (!nodes || nodes.length === 0) {
      message.warning('No nodes to execute');
      return;
    }
    if (hasUnsavedChanges || tempStateSave) {
      setUnsavedPrompt({ open: true, intent: 'execute' });
      return;
    }
    doExecuteWorkflow();
  };

  /**
   * Execute the entire workflow (no save-gate — call only after the gate).
   * Iterates through nodes in order and executes each one.
   */
  const doExecuteWorkflow = async () => {
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

      // Start execution. Strip non-structured-cloneable values (Arrow Vectors,
      // functions, circular refs) first — the same sanitization the save path
      // uses. Without this, executing a saved multi-node workflow fails at the
      // IPC boundary with "An object could not be cloned".
      const result = await window.electronAPI.workflow.executeWorkflow({
        workflowId: currentWorkflowId,
        workflowName: workflowName || 'Untitled Workflow',
        nodes: toCloneable(nodes, 'nodes'),
        edges: toCloneable(edges, 'edges'),
        executionSteps: toCloneable(finalExecutionSteps, 'executionSteps')
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

  // ── Unsaved-changes prompt (Save / Don't save / Cancel) ──────────────────
  // Shown from Execute and Close when there are uncommitted changes.
  const handlePromptSave = () => {
    const intent = unsavedPrompt.intent;
    setUnsavedPrompt({ open: false, intent: null });
    if (saving) {
      message.warning('A save is already in progress. Please wait…');
      return;
    }
    if (!validateWorkflow()) {
      // e.g. missing name — user must fix, then retry close/execute.
      return;
    }
    // Route through the steps editor: the user verifies Execution Steps, then
    // an explicit save commits and the deferred action (close/execute) runs.
    setPendingAction(intent);
    setSaveAfterStepsEditor(true);
    setIsStepsEditorOpen(true);
  };

  const handlePromptDontSave = () => {
    const intent = unsavedPrompt.intent;
    setUnsavedPrompt({ open: false, intent: null });
    if (intent === 'close') {
      onCancel();
    } else if (intent === 'execute') {
      doExecuteWorkflow();
    }
  };

  const handlePromptCancel = () => {
    setUnsavedPrompt({ open: false, intent: null });
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
      {/* Header. The modal's own close button is turned off (closable={false}
          in WorkflowsTab) so the ✕ can live here, aligned with the other
          actions and inside the same padding as the name and description. */}
      <div style={{
        padding: '12px 20px',
        borderBottom: '1px solid #e2e6eb',
        background: '#fff',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Borderless inputs are pulled left by their own padding so the text
              lines up with the header's edge, and get it back on hover/focus
              so they still read as editable fields. */}
          <Input
            placeholder="Enter workflow name"
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            className="workflow-title-input"
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: '#111827',
              padding: '2px 6px',
              marginLeft: -6,
              letterSpacing: '-0.02em',
              borderRadius: 4,
            }}
            bordered={false}
          />
          <Input.TextArea
            placeholder="Enter workflow description"
            value={workflowDescription}
            onChange={(e) => setWorkflowDescription(e.target.value)}
            autoSize={{ minRows: 1, maxRows: 2 }}
            className="workflow-title-input"
            style={{
              fontSize: 12,
              lineHeight: 1.45,
              padding: '2px 6px',
              marginLeft: -6,
              marginTop: 2,
              color: '#5a6678',
              resize: 'none',
              borderRadius: 4,
            }}
            bordered={false}
          />
        </div>
        <Space size={6}>
          {runningExecution && (
            <span
              title={`Execution ${runningExecution.executionId} is running`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 10px', borderRadius: 4,
                background: 'rgba(37,99,235,0.16)', border: '1px solid rgba(37,99,235,0.4)',
                color: '#1d4ed8', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
              }}
            >
              <Spin size="small" /> Running…
            </span>
          )}
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleExecuteWorkflow}
            disabled={!nodes || nodes.length === 0 || isExecuting || !!runningExecution}
            loading={isExecuting || !!runningExecution}
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
            loading={saving}
            title="Save workflow"
            size="small"
            className="workflow-save-button"
          >
            {saving ? 'Saving…' : 'Save'}
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
          {/* Separated from the actions so it never reads as one of them —
              it still routes through handleCancel, so unsaved work prompts. */}
          <span style={{ width: 1, height: 20, background: '#e2e6eb', margin: '0 4px' }} />
          <Button
            size="small"
            icon={<CloseOutlined />}
            onClick={handleCancel}
            title="Close workflow"
            aria-label="Close workflow"
            style={{ borderRadius: 4, borderColor: '#e2e6eb', color: '#5a6678' }}
          />
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
          workflowScopeId={workflowScopeIdRef.current}
          onClose={onCloseSidebar}
          onConfigUpdate={onNodeConfigUpdate}
          onPreviewConfigUpdate={onPreviewConfigUpdate}
          onLoadDatabaseTables={loadDatabaseTables}
          onDataPreviewRefresh={handleDataPreviewRefresh}
          onRequestChatHandoff={handleRequestChatHandoff}
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
          onClose={() => { setSelectedNode(null); setIsSidebarOpen(false); }}
        />

        {/* File Drop Overlay */}
        {isDragOver && <FileDropOverlay title="Drop a file to add a data source" />}
      </div>

      {/* Dropped-file import — same form, titles and one-popup-per-file flow as
          the Connections tab, opened for the type the dropped file actually is. */}
      {activeFileType && (
        <Modal
          // Remount the form per dropped file so its name/state resets cleanly
          // between consecutive uploads of the same file type.
          key={droppedFile ? `${droppedFile.name}-${droppedFile.lastModified}` : activeFileType}
          title={LOCAL_FILE_MODAL_TITLES[activeFileType] || 'Create Data Source from File'}
          open
          onCancel={handleUploadCancel}
          footer={null}
          width={640}
          destroyOnClose
        >
          <LocalFileConnectionForm
            fileType={activeFileType}
            initialFile={droppedFile}
            onSave={handleSaveDroppedConnection}
            onCancel={handleUploadCancel}
          />
        </Modal>
      )}

      {/* Workflow Steps Editor */}
      <WorkflowStepsEditor
        open={isStepsEditorOpen}
        onClose={handleStepsEditorClose}
        onSave={handleStepsEditorSave}
        workflow={workflow}
        nodes={nodes}
        edges={edges}
      />

      {/* Unsaved-changes prompt (Save / Don't save / Cancel). Save opens the
          Edit Execution Steps editor, then commits an explicit save. */}
      <Modal
        open={unsavedPrompt.open}
        title="Unsaved changes"
        onCancel={handlePromptCancel}
        maskClosable={false}
        footer={[
          <Button key="cancel" onClick={handlePromptCancel}>
            Cancel
          </Button>,
          <Button key="dontsave" danger onClick={handlePromptDontSave}>
            Don't save
          </Button>,
          <Button key="save" type="primary" icon={<SaveOutlined />} onClick={handlePromptSave}>
            Save
          </Button>,
        ]}
      >
        {unsavedPrompt.intent === 'execute'
          ? 'You have unsaved changes. Save and verify the Execution Steps before running, or run without saving?'
          : 'You have unsaved changes. Save before closing, or discard them?'}
      </Modal>
    </div>
  );
};

export default WorkflowEditor;